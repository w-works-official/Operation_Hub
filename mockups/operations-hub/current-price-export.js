(function(g){
 'use strict';
 const sources=['smartstore','makeshop','ably'];
 const price=item=>item.field_key==='sellpia_sale_price';
 const group=item=>JSON.stringify([item.source_channel,item.seller_product_code]);
 function finite(value){return value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value));}
 function validSourceLocation(row){return Boolean(String(row?.source_file_name||'').trim())&&row?.source_row_no!==null&&row?.source_row_no!==undefined&&row?.source_row_no!==''&&Number.isInteger(Number(row.source_row_no))&&Number(row.source_row_no)>0;}
function normalizedTerms(value,fallback=[]){return Array.isArray(value)?value:Array.isArray(fallback)?fallback:[];}
function termsKey(terms){return JSON.stringify((terms||[]).map(({title,input_source,term_type,...term})=>Object.fromEntries(Object.entries(term).sort(([a],[b])=>a.localeCompare(b)))).sort((a,b)=>String(a.term_key||'').localeCompare(String(b.term_key||''))));}
function decisionIdentity(row){return JSON.stringify([String(row?.source_channel||'').trim(),String(row?.sku||row?.sellpia_sku_code||'').trim(),String(row?.seller_product_code||'').trim(),String(row?.seller_option_code??'').trim()]);}
function decisionTuple(decision){
 const price=decision?.price;
 if(!price||!['base','discounted','option','final'].every(key=>price[key]!==null&&price[key]!==undefined&&price[key]!==''&&Number.isSafeInteger(Number(price[key]))))throw Error(`현재 가격 결정 tuple이 불완전합니다: ${decision?.sku||'SKU 미상'}`);
 const tuple={base:Number(price.base),discounted:Number(price.discounted),option:Number(price.option),final:Number(price.final),terms:normalizedTerms(price.terms)};
 if(tuple.base<0||tuple.discounted<0||tuple.final<=0||tuple.discounted+tuple.option!==tuple.final)throw Error(`현재 가격 결정 tuple이 일치하지 않습니다: ${decision?.sku||'SKU 미상'}`);
 return tuple;
}
function normalizeCurrentPriceDecisions(response,{source,skus=[]}={}){
 const requested=[...new Set((skus||[]).map(value=>String(value||'').trim()).filter(Boolean))].sort(),allowed=new Set(requested),rows=Array.isArray(response?.rows)?response.rows:[];
 if((response?.groups||[]).some(group=>group.mapping_valid===false))throw Error('현재 가격 결정 판매처 연결이 변경되었습니다. 가격 미리보기를 다시 확인해주세요.');
 const byIdentity=new Map(),rowsBySku=new Map();
 for(const row of rows){
  const sku=String(row?.sku||row?.sellpia_sku_code||'').trim();
  if(!sku||!allowed.has(sku)||row.source_channel!==source||row.mapping_valid===false)throw Error(`현재 가격 결정 identity 오류 또는 판매처 연결 변경: ${sku||'SKU 미상'}`);
  const sellerProduct=String(row.seller_product_code||'').trim(),sellerOption=String(row.seller_option_code??'').trim();
  if(!sellerProduct||row.event_id===null||row.event_id===undefined||row.event_id===''||!Number.isSafeInteger(Number(row.revision))||Number(row.revision)<1)throw Error(`현재 가격 결정 증거가 불완전합니다: ${sku}`);
  const tuple=decisionTuple(row);
  const normalized={...row,sku,seller_product_code:sellerProduct,seller_option_code:sellerOption,revision:Number(row.revision),price:tuple},key=decisionIdentity(normalized),previous=byIdentity.get(key);
  if(previous){
   if(JSON.stringify(previous)!==JSON.stringify(normalized))throw Error(`현재 가격 결정 identity가 중복되고 값이 다릅니다: ${sku}`);
   continue;
  }
  byIdentity.set(key,normalized);if(!rowsBySku.has(sku))rowsBySku.set(sku,[]);rowsBySku.get(sku).push(normalized);
 }
 const bySku=new Map([...rowsBySku].filter(([,skuRows])=>skuRows.length===1).map(([sku,skuRows])=>[sku,skuRows[0]]));
 return {source,skus:requested,bySku,byIdentity,rowsBySku,groups:Array.isArray(response?.groups)?response.groups:[]};
}
function decisionForMapping(decisions,mapping,{source=decisions?.source}={}){
 const sku=String(mapping?.sku||mapping?.sellpia_sku_code||'').trim(),product=String(mapping?.seller_product_code||mapping?.product_code||'').trim(),option=String(mapping?.seller_option_code??mapping?.option_code??'').trim();
 if(!sku||!product)return null;
 return decisions?.byIdentity?.get(decisionIdentity({source_channel:source,sku,seller_product_code:product,seller_option_code:option}))||null;
}
function currentPriceDecisionProof(decisions){
 const rows=[...(decisions?.byIdentity?.values?.()||[])].map(row=>({sku:row.sku,event_id:String(row.event_id),revision:Number(row.revision),decision_source:String(row.decision_source||''),effective_at:String(row.effective_at||''),identity:[row.source_channel,row.seller_product_code,row.seller_option_code],price:row.price}));
 const seen=new Set(rows.map(row=>decisionIdentity({source_channel:decisions?.source,sku:row.sku,seller_product_code:row.identity?.[1],seller_option_code:row.identity?.[2]})));
 for(const group of decisions?.groups||[])for(const target of group.targets||[]){
  const targetSkus=[...new Set([...(target.member_skus||[]),target.sku].map(value=>String(value||'').trim()).filter(value=>(decisions?.skus||[]).includes(value)))];
  for(const sku of targetSkus){const identity=decisionIdentity({source_channel:group.source_channel||decisions?.source,sku,seller_product_code:target.seller_product_code||group.seller_product_code,seller_option_code:target.seller_option_code??''});if(seen.has(identity))continue;seen.add(identity);rows.push({sku,event_id:null,revision:null,decision_source:null,effective_at:null,identity:[group.source_channel||decisions?.source,target.seller_product_code||group.seller_product_code,String(target.seller_option_code??'')],price:null});}
 }
 for(const sku of decisions?.skus||[])if(!rows.some(row=>row.sku===sku))rows.push({sku,event_id:null,revision:null,decision_source:null,effective_at:null,identity:null,price:null});
 rows.sort((a,b)=>JSON.stringify([a.sku,a.identity||[]]).localeCompare(JSON.stringify([b.sku,b.identity||[]])));
 const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
 const groups=(decisions?.groups||[]).map(group=>({source_channel:group.source_channel||decisions?.source||'',seller_product_code:String(group.seller_product_code||''),revision:group.revision??null,mapping_fingerprint:group.mapping_fingerprint||'',input_fingerprints:canonical(group.input_fingerprints||{}),snapshot_id:group.snapshot_id||'',targets:(group.targets||[]).map(target=>({sku:String(target.sku||''),seller_product_code:String(target.seller_product_code||''),seller_option_code:String(target.seller_option_code??''),price:target.price||null,source_row_no:target.source_row_no??null})).sort((a,b)=>JSON.stringify([a.sku,a.seller_product_code,a.seller_option_code]).localeCompare(JSON.stringify([b.sku,b.seller_product_code,b.seller_option_code])))})).sort((a,b)=>JSON.stringify([a.source_channel,a.seller_product_code]).localeCompare(JSON.stringify([b.source_channel,b.seller_product_code])));
 return JSON.stringify({source:decisions?.source||'',rows,groups});
}
function assertCurrentPriceDecisionProof(expected,actual){
 if(!expected||expected!==actual)throw Error('미리보기 후 현재 가격 결정이 추가되거나 변경되었습니다. 가격 미리보기를 다시 확인해주세요.');
}
function validateCurrentPriceDecisionGroups(decisions){
 const groups=new Map(),sourceGroups=new Map((decisions?.groups||[]).map(group=>[JSON.stringify([group.source_channel||decisions?.source||'',String(group.seller_product_code||'')]),group]));
 for(const group of decisions?.groups||[])for(const target of group.targets||[]){
  const targetSkus=[...new Set([...(target.member_skus||[]),target.sku].map(value=>String(value||'').trim()).filter(value=>(decisions?.skus||[]).includes(value)))],state=target.current_state;
  for(const sku of targetSkus){
   const identity=decisionIdentity({source_channel:group.source_channel||decisions?.source,sku,seller_product_code:target.seller_product_code||group.seller_product_code,seller_option_code:target.seller_option_code??''}),decision=decisions?.byIdentity?.get(identity);
   if(state&&(!decision||String(decision.event_id)!==String(state.event_id)||Number(decision.revision)!==Number(state.revision)))throw Error(`${sku}: 현재 가격 결정 row와 상품 그룹의 현재 상태가 일치하지 않습니다.`);
   if(!state&&decision)throw Error(`${sku}: 현재 가격 그룹 상태에 없는 가격 결정 row가 있습니다.`);
  }
 }
 for(const [identity,row] of decisions?.byIdentity||[]){
  const sku=row.sku;
  const key=String(row.seller_product_code||''),tuple=decisionTuple(row),current=groups.get(key);
  if(current&&(current.base!==tuple.base||current.discounted!==tuple.discounted||termsKey(current.terms)!==termsKey(tuple.terms)))throw Error(`${key}: 같은 판매처 상품의 현재 가격 결정이 공통 등록가·할인조건과 일치하지 않습니다.`);
  if(!current)groups.set(key,tuple);
  const sourceGroup=sourceGroups.get(JSON.stringify([row.source_channel,key]));
  if(sourceGroup&&Array.isArray(sourceGroup.targets)){
   const matches=sourceGroup.targets.filter(target=>[...(target.member_skus||[]),target.sku].map(value=>String(value||'').trim()).includes(sku)&&String(target.seller_product_code||sourceGroup.seller_product_code||'').trim()===key&&String(target.seller_option_code??'').trim()===String(row.seller_option_code??'').trim());
   if(matches.length!==1)throw Error(`${sku}: 현재 가격 결정이 같은 상품 그룹의 고유 대상과 일치하지 않습니다.`);
   const targetPrice=decisionTuple({sku,price:matches[0].current_state?.price||matches[0].price});
   if(targetPrice.base!==tuple.base||targetPrice.discounted!==tuple.discounted||targetPrice.option!==tuple.option||targetPrice.final!==tuple.final||termsKey(targetPrice.terms)!==termsKey(tuple.terms))throw Error(`${sku}: 현재 가격 결정 tuple과 상품 그룹 target이 다릅니다.`);
  }
 }
 for(const [product,tuple] of groups){
  const group=sourceGroups.get(JSON.stringify([decisions?.source||'',product]));
  if(!Array.isArray(group?.targets))continue;
  for(const target of group.targets){
   if(String(target.seller_product_code||'').trim()!==product)throw Error(`${product}: 상품 그룹 target identity가 불일치합니다.`);
   const targetPrice=decisionTuple({sku:target.sku||product,price:target.current_state?.price||target.price});
   if(targetPrice.base!==tuple.base||targetPrice.discounted!==tuple.discounted||termsKey(targetPrice.terms)!==termsKey(tuple.terms))throw Error(`${product}: 현재 가격 결정과 다른 옵션의 공통 등록가·할인조건이 충돌합니다.`);
  }
 }
 return groups;
}
function attachCurrentPriceDecisions(mappingRows,decisions,{source}={}){
 const bySellerIdentity=new Map();
 for(const mapping of mappingRows||[]){
  const sku=String(mapping?.sku||mapping?.sellpia_sku_code||'').trim();if(!sku)continue;
  const product=String(mapping.seller_product_code||mapping.product_code||'').trim(),option=String(mapping.seller_option_code??mapping.option_code??'').trim(),sellerIdentity=JSON.stringify([source,product,option]);
  if(!bySellerIdentity.has(sellerIdentity))bySellerIdentity.set(sellerIdentity,[]);
  bySellerIdentity.get(sellerIdentity).push(sku);
 }
 validateCurrentPriceDecisionGroups(decisions);
 for(const decision of decisions?.byIdentity?.values?.()||[]){
  const sellerIdentity=JSON.stringify([source,decision.seller_product_code,decision.seller_option_code]);
  const mapped=bySellerIdentity.get(sellerIdentity)||[];
  if(mapped.length>1||mapped.length===1&&mapped[0]!==decision.sku)throw Error(`현재 가격 결정 매핑 identity가 여러 SKU 또는 중복 행에 연결됩니다: ${decision.sku}`);
 }
 return decisions?.byIdentity||new Map();
}
 function historicalPriceDiagnostic(row){
  const statuses=[row?.registration_status,row?.discount_status,row?.option_status,row?.final_status];
  const errors=[row?.registration_error,row?.discount_error,row?.option_error,row?.final_error].filter(value=>String(value||'').trim());
  const generations=[row?.registration_generation_id,row?.discount_generation_id,row?.option_generation_id,row?.final_generation_id].filter(value=>value!==null&&value!==undefined&&value!=='');
  if(!statuses.some(Boolean)&&!errors.length&&!generations.length)return null;
  return {statuses,errors,generations};
 }
function matrixPriceTarget(row){
  if(row?.current_price_decision){
   const tuple=decisionTuple(row.current_price_decision);
   return {...tuple,origin:'current_decision',event_id:row.current_price_decision.event_id,revision:row.current_price_decision.revision,decision_source:row.current_price_decision.decision_source,effective_at:row.current_price_decision.effective_at,ruleVersions:[]};
  }
  const draft=row.price_draft;
  const current=row.current_effective_price;
  const currentError=String(row.current_effective_error||current?.error||'').trim();
  const draftValues=[draft?.price_base_after,draft?.price_discounted_base_after,draft?.price_option_after,draft?.price_final_after??draft?.after_value];
  const hasCompleteDraft=Boolean(draft)&&draftValues.every(finite);
  if(!hasCompleteDraft&&row.active_price_rule!==true)return null;
  if(!hasCompleteDraft&&currentError)return {invalid:true,origin:'calculated',reason:currentError};
  const calculatedPrice=current&&!currentError?{
    platformBase:current.platformBase,
    platformDiscount:current.platformDiscount,
    platformOption:current.platformOption,
    platformFinal:current.platformFinal,
    platformTerms:normalizedTerms(current.platformTerms),
    error:null
  }:null;
  if(!hasCompleteDraft&&!calculatedPrice)return {invalid:true,origin:'calculated',reason:'현재 가격 target을 산출하지 못했습니다.'};
  const visible=g.SystemV3DiscountPriceMath.matrixVisibleValues({
    sourceBasePrice:row.source_base_price,
    sourceDiscountedBasePrice:row.source_discounted_base_price,
    sourceOptionPrice:row.source_option_price??0,
    sourceFinalPrice:row.source_final_price,
    sourceDiscountTerms:normalizedTerms(row.source_discount_terms),
    priceDraft:draft,
    draftBasePrice:draft?.price_base_after??null,
    draftDiscountedBasePrice:draft?.price_discounted_base_after??null,
    draftOptionPrice:draft?.price_option_after??null,
    draftFinalPrice:draft?.price_final_after??draft?.after_value??null,
    draftDiscountTerms:draft?.price_discount_terms_after??null,
    calculatedPrice
  });
  if(!visible.priceVisible||visible.priceOrigin==='source')return null;
  const values=[visible.effectiveBasePrice,visible.effectiveDiscountedBasePrice,visible.effectiveOptionPrice,visible.effectiveFinalPrice];
  if(!values.every(finite))return {invalid:true,origin:visible.priceOrigin,reason:'화면에 표시된 가격 구성값이 완전하지 않습니다.'};
  return {base:Number(values[0]),discounted:Number(values[1]),option:Number(values[2]),final:Number(values[3]),terms:normalizedTerms(visible.effectiveDiscountTerms),origin:visible.priceOrigin,ruleVersions:visible.priceOrigin==='calculated'&&Array.isArray(current?.versions)?current.versions:[]};
 }
function carrierPriceState(row,latestGeneration=null){
  const diagnostic=historicalPriceDiagnostic(row),target=matrixPriceTarget(row||{});
  if(!target)return {code:'original_fallback',label:'가격 지시 없음 · 판매처 원본 유지',detail:'수동 수정안과 현재 유효한 가격 Rule이 없어 판매처 원본을 유지합니다.',safe:true,usesOriginal:true,diagnostic};
  if(target.invalid)return {code:'timeout_error',label:'현재 가격 target 산출 실패 · 원본 유지',detail:target.reason,safe:false,usesOriginal:true,diagnostic};
  if(target.origin==='current_decision'){
   const sources={matrix_manual:'Matrix 수동 가격',pricing_rule:'가격태그 / Rule 적용',sellpia_apply:'Sellpia 가격 적용',rollback:'이전 가격 복원'};
   return {code:'current_price_decision',label:`${sources[target.decision_source]||target.decision_source||'현재 가격 결정'} · 현재 적용값`,detail:`event ${target.event_id} · revision ${target.revision} · ${new Date(target.effective_at).toLocaleString('ko-KR')}`,safe:true,usesOriginal:false,diagnostic};
  }
  return {code:'calculated_complete',label:target.origin==='draft'?'정상 표시값 · 현재 수정안':'현재 가격 target 계산 완료',detail:target.origin==='draft'?'완전한 가격 수정안(draft)을 우선 사용합니다.':'현재 Rule과 입력값으로 완전한 가격 tuple을 산출했습니다.',safe:true,usesOriginal:false,diagnostic};
  }
  function planVersionToken({source,fileName,snapshotId,preview,operations,stockSource=null,includeStock=true,includePrice=true,currentPriceDecisionProof=''}){
   const compact={source,fileName,snapshotId:snapshotId||null,stockSource,includeStock:Boolean(includeStock),includePrice:Boolean(includePrice),currentPriceDecisionProof:currentPriceDecisionProof||'',preview:(preview||[]).map(row=>({
    row:row.source_row_no,sku:row.sku||'',product:row.product_code||'',option:row.option_code||'',status:row.status,
    changed:row.changed_fields||[],priceState:row.price_state?.code||'',reason:row.reason||'',diff:row.diff||null,
    currentPriceDecision:row.current_price_decision_proof||null
   })),operations:(operations||[]).map(item=>({
    sku:item.sellpia_sku_code||'',field:item.field_key,row:item.source_row_no,before:item.before_value,after:item.after_value,
    base:item.target_base_price,discounted:item.target_discounted_base_price,option:item.target_option_price,final:item.target_final_price,
    terms:item.target_discount_terms||[],currentPriceDecision:item.current_price_decision_proof||null
   }))};
   const text=JSON.stringify(compact);let first=2166136261,second=2246822519;
   for(let index=0;index<text.length;index++){const code=text.charCodeAt(index);first=Math.imul(first^code,16777619);second=Math.imul(second^code,3266489917);}
   return `${(first>>>0).toString(16).padStart(8,'0')}${(second>>>0).toString(16).padStart(8,'0')}`;
  }
 function summarizeSourcePricePreview(plans=[]){
  const rows=(plans||[]).flatMap(plan=>Array.isArray(plan?.preview)?plan.preview:[]);
  const changed=rows.filter(row=>row?.status==='ready'&&row.changed===true).length;
  const noChange=rows.filter(row=>row?.status==='ready'&&row.changed!==true).length;
  const blocked=rows.filter(row=>row?.status==='blocked').length;
  const unclassified=rows.length-changed-noChange-blocked;
  return {total:rows.length,changed,noChange,blocked,unclassified,complete:unclassified===0};
 }
 function prepareCarrierItems(source,fileName,carrierRows,snapshotRows,{snapshotId=null,includeStock=true,includePrice=true,stockSource=null}={}){
  const identity=row=>JSON.stringify([String(row?.product_code||'').trim(),String(row?.option_code||'').trim()]);
  const snapshotGenerations=(snapshotRows||[]).flatMap(row=>[row?.latest_generation_id,row?.latest_price_generation_id,row?.registration_generation_id,row?.discount_generation_id,row?.option_generation_id,row?.final_generation_id]).filter(finite).map(Number);
  const latestGeneration=snapshotGenerations.length?snapshotGenerations.reduce((latest,value)=>Math.max(latest,value),Number.NEGATIVE_INFINITY):null;
  const snapshotByIdentity=new Map();
  for(const row of snapshotRows||[]){const key=identity(row);if(!snapshotByIdentity.has(key))snapshotByIdentity.set(key,[]);snapshotByIdentity.get(key).push(row);}
  const carrierCounts=new Map();for(const row of carrierRows||[]){const key=identity(row);carrierCounts.set(key,(carrierCounts.get(key)||0)+1);}
  const items=[],excludedItems=[],preview=[];let nextId=-1;
  const exclude=(row,reason,details={})=>{const export_item_id=nextId--;const status=details.warning?'warn_keep_original':'blocked';const item={export_item_id,sellpia_sku_code:details.sku||'',source_channel:source,seller_product_code:row.product_code||'',seller_option_code:row.option_code||'',field_key:'carrier_row',source_file_name:row.raw_payload?.source_file_name||fileName,source_row_no:row.source_row_no};excludedItems.push({export_item_id,item,reason,status});const currentPrice={base:row.base_price,discounted:row.discounted_base_price,option:row.option_price,final:row.final_price};preview.push({source_row_no:row.source_row_no,sku:details.sku||'',product_code:row.product_code,option_code:row.option_code,status,disposition:details.warning?status:'blocker',changed:false,changed_fields:[],reason,price_state:details.priceState||carrierPriceState(null),diff:{stock:{before:row.stock,after:row.stock,changed:false},price:{before:currentPrice,after:currentPrice,changed:false}}});};
  for(const original of carrierRows||[]){
   if(!String(original.product_code||'').trim()||!Number.isInteger(Number(original.source_row_no))||Number(original.source_row_no)<=0){exclude(original,'원본 상품 identity/행 위치를 신뢰할 수 없어 생성 차단');continue;}
   const key=identity(original),matches=snapshotByIdentity.get(key)||[];
   if(carrierCounts.get(key)!==1){exclude(original,'공식 수정파일 안에 같은 판매처 상품·옵션 행이 중복됩니다.');continue;}
   if(matches.length!==1){exclude(original,matches.length?'판매처 상품·옵션이 여러 SKU에 연결되어 있어 자동으로 쓸 수 없습니다.':'SKU 연결 없음 → 원본 유지',{warning:matches.length===0});continue;}
   const row={...matches[0],source_file_name:original.raw_payload?.source_file_name||fileName,source_row_no:Number(original.source_row_no),source_stock:original.stock,
    source_base_price:original.base_price,source_discounted_base_price:original.discounted_base_price,
    source_option_price:original.option_price,source_final_price:original.final_price,source_discount_terms:original.discount_terms||[]};
   const changedFields=[],rowItems=[];let priceState=includePrice?carrierPriceState(row):{code:'not_selected',label:'가격 미선택 · 판매처 원본 유지',detail:'재고-only 내보내기에서는 가격 필드를 계산하거나 수정하지 않습니다.',safe:true,usesOriginal:true};
   const stockTarget=includeStock?matrixStockTarget(matches[0],stockSource):null;
   if(includeStock&&original.stock!==null&&original.stock!==undefined&&original.stock!==''&&stockTarget===null){exclude(original,'재고 target 없음 → 이 행 원본 유지',{warning:true,sku:row.sku,priceState});continue;}
   if(includeStock&&original.stock!==null&&original.stock!==undefined&&original.stock!==''&&stockTarget!==null&&Number(original.stock)!==stockTarget){
    rowItems.push({export_item_id:nextId--,sellpia_sku_code:row.sku,source_channel:source,field_key:'sellpia_current_stock',seller_product_code:row.product_code,seller_option_code:row.option_code||'',source_file_name:row.source_file_name,source_row_no:Number(original.source_row_no),expected_source_value:original.stock,before_value:original.stock,after_value:stockTarget,matrix_visible_stock:true,target_component_skus:[row.sku]});changedFields.push('stock');
   }
   const target=includePrice&&priceState.safe?matrixPriceTarget(row):null;
   const currentPriceDecisionProof=row.current_price_decision?{event_id:String(row.current_price_decision.event_id),revision:Number(row.current_price_decision.revision),decision_source:String(row.current_price_decision.decision_source||''),effective_at:String(row.current_price_decision.effective_at||''),price:decisionTuple(row.current_price_decision)}:null;
   const currentPrice={base:original.base_price,discounted:original.discounted_base_price,option:original.option_price,final:original.final_price};
   const candidatePrice=target&&!target.invalid?{base:target.base,discounted:target.discounted,option:target.option,final:target.final}:currentPrice;
   const targetPrice=priceState.safe?candidatePrice:currentPrice;
   const rawStockSource=stockSource==='stock'?matches[0]?.sellpia_current_stock:stockSource==='available_stock'?matches[0]?.sellpia_available_stock:null;
   const diff={stock:{before:original.stock,after:stockTarget??original.stock,source:stockSource,source_raw:rawStockSource,clamped_to_zero:stockSource==='available_stock'&&Number(rawStockSource)<0,changed:changedFields.includes('stock')},price:{before:currentPrice,after:targetPrice,changed:false}};
   let priceWarningReason='';
   if(includePrice&&!priceState.safe)priceWarningReason=`${priceState.label} · 가격만 원본 유지`;
   else if(target?.invalid){priceState={code:'original_fallback',label:'가격 계산 미완료/오류 · 원본 유지',detail:target.reason,safe:false,usesOriginal:true};priceWarningReason=`${target.reason} · 가격만 원본 유지`;}
   else if(target){
    const current=[original.base_price,original.discounted_base_price,original.option_price,original.final_price];
    if(current.every(finite)){
     const changed=current.some((value,index)=>Number(value)!==[target.base,target.discounted,target.option,target.final][index])||termsKey(target.terms)!==termsKey(original.discount_terms||[]);
     if(changed){
      diff.price.candidate_after=candidatePrice;diff.price.candidate_changed=true;
      if(priceState.safe){rowItems.push({export_item_id:nextId--,sellpia_sku_code:row.sku,source_channel:source,field_key:'sellpia_sale_price',seller_product_code:row.product_code,seller_option_code:row.option_code||'',source_file_name:row.source_file_name,source_row_no:Number(original.source_row_no),expected_source_value:original.final_price,before_value:original.final_price,after_value:target.final,base_price:original.base_price,option_price:original.option_price,target_base_price:target.base,target_discounted_base_price:target.discounted,target_option_price:target.option,target_final_price:target.final,source_discount_terms:original.discount_terms||[],target_discount_terms:target.terms,stored_matrix_price:true,matrix_visible_price:true,rule_versions:target.ruleVersions,...(currentPriceDecisionProof?{current_price_decision_proof:currentPriceDecisionProof}:{}),target_component_skus:[row.sku]});changedFields.push('price');diff.price.changed=true;}
     }
     }else{priceState={code:'original_fallback',label:'가격 계산 미완료/오류 · 원본 유지',detail:'공식 수정파일의 현재 가격 구성값이 완전하지 않습니다.',safe:false,usesOriginal:true};priceWarningReason='공식 수정파일의 현재 가격 구성값이 완전하지 않아 가격만 원본 유지합니다.';}
   }
   items.push(...rowItems);
   if(priceWarningReason){
    const export_item_id=nextId--;excludedItems.push({export_item_id,status:'warn_keep_original',reason:priceWarningReason,item:{export_item_id,source_channel:source,sellpia_sku_code:row.sku,seller_product_code:row.product_code,seller_option_code:row.option_code||'',field_key:'sellpia_sale_price',source_file_name:row.source_file_name,source_row_no:Number(original.source_row_no)}});
    preview.push({source_row_no:original.source_row_no,sku:row.sku,product_code:row.product_code,option_code:row.option_code,status:'warn_keep_original',disposition:changedFields.length?'change_with_price_warning':'warn_keep_original',changed:changedFields.length>0,changed_fields:changedFields,warning_field:'price',reason:priceWarningReason,price_state:priceState,diff});
   }else preview.push({source_row_no:original.source_row_no,sku:row.sku,product_code:row.product_code,option_code:row.option_code,status:'ready',disposition:changedFields.length?'change':'unchanged',changed:changedFields.length>0,changed_fields:changedFields,price_state:priceState,current_price_decision_proof:currentPriceDecisionProof,diff});
  }
  // A product's base/discount is shared across options. If one sibling must keep its original
  // price, freeze only the shared price/discount operations. Independent stock changes stay eligible.
  const warningProducts=new Set(preview.filter(row=>row.status==='warn_keep_original').map(row=>String(row.product_code||'')));
  const sharedPriceReason='같은 상품의 일부 옵션이 원본 유지 대상이라 공유 판매가/할인은 원본 유지합니다. 재고 등 독립 필드는 안전한 경우 반영합니다.';
  for(const row of preview){
   if(row.status!=='ready'||!warningProducts.has(String(row.product_code||'')))continue;
   const hadPriceCandidate=Boolean(row.diff?.price?.changed||row.diff?.price?.candidate_changed||row.changed_fields?.includes('price'));
   if(!hadPriceCandidate)continue;
   row.shared_price_warning=true;row.shared_price_reason=sharedPriceReason;
   row.changed_fields=(row.changed_fields||[]).filter(field=>field!=='price');
   row.diff.price.after=row.diff.price.before;row.diff.price.changed=false;delete row.diff.price.candidate_changed;delete row.diff.price.candidate_after;
   row.changed=Boolean(row.diff?.stock?.changed||row.changed_fields.length);
   row.disposition=row.changed?'change_with_price_warning':'warn_keep_original';
   row.reason=sharedPriceReason;
   const export_item_id=nextId--;excludedItems.push({export_item_id,status:'warn_keep_original',reason:sharedPriceReason,item:{export_item_id,source_channel:source,sellpia_sku_code:row.sku,seller_product_code:row.product_code,seller_option_code:row.option_code,field_key:'sellpia_sale_price',source_file_name:row.source_file_name||fileName,source_row_no:row.source_row_no}});
  }
  for(let index=items.length-1;index>=0;index--){
   if(items[index].field_key==='sellpia_sale_price'&&warningProducts.has(String(items[index].seller_product_code||'')))items.splice(index,1);
  }
  const priceStates={calculated_complete:0,latest_generation_unreflected:0,timeout_error:0,original_fallback:0};
  for(const row of preview){const code=row.price_state?.code||'original_fallback';priceStates[code]=(priceStates[code]||0)+1;}
  const summary={total:preview.length,matched:preview.filter(row=>row.sku).length,changed:preview.filter(row=>row.diff?.stock?.changed||row.diff?.price?.changed).length,candidate_changed:preview.filter(row=>row.diff?.stock?.changed||row.diff?.price?.candidate_changed).length,unchanged:preview.filter(row=>row.status==='ready'&&!row.changed&&!row.shared_price_warning).length,warned:preview.filter(row=>row.status==='warn_keep_original'||row.shared_price_warning).length,warning_products:new Set(preview.filter(row=>row.status==='warn_keep_original'||row.shared_price_warning).map(row=>String(row.product_code||''))).size,shared_price_warned:preview.filter(row=>row.shared_price_warning).length,blocked:preview.filter(row=>row.status==='blocked').length,price_states:priceStates};
   const priceSafe=!includePrice||preview.length>0&&preview.every(row=>row.price_state?.safe===true);
   const canGenerate=preview.length>0&&summary.blocked===0;
   const versionToken=planVersionToken({source,fileName,snapshotId,preview,operations:items,stockSource,includeStock,includePrice});
    return {kind:'TransformationPlan',version:4,source,source_type:'carrier',file_name:fileName,created_at:new Date().toISOString(),snapshot_id:snapshotId,latest_generation_id:latestGeneration,preview_only:false,xlsx_connected:true,include_stock:Boolean(includeStock),include_price:Boolean(includePrice),stock_source:stockSource,items,operations:items,excludedItems,preview,summary,version_token:versionToken,canGenerate,safety:{can_generate_xlsx:canGenerate,price_complete:priceSafe,requires_revalidation:true,reason:canGenerate?`원본 유지 경고 ${summary.warned}건은 해당 가격 필드만 보존하고, 재고 등 안전한 독립 변경은 반영합니다. 생성 직전에 같은 대상을 재검증합니다.`:'identity/구조 관련 치명적 차단이 있어 파일을 생성할 수 없습니다.'}};
 }

 async function refreshItems(items,filesBySource,{sources:selected=sources,skus=null,includeRules=true,includeMatrixStock=false,onProgress}={}){
  const selectedSources=[...new Set(selected.filter(source=>sources.includes(source)))],requested=skus===null?null:[...new Set(skus)];
  const hasScopedPriceItems=(items||[]).some(item=>price(item)&&selectedSources.includes(item.source_channel)&&(!requested||requested.includes(item.sellpia_sku_code)));
  if(!includeRules&&!includeMatrixStock&&!hasScopedPriceItems)return {items:[...items],excludedItems:[],currentPriceDecisionRequests:[]};
  if(!selectedSources.length||requested&& !requested.length)return {items:[...items],excludedItems:[],currentPriceDecisionRequests:[]};
  if(!g.SystemV3Data?.loadCarrierSellerMappings||!g.SystemV3Data?.loadCarrierMatrixTargets)throw Error('현재 가격 projection 조회 모듈을 불러오지 못했습니다.');
  const scope=new Set(selectedSources),requestedSet=requested&&new Set(requested),inScope=item=>scope.has(item.source_channel)&&(!requestedSet||requestedSet.has(item.sellpia_sku_code));
  let output=items.filter(item=>!price(item)||!inScope(item)),excludedItems=[],nextId=items.reduce((minimum,item)=>Math.min(minimum,Number(item.export_item_id)||0),0)-1,decisionProofs=[],currentPriceDecisionRequests=[];
  const key=row=>JSON.stringify([row.seller_product_code||row.product_code,row.seller_option_code??row.option_code??'']);
  for(const source of selectedSources){
   const files=filesBySource.get(source)||[];if(!files.length)throw Error(source+': 최신 보관 원본 파일이 없습니다.');
   onProgress?.(`${source} · 원본 identity와 현재 가격 target을 연결합니다.`);
   const parsed=await g.SystemV3SellerParsers.parseSellerFiles(source,files,{price:true,discount:true});
   const mapped=await g.SystemV3Data.loadCarrierSellerMappings({source,identities:parsed.normalizedRows});
   let mappingRows=mapped.rows||[];
   if(requestedSet)mappingRows=mappingRows.filter(row=>requestedSet.has(row.sku));
   const identities=new Set(mappingRows.map(key));
   const carrierRows=parsed.normalizedRows.filter(row=>identities.has(key(row)));
   const targetSkus=[...new Set(mappingRows.map(row=>row.sku).filter(Boolean))];
   if(!targetSkus.length)continue;
   const targets=(includeRules||includeMatrixStock)?await g.SystemV3Data.loadCarrierMatrixTargets({source,skus:targetSkus,onQuery:q=>onProgress?.(`${source} · ${q.query} · ${q.scope_count} SKU · ${q.latency_ms}ms`)}):{rows:[]};
   const queuePriceSkus=[...new Set(items.filter(item=>price(item)&&item.source_channel===source&&(!requestedSet||requestedSet.has(item.sellpia_sku_code))).map(item=>String(item.sellpia_sku_code||'').trim()).filter(Boolean))];
   const shouldReadDecisions=includeRules&&targetSkus.length>0||queuePriceSkus.length>0;
   if(shouldReadDecisions&&!g.SystemV3Data.loadCurrentPriceDecisions)throw Error('현재 가격 결정 조회 모듈을 불러오지 못했습니다.');
   const decisionSkus=shouldReadDecisions?(includeRules?targetSkus:targetSkus.filter(sku=>queuePriceSkus.includes(sku))):[];
   const decisionResponse=decisionSkus.length?await g.SystemV3Data.loadCurrentPriceDecisions({source,skus:decisionSkus}):{rows:[],groups:[]};
   const decisions=normalizeCurrentPriceDecisions(decisionResponse,{source,skus:decisionSkus});
   if(decisionSkus.length)attachCurrentPriceDecisions(mappingRows,decisions,{source});
   const decisionProof=currentPriceDecisionProof(decisions);decisionProofs.push(decisionProof);
   if(decisionSkus.length)currentPriceDecisionRequests.push({source,skus:decisionSkus,expectedProof:decisionProof});
   if(!includeRules&&!includeMatrixStock){
    for(const item of items.filter(entry=>price(entry)&&entry.source_channel===source&&(!requestedSet||requestedSet.has(entry.sellpia_sku_code)))){
     const decision=decisionForMapping(decisions,{sku:item.sellpia_sku_code,seller_product_code:item.seller_product_code,seller_option_code:item.seller_option_code},{source});
     if(!decision){output.push(item);continue;}
     const tuple=decisionTuple(decision),proof={event_id:String(decision.event_id),revision:Number(decision.revision),decision_source:String(decision.decision_source||''),effective_at:String(decision.effective_at||''),price:tuple};
     output.push({...item,after_value:tuple.final,target_base_price:tuple.base,target_discounted_base_price:tuple.discounted,
      target_option_price:tuple.option,target_final_price:tuple.final,target_discount_terms:tuple.terms,current_price_decision_proof:proof});
    }
    continue;
   }
   const targetBySku=new Map((targets.rows||[]).map(row=>[row.sku,row]));
   const snapshotRows=mappingRows.map(row=>({...targetBySku.get(row.sku),...row,current_price_decision:decisionForMapping(decisions,row,{source})}));
   const plan=prepareCarrierItems(source,files[0].name,carrierRows,snapshotRows,{snapshotId:null,includeStock:includeMatrixStock});
   let generated=plan.items.filter(item=>(includeRules&&price(item))||(includeMatrixStock&&!price(item))).map(item=>({...item,export_item_id:nextId--}));
   const remapExclusion=entry=>{const export_item_id=nextId--;return {...entry,export_item_id,item:{...entry.item,export_item_id}};};
   excludedItems.push(...plan.excludedItems.filter(entry=>includeRules||!price(entry.item)).map(remapExclusion));
   // Shared base/discount cells affect every option in the seller product. Keep
   // unselected siblings' final prices stable without evaluating their Rules.
   const mappedIdentities=new Set(generated.map(key)),targetsByProduct=new Map(generated.map(item=>[item.seller_product_code,item])),changedProducts=new Set(),unsafe=new Map();
   if(source!=='ably')for(const item of generated)if(Number(item.target_base_price)!==Number(item.base_price)||termsKey(item.source_discount_terms)!==termsKey(item.target_discount_terms))changedProducts.add(item.seller_product_code);
   const originals=new Map();for(const row of parsed.normalizedRows){const identity=key(row);if(!originals.has(identity))originals.set(identity,[]);originals.get(identity).push(row);}
   const productsWithOptions=new Set(parsed.normalizedRows.filter(row=>String(row.option_code||'').trim()).map(row=>row.product_code));
   for(const original of parsed.normalizedRows){
    const identity=key(original);if(!changedProducts.has(original.product_code)||mappedIdentities.has(identity))continue;
    if(source==='makeshop'&&!String(original.option_code||'').trim()&&productsWithOptions.has(original.product_code))continue;
    const target=targetsByProduct.get(original.product_code),raw=original.final_price??original.price,final=Number(raw),option=final-Number(target.target_discounted_base_price);
    if(raw===null||raw===undefined||raw===''||!Number.isSafeInteger(final)||final<0||!Number.isSafeInteger(option)||(originals.get(identity)||[]).length!==1){unsafe.set(original.product_code,'미선택 옵션의 원본 최종가 또는 원본 위치를 확인할 수 없습니다.');continue;}
    generated.push({...target,export_item_id:nextId--,sellpia_sku_code:null,target_component_skus:[],preserve_unmapped:true,seller_option_code:original.option_code||'',source_file_name:original.raw_payload?.source_file_name||files[0].name,source_row_no:original.source_row_no,expected_source_value:final,before_value:final,after_value:final,base_price:original.base_price,option_price:original.option_price,target_option_price:option,target_final_price:final,source_discount_terms:original.discount_terms||[]});mappedIdentities.add(identity);
   }
   if(unsafe.size){
    for(const [product,reason] of unsafe){
     const affected=generated.filter(item=>item.seller_product_code===product&&!item.preserve_unmapped);
     generated=generated.filter(item=>item.seller_product_code!==product);
     for(const item of affected)excludedItems.push(remapExclusion({status:'warn_keep_original',reason,item}));
    }
   }
   output.push(...generated);
  }
  // A SKU without a current explicit price instruction keeps the carrier original.
  return {items:output,excludedItems,currentPriceDecisionProof:JSON.stringify(decisionProofs),currentPriceDecisionRequests};
 }
 // Opt-in, price-only plan. The selected SKU uses the latest uploaded Sellpia
 // price; every other option in the same seller product keeps its carrier final.
 // The serializer remains the authority for workbook identity/cell validation.
function prepareSellpiaSourcePricePlan(source,fileName,carrierRows,mappingRows,sourcePrices,selectedSkus,externalBlockedProducts=new Map(),currentDecisions=new Map()){
  if(!['smartstore','makeshop'].includes(source))throw Error('셀피아 판매가 기준은 스마트스토어·메이크샵 원본만 지원합니다.');
  if(!g.SystemV3DiscountPriceMath?.grossBaseForTarget)throw Error('가격 역산 모듈이 없습니다.');
  const selected=new Set(selectedSkus||[]),identity=row=>JSON.stringify([String(row.product_code||'').trim(),String(row.option_code||'').trim()]);
  if(!selected.size)throw Error('셀피아 판매가 기준은 태그 또는 SKU로 대상 범위를 선택해야 합니다.');
  const originals=new Map(),mappings=new Map(),duplicateProducts=new Set();
  for(const row of carrierRows||[]){const key=identity(row);if(originals.has(key))duplicateProducts.add(String(row.product_code||''));else originals.set(key,row);}
  const blockedProducts=new Map(externalBlockedProducts),selectedProducts=new Set();
  for(const row of mappingRows||[]){
   const key=identity(row),sku=String(row.sku||'');
   if(!mappings.has(key))mappings.set(key,new Set());mappings.get(key).add(sku);
   if(selected.has(sku)){const original=originals.get(key);if(original)selectedProducts.add(String(original.product_code||''));}
  }
  const products=new Map();
  for(const row of carrierRows||[]){const key=identity(row),product=String(row.product_code||'');if(!selectedProducts.has(product))continue;const mapped=mappings.get(key)||new Set(),selectedMapped=[...mapped].filter(sku=>selected.has(sku));if(mapped.size>1)blockedProducts.set(product,`${product}/${row.option_code}: 판매처 옵션이 여러 SKU에 연결되어 있습니다.`);if(!products.has(product))products.set(product,[]);products.get(product).push({row,sku:selectedMapped[0]||null});}
  const operations=[],preview=[],excludedItems=[];let exportId=-1;
  for(const [product,siblings] of products){
   if(!siblings.some(sibling=>sibling.sku)&&!blockedProducts.has(product))continue;
   const block=reason=>{for(const {row,sku} of siblings){const item={export_item_id:exportId--,sellpia_sku_code:sku||'',source_channel:source,field_key:'sellpia_sale_price',seller_product_code:product,seller_option_code:row.option_code||'',source_file_name:row.raw_payload?.source_file_name||fileName,source_row_no:Number(row.source_row_no)};excludedItems.push({item,export_item_id:item.export_item_id,reason});preview.push({source_row_no:row.source_row_no,sku:sku||'',product_code:product,option_code:row.option_code||'',status:'blocked',reason,changed:false,preserve_unmapped:!sku,price_state:{code:'blocked',label:'상품 묶음 원본 유지',safe:false},diff:{price:{before:{base:row.base_price,discounted:row.discounted_base_price,option:row.option_price,final:row.final_price,discount_terms:row.discount_terms},after:{base:row.base_price,discounted:row.discounted_base_price,option:row.option_price,final:row.final_price,discount_terms:row.discount_terms},changed:false}}});}};
   if(duplicateProducts.has(product)){block(`${product}: 판매처 원본 상품·옵션 identity가 중복됩니다.`);continue;}
   if(blockedProducts.has(product)){block(blockedProducts.get(product));continue;}
   const operationsStart=operations.length,previewStart=preview.length;
   try{
   const first=siblings[0].row,terms=first.discount_terms;
   if(!Array.isArray(terms)||!finite(first.base_price)||!finite(first.discounted_base_price))throw Error(`${product}: 판매처 원본 등록가·할인을 읽지 못했습니다.`);
   const sharedBase=Number(first.base_price),sharedDiscounted=Number(first.discounted_base_price),sharedTerms=termsKey(terms);
   if(!Number.isSafeInteger(sharedBase)||!Number.isSafeInteger(sharedDiscounted)||g.SystemV3DiscountPriceMath.discountedBase(sharedBase,terms)!==sharedDiscounted)throw Error(`${product}: 판매처 원본 할인조건과 할인 후 가격이 일치하지 않습니다.`);
   const desired=[];
   for(const {row,sku} of siblings){
    if(!validSourceLocation({...row,source_file_name:row.raw_payload?.source_file_name||fileName}))throw Error(`${product}: 판매처 원본 행 위치를 확인할 수 없습니다.`);
    if(!Array.isArray(row.discount_terms)||termsKey(row.discount_terms)!==sharedTerms||Number(row.base_price)!==sharedBase||Number(row.discounted_base_price)!==sharedDiscounted)throw Error(`${product}: 같은 상품의 등록가·할인조건이 옵션별로 다릅니다.`);
    const raw=row.raw_payload||{};
    if(source==='makeshop'){
     if(!Object.hasOwn(raw,'makeshop_discount_price')||!Object.hasOwn(raw,'makeshop_membership_discount'))throw Error(`${product}: 메이크샵 원본 할인정보를 읽지 못했습니다.`);
     const periodPresent=['makeshop_discount_code','makeshop_discount_title','makeshop_discount_price','makeshop_discount_date'].some(key=>String(raw[key]??'').trim());
     if(periodPresent&&(!String(raw.makeshop_discount_price??'').trim()||!row.discount_terms.some(term=>term.term_key==='period'&&Number.isFinite(Number(term.value))&&term.unit)))throw Error(`${product}: 메이크샵 기간할인을 해석할 수 없습니다.`);
     if(Number(raw.makeshop_membership_discount||0)&&!row.discount_terms.some(term=>term.term_key==='membership'))throw Error(`${product}: 메이크샵 회원할인을 해석할 수 없습니다.`);
    }
    for(const [termKey,prefix] of source==='smartstore'?[['basic','basic'],['mobile','mobile'],['reservation','reservation'],['multi_buy','multi_buy']]:[]){
     const valueKey=`smartstore_${prefix}_discount_value`,unitKey=`smartstore_${prefix}_discount_unit`;
     if(!Object.hasOwn(raw,valueKey)||!Object.hasOwn(raw,unitKey))throw Error(`${product}: 판매처 원본 할인정보를 읽지 못했습니다.`);
     const hasValue=String(raw[valueKey]??'').trim()!=='',hasUnit=String(raw[unitKey]??'').trim()!=='';
     if(hasValue!==hasUnit||hasValue&&!row.discount_terms.some(term=>term.term_key===termKey))throw Error(`${product}: 판매처 원본 ${termKey} 할인정보가 불완전합니다.`);
    }
    if(!Number.isSafeInteger(Number(row.final_price))||row.final_price===null||Number(row.final_price)<=0||!Number.isSafeInteger(Number(row.option_price))||sharedDiscounted+Number(row.option_price)!==Number(row.final_price))throw Error(`${product}/${row.option_code}: 판매처 원본 최종가를 신뢰할 수 없습니다.`);
    const decision=sku?currentDecisions.get(decisionIdentity({source_channel:source,sku,seller_product_code:product,seller_option_code:row.option_code||''}))||currentDecisions.get(sku):null;
    const target=decision?decision.price.final:sku?sourcePrices.get(sku):Number(row.final_price);
    if(!Number.isSafeInteger(target)||target<=0)throw Error(`${sku||product}: 최신 셀피아 원본 판매가가 없습니다.`);
    desired.push({row,sku,target,decision});
   }
   const decided=desired.filter(entry=>entry.decision),sharedDecision=decided[0]?.decision?decisionTuple(decided[0].decision):null;
   if(decided.some(entry=>String(entry.decision.seller_product_code||'').trim()!==product||String(entry.decision.seller_option_code??'').trim()!==String(entry.row.option_code||'').trim()))throw Error(`${product}: 현재 가격 결정 판매처 identity가 파일 행과 다릅니다.`);
   if(sharedDecision&&decided.some(entry=>entry.decision.price.base!==sharedDecision.base||entry.decision.price.discounted!==sharedDecision.discounted||termsKey(entry.decision.price.terms)!==termsKey(sharedDecision.terms)))throw Error(`${product}: 현재 가격 결정 옵션들의 공통 등록가·할인조건이 서로 다릅니다.`);
   const anchor=sharedDecision?sharedDecision.discounted:Math.min(...desired.map(entry=>entry.target));
   const reversed=sharedDecision?{exact:true,basePrice:sharedDecision.base,discountedPrice:sharedDecision.discounted}:g.SystemV3DiscountPriceMath.grossBaseForTarget(anchor,terms);
   let targetBase=reversed.basePrice,targetTerms=sharedDecision?sharedDecision.terms:terms,optionLimitAdjustment=null;
   if(!reversed.exact||!Number.isSafeInteger(targetBase)||reversed.discountedPrice!==anchor||g.SystemV3DiscountPriceMath.discountedBase(targetBase,targetTerms)!==anchor)throw Error(`${product}: 기준가와 할인조건이 현재 가격 결정 또는 기존 할인 규칙과 일치하지 않습니다. ${reversed.reason||''}`);
   if(source==='smartstore'){
    const maxOption=Math.max(...desired.map(entry=>entry.target-anchor));
    const optionLimit=base=>Math.floor((base*0.5)/10)*10;
    if(!Number.isSafeInteger(maxOption)||!Number.isSafeInteger(maxOption*2))throw Error(`${product}: 옵션가 허용범위를 안전하게 계산할 수 없습니다.`);
    if(maxOption>optionLimit(targetBase)){
     let requiredBase=Math.round((maxOption*2)/100)*100;
     while(optionLimit(requiredBase)<maxOption)requiredBase+=100;
     targetBase=Math.max(targetBase,requiredBase);
     const buffer=targetBase-reversed.basePrice;
     const basic=targetTerms.filter(term=>term?.term_key==='basic');
     if(!buffer||targetBase%100!==0||!Number.isSafeInteger(targetBase)||!Number.isSafeInteger(buffer)||basic.length!==1||basic[0].unit!=='amount'||!Number.isSafeInteger(Number(basic[0].value))||Number(basic[0].value)<0)throw Error(`${product}: 옵션가 허용범위 보정에 필요한 원본 기본할인 구조를 안전하게 수정할 수 없습니다.`);
     const nextDiscount=Number(basic[0].value)+buffer;
     if(!Number.isSafeInteger(nextDiscount))throw Error(`${product}: 보정한 즉시할인 금액이 유효하지 않습니다.`);
     if(sharedDecision)throw Error(`${product}: 현재 가격 결정 tuple이 스마트스토어 옵션가 허용범위와 맞지 않습니다.`);
     targetTerms=structuredClone(targetTerms);
     targetTerms.find(term=>term.term_key==='basic').value=nextDiscount;
     if(g.SystemV3DiscountPriceMath.discountedBase(targetBase,targetTerms)!==anchor)throw Error(`${product}: 등록가·즉시할인 보정 후 기준 최종가가 일치하지 않습니다.`);
     optionLimitAdjustment={before_base:reversed.basePrice,after_base:targetBase,before_discount:Number(basic[0].value),after_discount:nextDiscount,max_option:maxOption,allowed_option:optionLimit(targetBase)};
    }
   for(const entry of desired){const option=entry.target-anchor;if(!Number.isSafeInteger(option)||option < -optionLimit(targetBase)||option > optionLimit(targetBase))throw Error(`${product}: 스마트스토어 옵션가 허용범위를 초과합니다.`);if(entry.decision&&(entry.decision.price.base!==targetBase||entry.decision.price.discounted!==anchor||entry.decision.price.option!==option||termsKey(entry.decision.price.terms)!==termsKey(targetTerms)))throw Error(`${product}/${entry.row.option_code}: 현재 가격 결정 tuple이 판매처 공통 가격 계약과 다릅니다.`);}
   }
   for(const {row,sku,target,decision} of desired){
    const option=target-anchor;
    if(!Number.isSafeInteger(option)||anchor+option!==target)throw Error(`${product}/${row.option_code}: 옵션가 또는 최종가 검증 실패`);
    const changed=Number(row.base_price)!==targetBase||Number(row.option_price)!==option||Number(row.final_price)!==target||termsKey(terms)!==termsKey(targetTerms);
    const currentPriceDecisionProof=decision?{event_id:String(decision.event_id),revision:Number(decision.revision),decision_source:String(decision.decision_source||''),effective_at:String(decision.effective_at||''),price:decisionTuple(decision)}:null;
    preview.push({source_row_no:row.source_row_no,sku:sku||'',product_code:product,option_code:row.option_code||'',status:'ready',changed,changed_fields:changed?['price']:[],preserve_unmapped:!sku,price_source:decision?'current_price_decision':sku?'sellpia_source':'seller_original',option_limit_adjustment:optionLimitAdjustment,price_state:{code:decision?'current_price_decision':'sellpia_source',label:decision?'현재 가격 결정':sku?'셀피아 최신 원본 판매가':'미선택 옵션 원본 최종가 보존',safe:true},current_price_decision_proof:currentPriceDecisionProof,diff:{price:{before:{base:sharedBase,discounted:sharedDiscounted,option:Number(row.option_price),final:Number(row.final_price),discount_terms:terms},after:{base:targetBase,discounted:anchor,option,final:target,discount_terms:targetTerms},changed}}});
    if(!changed)continue;
    operations.push({export_item_id:exportId--,sellpia_sku_code:sku||null,source_channel:source,field_key:'sellpia_sale_price',seller_product_code:product,seller_option_code:row.option_code||'',source_file_name:row.raw_payload?.source_file_name||fileName,source_row_no:Number(row.source_row_no),expected_source_value:Number(row.final_price),before_value:Number(row.final_price),after_value:target,base_price:sharedBase,option_price:Number(row.option_price),target_base_price:targetBase,target_discounted_base_price:anchor,target_option_price:option,target_final_price:target,source_discount_terms:terms,target_discount_terms:targetTerms,stored_matrix_price:true,matrix_visible_price:false,pricing_input_mode:decision?'current_price_decision':'sellpia_source',current_price_decision_proof:currentPriceDecisionProof,preserve_unmapped:!sku,target_component_skus:sku?[sku]:[]});
   }
   }catch(error){operations.length=operationsStart;preview.length=previewStart;block(error?.message||String(error));}
  }
  return {kind:'TransformationPlan',source,source_type:'sellpia_source_overlay',file_name:fileName,version_token:planVersionToken({source,fileName,preview,operations}),operations,items:operations,excludedItems,preview,summary:{total:preview.length,selected:preview.filter(row=>row.sku&&row.status==='ready').length,preserved:preview.filter(row=>row.preserve_unmapped&&row.status==='ready').length,changed:preview.filter(row=>row.status==='ready'&&row.changed).length,unchanged:preview.filter(row=>row.status==='ready'&&!row.changed).length,blocked:preview.filter(row=>row.status==='blocked').length},canGenerate:true,safety:{can_generate_xlsx:true,price_complete:true,requires_revalidation:true,reason:'문제 상품은 원본 유지·빨간 표시하고, 안전한 상품만 셀피아 판매가로 변경합니다.'}};
 }
 async function buildArchive(files,items,onProgress,excludedItems=[]){
  let remaining=[...items],excluded=[...excludedItems];
  while(true){
   const archive=await g.SystemV3SellerExport.buildExportArchive(files,remaining,onProgress,excluded);
   const ruleGroups=new Set(remaining.filter(i=>i.stored_matrix_price||i.rule_generated).map(group));
   const remainingIds=new Set(remaining.map(item=>Number(item.export_item_id)));
   // Initial calculation exclusions are already settled. Only a new serializer
   // conflict on an item attempted in this pass can roll its shared-price group back.
   const blocked=new Map(archive.skippedItems.filter(e=>remainingIds.has(Number(e.export_item_id??e.item?.export_item_id))&&price(e.item)&&ruleGroups.has(group(e.item))).map(e=>[group(e.item),e.reason]));
   if(!blocked.size)return archive;
   excluded.push(...remaining.filter(i=>price(i)&&blocked.has(group(i))).map(item=>({item,export_item_id:item.export_item_id,reason:'상품 묶음 전체 제외: '+blocked.get(group(item))})));
   remaining=remaining.filter(i=>!(price(i)&&blocked.has(group(i))));
  }
 }
 function matrixStockTarget(row,stockSource=null){
  if(stockSource&&g.SystemV3SellpiaInventoryCount?.resolveExportStock)return g.SystemV3SellpiaInventoryCount.resolveExportStock(row,stockSource);
  if(finite(row?.stock_draft?.after_value))return Number(row.stock_draft.after_value);
  if(finite(row?.seller_stock))return Number(row.seller_stock);
  if(finite(row?.source_stock))return Number(row.source_stock);
  return null;
 }
 const decisionResolver=Object.freeze({normalize:normalizeCurrentPriceDecisions,proof:currentPriceDecisionProof,assertProof:assertCurrentPriceDecisionProof,attach:attachCurrentPriceDecisions,tuple:decisionTuple,validateGroups:validateCurrentPriceDecisionGroups,decisionForMapping});
 g.HubCurrentPriceDecisionResolver=decisionResolver;
 g.HubCurrentPriceExport={refreshItems,buildArchive,matrixPriceTarget,matrixStockTarget,prepareCarrierItems,prepareSellpiaSourcePricePlan,summarizeSourcePricePreview,validSourceLocation,carrierPriceState,planVersionToken,normalizeCurrentPriceDecisions,currentPriceDecisionProof,assertCurrentPriceDecisionProof,attachCurrentPriceDecisions,decisionTuple,validateCurrentPriceDecisionGroups,decisionForMapping};
})(typeof window==='undefined'?globalThis:window);
