(function(g){
 'use strict';
 const sources=['smartstore','makeshop','ably'],e=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const n=v=>v==null?'미확인':typeof v==='object'&&'final' in v?`판매가 ${n(v.base)} · 할인 적용가 ${n(v.discounted)} · 옵션 ${n(v.option)} · 최종 ${n(v.final)}`:typeof v==='object'&&'price' in v?`가격 ${n(v.price)} / 재고 ${n(v.stock)}`:typeof v==='object'?JSON.stringify(v):Number.isFinite(Number(v))?Number(v).toLocaleString('ko-KR'):String(v);
 const evidence=new Map();
 function rememberCarrierEvidence(items){for(const item of items||[]){const sku=item.resolution?.sku;if(!sku)continue;const list=evidence.get(sku)||[];if(!list.some(r=>JSON.stringify(r.carrier_identity)===JSON.stringify(item.carrier_identity)))list.push(structuredClone(item));evidence.set(sku,list);}}
 function carrierFor(sku){const rows=evidence.get(sku)||[];return rows.length===1?structuredClone(rows[0]):null;}
 function request(product,source,carrier=source==='ably'?carrierFor(product.sellpia_sku_code):null){return {sku:product.sellpia_sku_code,product_code:String(product[source+'_product_code']||''),option_code:String(product[source+'_option_code']||''),...(carrier?{carrier:{seller_product_code:String(carrier.seller_product_code||''),full_option_label:(carrier.option_pairs||[]).map(p=>String(p.value??'').trim()).join(', ')}}:{})};}
 function annotate(product,payload,carrier=payload.source==='ably'?carrierFor(product.sellpia_sku_code):null){
  const M=g.HubValueStateModel,source=payload.source,row=payload.rows.find(r=>r.sku===product.sellpia_sku_code);if(!row)throw Error('shadow SKU 응답 누락');
  let baseline=row.baseline,lookup=baseline?'matched':'unavailable',reason='',identity={product_code:row.product_code,option_code:row.option_code};
  if(carrier){const bridge=g.HubBaselineIdentityShadow.crosswalk({carrier,resolvedSku:product.sellpia_sku_code,baselineRows:row.candidates,declaredLinks:row.declared_links});
   if(bridge.disposition==='BLOCK'){lookup='conflict';baseline=null;reason=bridge.reason;}
   else if(bridge.row){lookup=baseline?'matched':'crosswalk';baseline=bridge.row.facts;identity=bridge.row;}
   else if(!baseline){lookup='unavailable';reason=bridge.reason;}}
  if(Number(product[source+'_listing_count']||1)!==1){lookup='conflict';reason='SKU에 판매처 identity 복수 · shadow BLOCK';}
  const version={id:payload.version_id,version:payload.version};
  const draft=product.__sellerDrafts?.[source+':sellpia_sale_price'];
  const marker=(row.draft_markers||[]).find(m=>Number(m.change_id)===Number(draft?.change_id));
  const manual=M.manualOverrideFromDraft(draft?{...draft,...marker}:null),stored=row.calculated||[];
  const c=field=>stored.find(r=>r.scope===source&&r.field===field),rulePrice=product.__hubRulePrices?.[source];
  const final=c('platform_final_price'),deltaAffected=row.source_delta?.ruleImpact?.affectedSkus?.includes(product.sellpia_sku_code),fingerprintCurrent=!!final?.result_details?.input_fingerprint&&final.result_details.input_fingerprint===row.current_input_fingerprint;
  const calc=rulePrice?{price:{base:rulePrice.platformBase,discounted:rulePrice.discounted,option:rulePrice.platformOption,final:rulePrice.platformFinal,terms:rulePrice.platformTerms||[]},generationId:final?.generation_id,ruleVersions:final?.rule_versions,status:final?.status,error:rulePrice.error,inputFingerprint:final?.result_details?.input_fingerprint,stale:deltaAffected&&!fingerprintCurrent}:null;
  const currentVersions=final?.rule_versions?.map(v=>{const current=row.current_rules?.find(r=>r.id===v.id&&Number(r.version)===Number(v.version)&&Number(r.assignmentVersion)===Number(v.assignmentVersion))||row.current_rules?.find(r=>r.id===v.id&&r.sku===product.sellpia_sku_code)||row.current_rules?.find(r=>r.id===v.id);return current?{id:current.id,version:current.version,assignmentVersion:current.assignmentVersion}:null;});
  const price=M.resolvePrice({rawSource:row.snapshot?.price,baseline:baseline?.price,baselineVersion:version,manualOverride:manual,activeRule:product.__hubActivePriceRules?.[source]===true,calculated:calc,currentInputFingerprint:row.current_input_fingerprint??row.source_delta?.after?.input_fingerprint,currentRuleVersions:currentVersions?.every(Boolean)?currentVersions:undefined});
  price.ruleNames=[...new Set([...(rulePrice?.versions||[]).map(v=>v.name),...(final?.rule_versions||[]).map(v=>row.current_rules?.find(r=>r.id===v.id)?.name),product.__priceRuleAssignments?.[source]?.set_name].filter(Boolean))];
  const stockDraft=product.__sellerDrafts?.[source+':sellpia_current_stock'];
  const stock=M.resolveStock({rawSource:row.snapshot?.stock,baseline:baseline?.stock,baselineVersion:version,manualOverride:stockDraft&&!['cancelled','applied','failed'].includes(stockDraft.status)?{explicit:true,value:stockDraft.after_value,changeId:stockDraft.change_id}:null});
  for(const state of [price,stock]){state.lookup=lookup;state.lookupReason=reason;state.sellerSyncState=lookup==='conflict'?'conflict':!baseline?'baseline unavailable':M.equal(state.baseline,state.effectiveTarget)?'기준본과 동일':'업로드 대기';if(lookup==='conflict')state.disposition='BLOCK';}
  const operations=[['price','sellpia_sale_price'],['stock','sellpia_current_stock']].map(([field,key])=>M.operationFor({source,sku:product.sellpia_sku_code,productCode:identity.product_code,optionCode:identity.option_code,identityCount:lookup==='conflict'?0:Number(product[source+'_listing_count']||1),fieldKey:key,state:field==='price'?price:stock,baseline:baseline?.[field]}));
  const projection={source,price,stock,baselineVersion:version,identity,lookup,sourceDelta:row.source_delta,calculated:stored,internalInputFingerprint:row.current_internal_input_fingerprint,operations,
   carrier_before:carrier?{price:{base:carrier.base_price,option:carrier.option_price},stock:carrier.sales_quantity}:null,baseline_before:baseline??null,effective_target:{price:price.effectiveTarget,stock:stock.effectiveTarget},serialized_after:null};
  return {...product,__hubShadowCompact:product.__hubShadowCompact||payload.compact===true,__hubShadow:{...product.__hubShadow,[source]:projection}};
 }
 function chip(text,kind=''){return `<span class="shadow-chip ${kind}">${e(text)}</span>`;}
 function freshness(value){return value==='fresh'?'최신':value==='stale'?'재계산 필요':value==='error'?'계산 오류':value==='not_applicable'?'':value==='missing'?'계산 미설정':'최신 여부 미확인';}
 function markers(product,source,field){
  const r=product.__hubShadow?.[source],s=r?.[field];if(!s||!product[source+'_product_code'])return '';
  const items=[];
  if(s.origin==='manual')items.push(['✎','수동 수정','manual']);
  else if(s.origin==='calculated')items.push(['fx','수식 Rule','formula']);
  if(s.freshness==='stale'||s.sellerSyncState==='업로드 대기')items.push(['↻',s.freshness==='stale'?'재계산 필요':'업로드 대기','pending']);
  if(s.lookup==='unavailable'||s.lookup==='conflict'||s.disposition==='BLOCK'||['unknown','error','missing'].includes(s.freshness))items.push(['⚠',s.lookup==='conflict'?'연결 충돌':s.lookup==='unavailable'?'기준본 없음':'확인 필요','warning']);
  const provenance=s.origin==='manual'?'수동 수정':s.origin==='calculated'?'수식 '+(s.ruleNames?.join(' · ')||'가격 Rule'):'판매처 기준본';
  const detail=`출처: ${provenance}\n기준본: v${r.baselineVersion?.version??'미확인'}\n상태: ${freshness(s.freshness)||'기준본 유지'} · ${s.sellerSyncState}\n기준본 값: ${n(s.baseline)}\nShadow 목표값: ${n(s.effectiveTarget)}${s.reason||s.lookupReason?'\n사유: '+(s.reason||s.lookupReason):''}\n클릭하여 값 계보 확인`;
  return markerButtons(items,detail);
 }
 function markerButtons(items,detail){return items.length?`<span class="shadow-markers">${items.map(([symbol,label,kind])=>`<button type="button" class="shadow-marker ${kind}" data-shadow-value-detail title="${e(label+'\n'+detail)}" aria-label="${e(label+' · 값 계보 열기')}">${e(symbol)}</button>`).join('')}</span>`:'';}
 function internalMarkers(product,field){const c=product.__hubInternalPrices?.[field];if(!c)return '';const s=internalState(product,field),items=[['fx','수식 Rule','formula']];if(s.freshness==='stale')items.push(['↻','재계산 필요','pending']);else if(s.freshness==='unknown')items.push(['⚠','최신 여부 확인 필요','warning']);return markerButtons(items,`출처: 수식 ${c.ruleNames?.join(' · ')||field}\n계산 세대: ${c.generationId??'미확인'}\n상태: ${freshness(s.freshness)}\n클릭하여 값 계보 확인`);}
 function chips(product,source,field){const r=product.__hubShadow?.[source],s=r?.[field];if(!s)return '';const provenance=s.lookup==='conflict'?'Identity Conflict':s.origin==='manual'?'Manual Override':s.origin==='calculated'?'fx '+(s.ruleNames?.join(' · ')||'가격 Rule'):s.lookup==='unavailable'?'Seller Original / Baseline unavailable':'Seller Baseline';
  return `<div class="matrix-shadow" data-shadow-source="${e(source)}" data-shadow-field="${e(field)}">${chip(provenance)}${freshness(s.freshness)?chip(freshness(s.freshness),s.freshness==='stale'?'warn':''):''}${chip(s.lookup==='crosswalk'?'exact crosswalk':s.sellerSyncState,s.lookup==='conflict'?'bad':'')}<small>shadow ${e(n(field==='price'?s.effectiveTarget?.final:s.effectiveTarget))}${s.baseline==null?' · seller original 유지':` · baseline ${e(n(field==='price'?s.baseline.final:s.baseline))}`}</small></div>`;
 }
 function internalState(product,field){const projections=Object.values(product.__hubShadow||{}),delta=projections.find(r=>r.sourceDelta?.ruleImpact?.affectedSkus?.includes(product.sellpia_sku_code))?.sourceDelta;
  const proof=projections.map(r=>({current:r.internalInputFingerprint,stored:r.calculated?.find(c=>!c.scope&&c.field===field)})).find(p=>p.current&&p.stored?.result_details?.input_fingerprint);
  return {delta,freshness:product.__hubInternalPrices?.[field]?.stale?'stale':proof?(proof.current===proof.stored.result_details.input_fingerprint?'fresh':'stale'):product.__hubInternalPrices?.[field]?.stale||delta?'stale':'unknown'};
 }
 function internalChips(product,field){const c=product.__hubInternalPrices?.[field];if(!c)return '';const s=internalState(product,field);return `<div class="matrix-shadow">${chip(c.provenanceMismatch?'저장된 계산값 · 현재 Rule과 다름': 'fx '+(c.ruleNames?.join(' · ')||field))}${s.delta?chip('원본 변경'):''}${chip(freshness(s.freshness),s.freshness==='stale'?'warn':'')}<small>generation ${e(c.generationId??'미확인')}</small></div>`;}
 function renderDetail(product){
  const rep=product.__hubRepresentativePrice;
  const representative=rep?`<details open><summary>상품 대표 기준가 · ${e(rep.rule?.tag_name||'활성 Rule 없음')}</summary><p>옵션 기준가 → 대표가 Rule → representative_base_price → 명시적 판매처 등록가 Rule</p><p><b>${e(n(rep.value))}</b> · ${e(rep.status)} · ${e(rep.rule?.selection||'미사용')}</p><p>generation ${e(rep.generation_id??'—')} · Rule v${e(rep.rule?.rule_version??'—')} · assignment v${e(rep.rule?.version??'—')}</p><p>선택 contributor: ${e((rep.selected_options||[]).join(', ')||'없음')}</p><ul>${(rep.contributors||[]).map(c=>`<li>${e(c.sku)} · ${e(n(c.value))} · generation ${e(c.generation_id??'—')}${c.lineage_valid?'':' · active Rule 증명 확인 필요'}</li>`).join('')}</ul>${(rep.issues||[]).map(i=>`<p>${e(i.sku||'')} ${e(i.message)}</p>`).join('')}${rep.status!=='calculated'&&rep.stored_history?`<p>저장된 계산 이력 ${e(n(rep.stored_history.value))} · 현재값에 미사용</p>`:''}<details><summary>대표가 dependency proof</summary><pre>${e(JSON.stringify(rep,null,2))}</pre></details></details>`:'';
  const internal=Object.entries(product.__hubInternalPrices||{}).map(([field,c])=>`<div><b>Calculated · ${e(field)}</b> ${e(n(c.value))}${internalChips(product,field)}</div>`).join('');
  const stored=Object.values(product.__hubShadow||{}).flatMap(r=>r.calculated||[]).filter(c=>!c.scope&&!product.__hubInternalPrices?.[c.field]);
  const historical=[...new Map(stored.map(c=>[c.field,c])).values()].map(c=>`<p><b>저장된 Calculated · ${e(c.field)}</b> ${e(n(c.value))} · generation ${e(c.generation_id)}<br>${chip('현재 표시값에 미사용')} ${chip('활성 태그 / freshness 확인 필요')}</p>`).join('');
  const raw=product.sellpia_source_purchase_price==null?'':`<p>Raw Sellpia 매입가 <b>${e(n(product.sellpia_source_purchase_price))}</b></p>`;
  const channels=sources.map(source=>{
   const r=product.__hubShadow?.[source];if(!r)return '';
   const fields=['price','stock'].map(field=>{
    const s=r[field];return `<div class="shadow-lineage-field"><b>${field==='price'?'가격':'재고'}</b>${chips(product,source,field)}<dl>${s.rawSource!=null?`<dt>Raw Seller Source</dt><dd>${e(n(s.rawSource))}</dd>`:''}${s.overrideId!=null?`<dt>Manual Override ID</dt><dd>${e(s.overrideId)} · target ${e(n(s.effectiveTarget))}</dd>`:''}${s.generationId!=null?`<dt>Calculation generation</dt><dd>${e(s.generationId)}</dd>`:''}<dt>Seller Baseline</dt><dd>${e(n(s.baseline))}</dd><dt>Effective Target</dt><dd>${e(n(s.effectiveTarget))}</dd><dt>판정</dt><dd>${e(s.disposition)} · ${e(s.reason||s.lookupReason||s.sellerSyncState)}</dd></dl></div>`;
   }).join('');
   const recalc=r.price.freshness==='stale'||Object.keys(product.__hubInternalPrices||{}).some(field=>internalState(product,field).freshness==='stale');
   const delta=r.sourceDelta?.changed?`<p>${chip('원본 변경')}${recalc?chip('재계산 필요','warn'):''} ${e(n(r.sourceDelta.before))} → ${e(n(r.sourceDelta.after))}</p>`:'';
   const operations=r.operations.filter(o=>o.operation).map(o=>`<p>${o.operation.field_key==='sellpia_current_stock'?'재고':'가격'} ${e(n(o.operation.before))} → ${e(n(o.operation.after))}</p>`).join('')||'<p>변경 operation 없음</p>';
   const checks=`<details><summary>파일·기준본 안전 검증 정보</summary><dl>${r.carrier_before?`<dt>carrier_before</dt><dd>${e(n(r.carrier_before))}</dd>`:''}<dt>baseline_before</dt><dd>${e(n(r.baseline_before))}</dd><dt>serialized_after</dt><dd>미생성 · 기존 serializer 유지</dd><dt>baseline version ID</dt><dd>${e(r.baselineVersion.id)}</dd></dl></details>`;
   return `<details open><summary>${e(source)} · baseline v${e(r.baselineVersion.version??'미확인')} · ${e(r.lookup)}</summary>${fields}${delta}<b>Shadow operations</b>${operations}${checks}</details>`;
  }).join('');
  return `<section class="shadow-lineage"><h4>값 계보 · shadow 검증</h4><p>Matrix 표시값은 기존 운영 로직을 사용합니다. 아래 목표값과 차이를 확인하세요.</p>${raw}${internal}${representative}${historical}${channels}</section>`;
 }
 function diagnostic(rows){const counts={matched:0,crosswalk:0,unavailable:0,conflict:0};for(const row of rows||[])counts[row.lookup]=(counts[row.lookup]||0)+1;return `<details class="shadow-lineage" open><summary>Baseline shadow 진단 · 기존 export 판정 유지</summary><p>${Object.entries(counts).map(([k,v])=>chip(k+' '+v,k==='conflict'?'bad':'')).join('')}</p><p>Conflict는 shadow BLOCK입니다. Production cutover 전까지 기존 생성 판정은 변경하지 않습니다.</p><div class="shadow-diagnostic-scroll">${(rows||[]).map(r=>`<p>${e(r.sku)} ${chip(r.lookup,r.lookup==='conflict'?'bad':'')} ${e(r.reason||'')}</p>`).join('')}</div></details>`;}
 function mountDiagnostics(){const toggle=g.document?.getElementById('shadow-diagnostics-toggle');if(!toggle)return;g.document.documentElement.dataset.shadowDiagnostics='off';toggle.addEventListener('click',()=>{const on=toggle.getAttribute('aria-pressed')!=='true';toggle.setAttribute('aria-pressed',String(on));toggle.textContent='Shadow 진단 보기 '+(on?'ON':'OFF');g.document.documentElement.dataset.shadowDiagnostics=on?'on':'off';});}
 if(g.document){if(g.document.readyState==='loading')g.document.addEventListener('DOMContentLoaded',mountDiagnostics,{once:true});else mountDiagnostics();}
 g.HubMatrixShadow=Object.freeze({annotate,request,chips,markers,internalChips,internalMarkers,internalState,renderDetail,diagnostic,rememberCarrierEvidence,carrierFor});
})(typeof window==='undefined'?globalThis:window);
