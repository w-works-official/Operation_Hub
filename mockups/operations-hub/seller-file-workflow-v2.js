(function initSellerFileWorkflowV2(global){
 'use strict';
 const D=()=>global.SystemV3Data,A=()=>global.AblyPlayautoExport,P=()=>global.AblyPriceProjection;
 const state={files:[],catalog:null,catalogKey:'',preview:null,previewFilter:'all',previewPage:1,role:null,loading:false,carrierFiles:new Map(),standardCarrierFiles:new Map(),standardCarrierPlans:new Map(),standardCarrierViews:new Map(),sourcePricePreviews:new Map(),tagCatalogRows:null,tagCatalogPromise:null,ablyJob:null,ablyJobSequence:0};
 const roles={
  playauto_product:{label:'PlayAuto · 판매가 + 옵션가',type:'product_price_option',hint:'쇼핑몰상품 시트',fileLabel:'쇼핑몰상품.xlsx'},
  playauto_option:{label:'PlayAuto · 옵션가 + 재고',type:'option_price_stock',hint:'옵션기본 시트 · V 추가 금액 / X *판매수량(실재고) / W 원본 보존',fileLabel:'옵션기본.xlsx'}
 };
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const n=v=>Number(v||0).toLocaleString('ko-KR');
 const fmtTime=v=>{if(!v)return '업로드 없음';const d=new Date(v);return Number.isNaN(d.getTime())?String(v):d.toLocaleString('ko-KR',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});};
 const currentFile=role=>state.files.find(row=>row.source_role===role)||null;
 const safeName=v=>String(v||'file').replace(/[\\/:*?"<>|]+/g,'_').trim().slice(0,120)||'file';

 const standardUiJobs=new Map(),standardLastActions=new Map(),standardRequests=new Map();
 function sellerPanel(source){return document.querySelector(`[data-seller-panel="${source}"]`);}
 function setSellerPanel(source,phase,message=''){
  const panel=sellerPanel(source);if(!panel)return;
  panel.dataset.state=phase;
  const progress=panel.querySelector(source==='ably'?'[data-ably-progress]':'[data-standard-progress]'),result=panel.querySelector(source==='ably'?'#export-preview-v2':'[data-standard-result]'),notice=panel.querySelector('[data-seller-notice]'),recovery=panel.querySelector('[data-seller-recovery]');
  if(progress)progress.hidden=phase!=='processing'&&!(source==='ably'&&phase==='error');
  if(result)result.hidden=phase!=='preview'&&!(source!=='ably'&&['success','error'].includes(phase));
  if(notice){notice.hidden=phase!=='idle'&&!(source==='ably'&&phase==='success');notice.textContent=message||'공식 수정파일을 선택하거나 변경분 미리보기를 시작하세요.';}
  if(recovery)recovery.hidden=phase!=='error';
  if(phase!=='processing'){
   const job=standardUiJobs.get(source);if(job)global.clearInterval(job.timer);
   standardUiJobs.delete(source);
  }
 }
 function resetSeller(source){
  if(source==='ably'){
   state.ablyJob?.cancel(false);state.ablyJob=null;state.preview=null;state.carrierFiles.clear();renderExportStatuses();
  }else{
   standardRequests.set(source,(standardRequests.get(source)||0)+1);
   state.standardCarrierFiles.delete(source);state.standardCarrierPlans.delete(source);state.standardCarrierViews.delete(source);state.sourcePricePreviews.delete(source);
   const button=document.querySelector(`[data-standard-carrier-run="${source}"]`);if(button){button.disabled=false;button.setAttribute('aria-disabled','true');button.removeAttribute('aria-busy');}
   const fileInfo=document.querySelector(`[data-selected-carrier="${source}"]`);if(fileInfo)fileInfo.textContent='선택한 파일 없음';
  }
  setSellerPanel(source,'idle','초기화했습니다. 다른 파일을 선택할 수 있습니다.');
 }
 function lockStandardGeneration(source,locked){
  const card=document.querySelector(`[data-standard-source="${source}"]`);if(!card)return;
  for(const node of card.querySelectorAll('[data-seller-reset],[data-standard-carrier-input],[data-standard-carrier-pick]'))node.disabled=locked;
 }
 function arrangeSellerRows(section,page){
  const cards=section.querySelectorAll('.export-channel-card');
  cards.forEach((card,index)=>{
   const source=card.dataset.standardSource||'ably',controls=document.createElement('div'),panel=document.createElement('div');
   card.dataset.sellerSource=source;controls.className='seller-export-controls';panel.className='seller-export-panel';panel.dataset.sellerPanel=source;panel.dataset.state='idle';panel.setAttribute('aria-live','polite');
   for(const child of [...card.children]){
    if(child.matches('.direct-export-progress,.direct-export-preview'))panel.append(child);else controls.append(child);
   }
   const reset=document.createElement('button');reset.type='button';reset.className='btn';reset.dataset.sellerReset=source;reset.textContent='초기화';reset.onclick=()=>resetSeller(source);controls.append(reset);
   if(source!=='ably'){
    const file=document.createElement('div');file.className='seller-selected-file';file.dataset.selectedCarrier=source;file.textContent='선택한 파일 없음';controls.append(file);
   }else{
    const preview=document.getElementById('export-preview-v2');if(preview)panel.append(preview);
   }
   const notice=document.createElement('div');notice.className='seller-state-notice';notice.dataset.sellerNotice='';panel.append(notice);
   const recovery=document.createElement('div');recovery.className='seller-state-recovery';recovery.dataset.sellerRecovery='';recovery.hidden=true;
   const retry=document.createElement('button');retry.type='button';retry.className='btn primary';retry.textContent='재시도';retry.onclick=()=>{if(source==='ably'){if(state.role)void preview(state.role);}else{const action=standardLastActions.get(source);if(action)void action();else void previewStandardCarrier(source);}};
   const clear=document.createElement('button');clear.type='button';clear.className='btn';clear.textContent='초기화';clear.onclick=()=>resetSeller(source);recovery.append(retry,clear);panel.append(recovery);
   card.append(controls,panel);setSellerPanel(source,'idle');
  });
  const historyNodes=[...page.children].filter(node=>node!==section&&!node.classList.contains('page-head'));
  if(historyNodes.length){const history=document.createElement('details');history.className='seller-export-history';const summary=document.createElement('summary');summary.textContent='작업 배치 · 과거 작업 · 감사 이력 펼치기';history.append(summary);historyNodes.forEach(node=>history.append(node));section.insertAdjacentElement('afterend',history);}
 }

 function sellerScopeMarkup(source){
  return `<div class="seller-card-scope" data-seller-scope="${source}">
   <label>대상 범위<select data-seller-scope-mode="${source}"><option value="all">파일에서 매칭되는 전체 SKU</option><option value="manual">SKU 직접 입력</option><option value="tag">태그 적용 SKU</option></select></label>
   <label class="seller-card-scope-detail" data-seller-scope-manual-wrap="${source}" hidden>SKU 목록<textarea data-seller-scope-manual="${source}" placeholder="10000-1&#10;10000-2"></textarea></label>
   <label class="seller-card-scope-detail" data-seller-scope-tag-wrap="${source}" hidden>태그<select data-seller-scope-tag="${source}"><option value="">태그 선택</option></select></label>
   ${['smartstore','makeshop'].includes(source)?`<label class="seller-field-mode-label">내보낼 항목<select data-standard-field-mode="${source}"><option value="price_stock">가격 + 재고 (기존)</option><option value="price_only">가격만</option><option value="stock_only">재고만</option></select></label><label class="seller-stock-source-label" data-standard-stock-source-wrap="${source}" hidden>재고 내보내기 기준<select data-standard-stock-source="${source}"><option value="available_stock">가용재고</option><option value="stock">재고</option></select></label>`:''}
   ${source==='ably'?`<label class="seller-field-mode-label">옵션가 + 재고 파일 항목<select data-ably-field-mode><option value="option_stock">옵션가 + 재고 (기존)</option><option value="price_only">옵션가만</option><option value="stock_only">재고만</option></select></label><label class="seller-stock-source-label" data-ably-stock-source-wrap hidden>재고 내보내기 기준<select data-ably-stock-source><option value="available_stock">가용재고</option><option value="stock">재고</option></select></label>`:''}
   ${['smartstore','makeshop'].includes(source)?`<label class="seller-price-mode-label">가격 계산<select data-standard-price-mode="${source}"><option value="rules">수식 적용 (기본)</option><option value="sellpia_source">셀피아 판매가 기준</option></select></label>`:source==='ably'?`<label class="seller-price-mode-label">판매가 + 옵션가 가격 계산<select data-standard-price-mode="ably"><option value="rules">수식 적용 (기본)</option><option value="sellpia_source">셀피아 판매가 기준</option></select></label>`:''}
   <small data-seller-scope-summary="${source}">파일에서 매칭되는 전체 SKU</small>
  </div>`;
 }

 function updateSellerScopeSummary(source){
  const mode=document.querySelector(`[data-seller-scope-mode="${source}"]`)?.value||'all',summary=document.querySelector(`[data-seller-scope-summary="${source}"]`);
  if(!summary)return;
  if(mode==='manual'){
   const values=String(document.querySelector(`[data-seller-scope-manual="${source}"]`)?.value||'').split(/[,\s]+/).map(value=>value.trim()).filter(Boolean);
   summary.textContent=values.length?`직접 입력 ${n(new Set(values).size)} SKU`:'SKU를 입력해주세요.';
   return;
  }
  if(mode==='tag'){
   const select=document.querySelector(`[data-seller-scope-tag="${source}"]`),option=select?.selectedOptions?.[0];
   summary.textContent=select?.value?(option?.textContent||'선택 태그'):'태그를 선택해주세요.';
   return;
  }
  summary.textContent='파일에서 매칭되는 전체 SKU';
 }

 function bindSellerScope(section,source){
  const mode=section.querySelector(`[data-seller-scope-mode="${source}"]`),manual=section.querySelector(`[data-seller-scope-manual="${source}"]`),tag=section.querySelector(`[data-seller-scope-tag="${source}"]`);
  if(!mode)return;
  mode.onchange=()=>{
   state.sourcePricePreviews.delete(source);
   const manualWrap=section.querySelector(`[data-seller-scope-manual-wrap="${source}"]`),tagWrap=section.querySelector(`[data-seller-scope-tag-wrap="${source}"]`);
   if(manualWrap)manualWrap.hidden=mode.value!=='manual';
   if(tagWrap)tagWrap.hidden=mode.value!=='tag';
   if(mode.value==='tag')void loadTags(source);
   updateSellerScopeSummary(source);
  };
  if(manual)manual.oninput=()=>{state.sourcePricePreviews.delete(source);updateSellerScopeSummary(source);};
  if(tag)tag.onchange=()=>{state.sourcePricePreviews.delete(source);updateSellerScopeSummary(source);};
  const priceMode=section.querySelector(`[data-standard-price-mode="${source}"]`);
  if(priceMode)priceMode.onchange=()=>{state.sourcePricePreviews.delete(source);if(source==='ably'){state.preview=null;setSellerPanel('ably','idle','가격 계산 방식이 바뀌었습니다. 판매가 + 옵션가 파일을 다시 미리보세요.');}};
  const fieldMode=section.querySelector(`[data-standard-field-mode="${source}"]`),stockSource=section.querySelector(`[data-standard-stock-source="${source}"]`),stockWrap=section.querySelector(`[data-standard-stock-source-wrap="${source}"]`);
  const syncFieldMode=()=>{const stockOnly=fieldMode?.value==='stock_only',priceOnly=fieldMode?.value==='price_only',recalculate=section.querySelector(`[data-standard-recalculate="${source}"]`);if(stockWrap)stockWrap.hidden=!stockOnly;if(priceMode)priceMode.disabled=stockOnly;if(recalculate){recalculate.hidden=stockOnly;recalculate.disabled=stockOnly;}state.sourcePricePreviews.delete(source);updateExportPresetState(section);if(stockOnly)setSellerPanel(source,'idle','재고-only는 선택한 셀피아 재고 기준만 판매처 재고 셀에 반영합니다. 가격과 기타 셀은 보존합니다.');else if(priceOnly)setSellerPanel(source,'idle','가격-only는 가격·옵션가만 반영하고 판매처 재고 셀은 원본 그대로 보존합니다.');};
  if(fieldMode){fieldMode.onchange=syncFieldMode;syncFieldMode();}
  if(stockSource)stockSource.onchange=()=>{state.sourcePricePreviews.delete(source);setSellerPanel(source,'idle','재고 기준이 바뀌었습니다. 같은 범위로 미리보기를 다시 실행하세요.');};
  const ablyFieldMode=section.querySelector('[data-ably-field-mode]'),ablyStockSource=section.querySelector('[data-ably-stock-source]'),ablyStockWrap=section.querySelector('[data-ably-stock-source-wrap]');
  const syncAblyFields=()=>{if(!ablyFieldMode)return;const stockOnly=ablyFieldMode.value==='stock_only',priceOnly=ablyFieldMode.value==='price_only';if(ablyStockWrap)ablyStockWrap.hidden=!stockOnly;if(priceMode)priceMode.disabled=stockOnly;state.preview=null;updateExportPresetState(section);setSellerPanel('ably','idle',stockOnly?'옵션가 + 재고 파일에서 선택한 Sellpia 재고만 X열에 반영합니다. V/W와 나머지 셀은 보존합니다.':priceOnly?'옵션가 + 재고 파일에서 V 옵션 추가금액만 반영하고 X/W 재고 셀은 보존합니다.':'옵션가 + 재고 기존 계약을 사용합니다.');};
  if(source==='ably'&&ablyFieldMode){ablyFieldMode.onchange=syncAblyFields;syncAblyFields();}
  if(source==='ably'&&ablyStockSource)ablyStockSource.onchange=()=>{state.preview=null;setSellerPanel('ably','idle','재고 기준이 바뀌었습니다. 옵션가 + 재고 파일을 다시 미리보세요.');};
  updateSellerScopeSummary(source);
 }

function standardSelection(source){
  const fieldMode=document.querySelector(`[data-standard-field-mode="${source}"]`)?.value||'price_stock',stockOnly=fieldMode==='stock_only',priceOnly=fieldMode==='price_only';
  return {fieldMode,stockOnly,priceOnly,includePrice:!stockOnly,includeStock:!priceOnly,stockSource:stockOnly?(document.querySelector(`[data-standard-stock-source="${source}"]`)?.value||'available_stock'):null,priceMode:document.querySelector(`[data-standard-price-mode="${source}"]`)?.value||'rules'};
}

 async function loadCurrentPriceDecisionState(source,skus){
  const resolver=global.HubCurrentPriceDecisionResolver;
  if(!resolver||!D()?.loadCurrentPriceDecisions)throw Error('현재 가격 결정 조회 모듈을 불러오지 못했습니다.');
  const response=await D().loadCurrentPriceDecisions({source,skus});
  const decisions=resolver.normalize(response,{source,skus});
  return {decisions,proof:resolver.proof(decisions)};
 }

 function updateExportPresetState(section=document.getElementById('export-workflow-v2')){
  if(!section)return;
  const standard=[...section.querySelectorAll('[data-standard-field-mode]')].map(node=>node.value),ably=section.querySelector('[data-ably-field-mode]')?.value;
  const normalizedAbly=ably==='option_stock'?'price_stock':ably;
  const active=standard.length&&standard.every(value=>value===standard[0])&&standard[0]===normalizedAbly?standard[0]:'';
  section.querySelectorAll('[data-export-field-preset]').forEach(button=>{const selected=button.dataset.exportFieldPreset===active;button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected));});
 }

 function bindExportPresets(section){
  section.querySelectorAll('[data-export-field-preset]').forEach(button=>button.onclick=()=>applyExportFieldPreset(section,button.dataset.exportFieldPreset));
  updateExportPresetState(section);
 }

 function applyExportFieldPreset(section,mode,{onlyWhenChanged=false}={}){
  if(!section)return;
  section.querySelectorAll('[data-standard-field-mode]').forEach(select=>{const changed=select.value!==mode;select.value=mode;if(!onlyWhenChanged||changed)select.dispatchEvent(new Event('change',{bubbles:true}));});
  const ably=section.querySelector('[data-ably-field-mode]');if(ably){const value=mode==='price_stock'?'option_stock':mode,changed=ably.value!==value;ably.value=value;if(!onlyWhenChanged||changed)ably.dispatchEvent(new Event('change',{bubbles:true}));}
  updateExportPresetState(section);
 }

 function setStatus(text,kind=''){
  for(const id of ['seller-file-status','export-workflow-status']){const el=document.getElementById(id);if(el){el.className=`${id} ${kind}`.trim();el.textContent=text;}}
  const exportStatus=document.getElementById('export-workflow-status');
  if(exportStatus)exportStatus.hidden=kind!=='error'||Boolean(document.querySelector('[data-seller-panel][data-state="error"]'));
 }

 // Progress is phase-based. Counts are only shown when a phase has actually processed rows.
 // Cancelling invalidates the browser job, not an already submitted read-only RPC.
 const ablyPhases=[['read','파일 읽기',5],['parse','XLSX 파싱',15],['normalize','row 정규화',25],['match','SKU / identity 매칭',40],['targets','가격·재고 조회',65],['guards','guard / 변환 가능성 검증',80],['preview','preview 생성',95],['serialize','XLSX 생성',98],['done','완료',100]];
 const carrierNow=()=>global.performance?.now?.()??Date.now();
 function carrierCancelled(){const error=Error('파일 처리가 취소되었습니다.');error.name='CarrierCancelledError';return error;}
 function createAblyJob(role,file){
  if(state.ablyJob?.running)state.ablyJob.cancel(false);
  const started=carrierNow(),job={id:++state.ablyJobSequence,role,file,running:true,phase:'read',processed:null,total:null,started,lastProgress:started,phaseStarted:started,timings:[],error:'',cancelled:false};
  state.ablyJob=job;
  job.check=()=>{if(job.cancelled||state.ablyJob!==job)throw carrierCancelled();};
  job.render=()=>{
   if(state.ablyJob!==job)return;
   const box=document.querySelector('[data-ably-progress]');if(!box)return;
   box.hidden=false;
   const phase=ablyPhases.find(item=>item[0]===job.phase)||ablyPhases[0],elapsed=Math.max(0,Math.floor((carrierNow()-started)/1000)),delay=job.running&&carrierNow()-job.lastProgress>=30000;
   box.dataset.state=job.running?'running':job.cancelled?'cancelled':job.error?'error':'done';
   if(typeof setSellerPanel==='function')setSellerPanel('ably',job.running?'processing':job.error?'error':job.cancelled?'idle':'preview');
   const title=box.querySelector('[data-ably-progress-title]'),detail=box.querySelector('[data-ably-progress-detail]'),bar=box.querySelector('[data-ably-progress-bar]'),cancel=box.querySelector('[data-ably-progress-cancel]');
   if(title)title.textContent=job.error?`${phase[1]} · 파일 처리 실패`:job.cancelled?'파일 처리 취소':phase[1]+(job.processed===null?'':` · ${n(job.processed)} / ${n(job.total)}`);
   if(detail)detail.textContent=job.error||`${file.name} · ${elapsed}초${delay?' · 처리 지연 감지 — 응답 대기 중입니다. 취소 후 다른 파일을 선택할 수 있습니다.':''}`;
   if(bar)bar.style.width=(job.running?phase[2]:job.error||job.cancelled?phase[2]:100)+'%';
   if(cancel){cancel.disabled=!job.running;cancel.onclick=()=>job.cancel(true);}
  };
  job.phaseTo=(phase,processed=null,total=null)=>{
   job.check();const now=carrierNow();
   if(job.phase!==phase){job.timings.push({phase:job.phase,ms:Math.round(now-job.phaseStarted),processed:job.processed,total:job.total});job.phaseStarted=now;}
   if(job.phase!==phase||job.processed!==processed||job.total!==total)job.lastProgress=now;
   job.phase=phase;job.processed=processed;job.total=total;job.render();
  };
  job.finish=error=>{
   if(state.ablyJob!==job||job.cancelled)return;
   const now=carrierNow();job.timings.push({phase:job.phase,ms:Math.round(now-job.phaseStarted),processed:job.processed,total:job.total});
   job.totalMs=Math.round(now-started);job.error=error?String(error?.message||error):'';job.running=false;if(!error)job.phase='done';global.clearInterval(job.timer);job.render();
   const timing=job.timings.map(item=>`${item.phase} ${item.ms}ms`).join(' · '),detail=document.querySelector('[data-ably-progress-detail]');
   const queries=(job.queries||[]).map(query=>`${query.query}: ${query.scope_count}개 / ${query.latency_ms}ms / ${query.status}`).join(' · ');
   if(detail)detail.textContent=(job.error?job.error+' · ':'')+`${file.name} · 총 ${job.totalMs}ms · ${timing} · DB 조회 ${(job.queries||[]).length}회${queries?' · '+queries:''}`;
  };
  job.cancel=visible=>{
   job.cancelled=true;job.running=false;global.clearInterval(job.timer);
   if(state.ablyJob!==job)return;
   state.preview=null;const previewBox=document.getElementById('export-preview-v2');if(previewBox)previewBox.hidden=true;
   if(visible){if(state.carrierFiles.get(role)===file)state.carrierFiles.delete(role);renderExportStatuses();job.render();setStatus('파일 처리를 취소했습니다. 다른 공식 수정파일을 선택할 수 있습니다.');}
  };
  job.mapRows=async(items,resolve)=>{
   const output=[];job.phaseTo(job.phase,0,items.length);
   for(let offset=0;offset<items.length;offset+=250){job.check();output.push(...items.slice(offset,offset+250).map(resolve));job.phaseTo(job.phase,output.length,items.length);await new Promise(resolveYield=>global.setTimeout(resolveYield,0));}
   job.check();return output;
  };
  job.timer=global.setInterval(job.render,1000);job.render();return job;
 }

 async function loadStatuses(){
  try{
   const [result,standard]=await Promise.all([D().loadAuxiliarySellerFiles('ably'),D().loadLatestSellerOriginalStatus(['smartstore','makeshop'])]);
   state.files=result.rows||[];state.standardStatuses=standard||[];renderUploadStatuses();renderExportStatuses();renderStandardStatuses();
  }catch(error){setStatus(`판매처 원본 상태 조회 실패: ${error?.message||error}`,'error');}
 }

 async function catalog(productCodes=[],silent=false,onQuery=null){
  const normalized=[...new Set((productCodes||[]).map(value=>String(value||'').trim()).filter(Boolean))].sort(),key=normalized.join('\u0000');
  if(state.catalog&&state.catalogKey===key)return state.catalog;
  if(!silent)setStatus('셀피아 SKU·상품코드·옵션명을 불러오는 중…');
  state.catalog=await D().loadPlayautoSellpiaCatalog(normalized,onQuery);
  state.catalogKey=key;
  return state.catalog;
 }

 function uploadCard(role){
  const config=roles[role];
  return `<article class="ably-file-card" data-role="${role}">
   <header><h4>${esc(config.label)}</h4><span>${esc(config.hint)}</span></header>
   <p>에이블리 수정 업로드용 PlayAuto 원본을 보관합니다. 내보낼 때 이 파일의 구조·서식을 그대로 사용합니다.</p>
   <div class="ably-file-card-status" data-file-status="${role}">상태 확인 중…</div>
   <input type="file" data-file-input="${role}" accept=".xlsx,.xls">
   <button class="btn" type="button" data-file-pick="${role}">파일 선택·업로드</button>
  </article>`;
 }

 function ensureUpload(){
  const page=document.getElementById('upload'),layout=page?.querySelector('.upload-layout'),source=document.getElementById('source-select');
  if(page)global.HubSourceLifecycle?.mount(page);
  if(!page||!layout||!source||document.getElementById('ably-file-set'))return;
  const section=document.createElement('section');section.id='ably-file-set';section.className='ably-file-set';section.hidden=source.value!=='ably';
  section.innerHTML=`<div class="ably-file-set-head"><div><h3>에이블리 장기 원본</h3><p>GOODS_LIST와 판매가·옵션가 ALL만 장기 reference로 보관합니다. 옵션가·재고 부분 수정파일은 내보내기 화면에서 브라우저 메모리로만 처리합니다.</p></div><button class="btn" id="ably-file-refresh" type="button">상태 새로고침</button></div><div class="ably-file-set-grid"><article class="ably-file-card"><header><h4>에이블리 전체 원본 · GOODS_LIST</h4><span>조회·매칭용</span></header><p>상품/옵션 존재 확인과 판매처 매칭 검증에 사용합니다. 이 파일 자체를 수정 업로드용으로 다시 내보내지 않습니다.</p><div class="ably-file-card-status ready">위의 기존 에이블리 원본 업로드 기능으로 등록</div></article>${uploadCard('playauto_product')}<article class="ably-file-card"><header><h4>옵션가·재고 수정파일</h4><span>임시 carrier</span></header><p>Storage에 저장하지 않습니다. 판매처 내보내기 화면에서 파일을 선택해 즉시 변환합니다.</p><div class="ably-file-card-status ready">브라우저 세션 동안만 사용</div></article></div><div id="seller-file-status" class="export-workflow-status">장기 원본과 임시 carrier를 분리해 관리합니다.</div>`;
  layout.insertAdjacentElement('afterend',section);
  const syncVisibility=()=>{section.hidden=source.value!=='ably';if(!section.hidden)void loadStatuses();};
  source.addEventListener('change',syncVisibility);
  document.getElementById('ably-file-refresh').onclick=()=>void loadStatuses();
  section.querySelectorAll('[data-file-pick]').forEach(btn=>btn.onclick=()=>section.querySelector(`[data-file-input="${btn.dataset.filePick}"]`)?.click());
  section.querySelectorAll('[data-file-input]').forEach(input=>input.onchange=()=>{const file=input.files?.[0];if(file)void uploadRole(input.dataset.fileInput,file);input.value='';});
  if(!section.hidden)void loadStatuses();
 }

 function renderUploadStatuses(){
  for(const role of Object.keys(roles)){
   const el=document.querySelector(`[data-file-status="${role}"]`);if(!el)continue;
   const row=currentFile(role);
   if(!row){el.className='ably-file-card-status warn';el.textContent='등록된 파일 없음';continue;}
   el.className='ably-file-card-status ready';
   el.textContent=`${row.file_name} · ${fmtTime(row.created_at)} · ${n(row.row_count)}행 · 매칭 ${n(row.matched_count)} / 미확정 ${n(row.unresolved_count)}`;
  }
 }

 async function uploadRole(role,file){
  const config=roles[role];if(!config)return;
  setStatus(`${config.label} 파일을 검사하는 중…`);
  try{
   const parsed=await A().readTemplate(file);
   if(parsed.type!==config.type)throw Error(`${config.label} 양식이 아닙니다. 감지된 형식: ${parsed.type||'알 수 없음'}`);
   const [catalogRows,mappingResult]=await Promise.all([
    catalog(parsed.items.map(item=>item.sellpia_product_code)),
    D().loadCarrierSellerMappings({source:'ably',identities:parsed.items})
   ]);
   const resolved=A().resolveRows(parsed.items,catalogRows,mappingResult.rows||[]);
   const matched=resolved.filter(item=>item.resolution?.sku).length,unresolved=resolved.length-matched;
   setStatus(`양식 확인 완료 · ${n(resolved.length)}행 · 매칭 ${n(matched)} · 미확정 ${n(unresolved)} · 업로드 중…`);
   await D().uploadAuxiliarySellerFile({
    sourceChannel:'ably',sourceRole:role,file,rowCount:resolved.length,matchedCount:matched,unresolvedCount:unresolved,
    metadata:{detected_type:parsed.type,sheet:parsed.sheet}
   });
   state.catalog=null;await loadStatuses();setStatus(`${config.label} 저장 완료`,'success');
  }catch(error){setStatus(`파일 저장 실패: ${error?.message||error}`,'error');}
 }

 function ensureExport(){
  const page=document.getElementById('jobs'),head=page?.querySelector('.page-head');
  if(!page||!head||document.getElementById('export-workflow-v2'))return;
  page.querySelector('.export-hub')?.remove();
  const section=document.createElement('section');section.id='export-workflow-v2';section.className='export-workflow-v2';
   section.innerHTML=`<header><h3>판매처 파일 내보내기</h3><p>각 판매처 카드에서 파일 전체·직접 입력·태그 적용 SKU 범위를 선택합니다. 스마트스토어·메이크샵은 변경분 또는 선택한 공식 수정파일을 변환합니다.</p></header>
    <div class="seller-export-field-presets" aria-label="판매처 내보내기 필드 빠른 선택"><div><b>내보낼 필드 빠른 선택</b><span>모든 판매처 카드에 같은 모드를 적용합니다. 카드별로 다시 바꿀 수도 있습니다.</span></div><div><button class="btn active" type="button" data-export-field-preset="price_stock" aria-pressed="true">가격 + 재고</button><button class="btn" type="button" data-export-field-preset="price_only" aria-pressed="false">가격만</button><button class="btn" type="button" data-export-field-preset="stock_only" aria-pressed="false">재고만</button></div></div>
    <div class="export-channel-grid">
      <article class="export-channel-card" data-standard-source="smartstore"><header><h4>스마트스토어</h4><span>원본 양식</span></header><p>현재 매트릭스와 다른 안전 상품 묶음만 생성하거나, 직접 받은 공식 부분 수정 XLSX를 메모리에서 변환합니다.</p><div class="export-role-status" data-standard-status="smartstore">원본 상태 확인 중…</div><div class="export-role-status matrix-stock-state" data-matrix-stock-status="smartstore">재고 상태 확인 전 · 새 수정안을 계산하지 않습니다.</div>${sellerScopeMarkup('smartstore')}<input type="file" data-standard-carrier-input="smartstore" accept=".xlsx,.xls"><div class="direct-export-actions"><button class="btn" type="button" data-standard-full-preview="smartstore">전체 원본 미리보기</button><button class="btn primary" type="button" data-standard-full-run="smartstore">전체 원본 XLSX 생성</button><button class="btn" type="button" data-standard-preview="smartstore">변경분 미리보기</button><button class="btn primary" type="button" data-standard-run="smartstore">변경분 XLSX 생성</button><button class="btn" type="button" data-standard-carrier-pick="smartstore">수정파일 선택</button><button class="btn primary" type="button" data-standard-carrier-run="smartstore" aria-disabled="true">선택 파일 변환</button><button class="btn wide" type="button" data-standard-recalculate="smartstore">선택 범위 가격 재계산</button></div><div class="direct-export-progress" data-standard-progress="smartstore" hidden><div class="direct-export-progress-head"><b data-progress-title>파일 생성 준비</b><span data-progress-percent>0%</span></div><div class="direct-export-progress-track"><i data-progress-bar style="width:0%"></i></div><small data-progress-detail>대상 범위와 원본을 확인합니다.</small></div><div class="direct-export-preview" data-standard-result="smartstore">변경분을 확인하거나 공식 수정파일을 선택하세요.</div></article>
      <article class="export-channel-card" data-standard-source="makeshop"><header><h4>메이크샵</h4><span>원본 양식</span></header><p>현재 매트릭스와 다른 안전 상품 묶음만 생성하거나, 직접 받은 공식 부분 수정 XLSX를 메모리에서 변환합니다.</p><div class="export-role-status" data-standard-status="makeshop">원본 상태 확인 중…</div><div class="export-role-status matrix-stock-state" data-matrix-stock-status="makeshop">재고 상태 확인 전 · 새 수정안을 계산하지 않습니다.</div>${sellerScopeMarkup('makeshop')}<input type="file" data-standard-carrier-input="makeshop" accept=".xlsx,.xls"><div class="direct-export-actions"><button class="btn" type="button" data-standard-full-preview="makeshop">전체 원본 미리보기</button><button class="btn primary" type="button" data-standard-full-run="makeshop">전체 원본 XLSX 생성</button><button class="btn" type="button" data-standard-preview="makeshop">변경분 미리보기</button><button class="btn primary" type="button" data-standard-run="makeshop">변경분 XLSX 생성</button><button class="btn" type="button" data-standard-carrier-pick="makeshop">수정파일 선택</button><button class="btn primary" type="button" data-standard-carrier-run="makeshop" aria-disabled="true">선택 파일 변환</button><button class="btn wide" type="button" data-standard-recalculate="makeshop">선택 범위 가격 재계산</button></div><div class="direct-export-progress" data-standard-progress="makeshop" hidden><div class="direct-export-progress-head"><b data-progress-title>파일 생성 준비</b><span data-progress-percent>0%</span></div><div class="direct-export-progress-track"><i data-progress-bar style="width:0%"></i></div><small data-progress-detail>대상 범위와 원본을 확인합니다.</small></div><div class="direct-export-preview" data-standard-result="makeshop">변경분을 확인하거나 공식 수정파일을 선택하세요.</div></article>
      <article class="export-channel-card"><header><h4>에이블리 · PlayAuto 빠른 변환</h4><span>전용 양식</span></header><p>두 공식 수정파일 모두 Storage에 저장하지 않고 브라우저 메모리에서 미리보기 후 변환합니다. 장기 원본은 별도로 유지됩니다.</p><div class="export-role-status">에이블리 할인은 공식 파일에 지원 컬럼이 없어 자동 반영하지 않습니다. 판매처 관리자에서 수동 관리하세요.</div>${sellerScopeMarkup('ably')}
      <div class="export-role-status" data-export-file="playauto_product"></div>
      <div class="export-role-status" data-export-file="playauto_option"></div>
      <input type="file" data-carrier-input="playauto_product" accept=".xlsx,.xls"><input type="file" data-carrier-input="playauto_option" accept=".xlsx,.xls"><div class="ably-export-actions"><button class="btn" type="button" data-carrier-pick="playauto_product">판매가 + 옵션가 파일 선택</button><button class="btn" type="button" data-carrier-pick="playauto_option">옵션가 + 재고 파일 선택</button><button class="btn wide" type="button" data-page-upload-ably>장기 원본 관리</button></div>
      <div class="direct-export-progress" data-ably-progress hidden aria-live="polite"><div class="direct-export-progress-head"><b data-ably-progress-title>파일 읽기</b><button class="btn" type="button" data-ably-progress-cancel>취소 / 초기화</button></div><div class="direct-export-progress-track"><i data-ably-progress-bar style="width:0%"></i></div><small data-ably-progress-detail></small></div>
    </article>
   </div>
   <section id="export-preview-v2" class="export-preview-v2" hidden><div class="export-preview-head"><div><h4 id="export-preview-title">미리보기</h4><p id="export-preview-copy"></p></div><button class="btn" id="export-preview-close" type="button">닫기</button></div><div id="export-preview-counts" class="export-preview-counts"></div><div class="export-preview-table-wrap"><table class="export-preview-table"><thead><tr><th>SKU</th><th>현재값</th><th>저장값</th><th>상태</th></tr></thead><tbody id="export-preview-rows"></tbody></table></div><div class="export-preview-footer"><div id="export-preview-pagination"></div><button class="btn primary" id="export-preview-generate" type="button">검증된 값으로 XLSX 생성</button></div></section>
   <div id="export-workflow-status" class="export-workflow-status">내보내기 전에 미리보기에서 매칭·변경·제외 건수를 확인하세요.</div>`;
  head.insertAdjacentElement('afterend',section);
  arrangeSellerRows(section,page);
  global.SellpiaPatchExport?.mount(section.querySelector('.export-channel-grid'));
  // UI preview release: canary controls are not mounted, including URL opt-in.
  document.getElementById('export-workflow-status').hidden=true;

  for(const source of ['smartstore','makeshop','ably'])bindSellerScope(section,source);
  bindExportPresets(section);

  if(!section.dataset.progressBound){section.dataset.progressBound='1';global.addEventListener('system-v3-seller-export-progress',event=>{const d=event.detail||{};if(d.source)standardProgress(d.source,d.percent,d.title,d.detail,d.percent>=100?'done':'running');});}
  section.querySelectorAll('[data-standard-full-preview]').forEach(btn=>btn.onclick=()=>{const source=btn.dataset.standardFullPreview;standardLastActions.set(source,()=>previewStandard(source,'full_original'));void previewStandard(source,'full_original');});
  section.querySelectorAll('[data-standard-full-run]').forEach(btn=>btn.onclick=()=>{const source=btn.dataset.standardFullRun;standardLastActions.set(source,()=>runStandard(source,'full_original'));void runStandard(source,'full_original');});
  section.querySelectorAll('[data-standard-preview]').forEach(btn=>btn.onclick=()=>{const source=btn.dataset.standardPreview;standardLastActions.set(source,()=>previewStandard(source));void previewStandard(source);});
  section.querySelectorAll('[data-standard-run]').forEach(btn=>btn.onclick=()=>{const source=btn.dataset.standardRun;standardLastActions.set(source,()=>runStandard(source));void runStandard(source);});
  section.querySelectorAll('[data-standard-carrier-pick]').forEach(btn=>btn.onclick=()=>section.querySelector(`[data-standard-carrier-input="${btn.dataset.standardCarrierPick}"]`)?.click());
  section.querySelectorAll('[data-standard-carrier-input]').forEach(input=>input.onchange=()=>{const file=input.files?.[0];if(file){state.standardCarrierFiles.set(input.dataset.standardCarrierInput,file);void previewStandardCarrier(input.dataset.standardCarrierInput,file);}input.value='';});
  section.querySelectorAll('[data-standard-carrier-run]').forEach(btn=>btn.onclick=()=>void runStandardCarrier(btn.dataset.standardCarrierRun));
  section.querySelectorAll('[data-standard-recalculate]').forEach(btn=>btn.onclick=()=>void recalculateStandardScope(btn.dataset.standardRecalculate));
  section.querySelector('[data-page-upload-ably]').onclick=()=>{document.querySelector('.nav-item[data-page="upload"]')?.click();setTimeout(()=>{const source=document.getElementById('source-select');if(source){source.value='ably';source.dispatchEvent(new Event('change',{bubbles:true}));}},80);};
  section.querySelectorAll('[data-preview-role]').forEach(btn=>btn.onclick=()=>void preview(btn.dataset.previewRole));
  section.querySelectorAll('[data-carrier-pick]').forEach(btn=>btn.onclick=()=>section.querySelector(`[data-carrier-input="${btn.dataset.carrierPick}"]`)?.click());
  section.querySelectorAll('[data-carrier-input]').forEach(input=>input.onchange=()=>{const file=input.files?.[0];if(file){state.carrierFiles.set(input.dataset.carrierInput,file);renderExportStatuses();void preview(input.dataset.carrierInput);}input.value='';});
  document.getElementById('export-preview-close').onclick=()=>setSellerPanel('ably','idle','미리보기를 닫았습니다. 파일을 다시 선택하거나 재시도할 수 있습니다.');
  document.getElementById('export-preview-generate').onclick=()=>void generate();
  void loadStatuses();renameLegacyExportUi();
 }

 function renderStandardStatuses(){
  for(const source of ['smartstore','makeshop']){
   const el=document.querySelector(`[data-standard-status="${source}"]`);if(!el)continue;
   const row=(state.standardStatuses||[]).find(item=>item.source===source);
   if(!row?.available){el.className='export-role-status missing';el.textContent='최신 보관 원본 없음 · 먼저 원본 업로드 필요';continue;}
   el.className='export-role-status ready';
   el.textContent=`${row.fileNames?.length||0}개 보관 · ${fmtTime(row.completedAt)}`;
  }
 }

 async function directScopeSkus(source){
  const scope=await scopeSkus(source);
  return scope?[...scope]:null;
 }

 function standardResult(source,text,kind=''){
  const el=document.querySelector(`[data-standard-result="${source}"]`);if(!el)return;
  if(kind==='error'&&sellerPanel(source)?.dataset.state==='processing'){
   const phase=document.querySelector(`[data-standard-progress="${source}"] [data-progress-title]`)?.textContent;
   if(phase)text=`실패 단계: ${phase} · ${text}`;
  }
  el.className=`direct-export-preview ${kind}`.trim();el.textContent=text;
  setSellerPanel(source,kind==='error'?'error':kind==='success'?'success':'processing');
 }

 function carrierPriceTuple(value){
  if(!value)return '가격 원본 정보 없음';
  const show=number=>number===null||number===undefined||number===''?'—':n(number);
  return `기준 ${show(value.base)} / 할인 ${show(value.discounted)} / 옵션 ${show(value.option)} / 최종 ${show(value.final)}`;
 }

 function renderTransformationPlan(source,file,result){
  const renderStarted=global.performance?.now?.()??Date.now(),plan=result?.plan,el=document.querySelector(`[data-standard-result="${source}"]`);if(!el)return;
  if(!plan||plan.kind!=='TransformationPlan'){standardResult(source,'TransformationPlan을 만들지 못했습니다. 새로고침 후 다시 확인해주세요.','error');return;}
  state.standardCarrierPlans.set(source,plan);
  const c=plan.summary||{},states=c.price_states||{},operations=plan.operations||[],priceOps=operations.filter(item=>item.field_key==='sellpia_sale_price').length,stockOps=operations.filter(item=>item.field_key==='sellpia_current_stock').length,view=state.standardCarrierViews.get(source)||{filter:'all',page:1},allRows=plan.preview||[];
  const matchesFilter=row=>view.filter==='all'||(view.filter==='changed'&&row.changed)||(view.filter==='unchanged'&&row.status==='ready'&&!row.changed)||(view.filter==='fallback'&&row.status==='warn_keep_original')||(view.filter==='blocked'&&row.status==='blocked');
  const filtered=allRows.filter(matchesFilter),pageSize=100,totalPages=Math.max(1,Math.ceil(filtered.length/pageSize));view.page=Math.min(Math.max(1,view.page||1),totalPages);state.standardCarrierViews.set(source,view);
  const rows=filtered.slice((view.page-1)*pageSize,view.page*pageSize),stateClass=code=>code==='calculated_complete'?'complete':code==='latest_generation_unreflected'?'stale':code==='timeout_error'?'error':'fallback';
  const filterButton=(code,label,count)=>`<button type="button" class="export-preview-filter ${view.filter===code?'active':''}" data-plan-filter="${code}">${esc(label)} ${n(count)}</button>`;
  el.className='direct-export-preview transformation-plan-preview';
  setSellerPanel(source,'preview');
  el.innerHTML=`<div class="transformation-plan-head"><b>${esc(file.name)} · TransformationPlan</b><span>브라우저 메모리 · Storage 저장 안 함</span></div>
   <div class="transformation-plan-summary"><span>입력 ${n(c.total)}</span><span>매칭 ${n(c.matched)}</span><span>변경 ${n(c.changed)}</span><span>가격 변경 ${n(priceOps)}</span><span>재고 변경 ${n(stockOps)}</span><span>변경 없음 ${n(c.unchanged)}</span><span>경고 상품 ${n(c.warning_products||0)}</span><span>경고 identity ${n(c.warned)}</span><span>치명적 차단 ${n(c.blocked)}</span><span>정상 완료 ${n(states.calculated_complete)}</span><span>latest generation 미반영 ${n(states.latest_generation_unreflected)}</span><span>timeout/error ${n(states.timeout_error)}</span><span>원본 fallback ${n(states.original_fallback)}</span></div>
   <div class="transformation-plan-filters">${filterButton('all','전체',allRows.length)}${filterButton('changed','변경',c.changed)}${filterButton('unchanged','변경 없음',c.unchanged)}${filterButton('fallback','원본 유지 경고',c.warned)}${filterButton('blocked','치명적 차단',c.blocked)}</div>
   <div class="transformation-plan-warning">${esc(plan.safety?.reason||'가격 계산 상태를 재검증해야 합니다.')} · XLSX: 변경 셀 노랑 / 원본 유지 경고 셀 빨강 · 생성 시 대상 SKU만 다시 확인합니다. · 처리 ${((plan.timings?.total_ms||0)/1000).toFixed(2)}초</div>
   <details class="transformation-plan-warning"><summary>조회 진단 · ${n(plan.diagnostics?.query_count)}회 · ${n(plan.diagnostics?.sku_count)} SKU · 전체 snapshot 없음</summary>${Object.entries(plan.timings||{}).map(([key,value])=>`${esc(key)} ${n(value)}ms`).join(' · ')}<br>${(plan.diagnostics?.queries||[]).map(query=>`${esc(query.query)} · 대상 ${n(query.scope_count)} · ${n(query.latency_ms)}ms · ${esc(query.status)}`).join('<br>')}</details>
   <div class="transformation-plan-table-wrap"><table class="transformation-plan-table"><thead><tr><th>행 / SKU</th><th>상품 · 옵션</th><th>현재값</th><th>preview 저장값</th><th>상태 / 사유</th></tr></thead><tbody>${rows.map(row=>{const diff=row.diff||{},stock=diff.stock||{},price=diff.price||{},priceState=row.price_state||{},status=row.status==='blocked'?'치명적 차단':row.status==='warn_keep_original'?(row.changed?'변경 + 가격 원본 유지 경고':'가격 원본 유지 경고'):row.shared_price_warning?(row.changed?'변경 + 공유가격 원본 유지':'공유가격 원본 유지'):row.changed?'변경':'변경 없음';return `<tr class="export-row-${row.status==='blocked'?'blocker':row.status==='warn_keep_original'||row.shared_price_warning?'warning':row.changed?'change':'unchanged'}"><td>${esc(row.source_row_no??'—')} / ${esc(row.sku||'—')}</td><td>${esc(row.product_code||'—')} · ${esc(row.option_code||'—')}</td><td>재고 ${esc(stock.before??'—')}<br>${esc(carrierPriceTuple(price.before))}</td><td>재고 ${esc(stock.after??stock.before??'—')}<br>${esc(carrierPriceTuple(price.after||price.before))}</td><td class="price-state ${stateClass(priceState.code)}"><b>${status}</b><br>${esc(priceState.label||'원본 유지')}<br><small>${esc(row.reason||row.shared_price_reason||priceState.detail||'')}</small></td></tr>`;}).join('')||'<tr><td colspan="5">이 조건에 해당하는 항목이 없습니다.</td></tr>'}</tbody></table></div>
   <div class="transformation-plan-limit"><button type="button" class="btn" data-plan-page="prev" ${view.page<=1?'disabled':''}>이전</button><span>${n(view.page)} / ${n(totalPages)} · ${n(filtered.length)}행</span><button type="button" class="btn" data-plan-page="next" ${view.page>=totalPages?'disabled':''}>다음</button></div>`;
  el.querySelector('.transformation-plan-filters')?.addEventListener('click',event=>{const button=event.target.closest?.('[data-plan-filter]');if(!button)return;state.standardCarrierViews.set(source,{filter:button.dataset.planFilter,page:1});renderTransformationPlan(source,file,result);});
  el.querySelector('.transformation-plan-limit')?.addEventListener('click',event=>{const button=event.target.closest?.('[data-plan-page]');if(!button)return;view.page+=button.dataset.planPage==='next'?1:-1;state.standardCarrierViews.set(source,view);renderTransformationPlan(source,file,result);});
  plan.timings=plan.timings||{};plan.timings.dom_render_ms=Math.round((global.performance?.now?.()??Date.now())-renderStarted);
  const button=document.querySelector('[data-standard-carrier-run="'+source+'"]');if(button){button.disabled=false;button.dataset.planCanGenerate=String(Boolean(plan.canGenerate));button.setAttribute('aria-disabled',String(!plan.canGenerate));button.title=plan.canGenerate?'생성 직전에 같은 대상 SKU의 가격·재고 상태를 재검증합니다.':(plan.safety?.reason||'가격 결과가 완결되지 않았거나 stale이므로 XLSX 생성을 차단합니다.');}
 }

 function standardProgress(source,percent,title,detail,stateName='running'){
  const box=document.querySelector(`[data-standard-progress="${source}"]`);if(!box)return;
  const safe=Math.max(0,Math.min(100,Math.round(Number(percent)||0)));
  box.hidden=false;box.dataset.state=stateName;
  const titleNode=box.querySelector('[data-progress-title]'),percentNode=box.querySelector('[data-progress-percent]'),bar=box.querySelector('[data-progress-bar]'),detailNode=box.querySelector('[data-progress-detail]');
  if(titleNode)titleNode.textContent=title||'파일 생성 중';
  if(percentNode)percentNode.textContent=`${safe}%`;
  if(bar)bar.style.width=`${safe}%`;
  if(detailNode)detailNode.textContent=detail||'';
  if(stateName==='running'){
   setSellerPanel(source,'processing');
   if(!standardUiJobs.has(source)){
    const started=carrierNow(),elapsed=document.createElement('small');elapsed.dataset.progressElapsed='';box.append(elapsed);
    box.querySelectorAll('[data-progress-elapsed]').forEach(node=>{if(node!==elapsed)node.remove();});
    const job={started,lastProgress:carrierNow(),timer:global.setInterval(()=>{elapsed.textContent=`경과 ${Math.floor((carrierNow()-started)/1000)}초${carrierNow()-job.lastProgress>=30000?' · 처리 지연 감지 — 응답 대기 중입니다. 초기화 후 다른 파일을 선택할 수 있습니다.':''}`;},1000)};standardUiJobs.set(source,job);
   }
   standardUiJobs.get(source).lastProgress=carrierNow();
  }
 }

 async function refreshMatrixStockStatus(source,skus=null){
  const el=document.querySelector('[data-matrix-stock-status="'+source+'"]');if(!el)return null;
  el.textContent='매트릭스 재고 반영 상태 확인 중…';
  try{const r=await D().summarizeMatrixStocksForExport({source,skus});el.className='export-role-status matrix-stock-state ready';el.textContent='재고 상태 · 판매처 반영 '+n(r.applied)+'건 · 수정안 있음 '+n(r.draft)+'건 · 미반영 '+n(r.unapplied)+'건 · 기준재고 없음 '+n(r.missing)+'건'+(r.sourceMissing?' · 원본 위치 없음 '+n(r.sourceMissing)+'건':'');return r;}
  catch(error){el.className='export-role-status matrix-stock-state missing';el.textContent='재고 상태 조회 실패 · '+(error?.message||error);return null;}
 }

 async function recalculateStandardScope(source){
  const button=document.querySelector(`[data-standard-recalculate="${source}"]`),materializer=global.HubPriceMaterializer;
  if(!materializer?.materialize){standardResult(source,'가격 재계산 모듈을 불러오지 못했습니다. 새로고침 후 다시 시도해주세요.','error');return;}
  if((document.querySelector(`[data-seller-scope-mode="${source}"]`)?.value||'all')==='all'){standardResult(source,'재계산은 SKU 직접 입력 또는 태그 적용 SKU로 범위를 제한한 뒤 실행해주세요.','error');return;}
  if(button)button.disabled=true;global.__systemV3DirectExportBusy=true;state.standardCarrierPlans.delete(source);
  standardResult(source,'선택 범위의 내부 가격과 판매처 active Rule을 재계산합니다.');
  standardProgress(source,1,'가격 재계산 준비','서버에서 태그/SKU 범위를 다시 검증합니다.');
  try{
   const selected=await directScopeSkus(source);if(!selected?.length)throw Error('재계산할 SKU가 없습니다.');if(selected.length>5000)throw Error('한 번에 재계산할 수 있는 범위는 5,000 SKU까지입니다.');
   const result=await materializer.materialize({skus:selected,sources:[source],reason:`seller-export-timeout-recovery:${source}`,activeRulesOnly:true,maxAffectedSkus:5000,onProgress:progress=>{
    const total=Math.max(1,Number(progress.totalSkus||selected.length)),completed=Math.min(total,Number(progress.completedSkus||0)),percent=Math.min(98,5+Math.floor(completed/total*90));
    const phase=progress.phase==='resolve'?'영향 SKU 확인':progress.phase==='persist'?'계산 결과 저장':progress.phase==='complete'?'완료':'의존순서 가격 계산';
    standardProgress(source,percent,phase,`진행 ${n(completed)} / ${n(total)} SKU · 저장 ${n(progress.persistedRows)}개 · 오류 ${n(progress.errorRows)}개`);
   }});
   const errors=Number(result.errorRows||0);standardProgress(source,100,errors?'가격 재계산 부분 완료':'가격 재계산 완료',`영향 ${n(result.totalSkus)} SKU · 저장 ${n(result.persistedRows)}개 · 오류 ${n(errors)}개`,errors?'error':'done');
   standardResult(source,errors?`재계산을 완료했지만 오류 결과가 ${n(errors)}개 남았습니다. 미리보기에서 실제 사유를 확인해주세요.`:`선택 범위 ${n(result.totalSkus)} SKU 가격 재계산 완료 · timeout 결과를 새 generation ${n(result.generationId)}로 교체했습니다. 미리보기를 다시 실행해주세요.`,errors?'error':'success');
   global.dispatchEvent(new CustomEvent('hub-rules-changed',{detail:{persisted:true,affectedSkus:selected}}));
  }catch(error){standardProgress(source,100,'가격 재계산 중단',error?.message||String(error),'error');standardResult(source,'가격 재계산 실패: '+(error?.message||error),'error');}
  finally{global.__systemV3DirectExportBusy=false;if(button)button.disabled=false;}
 }

 function renderSourcePricePreview(source,result){
  const el=document.querySelector(`[data-standard-result="${source}"]`);if(!el)return;
  const rows=(result.plans||[]).flatMap(plan=>plan.preview||[]),selected=rows.filter(row=>row.sku&&row.status==='ready'),preserved=rows.filter(row=>row.preserve_unmapped&&row.status==='ready'),blocked=rows.filter(row=>row.status==='blocked');
  const summary=global.HubCurrentPriceExport?.summarizeSourcePricePreview(result.plans)||{total:rows.length,changed:rows.filter(row=>row.status==='ready'&&row.changed).length,noChange:rows.filter(row=>row.status==='ready'&&!row.changed).length,blocked:blocked.length,unclassified:0,complete:true};
  const warningRows=(result.skippedItems||[]).length,shown=[...blocked,...rows.filter(row=>row.status==='ready'&&row.changed),...rows.filter(row=>row.status==='ready'&&!row.changed)].slice(0,150),money=value=>n(value??0),discount=terms=>(terms||[]).filter(term=>term.is_baseline).map(term=>`${money(term.value)}${term.unit==='percent'?'%':'원'}`).join(' + ')||'없음';
  el.className='direct-export-preview transformation-plan-preview';setSellerPanel(source,'preview');
  el.innerHTML=`<b>셀피아 판매가 기준 · 가격 전용 미리보기</b>
   <div class="transformation-plan-summary"><span>전체 대상 ${n(summary.total)}행</span><span>변경 ${n(summary.changed)}행</span><span>변경 불필요 ${n(summary.noChange)}행</span><span>차단 ${n(summary.blocked)}행</span>${summary.unclassified?`<span>미분류 ${n(summary.unclassified)}행</span>`:''}</div>
   <p>변경 불필요 = 계산된 값이 현재 원본과 동일 · 차단 = 안전검사 때문에 원본값 유지 · 경고 CSV ${n(warningRows)}행에는 차단만 포함합니다.${warningRows!==summary.blocked?' 경고 CSV와 차단 행 수가 일치하지 않아 생성 전 확인이 필요합니다.':''}</p>
   <p>안전한 선택 ${n(selected.length)}옵션 · 미선택 가격 보존 ${n(preserved.length)}옵션 · 판매처 미연결 ${n(result.diagnostics?.unmatched_selected_skus?.length)} SKU(파일 변경 없음). 변경 셀은 노란색, 차단 상품은 빨간색으로 표시합니다.</p>
   <div class="transformation-plan-table-wrap"><table class="transformation-plan-table"><thead><tr><th>SKU / 옵션</th><th>기존 등록가</th><th>기존 할인</th><th>새 등록가</th><th>새 할인</th><th>새 옵션가</th><th>새 최종가</th><th>상태 / 가격 기준 / 사유</th></tr></thead><tbody>${shown.map(row=>{const before=row.diff?.price?.before||{},after=row.diff?.price?.after||{},adjustment=row.option_limit_adjustment,status=row.status==='blocked'?'차단':row.changed?'변경':'변경없음',detail=row.status==='blocked'?'원본 유지: '+esc(row.reason||'가격 검증 실패'):adjustment?`옵션가 제한 보정 · 최고 ${money(adjustment.max_option)} / 허용 ${money(adjustment.allowed_option)} · ${row.preserve_unmapped?'미선택 가격 보존':'셀피아 최신 원본 판매가'}`:row.preserve_unmapped?'판매처 원본 최종가 보존':'셀피아 최신 원본 판매가';return `<tr class="${row.status==='blocked'?'export-row-blocker':row.changed?'export-row-change':'export-row-unchanged'}"><td>${esc(row.sku||'미선택')} · ${esc(row.option_code||'단일')}</td><td>${money(before.base)}</td><td>${esc(discount(before.discount_terms))}</td><td>${money(after.base)}</td><td>${esc(discount(after.discount_terms))}</td><td>${money(after.option)}</td><td>${money(after.final)}</td><td><b>${status}</b><br>${detail}</td></tr>`;}).join('')}</tbody></table></div>${rows.length>shown.length?`<small>첫 ${n(shown.length)}행 표시 · 전체 ${n(rows.length)}행은 XLSX에 검증 후 반영</small>`:''}`;
 }

 function renderStockOnlyPreview(source,result){
  const el=document.querySelector(`[data-standard-result="${source}"]`);if(!el)return;
  const rows=(result.plans||[]).flatMap(plan=>plan.preview||[]),shown=rows.slice(0,150),changed=rows.filter(row=>row.diff?.stock?.changed).length,blocked=rows.filter(row=>row.status==='blocked').length,warned=rows.filter(row=>row.status==='warn_keep_original').length;
  el.className='direct-export-preview transformation-plan-preview';setSellerPanel(source,'preview');
  el.innerHTML=`<b>재고-only 미리보기 · 기준 ${result.stockSource==='stock'?'재고':'가용재고'}</b><div class="transformation-plan-summary"><span>전체 ${n(rows.length)}행</span><span>재고 변경 ${n(changed)}행</span><span>변경 없음 ${n(rows.length-changed-blocked-warned)}행</span><span>원본 유지 경고 ${n(warned)}행</span><span>차단 ${n(blocked)}행</span><span>가격 변경 0행</span></div><p>선택한 Sellpia ${result.stockSource==='stock'?'재고':'가용재고'}를 판매처 재고 셀에만 반영합니다.${result.stockSource==='available_stock'?' 가용재고가 음수이면 DB 원값은 유지하고 판매처에는 0으로 내보냅니다.':''} 판매가·옵션가·상품명·옵션명과 나머지 원본 셀은 유지됩니다.</p><div class="transformation-plan-table-wrap"><table class="transformation-plan-table"><thead><tr><th>행 / SKU</th><th>판매처 기존 재고</th><th>내보낼 재고</th><th>기준</th><th>상태</th></tr></thead><tbody>${shown.map(row=>`<tr class="${row.status==='blocked'?'export-row-blocker':row.status==='warn_keep_original'?'export-row-warning':row.diff?.stock?.changed?'export-row-change':'export-row-unchanged'}"><td>${esc(row.source_row_no??'—')} / ${esc(row.sku||'—')}</td><td>${esc(row.diff?.stock?.before??'—')}</td><td>${esc(row.diff?.stock?.after??row.diff?.stock?.before??'—')}</td><td>${result.stockSource==='stock'?'재고':row.diff?.stock?.clamped_to_zero?`가용재고 ${esc(row.diff.stock.source_raw)} → 판매처 0`:'가용재고'}</td><td>${row.status==='blocked'?'차단':row.status==='warn_keep_original'?'원본 유지 경고':row.diff?.stock?.changed?'변경':'변경 없음'}${row.reason?` · ${esc(row.reason)}`:''}</td></tr>`).join('')}</tbody></table></div>${rows.length>shown.length?`<small>첫 ${n(shown.length)}행 표시 · 전체 ${n(rows.length)}행은 생성 전에 같은 fingerprint로 재검증</small>`:''}`;
 }

 async function previewStandard(source,mode='changed_only'){
  const bridge=global.SystemV3SellerExportBridge;if(!bridge){standardResult(source,'직접 내보내기 연결 모듈을 불러오지 못했습니다. 새로고침해주세요.','error');return;}
  const button=document.querySelector('[data-standard-preview="'+source+'"]');if(button)button.disabled=true;global.__systemV3DirectExportBusy=true;
  standardResult(source,'매트릭스 가격·재고와 원본 위치를 검증하는 중…');
  standardProgress(source,3,'변경분 조회','현재 매트릭스 표시값과 최신 원본을 비교합니다.');
  try{
   const skus=await directScopeSkus(source),selection=standardSelection(source),scopeKey=skus?JSON.stringify([...skus].sort()):'ALL';
   const result=selection.stockOnly
    ?await bridge.previewStockOnly({source,skus,stockSource:selection.stockSource,mode})
    :selection.priceOnly
      ?await bridge.previewPriceOnly({source,skus,priceMode:selection.priceMode,mode})
      :mode==='full_original'?await bridge.previewFullOriginal({source,skus,priceMode:selection.priceMode}):await bridge.previewChangedOnly({source,skus,priceMode:selection.priceMode});
   const stock=document.querySelector('[data-matrix-stock-status="'+source+'"]');if(stock){stock.className='export-role-status matrix-stock-state ready';stock.textContent='carrier 대상 '+n(result.diagnostics?.sku_count)+' SKU · DB 조회 '+n(result.diagnostics?.query_count)+'회 · 전체 snapshot 없음';}
   if(selection.stockOnly){state.sourcePricePreviews.set(source,{mode,scope:scopeKey,fingerprint:result.planFingerprint,stockSource:selection.stockSource,kind:'stock_only'});renderStockOnlyPreview(source,result);}
   else if(selection.priceMode==='sellpia_source'){state.sourcePricePreviews.set(source,{mode,scope:scopeKey,fingerprint:result.planFingerprint,kind:'sellpia_source'});renderSourcePricePreview(source,result);}
   else{state.sourcePricePreviews.set(source,{mode,scope:scopeKey,fingerprint:result.planFingerprint,kind:'price'});standardResult(source,[result.count,result.detail,selection.priceOnly?'재고 변경 0건 · 판매처 원본 재고 보존':'재고는 현재 수정안/판매처 반영 상태만 사용','현재 가격 결정과 최신 매핑을 생성 직전에 다시 검증합니다.'].filter(Boolean).join(' · '),'success');}
   setStatus((source==='smartstore'?'스마트스토어':'메이크샵')+(mode==='full_original'?' 전체 원본 미리보기 완료':' 변경분 미리보기 완료'),'success');
  }catch(error){standardResult(source,error?.message||String(error),'error');setStatus('미리보기 실패: '+(error?.message||error),'error');}
  finally{global.__systemV3DirectExportBusy=false;if(button)button.disabled=false;}
 }

 async function runStandard(source,mode='changed_only'){
  const bridge=global.SystemV3SellerExportBridge;if(!bridge){standardResult(source,'직접 내보내기 연결 모듈을 불러오지 못했습니다. 새로고침해주세요.','error');return;}
  const button=document.querySelector('[data-standard-run="'+source+'"]');if(button)button.disabled=true;global.__systemV3DirectExportBusy=true;
  if(typeof lockStandardGeneration==='function')lockStandardGeneration(source,true);
  standardProgress(source,3,'파일 생성 준비','현재 매트릭스 표시값과 최신 원본 위치를 읽습니다.');standardResult(source,'미리보기 계약을 재검증하고 파일을 생성하는 중…');setStatus('판매처 파일 생성 중…');
  try{
   const skus=await directScopeSkus(source),selection=standardSelection(source),scopeKey=skus?JSON.stringify([...skus].sort()):'ALL',preview=state.sourcePricePreviews.get(source);
   const needsPreview=selection.stockOnly||selection.includePrice;
   if(needsPreview&&(!preview||preview.mode!==mode||preview.scope!==scopeKey||!preview.fingerprint||selection.stockOnly&&(preview.kind!=='stock_only'||preview.stockSource!==selection.stockSource)||selection.includePrice&&!selection.stockOnly&&preview.kind!== (selection.priceMode==='sellpia_source'?'sellpia_source':'price')))throw Error(selection.stockOnly?'같은 범위와 재고 기준의 미리보기를 먼저 확인해주세요.':'같은 범위와 가격 모드의 가격 미리보기를 먼저 확인해주세요.');
   const request={source,skus,priceMode:selection.priceMode,expectedPlanFingerprint:needsPreview?preview.fingerprint:null};
   const result=selection.stockOnly
    ?await bridge.runStockOnly({source,skus,stockSource:selection.stockSource,mode,expectedPlanFingerprint:preview.fingerprint})
    :selection.priceOnly
      ?await bridge.runPriceOnly({source,skus,priceMode:selection.priceMode,mode,expectedPlanFingerprint:needsPreview?preview.fingerprint:null})
      :mode==='full_original'?await bridge.runFullOriginal(request):await bridge.runChangedOnly(request);
   if(needsPreview)state.sourcePricePreviews.delete(source);
   const stock=document.querySelector('[data-matrix-stock-status="'+source+'"]');if(stock){stock.className='export-role-status matrix-stock-state ready';stock.textContent='carrier 대상 '+n(result.diagnostics?.sku_count)+' SKU · DB 조회 '+n(result.diagnostics?.query_count)+'회 · 전체 snapshot 없음';}
   standardProgress(source,100,selection.stockOnly?'재고-only 파일 생성 완료':selection.priceOnly?'가격-only 파일 생성 완료':mode==='full_original'?'전체 원본 파일 생성 완료':'변경분 파일 생성 완료',selection.stockOnly?'선택한 재고 기준만 반영하고 가격·기타 셀은 보존했습니다.':selection.priceOnly?'가격·옵션가만 반영하고 재고·기타 셀은 보존했습니다.':mode==='full_original'?'원본의 모든 데이터 행을 유지하고 안전한 변경 셀만 반영했습니다.':'실제 변경이 있는 상품 묶음만 연속 행으로 남겼습니다.','done');
   standardResult(source,[result.title,result.progressDetail].filter(Boolean).join(' · ')||'파일 생성 완료','success');setStatus(selection.stockOnly?'재고-only 파일 생성 완료':selection.priceOnly?'가격-only 파일 생성 완료':mode==='full_original'?'전체 원본 파일 생성 완료':'변경분 파일 생성 완료','success');
  }catch(error){standardProgress(source,100,'파일 생성 중단',error?.message||String(error),'error');standardResult(source,error?.message||String(error),'error');setStatus('파일 생성 실패: '+(error?.message||error),'error');}
  finally{global.__systemV3DirectExportBusy=false;if(button)button.disabled=false;if(typeof lockStandardGeneration==='function')lockStandardGeneration(source,false);}
 }

 async function previewStandardCarrier(source,file=state.standardCarrierFiles.get(source)){
  const bridge=global.SystemV3SellerExportBridge,button=document.querySelector('[data-standard-carrier-run="'+source+'"]');
  if(!bridge?.previewCarrier){standardResult(source,'공식 수정파일 변환 모듈을 불러오지 못했습니다. 새로고침해주세요.','error');return;}
  if(!file){standardResult(source,'공식 수정 XLSX를 선택해주세요.','error');return;}
  const request=(standardRequests.get(source)||0)+1;standardRequests.set(source,request);
  state.standardCarrierPlans.delete(source);standardLastActions.set(source,()=>previewStandardCarrier(source,file));
  const selected=document.querySelector(`[data-selected-carrier="${source}"]`);if(selected)selected.textContent=`${file.name} · 선택 ${fmtTime(new Date())}`;
  if(button){button.disabled=true;button.setAttribute('aria-busy','true');}
  standardResult(source,`${file.name} · 브라우저 메모리에서 매칭 확인 중…`);
  standardProgress(source,3,'공식 수정파일 확인',`${file.name} · 파일 읽기 / 파싱 준비`);
  try{const result=await bridge.previewCarrier({source,file,isCurrent:()=>standardRequests.get(source)===request});if(standardRequests.get(source)!==request)return;state.standardCarrierViews.set(source,{filter:'all',page:1});renderTransformationPlan(source,file,result);setStatus((source==='smartstore'?'스마트스토어':'메이크샵')+' TransformationPlan 미리보기 완료','success');}
  catch(error){if(standardRequests.get(source)!==request)return;standardResult(source,'공식 수정파일 확인 실패: '+(error?.message||error),'error');setStatus('공식 수정파일 확인 실패: '+(error?.message||error),'error');}
  finally{if(button&&standardRequests.get(source)===request){button.disabled=false;button.removeAttribute('aria-busy');if(!state.standardCarrierPlans.get(source))button.setAttribute('aria-disabled','true');}}
 }

 async function runStandardCarrier(source){
  const bridge=global.SystemV3SellerExportBridge,file=state.standardCarrierFiles.get(source),plan=state.standardCarrierPlans.get(source),button=document.querySelector('[data-standard-carrier-run="'+source+'"]');
  if(!bridge?.runCarrier||!file||!plan){const reason='먼저 공식 수정 XLSX의 미리보기를 확인해주세요.';standardResult(source,reason,'error');setStatus(reason,'error');return;}
  if(!plan.canGenerate){const reason=plan.safety?.reason||'가격/매칭 상태가 안전하지 않아 XLSX 생성을 차단했습니다.';standardResult(source,reason,'error');setStatus('공식 수정파일 변환 차단: '+reason,'error');return;}
  if(button){button.disabled=true;button.setAttribute('aria-busy','true');}
  if(typeof lockStandardGeneration==='function')lockStandardGeneration(source,true);
  standardProgress(source,5,'공식 수정파일 변환 시작','미리보기 때 확인한 대상만 다시 검증합니다.');standardResult(source,`${file.name} · 현재 매트릭스 표시값으로 변환 중…`);setStatus('공식 수정파일 변환 중…');
  try{const result=await bridge.runCarrier({source,file,plan});standardProgress(source,100,'공식 수정파일 변환 완료',result.progressDetail||'변환된 XLSX 다운로드를 시작했습니다.','done');standardResult(source,[result.title,result.progressDetail,'Storage 저장 안 함'].filter(Boolean).join(' · ')||'공식 수정파일 변환 완료','success');setStatus('공식 수정파일 변환 완료','success');}
  catch(error){const reason=error?.message||String(error);standardProgress(source,100,'공식 수정파일 변환 중단',reason,'error');standardResult(source,'공식 수정파일 변환 실패: '+reason,'error');setStatus('공식 수정파일 변환 실패: '+reason,'error');}
  finally{if(typeof lockStandardGeneration==='function')lockStandardGeneration(source,false);if(button){button.disabled=false;button.removeAttribute('aria-busy');button.setAttribute('aria-disabled',String(!state.standardCarrierPlans.get(source)?.canGenerate));}}
 }

 function renderExportStatuses(){
  for(const role of Object.keys(roles)){
   const el=document.querySelector(`[data-export-file="${role}"]`);if(!el)continue;
   const file=state.carrierFiles.get(role),row=currentFile(role);
   if(file){el.className='export-role-status ready';el.innerHTML=`<b>${esc(roles[role].label)}</b><span>${esc(file.name)} · 브라우저 메모리 carrier · 처리 단계는 아래 진행상태에서 확인</span>`;continue;}
   if(role==='playauto_product'&&row){el.className='export-role-status ready';el.innerHTML=`<b>${esc(roles[role].label)}</b><span>장기 원본 ${esc(row.file_name)} · ${fmtTime(row.created_at)} · 빠른 변환 파일을 선택할 수 있습니다.</span>`;continue;}
   el.className='export-role-status missing';el.innerHTML=`<b>${esc(roles[role].label)}</b><span>공식 수정 XLSX를 선택해주세요 · Storage 저장 안 함</span>`;
  }
 }

 async function loadTags(source){
  const select=document.querySelector(`[data-seller-scope-tag="${source}"]`);if(!select||select.dataset.loaded==='1')return;
  try{
   if(!state.tagCatalogRows){state.tagCatalogPromise=state.tagCatalogPromise||D().loadTagCatalog({search:''});const result=await state.tagCatalogPromise;state.tagCatalogRows=result.rows||[];}
   const current=select.value;select.innerHTML='<option value="">태그 선택</option>'+state.tagCatalogRows.map(tag=>`<option value="${esc(tag.tag_id)}">${esc(tag.tag_name)} · ${n(tag.option_count)} SKU</option>`).join('');select.value=current;select.dataset.loaded='1';updateSellerScopeSummary(source);
  }catch(error){state.tagCatalogPromise=null;setStatus(`태그 목록 조회 실패: ${error?.message||error}`,'error');}
 }

 async function scopeSkus(source='ably'){
  const mode=document.querySelector(`[data-seller-scope-mode="${source}"]`)?.value||'all';
  if(mode==='all')return null;
  if(mode==='manual'){
   const values=String(document.querySelector(`[data-seller-scope-manual="${source}"]`)?.value||'').split(/[,\s]+/).map(v=>v.trim()).filter(Boolean);
   if(!values.length)throw Error('내보낼 SKU를 입력해주세요.');
   return new Set(values);
  }
  const tagId=document.querySelector(`[data-seller-scope-tag="${source}"]`)?.value;if(!tagId)throw Error('태그를 선택해주세요.');
  const rows=[];let page=1,expected=null;
  while(true){const result=await D().loadTagMembers({tagId,page,pageSize:1000,search:''}),count=Number(result.count||0);if(expected===null)expected=count;else if(expected!==count)throw Error('태그 적용 SKU가 조회 중 변경되었습니다. 다시 시도해주세요.');rows.push(...(result.rows||[]));if(rows.length>=expected||(result.rows||[]).length<1000)break;page++;}
  if(!rows.length)throw Error('선택한 태그에 적용된 SKU가 없습니다.');
  const skus=new Set(rows.map(row=>row.sellpia_sku_code).filter(Boolean));
  if(skus.size!==expected)throw Error(`태그 적용 SKU 검증 실패 · 기대 ${n(expected)} / 확인 ${n(skus.size)}`);
  return skus;
 }

 async function blobFile(record){
  const blob=await D().downloadAuxiliarySellerFile(record);
  return new File([blob],record.file_name,{type:record.mime_type||blob.type||'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
 }

 async function preview(role){
  const priceMode=document.querySelector('[data-standard-price-mode="ably"]')?.value||'rules';
  const fieldMode=document.querySelector('[data-ably-field-mode]')?.value||'option_stock';
  const stockOnly=role==='playauto_option'&&fieldMode==='stock_only';
  const priceOnly=role==='playauto_option'&&fieldMode==='price_only';
  const stockSource=stockOnly?(document.querySelector('[data-ably-stock-source]')?.value||'available_stock'):null;
  if(role==='playauto_product'&&document.querySelector('[data-ably-field-mode]')?.value==='stock_only'){setStatus('재고-only는 PlayAuto 옵션가 + 재고 파일에서 사용해주세요.','error');return;}
  if(priceMode==='sellpia_source'&&role!=='playauto_product'){setStatus('셀피아 판매가 기준은 PlayAuto 판매가 + 옵션가 파일에서만 사용합니다.','error');return;}
  if(priceMode==='sellpia_source'&&(document.querySelector('[data-seller-scope-mode="ably"]')?.value||'all')==='all'){setStatus('셀피아 판매가 기준은 SKU 직접 입력 또는 태그 적용 SKU 범위를 선택해주세요.','error');return;}
  const carrier=state.carrierFiles.get(role)||null,record=carrier?null:currentFile(role);
  if(!record&&!carrier){setStatus(`${roles[role].label} 공식 수정파일을 선택해주세요.`,'error');return;}
  const job=createAblyJob(role,carrier||{name:record.file_name});
  job.queries=[];const onQuery=query=>{job.queries.push(query);};
  state.role=role;state.preview=null;state.previewFilter='all';state.previewPage=1;setStatus(`${roles[role].label} 원본과 저장값을 비교하는 중…`);
  const oldPreview=document.getElementById('export-preview-v2');if(oldPreview)oldPreview.hidden=true;
  try{
   // Read once for parsing, retain the selected original File for byte-preserving serialization.
   await new Promise(resolveYield=>global.setTimeout(resolveYield,0));job.check();
   const file=carrier||await blobFile(record),bytes=await file.arrayBuffer();job.check();job.phaseTo('parse');
   await new Promise(resolveYield=>global.setTimeout(resolveYield,0));job.check();
   const parsed=await A().readTemplate({name:file.name,arrayBuffer:async()=>bytes});job.check();
   job.phaseTo('normalize',parsed.items.length,parsed.items.length);
   if(parsed.type!==roles[role].type)throw Error('보관된 PlayAuto 원본 역할과 실제 양식이 다릅니다.');
   await new Promise(resolveYield=>global.setTimeout(resolveYield,0));job.check();job.phaseTo('match');
   const [mappingResult,catalogRows,scope]=await Promise.all([
    D().loadCarrierSellerMappings({source:'ably',identities:parsed.items,onQuery}),
    catalog(parsed.items.map(item=>item.sellpia_product_code),true,onQuery),
    scopeSkus('ably')
   ]);
   job.check();
   const resolved=await job.mapRows(parsed.items,item=>A().resolveRows([item],catalogRows,mappingResult.rows||[],{
    preferDirectProductSku:role==='playauto_product'&&priceMode==='sellpia_source'
   })[0]);
   const resolvedWithSku=resolved.filter(item=>item.resolution?.sku);
   let chosen=scope?resolvedWithSku.filter(item=>scope.has(item.resolution.sku)):resolvedWithSku;
   if(!chosen.length&&scope)throw Error('선택 범위에서 PlayAuto 원본과 매칭되는 SKU가 없습니다.');

   // 상품 판매가는 한 행의 옵션들이 공유하므로 선택된 행의 모든 옵션을 함께 읽어 안전성을 확인한다.
   let safetyRows=chosen;
   if(role==='playauto_product'){
    const touched=new Set(chosen.map(item=>item.source_row_no));
    safetyRows=scope?resolved.filter(item=>touched.has(item.source_row_no)):resolved;
    }
    const safetySkus=[...new Set(safetyRows.map(item=>item.resolution?.sku).filter(Boolean))];
    job.phaseTo('targets',0,safetySkus.length);
    const currentDecisionState=stockOnly?{decisions:new Map(),proof:''}:await loadCurrentPriceDecisionState('ably',safetySkus);
    const decisionMappings=safetyRows.map(item=>({sku:item.resolution?.sku,seller_product_code:item.seller_product_code||item.product_code,seller_option_code:item.seller_option_code??item.option_code??''}));
    if(!stockOnly)global.HubCurrentPriceDecisionResolver.attach(decisionMappings,currentDecisionState.decisions,{source:'ably'});
    const sellpiaSourceSkus=!stockOnly&&priceMode==='sellpia_source'?[...new Set(chosen.filter(item=>!global.HubCurrentPriceDecisionResolver.decisionForMapping(currentDecisionState.decisions,
     {sku:item.resolution?.sku,seller_product_code:item.seller_product_code||item.product_code,seller_option_code:item.seller_option_code??item.option_code??''},{source:'ably'})).map(item=>item.resolution.sku))]:[];
    const [stored,sellpiaPrices,carrierPolicies,stockSources]=await Promise.all([
     !stockOnly&&priceMode==='rules'?D().loadCarrierMatrixTargets({source:'ably',skus:safetySkus,onQuery}):Promise.resolve({rows:[]}),
     sellpiaSourceSkus.length?D().loadSellpiaSourcePricesForExport({skus:sellpiaSourceSkus,onQuery}):!stockOnly&&priceMode==='sellpia_source'?Promise.resolve(new Map()):Promise.resolve(null),
     role==='playauto_product'?D().loadAblyCarrierPoliciesForSkus({skus:safetySkus}):Promise.resolve({rows:[],fingerprint:'[]'}),
     stockOnly?D().loadSellpiaStockSourcesForExport({skus:safetySkus,onQuery}):Promise.resolve(null)
    ]);
    job.check();job.phaseTo('targets',safetySkus.length,safetySkus.length);
    const targetMap=new Map(safetySkus.map(sku=>[sku,{...((stored.rows||[]).find(row=>row.sku===sku)||{}),...(stockSources?.bySku.get(sku)||{}),sku}]));
    const targetFinalBySku=new Map(),legacyRulesBaseBySku=new Map();
    const policyTagsBySku=new Map((carrierPolicies.rows||[]).map(row=>[row.sku,(row.tags||[]).map(tag=>P().normalizePolicyDocument(tag.document,tag)).filter(Boolean)]));
    const chosenSet=new Set(chosen.map(item=>`${item.source_row_no}|${item.option_index??''}|${item.resolution.sku}`));
   const sourceRows=role==='playauto_option'&&!scope?resolved:safetyRows;
   job.phaseTo('guards',0,sourceRows.length);
    const prepared=await job.mapRows(sourceRows,item=>{
     const sku=item.resolution?.sku,baseRow=sku?targetMap.get(sku):null,row=baseRow?{...baseRow,current_price_decision:stockOnly?null:global.HubCurrentPriceDecisionResolver.decisionForMapping(currentDecisionState.decisions,{sku,seller_product_code:item.seller_product_code||item.product_code,seller_option_code:item.seller_option_code??item.option_code??''},{source:'ably'})}:null,inScope=sku?chosenSet.has(`${item.source_row_no}|${item.option_index??''}|${sku}`):!scope;
     const out={...item,resolution:item.resolution,_inScope:inScope,_status:'ready',_error:'',_changedFields:[]};
     if(row?.current_price_decision){const decision=row.current_price_decision;out._currentPriceDecision=decision;out._currentPriceDecisionProof={event_id:String(decision.event_id),revision:Number(decision.revision),decision_source:String(decision.decision_source||''),effective_at:String(decision.effective_at||''),price:decision.price};}
     if(item.carrier_identity_error){out._status='ambiguous';out._error=item.carrier_identity_error;return out;}
     if(stockOnly){
      return A().prepareStockOnlyRow(out,row,{stockSource,inScope});
     }
     if(item.carrier_identity_error){out._status='ambiguous';out._error=item.carrier_identity_error;return out;}
     if(priceMode==='sellpia_source'){
      if(inScope&&sku)targetFinalBySku.set(sku,Number(sellpiaPrices?.get(sku)));
      return out;
     }
     if(!sku){out._status=item.resolution?.method==='unresolved'?'warn_keep_original':'ambiguous';out._error=item.resolution?.error||'SKU를 정확히 찾지 못했습니다.';return out;}
     const priceState=global.HubCurrentPriceExport.carrierPriceState(row);out._priceState=priceState;
     const sourceBase=item.base_price!=null&&item.base_price!==''&&Number.isFinite(Number(item.base_price))?Number(item.base_price):null;
     const sourceOption=item.option_price!=null&&item.option_price!==''&&Number.isFinite(Number(item.option_price))?Number(item.option_price):null;
     const sourceFinal=sourceBase!==null&&sourceOption!==null?sourceBase+sourceOption:null;
     if(inScope&&!priceState.safe){out._status='warn_keep_original';out._error=priceState.label+' · 이 행 전체 원본 유지';return out;}
     const matrixTarget=global.HubCurrentPriceExport?.matrixPriceTarget({...row,
       source_base_price:sourceBase,source_discounted_base_price:sourceBase,source_option_price:sourceOption,
       source_final_price:sourceFinal,source_discount_terms:[]
     });
     if(inScope&&matrixTarget?.invalid){out._status='warn_keep_original';out._error=matrixTarget.reason;return out;}
     if(sourceBase===null||sourceOption===null){out._status='warn_keep_original';out._error='현재 가격 구성값 없음 → 이 행 원본 유지';return out;}
     if(role==='playauto_product'){
       if(inScope){
        const targetFinal=matrixTarget?Number(matrixTarget.final):sourceFinal,targetBase=matrixTarget?Number(matrixTarget.base):sourceBase;
        if(Number.isSafeInteger(targetFinal))targetFinalBySku.set(sku,targetFinal);
        if(Number.isSafeInteger(targetBase))legacyRulesBaseBySku.set(sku,targetBase);
       }
     }else{
      if(inScope&&row?.current_price_decision&&(row.current_price_decision.price.base!==sourceBase||row.current_price_decision.price.discounted!==sourceBase||row.current_price_decision.price.option!==row.current_price_decision.price.final-sourceBase)){
       out._status='warn_keep_original';out._error='현재 가격 결정은 옵션가 전용 파일에서 공통 기준가격까지 함께 반영할 수 없습니다.';return out;
      }
      if(inScope)out.target_option_price=matrixTarget?Number(matrixTarget.option):sourceOption;
      if(!priceOnly){
       const matrixStock=global.HubCurrentPriceExport?.matrixStockTarget(row);
       if(inScope&&item.sales_quantity==null)out._blankStockPreserved=true;
       else if(inScope&&matrixStock!==null&&matrixStock!==undefined&&Number.isFinite(Number(matrixStock)))out.target_stock=Number(matrixStock);
       else if(inScope){out._status='warn_keep_original';out._error='재고 target 없음 → 이 행 원본 유지';delete out.target_option_price;}
      }
    }
    return out;
    });

    if(role==='playauto_product'){
     const byRow=new Map();for(const item of prepared){if(!byRow.has(item.source_row_no))byRow.set(item.source_row_no,[]);byRow.get(item.source_row_no).push(item);}
     const policyByRow=new Map();
     for(const [rowNo,group] of byRow){
      const policies=group.flatMap(item=>policyTagsBySku.get(item.resolution?.sku)||[]);
      policyByRow.set(rowNo,P().resolveCarrierPolicy({tagPolicies:policies,fallbackStrategy:priceMode==='rules'?'legacy_rules':'lowest',fallbackSource:'legacy fallback'}));
     }
     P().projectProductRows(prepared,{priceMode,targetFinalBySku,policyByRow,legacyRulesBaseBySku,allowLowerMiddle:false});
    }

    const output=role==='playauto_product'?prepared:prepared.filter(item=>item._inScope);
    for(const item of output){
     if(item._status!=='ready'){
      delete item.target_base_price;delete item.target_option_price;delete item.target_stock;
      if(role==='playauto_product'){
       item._current=`I ${n(item.base_price)} / T ${n(item.option_price)} / 최종 ${n(Number(item.base_price)+Number(item.option_price))}`;
       item._target=item._projection?`미리보기 I ${n(item._projection.representativeBase)} / T ${n(item._projectionOptionDelta)} / 목표 최종 ${n(item._projectionTargetFinal)}`:item._current;
      }else{item._current=`추가 금액 ${n(item.option_price)} / *판매수량(실재고) ${item.sales_quantity==null?'빈칸':n(item.sales_quantity)}`;item._target=item._current;}
      continue;
     }
     if(role==='playauto_product'){
       const baseChanged=Number(item.target_base_price)!==Number(item.base_price),optionChanged=Number(item.target_option_price)!==Number(item.option_price);
       if(baseChanged)item._changedFields.push('base');if(optionChanged)item._changedFields.push('option');
       item._changed=baseChanged||optionChanged;
       item._current=`I ${n(item.base_price)} / T ${n(item.option_price)} / 최종 ${n(Number(item.base_price)+Number(item.option_price))}`;
       item._target=`I ${n(item.target_base_price)} / T ${n(item.target_option_price)} / 목표 최종 ${n(Number(item.target_base_price)+Number(item.target_option_price))}`;
    }else{
      const optionChanged=Number.isFinite(Number(item.target_option_price))&&Number(item.target_option_price)!==Number(item.option_price);
      const stockChanged=item.target_stock!=null&&Number.isFinite(Number(item.target_stock))&&item.sales_quantity!==null&&Number(item.target_stock)!==Number(item.sales_quantity);
      if(optionChanged)item._changedFields.push('option');if(stockChanged)item._changedFields.push('stock');
      item._changed=optionChanged||stockChanged;
      item._current=`추가 금액 ${n(item.option_price)} / *판매수량(실재고) ${item.sales_quantity==null?'빈칸':n(item.sales_quantity)}`;item._target=`추가 금액 ${Number.isFinite(Number(item.target_option_price))?n(item.target_option_price):'유지'} / *판매수량(실재고) ${item._blankStockPreserved?'빈셀 유지':item.target_stock!=null&&Number.isFinite(Number(item.target_stock))?n(item.target_stock):'유지'}`;
    }
    }
    const unresolved=output.filter(item=>!item.resolution?.sku).length,ready=output.filter(item=>item._status==='ready').length,changed=output.filter(item=>item._status==='ready'&&item._changed).length,preserved=output.filter(item=>item._blankStockPreserved).length,warned=output.filter(item=>item._status==='warn_keep_original').length,blocked=output.filter(item=>item._status!=='ready'&&item._status!=='warn_keep_original').length;
    const policySummaries=[...new Map(output.filter(item=>item._projection?.policy).map(item=>{const policy=item._projection.policy,key=JSON.stringify([policy.strategy,policy.sourceLabel]);return [key,policy];})).values()];
    const policyDownloadBlocked=output.some(item=>item._inScope&&item._projection?.policy?.strategy==='lower_middle');
    const versionToken=JSON.stringify([priceMode,stockOnly,priceOnly,stockSource,stockSources?.snapshotId||'',carrierPolicies.fingerprint||'[]',currentDecisionState.proof||'',...output.map(item=>[item.source_row_no,item.option_index??'',item.resolution?.sku||'',item.resolution?.method||'',item._status,item._changedFields,item._current,item._target,item._error,item._projection?.policy?.strategy||'',item._projection?.policy?.sourceLabel||'',item._projectionTargetFinal??'',item._projectionOptionDelta??'',item._currentPriceDecisionProof||null])]);
   job.check();job.phaseTo('preview',output.length,output.length);
   let shadowDiagnostics=[];
   if(global.HubMatrixShadow&&D().loadMatrixShadowMetadata&&global.HubMatrixShadowEnabled!==false){
    try{
     const groups=new Map();for(const item of sourceRows.filter(item=>item.resolution?.sku)){const group=groups.get(item.resolution.sku)||[];group.push(item);groups.set(item.resolution.sku,group);}
     const ambiguityDiagnostics=sourceRows.filter(item=>item.resolution?.method==='seller_mapping_ambiguous').map(item=>({sku:item.seller_product_code||item.seller_management_code||'미확정 identity',lookup:'conflict',reason:item.resolution?.error||'판매처 identity가 여러 SKU를 가리킵니다.'}));
     const multiListingDiagnostics=[...groups].filter(([,rows])=>rows.length>1).map(([sku,rows])=>({sku,lookup:'multi',reason:`동일 SKU가 ${rows.length}개 carrier row에 연결됨 · 정상 fan-out`}));
     const unique=[...groups.values()].filter(rows=>rows.length===1).map(rows=>rows[0]);
     // Read evidence after production guards/targets are fixed. Never mutate prepared rows.
     const shadow=await D().loadMatrixShadowMetadata({source:'ably',rows:unique.map(item=>global.HubMatrixShadow.request({sellpia_sku_code:item.resolution.sku},'ably',item))});
     shadowDiagnostics=[...ambiguityDiagnostics,...multiListingDiagnostics,...unique.map(item=>{const r=shadow.rows.find(row=>row.sku===item.resolution.sku);if(!r)throw Error('shadow SKU 누락');const b=global.HubBaselineIdentityShadow.crosswalk({carrier:item,resolvedSku:item.resolution.sku,baselineRows:r.candidates,declaredLinks:r.declared_links});return {sku:item.resolution.sku,lookup:b.disposition==='BLOCK'?'conflict':b.row?(r.declared_links.length?'matched':'crosswalk'):'unavailable',reason:b.reason};})];
     global.HubMatrixShadow.rememberCarrierEvidence(unique);
    }catch(error){shadowDiagnostics=[{sku:'진단',lookup:'unavailable',reason:error?.message||String(error)}];}
    job.check();
   }
    state.preview={role,priceMode,stockOnly,priceOnly,stockSource,record,file,parsed,items:prepared,output,versionToken,currentPriceDecisionProof:currentDecisionState.proof||'',currentPriceDecisionSkus:stockOnly?[]:safetySkus,policySummaries,policyDownloadBlocked,timings:job.timings,shadowDiagnostics,counts:{template:parsed.items.length,matched:resolvedWithSku.length,selected:chosen.length,pricePreserved:output.filter(item=>item._preserveUnselected).length,mappingOverrides:output.filter(item=>item._status==='ready'&&item.resolution?.mapping_override).length,ready,changed,unchanged:ready-changed,warned,blocked,unresolved,preserved}};
   renderPreview();job.finish();setStatus(`${roles[role].label} 미리보기 완료 · 변경 ${n(changed)} · 원본 유지 경고 ${n(warned)} · 치명적 차단 ${n(blocked)}`,'success');return state.preview;
  }catch(error){if(error?.name==='CarrierCancelledError'||state.ablyJob!==job||job.cancelled)return;job.finish(error);setStatus(`미리보기 실패: ${error?.message||error}`,'error');}
 }

 function previewRowsForFilter(preview,filter='all'){
  const rows=Array.isArray(preview?.output)?preview.output:[];
  if(filter==='ready')return rows.filter(item=>item._status==='ready');
  if(filter==='changed')return rows.filter(item=>item._status==='ready'&&item._changed);
  if(filter==='unresolved')return rows.filter(item=>!item.resolution?.sku);
  if(filter==='warned')return rows.filter(item=>item._status==='warn_keep_original');
  if(filter==='unchanged')return rows.filter(item=>item._status==='ready'&&!item._changed);
  if(filter==='preserved')return rows.filter(item=>item._blankStockPreserved);
  if(filter==='blocked')return rows.filter(item=>item._status!=='ready'&&item._status!=='warn_keep_original');
  return rows;
 }

 function previewFilterButton(filter,label,count,tone=''){
  const active=state.previewFilter===filter;
  return `<button type="button" class="export-preview-filter ${tone} ${active?'active':''}" data-preview-filter="${filter}" aria-pressed="${active}" title="${esc(label)} 항목만 보기">${esc(label)} ${n(count)}</button>`;
 }

 function renderPreview(){
  const p=state.preview,box=document.getElementById('export-preview-v2');if(!p||!box)return;
  box.hidden=false;document.getElementById('export-preview-title').textContent=roles[p.role].label;
  setSellerPanel('ably','preview');
  const policyLabels={legacy_rules:'legacy (Rule platformBase)',lowest:'lowest',lower_middle:'lower_middle',preserve_existing_base:'preserve_existing_base'};
  const policyText=(p.policySummaries||[]).map(policy=>`${policyLabels[policy.strategy]||policy.strategy} · ${policy.sourceLabel||policy.source}`).join(' / ');
  const partialNotice=p.role==='playauto_product'&&p.counts.pricePreserved?` 공통 I 변경에 맞춰 같은 PlayAuto 상품 행 전체 T를 다시 계산하며, 미선택 ${n(p.counts.pricePreserved)}개 sibling의 기존 최종가는 보존합니다.`:'';
  document.getElementById('export-preview-copy').textContent=(p.role==='playauto_product'?`Price source: ${p.priceMode}. Resolved Ably policy: ${policyText||'legacy fallback'}.${partialNotice}${p.priceMode==='sellpia_source'?' 판매처 외부 할인은 이 양식에 없어 반영하지 않습니다.':''}`:p.stockOnly?`재고-only · 기준 ${p.stockSource==='stock'?'재고':'가용재고'}. X *판매수량만 변경하며 V 옵션 추가금액, W 판매가능재고와 나머지 셀은 보존합니다.${p.stockSource==='available_stock'?' 음수 가용재고는 DB 원값을 유지하고 판매처에는 0으로 내보냅니다.':''}`:p.priceOnly?'가격-only · V 옵션 추가금액만 변경하며 X *판매수량과 W 판매가능재고, 나머지 셀은 보존합니다.':'공식 옵션기본 파일을 Storage에 저장하지 않고 V 추가 금액과 X *판매수량(실재고)만 현재 매트릭스 표시값으로 변환합니다. W 판매가능재고와 나머지 셀은 보존합니다.')+(p.policyDownloadBlocked?' lower_middle은 계산 미리보기만 제공하며 실제 다운로드는 현재 차단됩니다.':'')+' XLSX: 변경 셀 노랑 / 원본 유지 경고 셀 빨강.';
  const c=p.counts,counts=document.getElementById('export-preview-counts');
  counts.innerHTML=`<span>원본 ${n(c.template)}</span><span>매칭 ${n(c.matched)}</span>${p.priceMode==='sellpia_source'?`<span>선택 SKU ${n(c.selected)}</span>${previewFilterButton('all','가격 계획',p.output.length)}`:previewFilterButton('all','선택',c.selected)}${c.pricePreserved?`<span>미선택 옵션 가격 보존 ${n(c.pricePreserved)}</span>`:''}${c.mappingOverrides?`<span>파일 SKU 우선 ${n(c.mappingOverrides)}</span>`:''}${previewFilterButton('ready','생성 가능',c.ready,'good')}${previewFilterButton('changed','변경',c.changed,'good')}${previewFilterButton('unchanged','변경 없음',c.unchanged)}${previewFilterButton('warned','원본 유지 경고',c.warned,'warn')}${previewFilterButton('unresolved','미확정',c.unresolved,'warn')}${c.preserved?previewFilterButton('preserved','원본 blank 유지',c.preserved):''}${previewFilterButton('blocked','치명적 차단',c.blocked,c.blocked?'bad':'')}`;
  let shadowBox=document.getElementById('export-shadow-provenance');
  if(!shadowBox){shadowBox=document.createElement('div');shadowBox.id='export-shadow-provenance';counts.after(shadowBox);}
  shadowBox.innerHTML=global.HubMatrixShadow?.diagnostic(p.shadowDiagnostics)||'';
  counts.onclick=event=>{const button=event.target.closest?.('[data-preview-filter]');if(!button)return;const next=button.dataset.previewFilter;state.previewFilter=state.previewFilter===next&&next!=='all'?'all':next;state.previewPage=1;renderPreview();};
  const rows=previewRowsForFilter(p,state.previewFilter);
  const pageSize=100,totalPages=Math.max(1,Math.ceil(rows.length/pageSize));state.previewPage=Math.min(Math.max(1,state.previewPage||1),totalPages);
  document.getElementById('export-preview-rows').innerHTML=rows.slice((state.previewPage-1)*pageSize,state.previewPage*pageSize).map(item=>`<tr class="export-row-${item._status==='ready'?(item._changed?'change':'unchanged'):item._status==='warn_keep_original'?'warning':'blocker'}"><td>${esc(item.resolution?.sku||'—')}</td><td>${esc(item._current||'—')}</td><td>${esc(item._target||'—')}</td><td>${item._status==='ready'?(item.resolution?.mapping_override?`파일 P열 SKU 우선 · 기존 연결 ${esc(item.resolution.mapped_sku)}`:item._preserveUnselected?'미선택 옵션 최종가 보존':item._changed?'변경':'변경 없음'):`${item._status==='warn_keep_original'?'원본 유지 경고':'치명적 차단'} · ${esc(item._error||item._status)}`}</td></tr>`).join('')||'<tr><td colspan="4">이 조건에 해당하는 항목이 없습니다.</td></tr>';
  const pagination=document.getElementById('export-preview-pagination');if(pagination){pagination.innerHTML=`<button class="btn" type="button" data-ably-page="prev" ${state.previewPage<=1?'disabled':''}>이전</button><span>${n(state.previewPage)} / ${n(totalPages)} · ${n(rows.length)}행</span><button class="btn" type="button" data-ably-page="next" ${state.previewPage>=totalPages?'disabled':''}>다음</button>`;pagination.onclick=event=>{const button=event.target.closest?.('[data-ably-page]');if(!button)return;state.previewPage+=button.dataset.ablyPage==='next'?1:-1;renderPreview();};}
  document.getElementById('export-preview-generate').disabled=!c.selected||p.policyDownloadBlocked;
 }

 async function generate(){
  const p=state.preview;if(!p)return;
  if(p.policyDownloadBlocked){setStatus('lower_middle은 PlayAuto/Ably 음수 옵션가와 허용범위 확인 전까지 다운로드할 수 없습니다.','error');return;}
  setStatus('현재 매트릭스 표시값이 미리보기 이후 바뀌지 않았는지 확인하는 중…');
  const revalidated=await preview(p.role);
  if(!revalidated||revalidated.versionToken!==p.versionToken){
   if(revalidated){state.ablyJob?.finish(Error('가격/재고 상태가 변경되었습니다. 미리보기를 다시 확인해주세요.'));setSellerPanel('ably','error');}
   setStatus('가격/재고 상태가 변경되었습니다. 미리보기를 다시 확인해주세요.','error');return;
  }
  const serializationJob=state.ablyJob;if(!serializationJob||serializationJob.cancelled)return;
  const writeByKey=new Map(p.output.filter(item=>item._status==='ready'&&item._changed).map(item=>[`${item.source_row_no}|${item.option_index??''}|${item.resolution?.sku||''}`,item]));
  const items=p.items.map(item=>{
   const selected=writeByKey.get(`${item.source_row_no}|${item.option_index??''}|${item.resolution?.sku||''}`),fields=new Set(selected?._changedFields||[]);
   return {...item,target_base_price:fields.has('base')?selected.target_base_price:null,target_option_price:fields.has('option')?selected.target_option_price:null,target_stock:fields.has('stock')?selected.target_stock:null};
  });
  const progressBox=document.getElementById('export-preview-v2');if(progressBox){progressBox.dataset.generating='1';}
  const generateButton=document.getElementById('export-preview-generate');if(generateButton)generateButton.disabled=true;
  setStatus('PlayAuto XLSX 생성 중 · 25% · 원본 템플릿 준비');
  try{
   serializationJob.check();serializationJob.running=true;serializationJob.phaseTo('serialize');serializationJob.timer=global.setInterval(serializationJob.render,1000);
   setSellerPanel('ably','processing');
   setStatus('PlayAuto XLSX 생성 중 · 55% · 수정 셀 반영');
   const blob=p.role==='playauto_product'?await A().buildProductPriceOption(p.file,items):await A().buildOptionPriceStock(p.file,items);
   serializationJob?.check();
   setStatus('PlayAuto XLSX 생성 중 · 90% · 파일 저장 준비');
   const suffix=p.role==='playauto_product'?'판매가_옵션가':p.stockOnly?`재고_${p.stockSource==='stock'?'재고기준':'가용재고기준'}`:p.priceOnly?'옵션가만':'옵션가_재고';
   const base=safeName(p.file.name).replace(/\.(xlsx|xls)$/i,'');
   if(p.stockOnly){
    if(!D()?.recordStockExportAudit)throw Error('재고 내보내기 감사 기록 기능을 불러오지 못했습니다. migration 적용 상태를 확인해주세요.');
    const itemCount=p.output.filter(item=>item._status==='ready'&&item._changedFields?.includes('stock')).length;
    await D().recordStockExportAudit({batchId:global.crypto.randomUUID(),sources:['ably'],stockSource:p.stockSource,itemCount,manifest:[{source_channel:'ably',source_file_name:p.file.name,item_count:itemCount,stock_source:p.stockSource,role:p.role}]});
   }
   if(!p.stockOnly){
    const finalDecisionState=await loadCurrentPriceDecisionState('ably',p.currentPriceDecisionSkus||[]);
    global.HubCurrentPriceDecisionResolver.assertProof(p.currentPriceDecisionProof,finalDecisionState.proof);
   }
   global.SystemV3SellerExport.downloadBlob(blob,`${base}_SystemV3_${suffix}_${new Date().toISOString().slice(0,10)}.xlsx`);
   const excluded=p.output.filter(item=>item._status!=='ready').map(item=>({item:{source_channel:'ably',sellpia_sku_code:item.resolution?.sku||'',field_key:p.role==='playauto_product'||p.priceOnly?'sellpia_sale_price':'sellpia_current_stock',seller_product_code:item.seller_product_code||item.product_code||'',seller_option_code:item.seller_option_code||item.option_code||'',source_file_name:p.file.name,source_row_no:item.source_row_no},reason:item._error||item._status}));
   if(excluded.length)global.SystemV3SellerExport.downloadBlob(new Blob([global.SystemV3SellerExport.conflictCsv(excluded)],{type:'text/csv;charset=utf-8'}),`${base}_SystemV3_${suffix}_경고.csv`);
   serializationJob.finish();
   setStatus(`에이블리 ${roles[p.role].label} XLSX 생성 완료 · 원본 유지 경고/차단 ${n(excluded.length)}건`,'success');
   setSellerPanel('ably','success',`${p.file.name} · XLSX 생성 완료. 경고/차단 행은 빨간색과 별도 CSV로 확인하세요.`);
  }catch(error){if(error?.name!=='CarrierCancelledError'){serializationJob?.finish(error);setSellerPanel('ably','error');setStatus(`XLSX 생성 실패: ${error?.message||error}`,'error');}}
  finally{if(progressBox)delete progressBox.dataset.generating;if(generateButton&&state.ablyJob===serializationJob)generateButton.disabled=!state.preview?.counts?.selected||state.preview?.policyDownloadBlocked;}
 }

 function renameLegacyExportUi(){
  document.querySelectorAll('button').forEach(btn=>{if(btn.textContent.trim()==='현재 데이터 내보내기')btn.textContent='원본 양식 내보내기';});
  for(const dialog of document.querySelectorAll('[role="dialog"],.modal,.modal-panel')){
   if(!/판매처 원본 파일 생성|현재 데이터 내보내기/.test(dialog.textContent||''))continue;
   for(const input of dialog.querySelectorAll('input[type="checkbox"]')){
    const container=input.closest('label,div');if(container&&/에이블리/.test(container.textContent||'')){input.checked=false;input.disabled=true;container.title='에이블리는 판매처 원본 대신 PlayAuto 전용 내보내기를 사용합니다.';container.style.opacity='.45';}
   }
  }
 }

 function tick(){ensureUpload();ensureExport();renameLegacyExportUi();}
 const observer=new MutationObserver(()=>queueMicrotask(tick));observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','class']});
 global.addEventListener('load',tick);tick();
})(window);
