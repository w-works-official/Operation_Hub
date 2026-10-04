(function(g){
 'use strict';
 const M=()=>g.HubValueStateModel;
 function classify(row){
  const baseline=row.baseline,seller=row.seller,fields=['price','stock'],pending={};
  for(const q of row.pending||[]){if(q.target_eligible===false)continue;const field=q.field_key==='sellpia_sale_price'?'price':q.field_key==='sellpia_current_stock'?'stock':null;if(!field)continue;
   const target=field==='price'?{base:q.price_base_after,discounted:q.price_discounted_base_after,option:q.price_option_after,final:q.price_final_after??q.after_value,terms:q.price_discount_terms_after||[]}:q.after_value;
   if(field==='price'&&!M().priceTuple(target))continue;pending[field]=target;
  }
  const external=fields.filter(f=>!M().equal(baseline?.[f]??null,seller?.[f]??null));
  const local=fields.filter(f=>Object.hasOwn(pending,f)&&!M().equal(pending[f],baseline?.[f]??null));
  const conflicts=external.filter(f=>local.includes(f)&&!M().equal(seller?.[f]??null,pending[f]));
  const identityChange=baseline==null?'added':seller==null?'deleted':'same';
  return {...row,pendingTarget:pending,suppressedPending:(row.pending||[]).filter(q=>q.target_eligible===false).length,externalFields:external,localFields:local,conflictFields:conflicts,identityChange,
   state:conflicts.length?'conflict':external.length||identityChange!=='same'?'seller_changed':local.length?'local_pending':'same',previewOnly:true};
 }
 function reconcile(rows){const classified=rows.map(classify),summary={same:0,seller_changed:0,local_pending:0,conflict:0,added:0,deleted:0,warn_keep_original:0};for(const row of classified){summary[row.state]++;if(row.identityChange!=='same')summary[row.identityChange]++;if(row.suppressedPending)summary.warn_keep_original++;}return {rows:classified,summary,previewOnly:true};}
 function deltaSummary(rows){const changed=new Set(),affected=new Set(),baselineOnly=new Set(),conflicts=[];
  for(const row of rows){const ids=row.ruleImpact?.mappedSkus||[];for(const sku of ids)changed.add(sku);for(const sku of row.ruleImpact?.affectedSkus||[])affected.add(sku);if(row.ruleImpact?.identityConflict)conflicts.push(row.identity);}
  for(const sku of changed)if(!affected.has(sku))baselineOnly.add(sku);
  return {changedRows:rows.length,changedSkus:[...changed],affectedSkus:[...affected],baselineOnlySkus:[...baselineOnly],identityConflicts:conflicts};
 }
 async function recalculate(preview,{api=g.SystemV3Data,materializer=g.HubPriceMaterializer,onProgress}={}){
  if(g.HubReleasePolicy?.previewOnly)throw Error('영향 SKU 재계산은 현재 미리보기 배포에서 사용할 수 없습니다.');
  if(preview.summary.identityConflicts.length)throw Error('Identity conflict를 검토한 후 재계산하세요.');
  const latest=await api.loadSourceSnapshotPair(preview.request.source);
  if(latest.snapshotId!==preview.request.snapshotId)throw Error('새 원본이 등록됐습니다. 최근 원본 비교를 다시 확인하세요.');
  // Re-query immutable snapshots and current Rule impact before acting on a stale preview.
  const current=await api.loadSourceDelta({...preview.request,persist:false});
  if(current.summary.identityConflicts.length)throw Error('현재 identity conflict를 검토한 후 재계산하세요.');
  const skus=current.summary.affectedSkus;if(!skus.length)return {status:'complete',totalSkus:0,persistedRows:0};
  return materializer.materialize({skus,sources:preview.request.source==='sellpia'?['smartstore','makeshop','ably']:[preview.request.source],activeRulesOnly:true,reason:'explicit-source-impact-recalculation',onProgress});
 }
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function render(preview){const s=preview.summary;return `<p>원본 변경 ${s.changedRows} · Rule 재계산 필요 ${s.affectedSkus.length} · 가격 재계산 없음 ${s.baselineOnlySkus.length}</p><p>변경 상세는 처음 200행을 표시합니다.</p><table><thead><tr><th>Identity</th><th>원본 before → after</th><th>영향 SKU</th></tr></thead><tbody>${preview.rows.slice(0,200).map(r=>`<tr><td>${esc(r.identity)}</td><td>${esc(JSON.stringify(r.before))} → ${esc(JSON.stringify(r.after))}</td><td>${esc((r.ruleImpact?.affectedSkus||[]).join(', ')||'가격 재계산 없음')}</td></tr>`).join('')}</tbody></table>`;}
 function renderReconcile(result){const labels={same:'기준본과 동일',seller_changed:'판매처 외부 변경',local_pending:'업로드 대기',conflict:'충돌'},identities={same:'기존 identity',added:'추가 identity',deleted:'삭제 identity'},ordered=[...result.rows.filter(r=>r.state!=='same'),...result.rows.filter(r=>r.state==='same')];
  return '<h4>Seller Baseline reconcile · preview</h4><p>'+Object.entries(labels).map(([state,label])=>'<span class="shadow-chip" data-reconcile-summary="'+state+'">'+label+' · '+state+' '+Number(result.summary[state]||0)+'</span>').join(' ')+' · 추가 '+Number(result.summary.added||0)+' · 삭제 '+Number(result.summary.deleted||0)+'</p><p>처음 200행 표시 · 변경 행 우선 · 자동 적용 없음</p><table><thead><tr><th>Identity / 상태</th><th>Baseline</th><th>새 seller 원본</th><th>Pending target</th></tr></thead><tbody>'+ordered.slice(0,200).map(row=>'<tr data-reconcile-state="'+esc(row.state)+'" data-identity-change="'+esc(row.identityChange)+'"><td>'+esc(row.identity)+' <span class="shadow-chip">'+esc(labels[row.state])+' · '+esc(row.state)+'</span> <span class="shadow-chip">'+esc(identities[row.identityChange])+'</span></td><td>'+esc(JSON.stringify(row.baseline))+'</td><td>'+esc(JSON.stringify(row.seller))+'</td><td>'+esc(JSON.stringify(row.pendingTarget))+'</td></tr>').join('')+'</tbody></table>';
 }
 function mount(parent,{api=g.SystemV3Data}={}){
  if(parent.querySelector('[data-source-lifecycle]'))return;
  const box=document.createElement('details');box.dataset.sourceLifecycle='';box.className='shadow-lineage';box.innerHTML='<summary>원본 변경 · 기준본 reconcile 검증</summary><p>Snapshot 간 delta와 baseline 비교를 제공합니다. Reconcile은 preview이며 기준본에 자동 적용하지 않습니다.</p><select data-life-source><option value="sellpia">Sellpia</option><option value="smartstore">Smartstore</option><option value="makeshop">Makeshop</option><option value="ably">Ably</option></select><button type="button" data-life-preview>최근 원본 비교</button><button type="button" data-life-recalculate disabled>영향 SKU 재계산</button><button type="button" data-life-download disabled>전체 비교 JSON</button><p data-life-status aria-live="polite"></p><div data-life-result style="overflow:auto;max-height:640px"></div>';parent.append(box);
  const q=k=>box.querySelector('[data-life-'+k+']');let preview,lastReconcile,busy=false;
  const previewOnly=g.HubReleasePolicy?.previewOnly===true;if(previewOnly){q('recalculate').hidden=true;q('recalculate').disabled=true;box.querySelector('summary').textContent='원본 변경 · 기준본 비교 미리보기';}
  async function run(fn){if(busy)return;busy=true;q('preview').disabled=q('source').disabled=q('recalculate').disabled=q('download').disabled=true;try{await fn();}catch(e){q('status').textContent='실패: '+e.message;}finally{busy=false;q('preview').disabled=q('source').disabled=false;q('download').disabled=!preview;q('recalculate').disabled=previewOnly||!preview||!preview.summary.affectedSkus.length||!!preview.summary.identityConflicts.length;}}
  q('source').onchange=()=>{preview=null;lastReconcile=null;q('recalculate').disabled=q('download').disabled=true;q('result').innerHTML='';};
  g.addEventListener('hub-source-imported',event=>{preview=event.detail;lastReconcile=null;q('download').disabled=busy;q('source').value=preview.request.source;q('result').innerHTML=render(preview);q('status').textContent='원본 변경 기록 완료 · 영향 범위를 확인한 뒤 재계산하세요.';q('recalculate').disabled=previewOnly||busy||!preview.summary.affectedSkus.length||!!preview.summary.identityConflicts.length;box.open=true;});
 q('preview').onclick=()=>void run(async()=>{preview=null;lastReconcile=null;q('status').textContent='최근 snapshot 비교 중…';const pair=await api.loadSourceSnapshotPair(q('source').value);preview=await api.loadSourceDelta({source:q('source').value,...pair,persist:false});q('result').innerHTML=render(preview);if(q('source').value!=='sellpia'){const r=await api.loadBaselineReconcile({source:q('source').value,snapshotId:pair.snapshotId});lastReconcile=r;q('result').innerHTML+=renderReconcile(r);}q('status').textContent='Preview 완료 · raw/기준본 write 없음';});
  q('download').onclick=()=>{if(!preview||busy)return;g.SystemV3SellerExport.downloadBlob(new Blob([JSON.stringify({delta:preview,reconcile:lastReconcile},null,2)],{type:'application/json'}),'source-reconcile-preview.json');};
  q('recalculate').onclick=()=>void run(async()=>{if(!g.confirm(`Rule 영향 SKU ${preview.summary.affectedSkus.length}개를 재계산합니까? 판매처 업로드와 기준본 갱신은 수행하지 않습니다.`))return;const r=await recalculate(preview,{api,onProgress:p=>q('status').textContent=`영향 SKU 계산 ${p.completedSkus||0}/${p.totalSkus||0}`});q('status').textContent=`재계산 ${r.status} · ${r.persistedRows||0}개 값 저장`;g.dispatchEvent(new CustomEvent('hub-canary-matrix-refresh'));});
  return {box,get preview(){return preview;}};
 }
 g.HubSourceLifecycle=Object.freeze({classify,reconcile,deltaSummary,recalculate,render,mount});
})(window);
