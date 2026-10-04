(function initAblyPriceProjection(global){
 'use strict';

 const PUBLIC_STRATEGIES=new Set(['lowest','lower_middle','preserve_existing_base']);
 const clean=value=>String(value??'').trim();
 const normalize=value=>clean(value).replace(/\s+/g,' ').toLowerCase();
 const finiteInteger=value=>value!==null&&value!==undefined&&value!==''&&Number.isSafeInteger(Number(value));
 const policyTitle=tagId=>`carrier-policy:tag:${clean(tagId)}`;

 function isNoBallAnchor(value){
  return /(?:^|[^\p{L}\p{N}])(?:no[\s_-]*ball|노볼)(?=$|[^\p{L}\p{N}])/iu.test(clean(value));
 }

 function normalizePolicyDocument(document,tag={}){
  const body=document?.body&&typeof document.body==='object'?document.body:{};
  const strategy=clean(body?.carriers?.ably?.representativeStrategy);
  if(!PUBLIC_STRATEGIES.has(strategy))return null;
  return {
   tag_id:clean(tag.tag_id||tag.id),tag_name:clean(tag.tag_name||tag.name)||clean(tag.tag_id||tag.id),
   strategy,document_id:document?.id||null,document_version:Number(document?.version||0),
   document_title:clean(document?.title)||policyTitle(tag.tag_id||tag.id),active:tag.is_active!==false
  };
 }

function resolveCarrierPolicy({tagPolicies=[],fallbackStrategy='lowest',fallbackSource='legacy fallback'}={}){
  const candidates=(tagPolicies||[]).filter(policy=>policy&&policy.active!==false&&PUBLIC_STRATEGIES.has(clean(policy.strategy)));
  const relevant=[...new Map(candidates.map((policy,index)=>[clean(policy.tag_id)||clean(policy.document_id)||`${policy.strategy}:${index}`,policy])).values()];
  const strategies=[...new Set(relevant.map(policy=>clean(policy.strategy)))].sort();
  if(strategies.length>1)return {
   status:'conflict',strategy:null,source:'tag conflict',version:1,
   policies:relevant,reason:`에이블리 대표가 정책 충돌: ${relevant.map(policy=>`${policy.tag_name||policy.tag_id} → ${policy.strategy}`).join(', ')}`
  };
  if(strategies.length===1){
   const strategy=strategies[0],owners=relevant.filter(policy=>policy.strategy===strategy);
   return {status:'resolved',strategy,source:'tag',version:1,policies:owners,
    sourceLabel:`tag ${owners.map(policy=>`${policy.tag_name||policy.tag_id} (v${policy.document_version||1})`).join(', ')}`};
  }
  return {status:'resolved',strategy:fallbackStrategy,source:'legacy',version:1,policies:[],sourceLabel:fallbackSource};
 }

 function selectRepresentativeBase(targetFinals,strategy,{existingBase=null,legacyRulesBase=null}={}){
  const values=(targetFinals||[]).map(Number).filter(Number.isSafeInteger).sort((a,b)=>a-b);
  if(!values.length)throw Error('대표 판매가를 계산할 목표 최종가가 없습니다.');
  if(strategy==='lowest')return values[0];
  if(strategy==='lower_middle')return values[Math.floor((values.length-1)/2)];
  if(strategy==='preserve_existing_base'){
   if(!finiteInteger(existingBase)||Number(existingBase)<0)throw Error('기존 PlayAuto 판매가 I를 읽을 수 없습니다.');
   return Number(existingBase);
  }
  if(strategy==='legacy_rules'){
   if(!finiteInteger(legacyRulesBase)||Number(legacyRulesBase)<0)throw Error('Rule의 platformBase를 하나로 결정할 수 없습니다.');
   return Number(legacyRulesBase);
  }
  throw Error(`지원하지 않는 에이블리 대표가 정책입니다: ${strategy}`);
 }

 function indexCarrierRows(items){
  const byRow=new Map(),skuRows=new Map(),identityCounts=new Map();
  for(const item of items||[]){
   const rowNo=item.source_row_no,sku=clean(item.resolution?.sku);
   if(!byRow.has(rowNo))byRow.set(rowNo,[]);
   byRow.get(rowNo).push(item);
   if(sku){if(!skuRows.has(sku))skuRows.set(sku,new Set());skuRows.get(sku).add(rowNo);}
   const identity=JSON.stringify([normalize(item.seller_management_code),normalize(item.primary_option_name),normalize(item.secondary_option_value)]);
   identityCounts.set(identity,(identityCounts.get(identity)||0)+1);
  }
  return {byRow,skuRows,identityCounts};
 }

 function resolveCarrierVariants(group,{skuRows,identityCounts}){
  const rowNo=group[0]?.source_row_no;
  for(const item of group){
   if(item._status!=='ready')throw Error(item._error||item.resolution?.error||`${rowNo}행: 판매처 옵션 identity가 불명확합니다.`);
   const sku=clean(item.resolution?.sku);
   if(!sku)throw Error(item.resolution?.error||`${rowNo}행: 판매처 옵션 identity가 불명확합니다.`);
   const direct=clean(item.direct_sellpia_sku_code);
   if(direct&&direct!==sku)throw Error(`${direct}: P열 직접 SKU와 카탈로그 또는 기존 판매처 연결이 충돌합니다.`);
   if(skuRows.get(sku)?.size>1)throw Error(`${sku}: 동일 SKU가 서로 다른 PlayAuto 상품 행에 중복됩니다.`);
   const identity=JSON.stringify([normalize(item.seller_management_code),normalize(item.primary_option_name),normalize(item.secondary_option_value)]);
   if(identityCounts.get(identity)>1)throw Error(`${rowNo}행: 같은 판매자관리코드와 옵션값이 파일에 중복됩니다.`);
   if(!finiteInteger(item.option_price))throw Error(`${rowNo}행: 동일 SKU 추가 옵션의 원본 추가금액을 읽을 수 없습니다.`);
  }
  const bySku=new Map();
  for(const item of group){const sku=clean(item.resolution.sku);if(!bySku.has(sku))bySku.set(sku,[]);bySku.get(sku).push(item);}
  for(const [sku,variants] of bySku){
   if(variants.length===1){variants[0].carrier_variant_role='anchor';variants[0].carrier_anchor_sku=sku;variants[0].carrier_addon_delta=0;continue;}
   const anchors=variants.filter(item=>isNoBallAnchor(item.secondary_option_value));
   if(!anchors.length)throw Error(`${sku}: 동일 SKU의 기준 노볼 옵션을 찾을 수 없습니다.`);
   if(anchors.length>1)throw Error(`${sku}: 동일 SKU의 기준 노볼 옵션이 중복됩니다.`);
   const anchorOption=Number(anchors[0].option_price);
   for(const item of variants){
    const delta=Number(item.option_price)-anchorOption;
    if(!Number.isSafeInteger(delta)||delta<0)throw Error(`${sku}: 동일 SKU 추가 옵션의 원본 추가금액 차이가 비정상입니다.`);
    item.carrier_variant_role=item===anchors[0]?'anchor':'addon';item.carrier_anchor_sku=sku;item.carrier_addon_delta=delta;
   }
  }
  return group;
 }

 function resolveTargetFinals(group,targetFinalBySku,originalBase){
  return group.map(item=>{
   const sku=clean(item.resolution?.sku),selected=item._inScope===true;
   const selectedBase=selected?Number(targetFinalBySku?.get(sku)):null;
   if(selected&&(!Number.isSafeInteger(selectedBase)||selectedBase<=0))throw Error(`${sku}: 선택 SKU 목표 최종가가 없습니다.`);
   const target=selected?selectedBase+Number(item.carrier_addon_delta||0):Number(originalBase)+Number(item.option_price);
   if(!Number.isSafeInteger(target)||target<=0)throw Error(`${sku||item.source_row_no}: 목표 최종가가 비정상입니다.`);
   return target;
  });
 }

function projectionMetrics(representativeBase,targetFinals){
  const optionDeltas=targetFinals.map(value=>Number(value)-Number(representativeBase));
  return {representativeBase,targetFinals:[...targetFinals],optionDeltas,
   minFinal:Math.min(...targetFinals),maxFinal:Math.max(...targetFinals),
   minDelta:Math.min(...optionDeltas),maxDelta:Math.max(...optionDeltas)};
 }

 function validateAblyProjection(projection,{allowNegative=false}={}){
  if(!finiteInteger(projection?.representativeBase)||!(projection?.targetFinals||[]).every(finiteInteger)||!(projection?.optionDeltas||[]).every(finiteInteger))throw Error('에이블리 가격 projection 값이 완전하지 않습니다.');
  if(projection.targetFinals.some((value,index)=>projection.representativeBase+projection.optionDeltas[index]!==value))throw Error('I + T가 목표 최종가와 일치하지 않습니다.');
  if(!allowNegative&&projection.minDelta<0)throw Error('음수 옵션가는 PlayAuto/Ably 허용 계약이 확인되지 않아 다운로드를 차단합니다.');
  return projection;
 }

 function blockGroup(group,error,projection=null){
  for(const item of group){
   item._status='conflict';item._error=`같은 상품 행 원본 유지: ${error?.message||error}`;
   if(projection)item._projection=projection;
   delete item.target_base_price;delete item.target_option_price;
  }
 }

 function projectProductRows(items,{priceMode='rules',targetFinalBySku=new Map(),policyByRow=new Map(),legacyRulesBaseBySku=new Map(),allowLowerMiddle=false}={}){
  const index=indexCarrierRows(items);
  for(const [rowNo,group] of index.byRow){
   if(!group.some(item=>item._inScope))continue;
   let projection=null;
   try{
    if(group.some(item=>!clean(item.resolution?.sku)))throw Error(`${rowNo}행: 판매처 옵션 identity가 불완전합니다.`);
    const hard=group.find(item=>item._status!=='ready'&&item._status!=='warn_keep_original');
    if(hard)throw Error(hard._error||hard.resolution?.error||`${rowNo}행: 판매처 옵션 identity가 불명확합니다.`);
    if(group.some(item=>item._status==='warn_keep_original')){
     for(const item of group){item._status='warn_keep_original';item._error='공유 판매가 보호: 같은 상품의 가격 경고 옵션이 있어 상품 전체 원본 유지';delete item.target_base_price;delete item.target_option_price;}
     continue;
    }
    resolveCarrierVariants(group,index);
    if(group.some(item=>item.base_price===null||item.base_price===undefined||item.base_price===''))throw Error(`${rowNo}행: PlayAuto 원본 공통 판매가가 불완전합니다.`);
    const originalBases=[...new Set(group.map(item=>Number(item.base_price)))];
    if(originalBases.length!==1||!Number.isSafeInteger(originalBases[0])||originalBases[0]<0)throw Error(`${rowNo}행: PlayAuto 원본 공통 판매가가 불완전합니다.`);
    const policy=policyByRow.get(rowNo)||resolveCarrierPolicy({fallbackStrategy:priceMode==='rules'?'legacy_rules':'lowest',fallbackSource:'legacy fallback'});
    if(policy.status==='conflict')throw Error(policy.reason);
    if(priceMode==='sellpia_source')for(const item of group.filter(row=>row._inScope)){const sku=clean(item.resolution?.sku);if(!finiteInteger(targetFinalBySku.get(sku))||Number(targetFinalBySku.get(sku))<=0)throw Error(`${sku}: 최신 셀피아 원본 판매가가 없습니다.`);}
    const targetFinals=resolveTargetFinals(group,targetFinalBySku,originalBases[0]);
    let legacyRulesBase=null;
    if(policy.strategy==='legacy_rules'){
     const values=[...new Set(group.filter(item=>item._inScope).map(item=>Number(legacyRulesBaseBySku.get(clean(item.resolution?.sku)))).filter(Number.isSafeInteger))];
     if(values.length!==1)throw Error('Rule 선택 SKU의 platformBase를 하나로 결정할 수 없습니다.');
     legacyRulesBase=values[0];
    }
    const representativeBase=selectRepresentativeBase(targetFinals,policy.strategy,{existingBase:originalBases[0],legacyRulesBase});
    projection={...projectionMetrics(representativeBase,targetFinals),priceMode,policy:{strategy:policy.strategy,source:policy.source,sourceLabel:policy.sourceLabel||policy.source,version:policy.version||1,policies:policy.policies||[]}};
    group.forEach((item,indexInGroup)=>{item._projection=projection;item._projectionTargetFinal=targetFinals[indexInGroup];item._projectionOptionDelta=projection.optionDeltas[indexInGroup];});
    if(policy.strategy==='lower_middle'&&!allowLowerMiddle)throw Error('lower_middle은 계산·미리보기만 지원합니다. PlayAuto/Ably 음수 옵션가 및 허용범위가 확인되기 전에는 다운로드를 차단합니다.');
    validateAblyProjection(projection,{allowNegative:policy.strategy==='lower_middle'&&allowLowerMiddle});
    group.forEach((item,indexInGroup)=>{
     const option=targetFinals[indexInGroup]-representativeBase;
     if(!Number.isSafeInteger(option))throw Error(`${rowNo}행: 목표 옵션가가 비정상입니다.`);
     if(representativeBase+option!==targetFinals[indexInGroup])throw Error(`${rowNo}행: I + T가 목표 최종가와 일치하지 않습니다.`);
     item.target_base_price=representativeBase;item.target_option_price=option;item._projection=projection;
     item._priceState={safe:true,code:priceMode,label:item._inScope?(priceMode==='sellpia_source'?(item.carrier_variant_role==='addon'?'셀피아 원본 판매가 + carrier add-on':'셀피아 원본 판매가'):'Rule platformFinal'):'미선택 sibling 기존 최종가 보존'};
     item._preserveUnselected=!item._inScope;
    });
   }catch(error){blockGroup(group,error,projection);}
  }
  return items;
 }

 global.AblyPriceProjection=Object.freeze({
  PUBLIC_STRATEGIES,policyTitle,isNoBallAnchor,normalizePolicyDocument,resolveCarrierPolicy,
  selectRepresentativeBase,indexCarrierRows,resolveCarrierVariants,resolveTargetFinals,projectionMetrics,validateAblyProjection,projectProductRows
 });
})(typeof window==='undefined'?globalThis:window);
