(function(global){
  'use strict';

  const PRODUCT_SHEET='쇼핑몰상품';
  const OPTION_SHEET='옵션기본';
  const PRODUCT_REQUIRED=['판매자관리코드','쇼핑몰(계정)','온라인 상품명','판매가','옵션','SKU','옵션 추가금액'];
  const OPTION_REQUIRED=['*쇼핑몰','*계정','*판매자관리코드','온라인 상품명','옵션1 명칭','옵션1 값','추가 금액','판매가능재고','*판매수량'];
  const PRODUCT_BASE_PRICE_COLUMN='I';
  const PRODUCT_OPTION_PRICE_COLUMN='T';
  const OPTION_PRICE_COLUMN='V';
  const OPTION_STOCK_COLUMN='X';
  const OPTION_SALES_QUANTITY_COLUMN='X';

  const clean=value=>String(value??'').trim();
  const normalize=value=>clean(value).replace(/\s+/g,' ').toLowerCase();
  const splitLines=value=>String(value??'').split(/\r?\n/).map(clean);
  const nonEmptyLines=value=>splitLines(value).filter(Boolean);
  const stripSellpiaPrefix=value=>clean(value).replace(/^sellpia_/i,'');
  const explicitSellpiaSku=value=>/^sellpia_.+-\d+$/i.test(clean(value))?stripSellpiaPrefix(value):'';
  const sellerProductCode=value=>{const match=clean(value).match(/^sellpia_(.+)$/i);return match?match[1]:'';};
  const headerMap=headers=>new Map((headers||[]).map((value,index)=>[clean(value),index]));
  const assertHeaders=(headers,required,label)=>{const map=headerMap(headers),missing=required.filter(name=>!map.has(name));if(missing.length)throw Error(`${label} 필수 헤더가 없습니다: ${missing.join(', ')}`);return map;};
  const valueAt=(row,map,name)=>row?.[map.get(name)]??'';
  const finite=value=>value!==null&&value!==undefined&&String(value).trim()!==''&&Number.isFinite(Number(value));
  const xmlDecode=value=>String(value??'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
  const xmlAttributes=value=>{const result={};String(value||'').replace(/([\w:]+)="([^"]*)"/g,(_,key,item)=>{result[key]=xmlDecode(item);return '';});return result;};

  function detect(rowsBySheet){
    const productRows=rowsBySheet?.[PRODUCT_SHEET];
    if(Array.isArray(productRows)&&productRows.length){try{assertHeaders(productRows[0],PRODUCT_REQUIRED,PRODUCT_SHEET);return {type:'product_price_option',sheet:PRODUCT_SHEET};}catch{}}
    const optionRows=rowsBySheet?.[OPTION_SHEET];
    if(Array.isArray(optionRows)&&optionRows.length){try{assertHeaders(optionRows[0],OPTION_REQUIRED,OPTION_SHEET);return {type:'option_price_stock',sheet:OPTION_SHEET};}catch{}}
    return null;
  }

  function productOptionLines(value){
    return nonEmptyLines(value).filter(line=>!/^\[.*\]$/.test(line)).map(line=>{
      const separator=line.indexOf('=');
      return {raw:line,option_name:clean(separator>=0?line.slice(0,separator):line),secondary_value:clean(separator>=0?line.slice(separator+1):'')};
    });
  }

  function parseProductRows(rows){
    if(!Array.isArray(rows)||rows.length<2)return [];
    const map=assertHeaders(rows[0],PRODUCT_REQUIRED,PRODUCT_SHEET),items=[];
    rows.slice(1).forEach((row,rowIndex)=>{
      const sellerCode=clean(valueAt(row,map,'판매자관리코드'));if(!sellerCode)return;
      const options=productOptionLines(valueAt(row,map,'옵션'));
      const skuLines=nonEmptyLines(valueAt(row,map,'SKU'));
      const optionPrices=splitLines(valueAt(row,map,'옵션 추가금액'));
      const optionStocks=map.has('옵션 판매수량')?splitLines(valueAt(row,map,'옵션 판매수량')):[];
      const optionCount=Math.max(options.length,skuLines.length,optionPrices.length,optionStocks.length,1);
      for(let index=0;index<optionCount;index++){
        const skuToken=skuLines[index]||'';
        const directSku=/^sellpia_.+-[^\s]+$/i.test(skuToken)&&/-\d+$/i.test(skuToken)?stripSellpiaPrefix(skuToken):'';
        const option=options[index]||{raw:'',option_name:'',secondary_value:''};
        items.push({
          template_type:'product_price_option',source_row_no:rowIndex+2,option_index:index,
          shop:clean(valueAt(row,map,'쇼핑몰(계정)')),seller_management_code:sellerCode,sellpia_product_code:sellerProductCode(sellerCode),
          seller_product_code:clean(valueAt(row,map,'쇼핑몰 상품번호')),product_name:clean(valueAt(row,map,'온라인 상품명')),
          direct_sellpia_sku_code:directSku,direct_sellpia_sku_error:skuToken&&!directSku?'P열 SKU를 셀피아 SKU 형식으로 읽을 수 없습니다.':'',option_candidates:[option.option_name].filter(Boolean),primary_option_name:option.option_name,
          secondary_option_value:option.secondary_value,base_price:finite(valueAt(row,map,'판매가'))?Number(valueAt(row,map,'판매가')):null,
          option_price:finite(optionPrices[index])?Number(optionPrices[index]):null,
          option_stock:finite(optionStocks[index])?Number(optionStocks[index]):null
        });
      }
    });
    return items;
  }

  function parseOptionRows(rows){
    if(!Array.isArray(rows)||rows.length<2)return [];
    const map=assertHeaders(rows[0],OPTION_REQUIRED,OPTION_SHEET);
    const items=rows.slice(1).map((row,rowIndex)=>{
      const sellerCode=clean(valueAt(row,map,'*판매자관리코드'));
      const optionPairs=[1,2,3].map(index=>({name:clean(valueAt(row,map,`옵션${index} 명칭`)),value:clean(valueAt(row,map,`옵션${index} 값`))})).filter(pair=>pair.name||pair.value);
      const values=optionPairs.map(pair=>pair.value).filter(Boolean),joined=values.join('/');
      const sellerOptionCode=clean(valueAt(row,map,'옵션관리코드')),optionSkuCode=clean(valueAt(row,map,'옵션 SKU 코드'));
      const directSkuCodes=[...new Set([sellerOptionCode,optionSkuCode].map(explicitSellpiaSku).filter(Boolean))];
      return {
        template_type:'option_price_stock',source_row_no:rowIndex+2,
        shop:clean(valueAt(row,map,'*쇼핑몰')),account:clean(valueAt(row,map,'*계정')),seller_management_code:sellerCode,
        sellpia_product_code:sellerProductCode(sellerCode),product_name:clean(valueAt(row,map,'온라인 상품명')),
        seller_product_code:clean(valueAt(row,map,'쇼핑몰상품코드')),base_price:finite(valueAt(row,map,'판매가'))?Number(valueAt(row,map,'판매가')):null,
        seller_option_code:sellerOptionCode,option_sku_code:optionSkuCode,
        direct_sellpia_sku_code:directSkuCodes.length===1?directSkuCodes[0]:'',
        direct_sellpia_sku_error:directSkuCodes.length>1?'옵션관리코드와 옵션 SKU 코드가 서로 다른 셀피아 SKU를 가리킵니다.':'',
        option_pairs:optionPairs,option_candidates:[...values,...(joined?[joined]:[])],primary_option_name:values[0]||'',
        option_price:finite(valueAt(row,map,'추가 금액'))?Number(valueAt(row,map,'추가 금액')):null,
        available_stock:finite(valueAt(row,map,'판매가능재고'))?Number(valueAt(row,map,'판매가능재고')):null,
        sales_quantity:finite(valueAt(row,map,'*판매수량'))?Number(valueAt(row,map,'*판매수량')):null,
        carrier_identity:JSON.stringify([sellerCode,...optionPairs.map(pair=>pair.value)])
      };
    }).filter(item=>item.seller_management_code);
    const counts=new Map();for(const item of items)counts.set(item.carrier_identity,(counts.get(item.carrier_identity)||0)+1);
    return items.map(item=>counts.get(item.carrier_identity)>1?{...item,carrier_identity_error:'같은 판매자관리코드와 옵션값이 파일에 중복됩니다.'}:item);
  }

  function resolveSellpiaSku(item,catalog,mappings=[],{preferDirectProductSku=false}={}){
    const optionCarrier=item.template_type==='option_price_stock';
    if(optionCarrier&&item.direct_sellpia_sku_error)return {error:item.direct_sellpia_sku_error,method:'direct_sku_ambiguous'};
    const sellerProduct=clean(item.seller_product_code);
    const optionKeys=[clean(item.seller_option_code),clean(item.option_sku_code)].filter(value=>value&&!explicitSellpiaSku(value));
    const productMappings=sellerProduct?(mappings||[]).filter(row=>clean(row.product_code)===sellerProduct):[];
    const exactMappings=productMappings.length?(optionKeys.length?productMappings.filter(row=>optionKeys.includes(clean(row.option_code))):(productMappings.length===1?productMappings:[])):[];
    const uniqueMappings=[...new Map(exactMappings.map(row=>[clean(row.sku),row])).values()].filter(row=>clean(row.sku));
    const rows=(catalog||[]).filter(row=>clean(row.sellpia_product_code)===clean(item.sellpia_product_code));
    if(preferDirectProductSku&&item.template_type==='product_price_option'&&item.direct_sellpia_sku_error)
      return {error:item.direct_sellpia_sku_error,method:'direct_sku_invalid'};
    if(preferDirectProductSku&&item.template_type==='product_price_option'&&item.direct_sellpia_sku_code){
      const directSku=clean(item.direct_sellpia_sku_code),direct=rows.filter(row=>clean(row.sellpia_sku_code)===directSku);
      if(direct.length>1)return {error:'P열 직접 SKU가 셀피아 카탈로그에 중복됩니다.',method:'direct_sku_invalid'};
      if(!direct.length)return {error:'P열 직접 SKU가 해당 셀피아 상품의 카탈로그에 없습니다.',method:'direct_sku_invalid'};
      const mappedSku=uniqueMappings.length===1?clean(uniqueMappings[0].sku):'';
      return {sku:directSku,method:'direct_sku',row:direct[0],mapping_override:!!mappedSku&&mappedSku!==directSku,mapped_sku:mappedSku};
    }
    if(optionCarrier&&item.direct_sellpia_sku_code){
      const directSku=clean(item.direct_sellpia_sku_code),direct=rows.filter(row=>clean(row.sellpia_sku_code)===directSku);
      if(direct.length>1)return {error:'직접 SKU가 카탈로그에 중복됩니다.',method:'direct_sku'};
      if(direct.length===0){
        const existsElsewhere=(catalog||[]).some(row=>clean(row.sellpia_sku_code)===directSku);
        return {error:existsElsewhere?'직접 SKU가 해당 셀피아 상품에 속하지 않습니다.':'직접 SKU를 카탈로그에서 찾지 못했습니다.',method:'direct_sku_invalid'};
      }
      if(uniqueMappings.length>1)return {error:'기존 에이블리 판매처 연결이 여러 SKU를 가리킵니다.',method:'seller_mapping_ambiguous'};
      if(uniqueMappings.length===1&&clean(uniqueMappings[0].sku)!==directSku)return {error:'직접 SKU와 기존 에이블리 판매처 연결이 충돌합니다.',method:'direct_sku_mapping_conflict'};
      return {sku:direct[0].sellpia_sku_code,method:'direct_sku',row:direct[0]};
    }
    if(productMappings.length){
      if(uniqueMappings.length===1)return {sku:uniqueMappings[0].sku,method:'seller_mapping_exact',row:uniqueMappings[0]};
      if(uniqueMappings.length>1)return {error:'기존 에이블리 판매처 연결이 여러 SKU를 가리킵니다.',method:'seller_mapping_ambiguous'};
    }
    if(item.direct_sellpia_sku_code){
      const direct=rows.filter(row=>clean(row.sellpia_sku_code)===clean(item.direct_sellpia_sku_code));
      if(direct.length===1)return {sku:direct[0].sellpia_sku_code,method:'direct_sku',row:direct[0]};
      if(direct.length>1)return {error:'직접 SKU가 중복됩니다.',method:'direct_sku'};
    }
    const candidateNames=[...new Set((item.option_candidates||[]).map(normalize).filter(Boolean))];
    const exact=[];
    for(const candidate of candidateNames){for(const row of rows){if(normalize(row.sellpia_option_name)===candidate)exact.push(row);}}
    const unique=[...new Map(exact.map(row=>[clean(row.sellpia_sku_code),row])).values()];
    if(unique.length===1)return {sku:unique[0].sellpia_sku_code,method:'product_option_exact',row:unique[0]};
    if(unique.length>1)return {error:'같은 상품 안에서 옵션명이 둘 이상 일치합니다.',method:'product_option_exact'};
    if(item.template_type!=='option_price_stock'&&rows.length===1)return {sku:rows[0].sellpia_sku_code,method:'single_product_sku',row:rows[0]};
    if(productMappings.length>1)return {error:'판매처 상품 연결이 여러 SKU를 가리키며 옵션 식별자와 옵션명으로 하나를 결정하지 못했습니다.',method:'seller_mapping_ambiguous'};
    return {error:rows.length?'옵션명으로 SKU를 하나로 결정하지 못했습니다.':'셀피아 상품코드를 찾지 못했습니다.',method:'unresolved'};
  }

  function resolveRows(items,catalog,mappings=[],options={}){return (items||[]).map(item=>({...item,resolution:resolveSellpiaSku(item,catalog,mappings,options)}));}

  function prepareStockOnlyRow(item,row,{stockSource,inScope=true}={}){
    const out={...item,_inScope:Boolean(inScope),_status:'ready',_error:'',_changedFields:[]};
    if(item.carrier_identity_error){out._status='ambiguous';out._error=item.carrier_identity_error;return out;}
    const sku=item.resolution?.sku;
    if(!sku){out._status=item.resolution?.method==='unresolved'?'warn_keep_original':'ambiguous';out._error=item.resolution?.error||'SKU를 정확히 찾지 못했습니다.';return out;}
    const stockTarget=global.HubCurrentPriceExport?.matrixStockTarget(row,stockSource);
    if(inScope&&item.sales_quantity==null)out._blankStockPreserved=true;
    else if(inScope&&stockTarget!==null&&stockTarget!==undefined&&Number.isSafeInteger(Number(stockTarget)))out.target_stock=Number(stockTarget);
    else if(inScope){out._status='warn_keep_original';out._error=`${stockSource==='stock'?'재고':'가용재고'} target 없음 → 이 행 원본 유지`;}
    return out;
  }

  function isNoBallAnchor(value){
    return /(?:^|[^\p{L}\p{N}])(?:no[\s_-]*ball|노볼)(?=$|[^\p{L}\p{N}])/iu.test(clean(value));
  }

  // Compatibility entry point for older callers. Both price sources now use the
  // common physical-product projection module in seller-file-workflow-v2.js.
  function prepareSellpiaSourceProductRows(items,sourcePrices){
    if(!global.AblyPriceProjection?.projectProductRows)throw Error('에이블리 공통 가격 projection 모듈을 불러오지 못했습니다.');
    const policyByRow=new Map();
    for(const item of items||[])if(!policyByRow.has(item.source_row_no))policyByRow.set(item.source_row_no,{status:'resolved',strategy:'lowest',source:'legacy',sourceLabel:'legacy fallback',version:1,policies:[]});
    return global.AblyPriceProjection.projectProductRows(items,{priceMode:'sellpia_source',targetFinalBySku:sourcePrices,policyByRow});
  }

  async function readTemplate(file){
    if(!global.XLSX)throw Error('XLSX 모듈을 불러오지 못했습니다.');
    const book=global.XLSX.read(await file.arrayBuffer(),{type:'array',raw:true});
    const rowsBySheet={};for(const name of book.SheetNames)rowsBySheet[name]=global.XLSX.utils.sheet_to_json(book.Sheets[name],{header:1,defval:'',raw:true});
    const detected=detect(rowsBySheet);if(!detected)throw Error('에이블리 PlayAuto 판매가+옵션가 또는 옵션가+재고 양식을 인식하지 못했습니다.');
    const items=detected.type==='product_price_option'?parseProductRows(rowsBySheet[detected.sheet]):parseOptionRows(rowsBySheet[detected.sheet]);
    return {...detected,items,rowsBySheet};
  }

  async function sheetParts(file,sheetName){
    if(!global.JSZip||!global.AblyStockExport?.patchCell)throw Error('원본 보존 XLSX 모듈을 불러오지 못했습니다.');
    const bytes=await file.arrayBuffer(),zip=await global.JSZip.loadAsync(bytes);
    const workbookXml=await zip.file('xl/workbook.xml')?.async('string');
    const relationshipXml=await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
    if(!workbookXml||!relationshipXml)throw Error('XLSX 통합문서 구조를 읽지 못했습니다.');
    let relationshipId='';
    String(workbookXml).replace(/<sheet\b([^>]*)\/?>(?:<\/sheet>)?/g,(_,attrs)=>{const parsed=xmlAttributes(attrs);if(parsed.name===sheetName)relationshipId=parsed['r:id']||parsed.id||'';return '';});
    let target='';
    String(relationshipXml).replace(/<Relationship\b([^>]*)\/?>(?:<\/Relationship>)?/g,(_,attrs)=>{const parsed=xmlAttributes(attrs);if(parsed.Id===relationshipId)target=parsed.Target||'';return '';});
    if(!target)throw Error(`${sheetName} 시트 연결을 찾지 못했습니다.`);
    const path=target.startsWith('/')?target.slice(1):'xl/'+target.replace(/^\.\//,'');
    const entry=zip.file(path);if(!entry)throw Error(`${sheetName} 원본 XML을 찾지 못했습니다.`);
    const stylesPath='xl/styles.xml',stylesEntry=zip.file(stylesPath);
    if(!stylesEntry)throw Error('원본 XLSX 스타일 정보를 읽지 못했습니다.');
    return {zip,path,xml:await entry.async('string'),stylesPath,stylesXml:await stylesEntry.async('string'),bytes};
  }

  function highlightChanges(parts,xml,changes,options){
    const apply=global.SystemV3SellerExport?.applyChangeHighlights;
    if(typeof apply!=='function')throw Error('XLSX 변경 셀 강조 모듈을 불러오지 못했습니다.');
    const highlighted=apply(xml,parts.stylesXml,changes,options);
    parts.stylesXml=highlighted.stylesXml;
    parts.zip.file(parts.stylesPath,highlighted.stylesXml,{createFolders:false});
    return highlighted.sheetXml;
  }

  async function buildProductPriceOption(file,items){
    if(!global.XLSX)throw Error('XLSX 모듈을 불러오지 못했습니다.');
    const parts=await sheetParts(file,PRODUCT_SHEET),{zip,path,bytes}=parts;let {xml}=parts;
    const book=global.XLSX.read(bytes,{type:'array',raw:true}),sheet=book.Sheets[PRODUCT_SHEET];if(!sheet)throw Error(`${PRODUCT_SHEET} 시트를 찾지 못했습니다.`);
    const byRow=new Map();for(const item of items||[]){if(!byRow.has(item.source_row_no))byRow.set(item.source_row_no,[]);byRow.get(item.source_row_no).push(item);}
    const changes=[];
    for(const [rowNo,rowItems] of byRow){
      const baseTargets=[...new Set(rowItems.filter(item=>finite(item.target_base_price)).map(item=>Number(item.target_base_price)))];
      if(baseTargets.length>1)throw Error(`${rowNo}행 상품 판매가 목표값이 옵션마다 다릅니다.`);
      if(baseTargets.length===1){xml=global.AblyStockExport.patchCell(xml,rowNo,PRODUCT_BASE_PRICE_COLUMN,baseTargets[0]);changes.push(`${PRODUCT_BASE_PRICE_COLUMN}${rowNo}`);}
      const ref=`${PRODUCT_OPTION_PRICE_COLUMN}${rowNo}`,current=splitLines(sheet[ref]?.v??'');
      let changed=false;for(const item of rowItems){if(!finite(item.target_option_price))continue;while(current.length<=item.option_index)current.push('');current[item.option_index]=String(Number(item.target_option_price));changes.push({reference:ref,lineIndex:item.option_index});changed=true;}
      if(changed)xml=global.AblyStockExport.patchCell(xml,rowNo,PRODUCT_OPTION_PRICE_COLUMN,current.join('\n'));
    }
    if(changes.length)xml=highlightChanges(parts,xml,changes);
    const warnings=(items||[]).filter(item=>item._status&&item._status!=='ready').flatMap(item=>[`${PRODUCT_BASE_PRICE_COLUMN}${item.source_row_no}`,`${PRODUCT_OPTION_PRICE_COLUMN}${item.source_row_no}`]);
    if(warnings.length)xml=highlightChanges(parts,xml,warnings,{fillColor:'FFFFC7CE',preserveText:true});
    zip.file(path,xml,{createFolders:false});return zip.generateAsync({type:'blob',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',compression:'DEFLATE'});
  }

  async function buildOptionPriceStock(file,items){
    const parts=await sheetParts(file,OPTION_SHEET);let xml=parts.xml;
    const changes=[];
    for(const item of items||[]){
      if(finite(item.target_option_price)){xml=global.AblyStockExport.patchCell(xml,item.source_row_no,OPTION_PRICE_COLUMN,Number(item.target_option_price));changes.push(`${OPTION_PRICE_COLUMN}${item.source_row_no}`);}
      // 운영 계약: X(*판매수량)가 실재고 write 대상이고 W(판매가능재고)는 보존한다.
      if(finite(item.target_stock)){xml=global.AblyStockExport.patchCell(xml,item.source_row_no,OPTION_STOCK_COLUMN,Number(item.target_stock));changes.push(`${OPTION_STOCK_COLUMN}${item.source_row_no}`);}
    }
    if(changes.length)xml=highlightChanges(parts,xml,changes);
    const warnings=(items||[]).filter(item=>item._status&&item._status!=='ready').flatMap(item=>[`${OPTION_PRICE_COLUMN}${item.source_row_no}`,`${OPTION_STOCK_COLUMN}${item.source_row_no}`]);
    if(warnings.length)xml=highlightChanges(parts,xml,warnings,{fillColor:'FFFFC7CE',preserveText:true});
    parts.zip.file(parts.path,xml,{createFolders:false});return parts.zip.generateAsync({type:'blob',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',compression:'DEFLATE'});
  }

  global.AblyPlayautoExport={
    PRODUCT_SHEET,OPTION_SHEET,PRODUCT_REQUIRED,OPTION_REQUIRED,
    PRODUCT_BASE_PRICE_COLUMN,PRODUCT_OPTION_PRICE_COLUMN,OPTION_PRICE_COLUMN,OPTION_STOCK_COLUMN,OPTION_SALES_QUANTITY_COLUMN,
    detect,productOptionLines,parseProductRows,parseOptionRows,resolveSellpiaSku,resolveRows,prepareStockOnlyRow,isNoBallAnchor,prepareSellpiaSourceProductRows,readTemplate,
    buildProductPriceOption,buildOptionPriceStock,sellerProductCode,stripSellpiaPrefix,normalize
  };
})(typeof window==='undefined'?globalThis:window);
