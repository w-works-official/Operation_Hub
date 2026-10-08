(function initPriceDecisionWorkspace(g){
 'use strict';
 const contexts=new WeakMap(),clean=value=>String(value??'').trim();
 const labels={matrix_manual:'Matrix 수동',pricing_rule:'가격태그 / Rule',sellpia_apply:'Sellpia 적용',rollback:'이전 가격으로 복원'};
 const escape=value=>clean(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const number=value=>Number(value).toLocaleString('ko-KR');
 const api=()=>g.SystemV3Data;
 const identity=(product,option)=>JSON.stringify([clean(product),clean(option)]);
 function current(product,source,productCode=product?.[source+'_product_code'],optionCode=product?.[source+'_option_code']){
  return (product?.__priceDecisions?.[source]||[]).find(row=>identity(row.seller_product_code,row.seller_option_code)===identity(productCode,optionCode))||null;
 }
 function visible(values,decision){
  if(!decision)return values;
  const p=decision.price;
  if(!p||![p.base,p.discounted,p.option,p.final].every(Number.isSafeInteger)||!Array.isArray(p.terms))throw Error('현재 가격 tuple이 유효하지 않습니다.');
  return {...values,priceVisible:true,priceOrigin:'decision',effectiveBasePrice:p.base,effectiveDiscountedBasePrice:p.discounted,
   effectiveOptionPrice:p.option,effectiveFinalPrice:p.final,effectiveDiscountTerms:p.terms};
 }
 function summary(row){
  return row?`${row.mapping_valid===false?'연결 변경 · 재적용 필요 · ':''}${number(row.price.final)}원 · ${labels[row.decision_source]||row.decision_source} · ${new Date(row.effective_at).toLocaleString('ko-KR')} · r${row.revision}`:'현재 가격 결정 없음 · 기존 가격 경로 사용';
 }
 function status(host,message,error=false){const node=host.querySelector('[data-decision-status]');node.textContent=message;node.classList.toggle('error',error);}
 function render(host,product){
  const source=host.dataset.source,code=clean(product?.[source+'_product_code']);
  host.innerHTML=`<div class="drawer-section-title"><h4>현재 적용가격</h4></div><p data-decision-current>${escape(summary(current(product,source)))}</p>
   <p class="drawer-value-comparison">Sellpia 최신 <b>${escape(product?.sellpia_source_sale_price==null?'확인 필요':number(product.sellpia_source_sale_price)+'원')}</b></p>
   <p>후보 확인과 재계산은 현재 가격을 바꾸지 않습니다. 적용 시 같은 판매처 상품의 연결된 옵션을 함께 확인합니다.</p>
   <div class="drawer-section-actions"><button type="button" class="btn" data-decision-action="preview-rule">가격태그 가격 확인</button><button type="button" class="btn" data-decision-action="preview-sellpia">Sellpia 가격 확인</button><button type="button" class="btn" data-decision-action="history">결정 이력</button></div>
   <div data-decision-candidate hidden></div><button type="button" class="btn primary" data-decision-action="apply" hidden>확인한 가격 적용</button><p data-decision-status role="status" aria-live="polite">연결과 현재 가격을 확인 중입니다.</p><div data-decision-history></div>`;
  contexts.set(host,{product,source,code,context:null,candidate:null,busy:false});
  if(!code){status(host,'판매처 연결 후 가격을 적용할 수 있습니다.');host.querySelectorAll('button').forEach(button=>button.disabled=true);return;}
  void refresh(host).catch(error=>status(host,error.message,true));
 }
 async function refresh(host){
  const state=contexts.get(host);if(!state)return;
  const context=await api().loadCurrentPriceDecisions({source:state.source,skus:[state.product.sellpia_sku_code]});
  if(!host.isConnected||contexts.get(host)!==state)return;
  state.context=context;state.group=context.groups.find(group=>group.seller_product_code===state.code);
  if(!state.group)throw Error('최신 판매처 연결과 원본을 찾지 못했습니다.');
  const row=context.rows.find(row=>identity(row.seller_product_code,row.seller_option_code)===identity(state.code,state.product[state.source+'_option_code']));
  host.querySelector('[data-decision-current]').textContent=summary(row);
  status(host,`연결된 ${state.group.targets.length}개 옵션 · 현재 revision ${state.group.revision}`);
 }
 function carrierRows(group){return group.targets.map(target=>({product_code:group.seller_product_code,option_code:target.seller_option_code,
  source_row_no:target.source_row_no,raw_payload:target.raw_payload||{},base_price:target.price?.base,discounted_base_price:target.price?.discounted,
  option_price:target.price?.option,final_price:target.price?.final,discount_terms:target.price?.terms}));}
 async function candidate(host,kind){
  const state=contexts.get(host);await refresh(host);
  const group=state.group,skus=[...new Set(group.targets.map(target=>target.sku))],byIdentity=new Map();
  let extra={};
  if(kind==='pricing_rule'){
   const result=await g.HubPlatformRules.calculate(skus,state.source,{ignoreManualIntent:true});
   if(result.errors?.length)throw Error(result.errors.map(row=>`${row.sku}: ${row.error}`).join(' · '));
   const rows=new Map(result.rows.map(row=>[row.sku,row]));
   for(const target of group.targets){
    const row=rows.get(target.sku);
    if(!row||!(row.versions||[]).length)throw Error(`${target.sku}: 적용 가능한 가격 Rule이 없습니다.`);
    byIdentity.set(identity(group.seller_product_code,target.seller_option_code),{base:row.platformBase,discounted:row.platformBase-row.platformDiscount,
     option:row.platformOption,final:row.platformFinal,terms:row.platformTerms||[]});
   }
   extra={rule_versions:result.rows.flatMap(row=>row.versions||[]),input_mode:'explicit_rule',ignore_previous_manual:true};
  }else{
   const prices=await api().loadSellpiaSourcePricesForExport({skus});
   for(const sku of skus)if(!Number.isSafeInteger(prices.get(sku))||prices.get(sku)<=0)throw Error(`${sku}: 최신 Sellpia 가격이 없습니다.`);
   if(!group.source_observed_at||!group.sellpia_snapshot_id||!group.sellpia_prices||typeof group.sellpia_prices!=='object')throw Error('최신 Sellpia 원본 snapshot 증거가 없어 가격 후보를 계산할 수 없습니다. 다시 조회해주세요.');
   for(const sku of skus)if(!Object.hasOwn(group.sellpia_prices,sku)||Number(group.sellpia_prices[sku])!==prices.get(sku))throw Error(`${sku}: 후보 계산 중 최신 Sellpia 원본 가격 snapshot이 달라졌습니다. 다시 조회해주세요.`);
   const originals=carrierRows(group);
   if(state.source==='ably'){
    const policyData=await api().loadAblyCarrierPoliciesForSkus({skus}),items=group.targets.map((target,index)=>({...originals[index],source_row_no:target.source_row_no||1,
     base_price:target.price.base,option_price:target.price.option,resolution:{sku:target.sku},_inScope:true,_status:'ready'}));
    const policiesBySku=new Map((policyData?.rows||[]).map(row=>[row.sku,(row.tags||[]).map(tag=>g.AblyPriceProjection.normalizePolicyDocument(tag.document,tag)).filter(Boolean)]));
    const tagsByRow=new Map();
    for(const item of items){const rowNo=item.source_row_no,tags=tagsByRow.get(rowNo)||[];tags.push(...(policiesBySku.get(item.resolution.sku)||[]));tagsByRow.set(rowNo,tags);}
    const policyByRow=new Map([...tagsByRow].map(([rowNo,tagPolicies])=>[rowNo,g.AblyPriceProjection.resolveCarrierPolicy({tagPolicies,fallbackStrategy:'lowest',fallbackSource:'legacy fallback'})]));
    g.AblyPriceProjection.projectProductRows(items,{priceMode:'sellpia_source',targetFinalBySku:prices,policyByRow});
    for(const item of items){if(item._status!=='ready')throw Error(item._error||'에이블리 가격 후보 검증 실패');
     byIdentity.set(identity(group.seller_product_code,item.option_code),{base:item.target_base_price,discounted:item.target_base_price,option:item.target_option_price,final:item.target_base_price+item.target_option_price,terms:[]});}
   }else{
    const mappings=group.targets.map(target=>({sku:target.sku,product_code:group.seller_product_code,option_code:target.seller_option_code}));
    const plan=g.HubCurrentPriceExport.prepareSellpiaSourcePricePlan(state.source,'원본',originals,mappings,prices,skus);
    if(plan.excludedItems.length||plan.preview.length!==group.targets.length||plan.preview.some(row=>row.status!=='ready'))throw Error(plan.excludedItems[0]?.reason||plan.preview.find(row=>row.status!=='ready')?.reason||'Sellpia 가격 후보를 모든 옵션에 적용할 수 없습니다.');
    for(const row of plan.preview)byIdentity.set(identity(row.product_code,row.option_code),{base:row.diff.price.after.base,discounted:row.diff.price.after.discounted,
     option:row.diff.price.after.option,final:row.diff.price.after.final,terms:row.diff.price.after.discount_terms});
   }
   extra={input_mode:'explicit_sellpia',source_prices:Object.fromEntries(prices),source_observed_at:group.source_observed_at,sellpia_snapshot_id:group.sellpia_snapshot_id,input_fingerprints:group.input_fingerprints||{}};
  }
  const targets=group.targets.map(target=>({...target,preview_before:target.current_state?.price||target.price,price:byIdentity.get(identity(group.seller_product_code,target.seller_option_code)),intent:extra}));
  if(targets.some(target=>!target.price))throw Error('가격 후보의 판매처 identity가 누락되었습니다.');
  const first=targets[0].price;
  for(const target of targets){visible({}, {price:target.price});
   if(target.price.base!==first.base||target.price.discounted!==first.discounted||JSON.stringify(target.price.terms)!==JSON.stringify(first.terms))throw Error('같은 상품 옵션의 공통 판매가 / 할인조건이 다릅니다.');}
  state.candidate={decisionSource:kind,groups:[{...group,expected_revision:group.revision,targets}],requestId:g.crypto.randomUUID(),reason:kind==='pricing_rule'?'가격태그 가격 명시적 적용':'Sellpia 가격 명시적 적용'};
  const node=host.querySelector('[data-decision-candidate]');node.hidden=false;
  node.innerHTML=`<p><b>${escape(labels[kind])} 후보</b> · ${targets.length}개 옵션 · 적용 전 현재 가격 유지</p><table class="relation-import-table"><thead><tr><th>SKU / 옵션</th><th>현재</th><th>후보 최종가</th></tr></thead><tbody>${targets.map(target=>`<tr><td>${escape(target.sku)} / ${escape(target.seller_option_code||'-')}</td><td>${escape(number(target.preview_before.final))}</td><td>${escape(number(target.price.final))}</td></tr>`).join('')}</tbody></table>`;
  host.querySelector('[data-decision-action="apply"]').hidden=false;status(host,'후보를 확인한 후 적용하세요. 조회 중 새 결정이 생기면 적용이 차단됩니다.');
 }
 async function history(host){
  const state=contexts.get(host),data=await api().loadPriceDecisionHistory({source:state.source,productCode:state.code});
  state.history=data.events||[];const requests=new Map();
  for(const event of state.history)if(!requests.has(event.request_id))requests.set(event.request_id,event);
  host.querySelector('[data-decision-history]').innerHTML=[...requests.values()].map(event=>`<p>${escape(labels[event.decision_source]||event.decision_source)} · ${escape(event.actor||'')} · ${escape(new Date(event.effective_at).toLocaleString('ko-KR'))} · r${escape(event.group_revision)} <button type="button" class="btn" data-decision-action="rollback" data-event-id="${escape(event.event_id)}">이 결정 가격 복원</button></p>`).join('')||'아직 가격 결정 이력이 없습니다.';
 }
 async function rollback(host,eventId){
  const state=contexts.get(host);await refresh(host);
  const reference=state.history.find(event=>String(event.event_id)===String(eventId));
  if(!reference)throw Error('복원할 가격 결정을 찾지 못했습니다.');
  const events=state.history.filter(event=>event.request_id===reference.request_id),targets=state.group.targets.map(target=>{
   const event=events.find(event=>clean(event.seller_option_code)===clean(target.seller_option_code));
   if(!event)return {...target,price:target.current_state?.price||target.price,intent:{input_mode:'preserve'}};
   return {...target,price:event.price,intent:{input_mode:'rollback',rollback_event_id:event.event_id}};
  });
  state.candidate={decisionSource:'rollback',groups:[{...state.group,expected_revision:state.group.revision,targets}],rollbackEventId:reference.event_id,requestId:g.crypto.randomUUID(),reason:'이전 가격 결정 복원'};
  const node=host.querySelector('[data-decision-candidate]');node.hidden=false;node.innerHTML=`<p>이전 결정의 ${events.length}개 옵션 가격을 새로운 복원 결정으로 적용합니다. 당시 변경하지 않은 옵션은 현재 가격을 유지합니다.</p><table class="relation-import-table"><thead><tr><th>SKU / 옵션</th><th>복원 후 최종가</th></tr></thead><tbody>${targets.map(target=>`<tr><td>${escape(target.sku)} / ${escape(target.seller_option_code||'-')}</td><td>${escape(number(target.price.final))}</td></tr>`).join('')}</tbody></table>`;
  host.querySelector('[data-decision-action="apply"]').hidden=false;status(host,'복원할 가격을 확인한 후 적용하세요.');
 }
 async function apply(host){
  const state=contexts.get(host);if(!state.candidate)throw Error('가격 후보를 먼저 확인해주세요.');
  const result=await api().applyPriceDecision({source:state.source,...state.candidate});
  state.candidate=null;host.querySelector('[data-decision-candidate]').hidden=true;host.querySelector('[data-decision-action="apply"]').hidden=true;
  const rows=result.rows||[];state.product.__priceDecisions??={};state.product.__priceDecisions[state.source]=rows.filter(row=>(row.sku||row.sellpia_sku_code)===state.product.sellpia_sku_code);
  await refresh(host);g.dispatchEvent(new CustomEvent('hub-price-decisions-applied',{detail:{skus:[...new Set(rows.map(row=>row.sku||row.sellpia_sku_code))]}}));
  status(host,'현재 적용가격이 저장됐습니다. 가격 계산이나 Sellpia 새로고침으로 이 결정이 바뀌지 않습니다.');
 }
 document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-decision-action]'),host=button?.closest('[data-price-decision-panel]');if(!host)return;
  const state=contexts.get(host);if(!state||state.busy)return;state.busy=true;
  const buttons=[...host.querySelectorAll('button')];buttons.forEach(button=>button.disabled=true);
  try{const action=button.dataset.decisionAction;
   if(action==='preview-rule'||action==='preview-sellpia')await candidate(host,action==='preview-rule'?'pricing_rule':'sellpia_apply');
   else if(action==='apply')await apply(host);else if(action==='history')await history(host);else if(action==='rollback')await rollback(host,button.dataset.eventId);
  }catch(error){status(host,error.message||String(error),true);
   if(/revision|변경|갱신|다시 계산/.test(error.message||'')){state.candidate=null;host.querySelector('[data-decision-action="apply"]').hidden=true;}
  }finally{state.busy=false;buttons.forEach(button=>button.disabled=false);}
 });
 g.HubPriceDecisionUI=Object.freeze({current,visible,summary,sourceLabel:source=>labels[source]||source,mount:(root,product)=>root.querySelectorAll('[data-price-decision-panel]').forEach(host=>render(host,product))});
})(window);
