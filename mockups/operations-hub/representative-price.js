(function(g){
 'use strict';
 const metadata=Object.freeze({stage:'representative_price',scope:'product',output_field:'representative_base_price',exclusive_group:'representative_price_rule'});
 const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
 const signature=value=>JSON.stringify(canonical(value));
 const identity=value=>typeof value==='string'&&value.trim()===value&&value.length>0;
 const versions=rows=>Array.isArray(rows)&&rows.length>0&&rows.every(r=>r&&identity(r.id)&&Number.isSafeInteger(r.version)&&r.version>0)&&new Set(rows.map(r=>r.id)).size===rows.length;
 const sameVersions=(a,b)=>versions(a)&&versions(b)&&signature([...a].map(r=>({id:r.id,version:r.version})).sort((x,y)=>x.id.localeCompare(y.id)))===signature([...b].map(r=>({id:r.id,version:r.version})).sort((x,y)=>x.id.localeCompare(y.id)));
 function calculate({product_identity,membership,assignments=[],options=[]}={}){
  const issues=[];
  const issue=(reason,message,sku='')=>issues.push({reason,message,sku});
  if(!identity(product_identity))issue('identity','상품 identity가 필요합니다.');
  if(!membership||membership.product_identity!==product_identity||membership.complete!==true||!Array.isArray(membership.options)||!membership.options.length||!identity(membership.fingerprint)||membership.fingerprint!==membership.current_fingerprint)issue('membership','현재 상품의 전체 옵션 목록과 fingerprint가 필요합니다.');
  if(!Array.isArray(assignments)||!Array.isArray(options))issue('input','Rule과 옵션 입력은 배열이어야 합니다.');
  const owned=(Array.isArray(assignments)?assignments:[]).filter(r=>r?.is_active!==false);
  if(owned.length!==1)issue('ownership','상품 대표가 output에는 정확히 하나의 active Rule이 필요합니다.');
  const rule=owned[0];
  if(!rule||!identity(rule.id)||!identity(rule.tag_id)||!Number.isSafeInteger(rule.version)||rule.version<1||rule.is_active!==true||rule.product_identity!==product_identity||Object.entries(metadata).some(([k,v])=>rule[k]!==v)||!['lowest','lower_middle','direct'].includes(rule.selection))issue('rule','대표가 Rule의 상품·stage·output·version을 확인하세요.');
  const expected=Array.isArray(membership?.options)?membership.options:[],known=new Map(),optionKeys=new Set();
  for(const item of expected){
   if(!item||!identity(item.sku)||!identity(item.option_identity)||known.has(item.sku)||optionKeys.has(item.option_identity)){issue('identity','상품 옵션 identity가 없거나 중복됩니다.',item?.sku);continue;}
   known.set(item.sku,item.option_identity);optionKeys.add(item.option_identity);
  }
  const seen=new Set(),inputs=[];
  for(const item of Array.isArray(options)?options:[]){
   if(!item||!identity(item.sku)||seen.has(item.sku)||item.product_identity!==product_identity||known.get(item.sku)!==item.option_identity){issue('identity','정확한 상품 옵션 identity에 유일하게 연결되지 않습니다.',item?.sku);continue;}
   seen.add(item.sku);
   const base=item.calculated_base_price;
   if(!base||base.field!=='calculated_base_price'||base.status!=='calculated'||!Number.isSafeInteger(base.value)||base.value<0){issue('invalid','유효한 옵션 기준가 계산 결과가 없습니다.',item.sku);continue;}
   if(base.freshness!=='fresh'||!identity(base.input_fingerprint)||base.input_fingerprint!==base.current_input_fingerprint){issue('stale','옵션 기준가 재계산이 필요합니다.',item.sku);continue;}
   if(!Number.isSafeInteger(base.generation_id)||base.generation_id<1||base.lineage_valid!==true||!sameVersions(base.rule_versions,base.active_rule_versions)){issue('proof','현재 active Rule lineage와 generation을 증명할 수 없습니다.',item.sku);continue;}
   inputs.push({sku:item.sku,option_identity:item.option_identity,value:base.value,generation_id:base.generation_id,input_fingerprint:base.input_fingerprint,rule_versions:base.rule_versions.map(r=>({id:r.id,version:r.version}))});
  }
  for(const sku of known.keys())if(!seen.has(sku))issue('unresolved','상품 옵션이 계산 입력에서 누락됐습니다.',sku);
  let direct=null;
  if(rule?.selection==='direct'){
   const ref=rule.direct_identity,keys=ref&&typeof ref==='object'?Object.keys(ref):[];
   if(keys.length!==1||!['sku','option_identity'].includes(keys[0])||!identity(ref[keys[0]]))issue('direct_identity','대표 옵션 SKU 또는 option identity 하나를 명시하세요.');
   else{const found=inputs.filter(r=>r[keys[0]]===ref[keys[0]]);if(found.length!==1)issue('direct_identity','지정한 대표 옵션을 이 상품에서 유일하게 확인할 수 없습니다.');else direct=found[0];}
  }
  const result={...metadata,product_identity,shadow_only:true,production_target:false,status:'blocked',value:null,issues,contributors:inputs,selected_options:[],rule:rule?{id:rule.id,tag_id:rule.tag_id,version:rule.version,selection:rule.selection}:null,input_signature:null};
  if(issues.length){result.status=issues.every(i=>i.reason==='stale')?'stale':'blocked';return result;}
  const ordered=[...inputs].sort((a,b)=>a.value-b.value||a.sku.localeCompare(b.sku));
  const value=rule.selection==='direct'?direct.value:ordered[rule.selection==='lower_middle'?Math.floor((ordered.length-1)/2):0].value;
  result.status='calculated';result.value=value;
  result.selected_options=rule.selection==='direct'?[direct.sku]:ordered.filter(item=>item.value===value).map(item=>item.sku);
  result.input_signature=signature({product_identity,membership:{fingerprint:membership.fingerprint,options:expected.map(r=>({sku:r.sku,option_identity:r.option_identity})).sort((a,b)=>a.sku.localeCompare(b.sku))},rule,inputs:[...inputs].sort((a,b)=>a.sku.localeCompare(b.sku))});
  return result;
 }
 g.HubRepresentativePrice=Object.freeze({metadata,calculate});
})(typeof window==='undefined'?globalThis:window);
