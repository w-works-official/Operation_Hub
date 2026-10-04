(function(g){
 'use strict';
 const sources=['smartstore','makeshop','ably'];
 const fields=['base','discounted','option','final'];
 const clean=v=>String(v??'').trim();
 const number=v=>v!==null&&v!==undefined&&v!==''&&Number.isSafeInteger(Number(v));
 function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  return value;
 }
 const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
 function priceTuple(value){
  if(!value||!fields.every(k=>number(value[k])))return null;
  const tuple=Object.fromEntries(fields.map(k=>[k,Number(value[k])]));
  if(tuple.base<0||tuple.discounted<0||tuple.final<0||tuple.discounted+tuple.option!==tuple.final)return null;
  return {...tuple,terms:Array.isArray(value.terms)?structuredClone(value.terms):[]};
 }
 function manualOverrideFromDraft(draft){
  if(!draft||['cancelled','applied','failed'].includes(draft.status))return null;
  const terms=draft.price_discount_terms_after;
  const explicit=draft.explicit_manual_override===true||draft.base_price_source==='manual'
   ||draft.option_price_source==='manual'||draft.pricing_input_mode==='final'
   ||draft.base_price_source==='discount'&&Array.isArray(terms)&&terms.some(t=>t.input_source==='manual');
  if(!explicit)return null;
  return {explicit:true,changeId:draft.change_id,price:{base:draft.price_base_after,discounted:draft.price_discounted_base_after,
   option:draft.price_option_after,final:draft.price_final_after??draft.after_value,terms:terms||[]}};
 }
 function calculationFreshness({calculated,currentInputFingerprint,currentRuleVersions}={}){
  if(!calculated)return 'missing';
  if(calculated.status==='error'||calculated.error)return 'error';
  if(calculated.stale===true)return 'stale';
  if(!currentInputFingerprint||!calculated.inputFingerprint)return 'unknown';
  if(calculated.inputFingerprint!==currentInputFingerprint)return 'stale';
  if(!Array.isArray(currentRuleVersions)||!Array.isArray(calculated.ruleVersions))return 'unknown';
  return equal(calculated.ruleVersions,currentRuleVersions)?'fresh':'stale';
 }
 function resolvePrice({rawSource,baseline,baselineVersion=null,manualOverride,activeRule=false,calculated,currentInputFingerprint,currentRuleVersions}={}){
  const original=priceTuple(baseline),freshness=calculationFreshness({calculated,currentInputFingerprint,currentRuleVersions});
  const result=(target,origin,extra={})=>({rawSource:structuredClone(rawSource??null),baseline:original,effectiveTarget:target,displayValue:target,
   origin,provenance:origin==='manual'?'수동 override':origin==='calculated'?'fx':original?'판매처 baseline':'판매처 baseline 미확인',
   baselineVersion:structuredClone(baselineVersion),generationId:origin==='calculated'?calculated?.generationId??null:null,
   overrideId:origin==='manual'?manualOverride?.changeId??null:null,
   freshness:origin==='calculated'?freshness:'not_applicable',sellerSyncState:'unknown',...extra});
  if(manualOverride?.explicit===true){
   const target=priceTuple(manualOverride.price);
   if(!target)return result(original,'manual',{displayValue:manualOverride.price,effectiveTarget:original,
    disposition:'WARN_KEEP_ORIGINAL',reason:'수동 override 가격 구성값이 완전하지 않습니다.'});
   return result(target,'manual',{changeId:manualOverride.changeId,disposition:equal(target,original)?'KEEP':'CHANGE'});
  }
  if(!activeRule)return result(original,'baseline',{disposition:original?'KEEP':'WARN_KEEP_ORIGINAL',reason:original?'':'판매처 baseline 값 없음'});
  const candidate=priceTuple(calculated?.price);
  if(candidate&&freshness==='fresh')return result(candidate,'calculated',{disposition:equal(candidate,original)?'KEEP':'CHANGE',generationId:calculated.generationId});
  return result(original,'calculated',{displayValue:candidate||original,freshness,effectiveTarget:original,disposition:'WARN_KEEP_ORIGINAL',
   generationId:calculated?.generationId??null,reason:freshness==='stale'?'재계산 필요':freshness==='unknown'?'입력 freshness 미확인':'가격 계산 미완료/오류'});
 }
 function resolveStock({rawSource=null,baseline,baselineVersion=null,manualOverride}={}){
  const original=number(baseline)&&Number(baseline)>=0?Number(baseline):null;
  const result=(target,origin,extra={})=>({rawSource,baseline:original,displayValue:target,effectiveTarget:target,origin,
   provenance:origin==='manual'?'명시적 재고 target':original===null?'판매처 baseline 미확인':'판매처 baseline',baselineVersion:structuredClone(baselineVersion),
   overrideId:origin==='manual'?manualOverride?.changeId??null:null,generationId:null,freshness:'not_applicable',...extra});
  if(manualOverride?.explicit===true){
   const v=manualOverride.value;
   if(!number(v)||Number(v)<0)return result(original,'manual',{disposition:'WARN_KEEP_ORIGINAL',reason:'재고 override 값 오류'});
   return result(Number(v),'manual',{disposition:Number(v)===original?'KEEP':'CHANGE'});
  }
  return result(original,'baseline',{disposition:original===null?'WARN_KEEP_ORIGINAL':'KEEP',reason:original===null?'판매처 baseline 값 없음':''});
 }
 function sourceDelta(before,after){
  const changedFields=[...new Set([...Object.keys(before||{}),...Object.keys(after||{})])].filter(k=>!equal(before?.[k],after?.[k]));
  return {changed:changedFields.length>0,changedFields,before:structuredClone(before??null),after:structuredClone(after??null)};
 }
 function ruleImpact(changedSkus,registry){
  const rules=new Map((registry.rules||[]).filter(r=>r.is_active!==false).map(r=>[r.id,r]));
  const assignments=(registry.assignments||[]).filter(a=>{const r=rules.get(a.rule_id);return r&&r.target_field===a.target_field&&(r.scope||'')===(a.scope||'');});
  const affected=new Set(changedSkus.map(clean).filter(Boolean));
  const refs=registry.dependencies||[];
  for(const sku of affected)for(const ref of refs)if(ref.parent_sku===sku&&assignments.some(a=>a.sku===ref.child_sku&&a.rule_id===ref.rule_id))affected.add(ref.child_sku);
  const rows=assignments.filter(a=>affected.has(a.sku));
  return {affectedSkus:[...new Set(rows.map(a=>a.sku))],sellerScopes:rows.filter(a=>sources.includes(a.scope)&&a.target_field.startsWith('platform_')),
   internal:rows.filter(a=>!a.scope),baselineOnlySkus:changedSkus.filter(sku=>!rows.some(a=>a.sku===sku))};
 }
 function operationFor({source,productCode,optionCode='',fieldKey,state,baseline,sku='',identityCount=1}){
  if(!sources.includes(source)||!clean(productCode)||identityCount!==1)return {disposition:'BLOCK',reason:'판매처 identity가 유일하지 않습니다.',operation:null};
  if(state.disposition!=='CHANGE')return {disposition:state.disposition,reason:state.reason||'',operation:null};
  if(baseline===null||baseline===undefined)return {disposition:'WARN_KEEP_ORIGINAL',reason:'baseline before 값 미확인',operation:null};
  return {disposition:'CHANGE',operation:{source_channel:source,seller_product_code:clean(productCode),seller_option_code:clean(optionCode),
   sellpia_sku_code:sku,field_key:fieldKey,before:structuredClone(baseline),after:structuredClone(state.effectiveTarget),provenance:state.origin}};
 }
 function compareShadow({snapshot,baseline,baselineVersion=null,priceInput,stockOverride,source,sku,productCode,optionCode,identityCount=1}){
  const price=resolvePrice({...priceInput,rawSource:snapshot?.price,baseline:baseline?.price,baselineVersion}),stock=resolveStock({rawSource:snapshot?.stock,baseline:baseline?.stock,baselineVersion,manualOverride:stockOverride});
  return {sku,source,snapshot:structuredClone(snapshot),baseline:structuredClone(baseline),snapshotEqualsBaseline:equal(snapshot,baseline),
   price,stock,operations:[operationFor({source,sku,productCode,optionCode,identityCount,fieldKey:'sellpia_sale_price',state:price,baseline:baseline?.price}),
    operationFor({source,sku,productCode,optionCode,identityCount,fieldKey:'sellpia_current_stock',state:stock,baseline:baseline?.stock})]};
 }
 function serializerItem(operation,{fileName,sourceRowNo,exportItemId=-1}={}){
  if(!clean(fileName)||!Number.isInteger(Number(sourceRowNo))||Number(sourceRowNo)<=0)throw Error('serializer 원본 위치가 없습니다.');
  const item={...structuredClone(operation),export_item_id:exportItemId,source_file_name:fileName,source_row_no:Number(sourceRowNo),
   target_component_skus:operation.sellpia_sku_code?[operation.sellpia_sku_code]:[]};
  if(operation.field_key==='sellpia_current_stock')return {...item,expected_source_value:operation.before,before_value:operation.before,after_value:operation.after};
  if(operation.field_key!=='sellpia_sale_price'||!priceTuple(operation.before)||!priceTuple(operation.after))throw Error('serializer 가격 operation이 완전하지 않습니다.');
  return {...item,expected_source_value:operation.before.final,before_value:operation.before.final,after_value:operation.after.final,
   base_price:operation.before.base,option_price:operation.before.option,source_discount_terms:operation.before.terms,
   target_base_price:operation.after.base,target_discounted_base_price:operation.after.discounted,target_option_price:operation.after.option,
   target_final_price:operation.after.final,target_discount_terms:operation.after.terms};
 }
 function mergeOperations(baselineRows,operations){
  const rows=structuredClone(baselineRows),seen=new Set();
  for(const op of operations){
   const key=JSON.stringify([op.source_channel,op.seller_product_code,op.seller_option_code||'',op.field_key]);
   if(seen.has(key))throw Error('중복 operation');seen.add(key);
   const matched=rows.filter(r=>r.source===op.source_channel&&r.product_code===op.seller_product_code&&(r.option_code||'')===(op.seller_option_code||''));
   if(matched.length!==1)throw Error('baseline identity 불일치');
   const row=matched[0],field=op.field_key==='sellpia_sale_price'?'price':op.field_key==='sellpia_current_stock'?'stock':null;
   if(!field||!equal(row.facts[field],op.before))throw Error('baseline before 값 불일치');
   if(field==='price'&&!priceTuple(op.after)||field==='stock'&&(!number(op.after)||Number(op.after)<0))throw Error('operation after 값 오류');
   row.facts[field]=structuredClone(op.after);
  }
  return rows;
 }
 g.HubValueStateModel=Object.freeze({canonical,equal,priceTuple,manualOverrideFromDraft,calculationFreshness,resolvePrice,resolveStock,sourceDelta,ruleImpact,operationFor,compareShadow,serializerItem,mergeOperations});
})(typeof window==='undefined'?globalThis:window);
