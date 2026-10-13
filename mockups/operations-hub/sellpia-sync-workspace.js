(function(global,factory){
  const api=factory(global);
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  global.SystemV3SellpiaSyncWorkspace=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(global){
  'use strict';
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const count=value=>value==null?'미확인':Number(value).toLocaleString('ko-KR');
  function mount(options={}){
    const doc=options.document||global.document,panel=doc?.getElementById('sellpia-sync-panel');
    if(!panel)return null;
    const start=doc.getElementById('sellpia-sync-start'),cancel=doc.getElementById('sellpia-sync-cancel'),apply=doc.getElementById('sellpia-sync-apply'),mode=doc.getElementById('sellpia-sync-mode'),output=doc.getElementById('sellpia-sync-result');
    const execution=doc.getElementById('sellpia-sync-execution'),recover=doc.getElementById('sellpia-sync-recover'),refresh=doc.getElementById('sellpia-sync-refresh'),availabilityPanel=doc.getElementById('sellpia-sync-availability'),historyPanel=doc.getElementById('sellpia-sync-history'),note=doc.getElementById('sellpia-sync-policy-note');
    const fields=Array.from(doc.querySelectorAll?.('[data-sellpia-sync-field]')||[]);
    let patchFields={inventory:true,price:true,basePrice:true,purchasePrice:true,basic:false,status:false};
    const defaults=options.getDefaultPolicy?.();
    if(defaults?.fields)patchFields={...patchFields,...defaults.fields};
    if(defaults?.applicationMode)mode.value=defaults.applicationMode;
    for(const field of fields)field.checked=patchFields[field.dataset.sellpiaSyncField]===true;
    function currentPolicy(){return {applicationMode:mode.value,fields:fields.length?Object.fromEntries(fields.map(field=>[field.dataset.sellpiaSyncField,field.checked])):options.getPolicy?.(mode.value)?.fields||patchFields,execution:execution?.value||'preview',automaticApproved:execution?.value==='auto'&&controller.getState().availability?.applyEnabled===true};}
    function updatePolicy(){
      if(mode.value==='full'){for(const field of fields)field.checked=true;}
      else for(const field of fields)field.checked=patchFields[field.dataset.sellpiaSyncField]===true;
      if(note)note.textContent=mode.value==='full'?'전체 교체는 모든 원본 필드를 바꾸고 새 파일에 없는 SKU를 최신 원본에서 제외합니다.':'원본은 전체를 수집하고, 부분 갱신은 선택 항목만 반영합니다. 파일에 없는 기존 SKU는 유지합니다.';
    }
    const confirmApply=options.confirmApply||(state=>global.confirm?.(state.automatic?`전체 원본을 수집·검증한 뒤 ${state.applicationMode==='full'?'모든 원본 필드를 전체 교체':'선택한 항목을 부분 갱신'}합니다. 이번 실행의 자동 반영을 승인할까요?`:`검증된 ${count(state.plan?.rowCount)}개 SKU를 ${state.plan?.mode==='full'?'전체 교체':'선택 항목만 부분 갱신'}할까요?`)===true);
    const controller=(options.client||global.SystemV3SellpiaSyncClient).createController({data:options.data,contract:options.contract||global.SystemV3SellpiaSyncContract,XLSX:options.XLSX||global.XLSX,productionEnabled:false,confirmApply,afterApply:options.afterApply,onState:render});
    function render(state){
      const locked=Boolean(state.busy)||['apply_unknown','matrix_pending','cancel_pending'].includes(state.stage),availability=state.availability;
      start.disabled=locked||availability?.enabled===false||availability?.runner?.online===false||availability?.runner?.status==='needs_login';mode.disabled=Boolean(state.busy);
      for(const field of fields)field.disabled=Boolean(state.busy)||mode.value==='full';
      if(execution){execution.disabled=Boolean(state.busy);const automatic=execution.querySelector('option[value="auto"]');if(automatic)automatic.disabled=availability?.applyEnabled!==true;if(availability?.applyEnabled!==true)execution.value='preview';}
      const capabilityNote=doc.getElementById('sellpia-sync-capability-note');
      if(capabilityNote)capabilityNote.textContent=execution?.value==='auto'?'자동 반영을 선택했습니다. 동기화 버튼을 누르면 위 반영 항목과 범위에 대한 이번 실행 승인이 됩니다. 검증과 서버 검토 조건을 통과한 원본만 반영합니다.':'미리보기가 기본입니다. 서버가 허용하고 검토 후 반영을 승인한 경우에만 DB에 반영합니다.';
      cancel.disabled=!(state.job||state.pendingRequestId)||['applying','matrix_pending','apply_unknown','completed'].includes(state.stage)||['failed','needs_login','cancelled','complete'].includes(state.job?.state);
      const approved=typeof availability?.applicationPolicy?.approvedSourceFingerprint==='string'&&/^[a-f0-9]{64}$/.test(availability.applicationPolicy.approvedSourceFingerprint)&&availability.applicationPolicy.approvedSourceFingerprint===state.plan?.sourceFingerprint;
      apply.disabled=state.stage!=='previewed'||!state.plan?.valid||Boolean(state.busy)||availability?.applyEnabled!==true||Boolean(state.plan?.summary?.reviewRequired&&!approved)||Boolean(state.comparison?.summary?.unknownCount);
      if(recover)recover.disabled=Boolean(state.busy)||!['apply_unknown','matrix_pending'].includes(state.stage);
      if(refresh)refresh.disabled=Boolean(state.overviewBusy);
      if(availabilityPanel){const runner=availability?.runner,runnerLabel={connected:'연결됨',busy:'수집 진행 중',starting:'준비 중',offline:'오프라인',needs_login:'회사 PC 재로그인 필요'}[runner?.status]||'미확인';availabilityPanel.innerHTML=`서버: ${escape(availability?availability.enabled?'수집 허용':'수집 비활성':'미확인')} · 회사 PC: ${escape(runnerLabel)}<br>마지막 연결: ${escape(runner?.lastSeenAt||'미확인')}<br>마지막 성공: ${escape(availability?.lastSuccess?.completedAt||availability?.lastSuccess?.updatedAt||'확인된 성공 없음')}${state.overviewError?`<br><span class="sellpia-sync-error">${escape(state.overviewError)}</span>`:''}`;}
      if(historyPanel){const history=state.history||[];historyPanel.innerHTML=history.length?`<table><thead><tr><th>수집 시각</th><th>반영 정책</th><th>상태</th><th>행 수</th></tr></thead><tbody>${history.map(job=>`<tr><td>${escape(job.collectedAt||job.createdAt||'미확인')}</td><td>${job.applicationMode==='full'?'전체 교체':'부분 갱신'}</td><td>${escape(controller.labels?.[job.state]||job.state||'미확인')}</td><td>${count(job.receipt?.rowCount||job.rowCount)}</td></tr>`).join('')}</tbody></table>`:'확인된 이력이 없습니다.';}
      output.dataset.stage=state.stage;
      const summary=state.plan?.summary,comparison=state.comparison?.summary,result=state.result;
      const rows=summary?[['수집 시각',state.collectionTime||'미확인'],['읽은 전체 행',count(summary.rowCount)],['유효 SKU',count(state.plan?.parsed?.rows?.length)],['변경 SKU',count(comparison?.changedCount)],['동일값 SKU',count(comparison?.unchangedCount)],['신규 SKU',count(comparison?.addedCount)],['이전 원본에만 있는 SKU',count(state.plan.mode==='patch'?comparison?.preservedCount:comparison?.removedCount)],['반영 시 제외할 SKU',count(comparison?.removedCount)],['중복 SKU',count(state.plan?.parsed?.duplicateSkuCount)],['오류 행',state.plan?.valid?'0':'미확인'],['비교 미확인 SKU',count(comparison?.unknownCount)],['반영 종류',state.plan.mode==='full'?'전체 교체':'부분 갱신'],['갱신 필드',Object.keys(state.plan.fields||{}).filter(key=>state.plan.fields[key]).map(key=>({inventory:'재고',price:'판매가',basePrice:'기준가격',purchasePrice:'매입가',basic:'상품 기본정보',status:'상품 상태'}[key]||key)).join(', ')],['snapshot',result?.snapshotId||'DB 반영 전'],['최종 상태',state.stage==='completed'?'동기화 완료':'수집·검증 성공 · 운영 반영 전']]:[];
      output.innerHTML=`<p><strong>${escape(state.label||'동기화 대기')}</strong></p>${state.error?`<p class="sellpia-sync-error">${escape(state.failedStage?`${state.failedStage} 단계: `:'')}${escape(state.error)}</p>`:`<p>${escape(state.detail||'버튼을 누르면 회사 PC의 실행기가 최신 전체 원본을 수집합니다.')}</p>`}${rows.length?`<dl>${rows.map(([key,value])=>`<dt>${escape(key)}</dt><dd>${escape(value)}</dd>`).join('')}</dl>`:''}${state.plan?.summary?.reviewRequired?`<p class="sellpia-sync-error">${approved?'이 원본 지문에 대한 서버의 검토 승인이 확인됐습니다.':'원본 범위·SKU 추가·제외 검토가 필요합니다. 서버가 이 원본을 승인하기 전에는 반영할 수 없습니다.'}</p>`:''}`;
    }
    function visibility(){panel.hidden=doc.getElementById('source-select')?.value!=='sellpia';}
    start.addEventListener('click',async()=>{try{await controller.run(currentPolicy());}catch(error){render({...controller.getState(),label:'동기화 시작 실패',error:error.message,busy:false});}});
    cancel.addEventListener('click',async()=>{try{await controller.cancel();}catch(error){render({...controller.getState(),error:error.message});}});
    apply.addEventListener('click',async()=>{try{await controller.apply();}catch(error){render({...controller.getState(),error:error.message});}});
    recover?.addEventListener('click',async()=>{try{await controller.recover();}catch(error){render({...controller.getState(),error:error.message});}});
    const refreshOverview=()=>{if(options.data?.hasOperationsHubSession?.()===false)return;controller.refreshOverview?.().catch(()=>{});};
    refresh?.addEventListener('click',refreshOverview);
    mode.addEventListener('change',()=>{updatePolicy();render(controller.getState());});
    execution?.addEventListener('change',()=>render(controller.getState()));
    for(const field of fields)field.addEventListener('change',()=>{if(mode.value==='patch')patchFields[field.dataset.sellpiaSyncField]=field.checked;render(controller.getState());});
    doc.getElementById('source-select')?.addEventListener('change',visibility);
    global.addEventListener?.('operations-hub-session-changed',event=>{if(event.detail?.authenticated)refreshOverview();});
    if(doc===global.document&&typeof global.setInterval==='function'){
      const timer=global.setInterval(()=>{if(doc.visibilityState==='visible'&&!panel.hidden&&doc.getElementById('upload')?.classList.contains('active-page')&&!controller.getState().busy&&!controller.getState().overviewBusy)refreshOverview();},15000);
      global.addEventListener?.('pagehide',()=>global.clearInterval(timer),{once:true});
    }
    visibility();updatePolicy();render(controller.getState());refreshOverview();
    return controller;
  }
  return Object.freeze({mount});
});
