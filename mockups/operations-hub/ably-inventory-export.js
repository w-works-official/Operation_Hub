(function initAblyInventoryExport(global){
 'use strict';
 const SHEET_NAME='재고 수량 수정_양식';
 const HEADERS=['솔루션사 고유코드','재고 수량'];

 function clean(value){return String(value??'').trim();}
 function solutionCode(value){return String(value??'');}
 function escapeXml(value){return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));}
 function attribute(source,name){return String(source||'').match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]??'';}
 function parseAttributes(source){const result={};String(source||'').replace(/([\w:.-]+)="([^"]*)"/g,(_,key,value)=>{result[key]=value;return '';});return result;}
 function resolveStock(row,stockSource){
  const policy=global.SystemV3SellpiaInventoryCount?.resolveExportStock;
  if(typeof policy!=='function')throw Error('Sellpia 재고 기준 정책을 불러오지 못했습니다.');
  return policy(row,stockSource);
 }
 function stableFingerprint(value){
  const text=JSON.stringify(value);let a=0x811c9dc5,b=0x9e3779b9;
  for(let index=0;index<text.length;index++){const code=text.charCodeAt(index);a=Math.imul(a^code,0x01000193)>>>0;b=Math.imul(b^code,0x85ebca6b)>>>0;}
  return `${a.toString(16).padStart(8,'0')}${b.toString(16).padStart(8,'0')}`;
 }
 function eligibleMapping(row){const code=solutionCode(row?.solution_code);return row?.is_active===true&&row?.mapping_state==='verified'&&(row?.stock_policy==='shared'||row?.stock_policy==='individual')&&!row?.suppression_active&&Boolean(code)&&code===clean(code)&&Boolean(clean(row?.sellpia_sku_code));}
 function readiness({mappingRows=[]}={}){
  const summary={mappingCount:Array.isArray(mappingRows)?mappingRows.length:0,eligibleCount:0,reviewCount:0,excludedCount:0};
  const eligible=[],seenCodes=new Set(),duplicateCodes=new Set(),identityOwners=new Map(),ambiguousIdentities=new Set();
  for(const raw of Array.isArray(mappingRows)?mappingRows:[]){
   const row={...raw},code=solutionCode(row.solution_code);
   if(eligibleMapping(row)){
    if(seenCodes.has(code))duplicateCodes.add(code);seenCodes.add(code);
    const identity=JSON.stringify([clean(row.product_code),clean(row.option_code)]),owner=JSON.stringify([clean(row.sellpia_sku_code),code]);
    if(identityOwners.has(identity)&&identityOwners.get(identity)!==owner)ambiguousIdentities.add(identity);
    else identityOwners.set(identity,owner);
    eligible.push(row);
   }else if(row.mapping_state==='review'||row.stock_policy==='review'){summary.reviewCount++;}
   else if(row.is_active===false||row.stock_policy==='excluded'||row.mapping_state==='conflict'||row.suppression_active){summary.excludedCount++;}
   else summary.reviewCount++;
  }
  summary.eligibleCount=eligible.length;
  const fingerprint=stableFingerprint(eligible.map(row=>[solutionCode(row.solution_code),clean(row.sellpia_sku_code),clean(row.product_code),clean(row.option_code),row.stock_policy,row.individual_stock??null]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
  const conflict=duplicateCodes.size>0||ambiguousIdentities.size>0;
  const reason=duplicateCodes.size?`중복 솔루션사 고유코드를 확인해주세요: ${[...duplicateCodes].slice(0,5).join(', ')}${duplicateCodes.size>5?' 외':''}`:ambiguousIdentities.size?`판매처 옵션이 여러 SKU 또는 솔루션사 고유코드에 연결되어 있습니다: ${[...ambiguousIdentities].slice(0,5).map(identity=>JSON.parse(identity).join('/')).join(', ')}${ambiguousIdentities.size>5?' 외':''}`:eligible.length?'':`내보낼 수 있는 에이블리 재고 매핑이 없습니다. 검토 ${summary.reviewCount}건 · 제외 ${summary.excludedCount}건`;
  return {ready:Boolean(eligible.length)&&!conflict,eligibleCount:eligible.length,reviewCount:summary.reviewCount,excludedCount:summary.excludedCount,fingerprint,reason,duplicateCodes:[...duplicateCodes],ambiguousIdentities:[...ambiguousIdentities]};
 }
 function excludedExportRow(row,status,reason){
  return {stage:'seller_export',source:'ably',file_name:clean(row?.source_file_name||row?.file_name),source_row_no:row?.source_row_no??null,
   sellpia_sku_code:clean(row?.sellpia_sku_code),solution_code:solutionCode(row?.solution_code),product_code:clean(row?.product_code),
   option_code:clean(row?.option_code),stock_policy:clean(row?.stock_policy),stock:null,available_stock:null,raw_stock:null,raw_available_stock:null,status,reason};
 }
 function prepare({mappingRows=[],stockSources,stockSource='available_stock',excludedSkus=[]}={}){
  if(!['stock','available_stock'].includes(stockSource))throw Error('에이블리 재고 기준을 확인해주세요.');
  if(!stockSources?.snapshotId||!(stockSources.bySku instanceof Map))throw Error('최신 Sellpia 재고 snapshot을 확인할 수 없습니다.');
  const mappingReadiness=readiness({mappingRows});
  if(!mappingReadiness.ready)throw Error(mappingReadiness.reason||'에이블리 재고 매핑이 준비되지 않았습니다.');
  const summary={mappingCount:Array.isArray(mappingRows)?mappingRows.length:0,eligibleCount:0,reviewCount:mappingReadiness.reviewCount,excludedCount:mappingReadiness.excludedCount,excludedRowCount:0};
  const rows=[],excludedRows=[];
  const inputBlockedSkus=new Set(Array.from(excludedSkus||[]).map(clean).filter(Boolean));
  for(const raw of Array.isArray(mappingRows)?mappingRows:[]){
   const row={...raw},code=solutionCode(row.solution_code),sku=clean(row.sellpia_sku_code);
   if(!eligibleMapping(row)){
    const state=clean(row.mapping_state)||'review',reasons=Array.isArray(row.review_reasons)?row.review_reasons.filter(Boolean):[],exclusionReasons=[];
    if(row.suppression_active)exclusionReasons.push('활성 연결 억제');
    if(row.stock_policy==='excluded')exclusionReasons.push('재고 자동 반영 제외 정책');
    if(!row.is_active)exclusionReasons.push('비활성 매핑');
    if(reasons.length)exclusionReasons.push(...reasons);
    if(!exclusionReasons.length)exclusionReasons.push(`매핑 상태/재고 정책 검토: ${state}/${row.stock_policy||'unknown'}`);
    const status=state==='conflict'||state==='review'?state:row.suppression_active?'suppressed':row.stock_policy==='excluded'?'excluded':!row.is_active?'inactive':state;
    excludedRows.push(excludedExportRow(row,status,exclusionReasons.join(' · ')));continue;
   }
   if(inputBlockedSkus.has(sku)){
    excludedRows.push(excludedExportRow(row,'inventory_input_blocked','Sellpia 재고 입력 단계에서 이 SKU가 차단되어 제외되었습니다.'));
    summary.reviewCount++;continue;
   }
   const source=stockSources.bySku.get(sku);
   if(!source){excludedRows.push(excludedExportRow(row,'snapshot_sku_missing',`최신 Sellpia 재고 snapshot에서 SKU를 찾지 못했습니다: ${sku}`));summary.reviewCount++;continue;}
   let quantity=null;
   if(row.stock_policy==='shared'){
    quantity=resolveStock(source,stockSource);
   }else quantity=row.individual_stock;
   if(quantity===null||quantity===undefined||clean(quantity)===''||!Number.isSafeInteger(Number(quantity))||Number(quantity)<0){
    excludedRows.push(excludedExportRow(row,'invalid_quantity',`선택한 재고 기준(${stockSource})의 수량을 확인할 수 없어 제외되었습니다.`));summary.reviewCount++;continue;
   }
   rows.push({solution_code:code,quantity:Number(quantity),sellpia_sku_code:sku,product_code:clean(row.product_code),option_code:clean(row.option_code)});
  }
  const uniqueRows=rows;
  summary.eligibleCount=uniqueRows.length;
  summary.excludedRowCount=excludedRows.length;
  return {kind:'AblyInventoryPlan',version:1,stockSource,snapshotId:String(stockSources.snapshotId),rows:uniqueRows,excludedRows,summary,mappingFingerprint:mappingReadiness.fingerprint};
 }
 function patchCell(xml,line,column,value,type){
  const reference=`${column}${line}`,rowRe=new RegExp(`<row\\b(?=[^>]*\\br="${line}")[^>]*>[\\s\\S]*?<\\/row>`),match=String(xml).match(rowRe);
  if(!match)throw Error(`템플릿 ${line}행을 찾지 못했습니다.`);
  const row=match[0],cellRe=new RegExp(`<c\\b([^>]*\\br="${reference}"[^>]*?)(?:\\/>|>[\\s\\S]*?<\\/c>)`),old=row.match(cellRe);
  if(!old)throw Error(`템플릿 ${reference} 셀을 찾지 못했습니다.`);
  const style=old[1].match(/\bs="[^"]*"/)?.[0]||'';
  const cell=type==='string'?`<c r="${reference}" ${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`:`<c r="${reference}" ${style}><v>${Number(value)}</v></c>`;
  return String(xml).replace(rowRe,()=>row.replace(cellRe,()=>cell));
 }
 function updateDimension(xml,lastRow){
  const current=String(xml).match(/<dimension\b[^>]*\bref="([^"]+)"[^>]*\/>/);
  if(!current)throw Error('공식 에이블리 재고 템플릿의 범위를 읽지 못했습니다.');
  const tail=current[1].split(':').at(-1),col=tail.match(/[A-Z]+/)?.[0]||'B';
  return String(xml).replace(current[0],current[0].replace(current[1],`A1:${col}${Math.max(Number(lastRow)||1,Number(tail.match(/\d+/)?.[0]||1))}`));
 }
 function ensureRows(xml,lastRow){
  const sheetData=String(xml).match(/<sheetData\b[^>]*>[\s\S]*?<\/sheetData>/);
  if(!sheetData)throw Error('공식 에이블리 재고 템플릿의 데이터 영역을 찾지 못했습니다.');
  const body=sheetData[0],matches=[...body.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>[\s\S]*?<\/row>/g)],rowMap=new Map(matches.map(match=>[Number(match[1]),match[0]]));
  const prototype=rowMap.get(2);if(!prototype)throw Error('공식 에이블리 재고 템플릿의 2행 서식을 찾지 못했습니다.');
  const maxExisting=Math.max(...rowMap.keys());if(lastRow>maxExisting){
   const additions=[];
   for(let row=maxExisting+1;row<=lastRow;row++)additions.push(prototype.replace(/(<row\b[^>]*\br=")2("[^>]*>)/,`$1${row}$2`).replace(/(\br="[A-Z]+)2("[^>]*>)/g,`$1${row}$2`));
   const replaced=body.replace('</sheetData>',additions.join('')+'</sheetData>');
   return {xml:String(xml).replace(sheetData[0],replaced),maxExisting};
  }
  return {xml:String(xml),maxExisting};
 }
 async function inspectTemplate(templateFile){
  if(!templateFile||typeof templateFile.arrayBuffer!=='function')throw Error('공식 에이블리 재고 양식 파일을 불러오지 못했습니다.');
  if(!global.XLSX||!global.JSZip)throw Error('에이블리 재고 XLSX 생성 모듈을 불러오지 못했습니다.');
  const bytes=await templateFile.arrayBuffer(),book=global.XLSX.read(bytes,{type:'array'}),sheet=book.Sheets[SHEET_NAME];
  if(!sheet||book.SheetNames?.length!==1)throw Error(`공식 에이블리 재고 양식은 ${SHEET_NAME} 시트 하나만 포함해야 합니다.`);
  HEADERS.forEach((header,index)=>{const cell=sheet[`${String.fromCharCode(65+index)}1`];if(String(cell?.v??'').trim()!==header)throw Error(`${header} 헤더가 공식 에이블리 재고 양식과 다릅니다.`);});
  const zip=await global.JSZip.loadAsync(bytes),workbookXml=await zip.file('xl/workbook.xml').async('string');
  const sheetNode=[...workbookXml.matchAll(/<sheet\b[^>]*>/g)].map(match=>match[0]).find(node=>attribute(node,'name')===SHEET_NAME),relationId=attribute(sheetNode,'r:id');
  const relXml=await zip.file('xl/_rels/workbook.xml.rels').async('string'),relation=[...relXml.matchAll(/<Relationship\b[^>]*>/g)].map(match=>match[0]).find(node=>attribute(node,'Id')===relationId),target=attribute(relation,'Target');
  if(!target)throw Error('공식 에이블리 재고 시트 연결을 찾지 못했습니다.');
  const sheetPath=target.startsWith('/')?target.slice(1):`xl/${target.replace(/^\.\//,'')}`,entry=zip.file(sheetPath);
  if(!entry)throw Error('공식 에이블리 재고 시트 파일을 읽지 못했습니다.');
  const xml=await entry.async('string'),dimension=xml.match(/<dimension\b[^>]*\bref="([^"]+)"/),last=Number(dimension?.[1].match(/\d+$/)?.[0]||0);
  if(!dimension||!dimension[1].startsWith('A1:K')||last<1002)throw Error('공식 에이블리 재고 양식의 범위/행 서식이 예상과 다릅니다.');
  if(String(sheet.D1?.v??'')!=='← 양식의 A,B열 순서를 변경하지 말아주세요.')throw Error('공식 에이블리 재고 양식의 안내문을 확인할 수 없습니다.');
  // Keep optional merge/validation sections exactly as shipped. The supplied
  // official template currently omits them, so their absence is valid.
  for(const address of Object.keys(sheet))if(/^[AB]\d+$/.test(address)&&Number(address.match(/\d+$/)?.[0])>1&&sheet[address]?.v!==undefined&&String(sheet[address].v)!=='')throw Error('공식 에이블리 재고 템플릿의 입력 행이 비어 있지 않습니다. 최신 빈 양식을 확인해주세요.');
  for(const address of ['A2','B2'])if(!new RegExp(`<c\\b[^>]*\\br="${address}"[^>]*\\bs="[^"]+"`).test(xml))throw Error(`공식 에이블리 재고 양식 ${address} 셀 서식을 확인할 수 없습니다.`);
  return {valid:true,sheetName:SHEET_NAME,capacity:last-1};
 }
 async function build({plan,templateFile}={}){
  if(!plan||plan.kind!=='AblyInventoryPlan'||!Array.isArray(plan.rows))throw Error('에이블리 재고 계획을 확인할 수 없습니다.');
  await inspectTemplate(templateFile);
  const bytes=await templateFile.arrayBuffer(),book=global.XLSX.read(bytes,{type:'array'}),sheet=book.Sheets[SHEET_NAME];
  const zip=await global.JSZip.loadAsync(bytes),workbookXml=await zip.file('xl/workbook.xml').async('string');
  const sheetNode=[...workbookXml.matchAll(/<sheet\b[^>]*>/g)].map(match=>match[0]).find(node=>attribute(node,'name')===SHEET_NAME);
  const relationId=attribute(sheetNode,'r:id');
  const relXml=await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const relation=[...relXml.matchAll(/<Relationship\b[^>]*>/g)].map(match=>match[0]).find(node=>attribute(node,'Id')===relationId),target=attribute(relation,'Target');
  if(!target)throw Error('공식 에이블리 재고 시트 연결을 찾지 못했습니다.');
  const sheetPath=target.startsWith('/')?target.slice(1):`xl/${target.replace(/^\.\//,'')}`,entry=zip.file(sheetPath);
  if(!entry)throw Error('공식 에이블리 재고 시트 파일을 읽지 못했습니다.');
  const originalXml=await entry.async('string'),lastRow=plan.rows.length+1,expanded=ensureRows(originalXml,lastRow);
  let written=0;
  let outputXml=expanded.xml.replace(/<row\b[^>]*\br="(\d+)"[^>]*>[\s\S]*?<\/row>/g,(rowXml,lineText)=>{
   const line=Number(lineText),row=plan.rows[line-2];if(line<2||!row)return rowXml;
   written++;return patchCell(patchCell(rowXml,line,'A',row.solution_code,'string'),line,'B',row.quantity,'number');
  });
  if(written!==plan.rows.length)throw Error('공식 에이블리 재고 양식의 출력 행을 모두 확인하지 못했습니다.');
  outputXml=updateDimension(outputXml,lastRow);
  zip.file(sheetPath,outputXml,{createFolders:false});
  const blob=await zip.generateAsync({type:'blob',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',compression:'DEFLATE'});
  const reopened=global.XLSX.read(await blob.arrayBuffer(),{type:'array'}),check=reopened.Sheets[SHEET_NAME];
  if(!check||String(check.A1?.v??'').trim()!==HEADERS[0]||String(check.B1?.v??'').trim()!==HEADERS[1])throw Error('생성한 에이블리 재고 파일의 공식 헤더를 다시 확인하지 못했습니다.');
  for(let index=0;index<plan.rows.length;index++){
   const line=index+2,row=plan.rows[index],code=check[`A${line}`]?.v,quantity=check[`B${line}`]?.v;
   if(String(code??'')!==row.solution_code||typeof Number(quantity)!=='number'||!Number.isSafeInteger(Number(quantity))||Number(quantity)!==row.quantity)throw Error(`생성한 에이블리 재고 파일 ${line}행 값을 확인하지 못했습니다.`);
  }
  const outputRows=global.XLSX.utils.sheet_to_json(check,{header:1,raw:true,defval:''});
  if(outputRows.length<plan.rows.length+1)throw Error('생성한 에이블리 재고 행 수가 예상보다 적습니다.');
  return {blob,fileName:'에이블리_재고 수량 변경.xlsx',rowCount:plan.rows.length,summary:{...plan.summary},mappingFingerprint:plan.mappingFingerprint};
 }
 global.HubAblyInventoryExport={HEADERS,SHEET_NAME,readiness,prepare,validateTemplate:inspectTemplate,build};
})(typeof window==='undefined'?globalThis:window);
