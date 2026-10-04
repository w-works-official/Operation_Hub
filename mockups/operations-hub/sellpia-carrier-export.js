(function initSellpiaCarrierExport(global){
  'use strict';

  const FIELD_COLUMNS={purchase:'purchasePrice',base:'salePrice',stock:'stock'};
  const FIELD_LABELS={purchase:'매입가',base:'기준가격',stock:'재고'};
  const clean=value=>String(value??'').trim();
  const numeric=value=>{const text=String(value??'').replace(/,/g,'').trim();return text===''?NaN:Number(text);};
  const same=(left,right)=>Number.isFinite(numeric(left))&&Number.isFinite(numeric(right))&&numeric(left)===numeric(right);

  async function matrixFromFile(file){
    const X=global.XLSX, parser=global.SystemV3SellpiaSourceParser;
    if(!X||!parser)throw Error('Sellpia 원본 해석 모듈을 불러오지 못했습니다.');
    const delimited=/\.(csv|tsv|txt)$/i.test(file.name);
    const buffer=await file.arrayBuffer();
    let workbook;
    if(delimited){
      const decoded=parser.decodeSellpiaBytes(buffer);
      workbook=X.read(decoded.binaryText||decoded.text,{type:decoded.inputType,raw:true,cellDates:false,...(decoded.inputType==='binary'?{codepage:949}:{})});
    }else{
      workbook=X.read(buffer,{type:'array',raw:true,cellDates:false});
    }
    const sheet=workbook.Sheets[workbook.SheetNames[0]];
    if(!sheet?.['!ref'])throw Error(`${file.name}: 첫 시트에 데이터가 없습니다.`);
    const rows=X.utils.sheet_to_json(sheet,{header:1,raw:true,defval:'',blankrows:true});
    const header=parser.buildSellpiaColumnMap(rows[0]||[]);
    if(!header.valid)throw Error(`${file.name}: ${header.errors.join(' ')}`);
    const bySku=new Map(), duplicates=new Set(), dataRows=[];
    for(let index=1;index<rows.length;index++){
      const row=rows[index]||[], sku=clean(row[header.columns.sku]);
      if(!sku&&!row.some(value=>clean(value)))continue;
      const physicalRow=index+1;
      dataRows.push(physicalRow);
      if(!sku)continue;
      if(bySku.has(sku))duplicates.add(sku);
      else bySku.set(sku,{sku,row,physicalRow});
    }
    return {file,delimited,rows,columns:header.columns,bySku,duplicates,dataRows};
  }

  function appendBlock(blocks,sku,field,reason,before=''){
    if(blocks.some(row=>row.sku===sku&&row.field===field&&row.reason===reason))return;
    blocks.push({sku,field,reason,before,status:'BLOCK'});
  }

  async function prepare(files,plan,mode='full'){
    const sourceFiles=Array.from(files||[]);
    if(!sourceFiles.length)throw Error('저장된 최신 Sellpia 전체 원본 carrier가 없습니다. 전체 원본을 다시 업로드해주세요.');
    if(!['full','changed_only'].includes(mode))throw Error('지원하지 않는 Sellpia 내보내기 모드입니다.');
    const analyses=[];
    for(const file of sourceFiles)analyses.push(await matrixFromFile(file));
    const locations=new Map();
    for(const analysis of analyses){
      for(const sku of analysis.duplicates)locations.set(sku,null);
      for(const [sku,row] of analysis.bySku){
        if(analysis.duplicates.has(sku))continue;
        if(locations.has(sku))locations.set(sku,null);
        else locations.set(sku,{analysis,row});
      }
    }
    const blocked=new Set(plan.blockedSkus||[]), blocks=[...(plan.errors||[]).map(error=>({sku:error.sku,field:error.field,reason:error.reason,before:plan.preview.find(row=>row.sku===error.sku&&row.field===error.field)?.before??'',status:'BLOCK'}))];
    const changesByFile=new Map(analyses.map(analysis=>[analysis.file.name,[]]));
    const changedRowsByFile=new Map(analyses.map(analysis=>[analysis.file.name,new Set()]));
    for(const value of plan.values||[]){
      const sku=value.sku;
      if(blocked.has(sku))continue;
      const location=locations.get(sku);
      if(location===null){
        appendBlock(blocks,sku,'identity','저장 원본 여러 파일에서 동일 SKU가 중복됩니다.');blocked.add(sku);continue;
      }
      if(!location){
        appendBlock(blocks,sku,'identity','최신 저장 원본 carrier에서 SKU를 찾지 못했습니다.');blocked.add(sku);continue;
      }
      const pending=[];
      for(const key of plan.keys||[]){
        const after=value[key], preview=plan.preview.find(row=>row.sku===sku&&row.key===key);
        if(preview?.error)continue;
        const columnIndex=location.analysis.columns[FIELD_COLUMNS[key]], actual=location.row.row[columnIndex], expected=preview?.before;
        if(!same(actual,expected)){
          appendBlock(blocks,sku,FIELD_LABELS[key],`${location.analysis.file.name}: 보관 원본 값(${actual})과 같은 snapshot 원본 값(${expected})이 다릅니다.`,actual);
          blocked.add(sku);break;
        }
        if(!same(actual,after))pending.push({sku,key,field:FIELD_LABELS[key],row:location.row.physicalRow,columnIndex,expected,value:Number(after),numeric:true});
      }
      if(blocked.has(sku))continue;
      if(pending.length){
        changesByFile.get(location.analysis.file.name).push(...pending);
        changedRowsByFile.get(location.analysis.file.name).add(location.row.physicalRow);
      }
    }
    for(const [name,changes] of changesByFile)changesByFile.set(name,changes.filter(change=>!blocked.has(change.sku)));
    const scopedWarnings=(plan.preview||[]).filter(row=>row.status==='경고'&&!blocked.has(row.sku));
    return {
      mode,analyses,changesByFile,changedRowsByFile,blocks,blockedSkus:[...blocked],
      priceChangeCount:[...changesByFile.values()].flat().filter(change=>change.key==='base').length,
      stockChangeCount:[...changesByFile.values()].flat().filter(change=>change.key==='stock').length,
      purchaseChangeCount:[...changesByFile.values()].flat().filter(change=>change.key==='purchase').length,
      warningSkuCount:new Set(scopedWarnings.map(row=>row.sku)).size,
      warningIdentityCount:new Set(scopedWarnings.map(row=>row.sku)).size,
      excludedIdentityCount:new Set(blocks.map(row=>row.sku)).size,
      changedSkuCount:new Set([...changesByFile.values()].flat().map(change=>change.sku)).size
    };
  }

  function columnName(index){
    let result='',value=Number(index)+1;
    while(value>0){value--;result=String.fromCharCode(65+value%26)+result;value=Math.floor(value/26);}
    return result;
  }

  function xlsxFileFromRows(rows,name){
    const X=global.XLSX;
    const sheet=X.utils.aoa_to_sheet(rows),book=X.utils.book_new();
    X.utils.book_append_sheet(book,sheet,'Sellpia원본');
    return new File([X.write(book,{type:'array',bookType:'xlsx',compression:true})],name,{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  }

  function xlsxOutputName(name,mode){
    const base=String(name||'Sellpia원본').replace(/\.(csv|tsv|txt)$/i,'');
    return `${base}${mode==='full'?'_SystemV3반영':'_SystemV3변경분'}.xlsx`;
  }

  async function build(prepared){
    const adapter=global.SystemV3SellerExport;
    if(!adapter?.transformTabularXlsx)throw Error('원본 workbook 보존 모듈을 불러오지 못했습니다.');
    const outputs=[], transformConflicts=[];let renumberStart=1;
    for(const analysis of prepared.analyses){
      const changes=prepared.changesByFile.get(analysis.file.name)||[], keep=prepared.changedRowsByFile.get(analysis.file.name)||new Set();
      if(prepared.mode==='changed_only'&&!keep.size)continue;
      if(analysis.delimited){
        let outputRows=analysis.rows.map(row=>[...row]),mappedChanges=changes;
        if(prepared.mode==='changed_only'){
          const kept=[...keep].sort((a,b)=>a-b);
          const rowMap=new Map(kept.map((physicalRow,index)=>[physicalRow,index+2]));
          outputRows=[outputRows[0],...kept.map((physicalRow,index)=>{
            const row=[...outputRows[physicalRow-1]];
            row[analysis.columns.rowNo]=renumberStart+index;
            return row;
          })];
          mappedChanges=changes.map(change=>({...change,row:rowMap.get(change.row)}));
          renumberStart+=kept.length;
        }
        const generated=xlsxFileFromRows(outputRows,xlsxOutputName(analysis.file.name,prepared.mode));
        const result=await adapter.transformTabularXlsx(generated,mappedChanges.map(change=>({...change,column:columnName(change.columnIndex)})));
        transformConflicts.push(...result.conflicts);
        outputs.push({name:xlsxOutputName(analysis.file.name,prepared.mode),blob:result.blob,changeCount:result.applied.length,rowCount:outputRows.length-1,stylePreserved:true,sourceFormat:'csv',outputFormat:'xlsx'});
      }else{
        if(/\.xls$/i.test(analysis.file.name)&&!/\.xlsx$/i.test(analysis.file.name))throw Error(`${analysis.file.name}: XLS 바이너리 원본은 구조 보존 수정이 불가능합니다. XLSX 또는 CSV 원본을 업로드해주세요.`);
        const result=await adapter.transformTabularXlsx(analysis.file,changes.map(change=>({...change,column:columnName(change.columnIndex)})),prepared.mode==='changed_only'?{
          dataRowNumbers:analysis.dataRows,keepOnlyRows:keep,renumberColumn:columnName(analysis.columns.rowNo),renumberStart
        }:{});
        transformConflicts.push(...result.conflicts);
        outputs.push({name:outputName(analysis.file.name,prepared.mode),blob:result.blob,changeCount:result.applied.length,rowCount:prepared.mode==='changed_only'?keep.size:analysis.dataRows.length,stylePreserved:true});
        if(prepared.mode==='changed_only')renumberStart+=keep.size;
      }
    }
    if(transformConflicts.length)throw Error(transformConflicts.map(row=>row.reason).join(' · '));
    if(!outputs.length)throw Error('실제 변경되는 정상 SKU가 없어 변경분 파일을 만들지 않았습니다.');
    if(outputs.length===1)return {blob:outputs[0].blob,name:outputs[0].name,outputs};
    if(!global.JSZip)throw Error('여러 원본 파일을 묶는 ZIP 모듈을 불러오지 못했습니다.');
    const zip=new global.JSZip();for(const output of outputs)zip.file(output.name,output.blob);
    return {blob:await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6}}),name:`Sellpia_${prepared.mode==='full'?'전체원본반영':'변경분'}_${dateStamp()}.zip`,outputs};
  }

  function dateStamp(){return new Date().toISOString().slice(0,10).replace(/-/g,'');}
  function outputName(name,mode){const dot=name.lastIndexOf('.'),suffix=mode==='full'?'_SystemV3반영':'_SystemV3변경분';return dot<0?`${name}${suffix}`:`${name.slice(0,dot)}${suffix}${name.slice(dot)}`;}
  global.SystemV3SellpiaCarrierExport=Object.freeze({matrixFromFile,prepare,build,outputName});
})(typeof window!=='undefined'?window:globalThis);
