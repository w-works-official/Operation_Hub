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
    const controller=(options.client||global.SystemV3SellpiaSyncClient).createController({data:options.data,contract:options.contract||global.SystemV3SellpiaSyncContract,XLSX:options.XLSX||global.XLSX,productionEnabled:false,afterApply:options.afterApply,onState:render});
    function render(state){
      start.disabled=Boolean(state.busy)||['apply_unknown','matrix_pending','cancel_pending'].includes(state.stage);mode.disabled=Boolean(state.busy);
      cancel.disabled=!(state.job||state.pendingRequestId)||state.stage==='applying'||state.stage==='matrix_pending'||state.stage==='apply_unknown';apply.disabled=true;
      output.dataset.stage=state.stage;
      const summary=state.plan?.summary,comparison=state.comparison?.summary,result=state.result;
      const rows=summary?[['수집 시각',state.collectionTime||'미확인'],['읽은 전체 행',count(summary.rowCount)],['유효 SKU',count(state.plan?.parsed?.rows?.length)],['변경 SKU',count(comparison?.changedCount)],['동일값 SKU',count(comparison?.unchangedCount)],['신규 SKU',count(comparison?.addedCount)],['이전 원본에만 있는 SKU',count(comparison?.removedCount)],['중복 SKU',count(state.plan?.parsed?.duplicateSkuCount)],['오류 행',state.plan?.valid?'0':'미확인'],['비교 미확인 SKU',count(comparison?.unknownCount)],['반영 종류',state.plan.mode==='full'?'전체 교체':'부분 갱신'],['갱신 필드',Object.keys(state.plan.fields||{}).filter(key=>state.plan.fields[key]).map(key=>({inventory:'재고',price:'판매가',basePrice:'기준가격',purchasePrice:'매입가',basic:'상품 기본정보',status:'상품 상태'}[key]||key)).join(', ')],['snapshot',result?.snapshotId||'DB 반영 전'],['최종 상태',state.stage==='completed'?'동기화 완료':'수집·검증 성공 · 운영 반영 전']]:[];
      output.innerHTML=`<p><strong>${escape(state.label||'동기화 대기')}</strong></p>${state.error?`<p class="sellpia-sync-error">${escape(state.failedStage?`${state.failedStage} 단계: `:'')}${escape(state.error)}</p>`:`<p>${escape(state.detail||'버튼을 누르면 회사 PC의 실행기가 최신 전체 원본을 수집합니다.')}</p>`}${rows.length?`<dl>${rows.map(([key,value])=>`<dt>${escape(key)}</dt><dd>${escape(value)}</dd>`).join('')}</dl>`:''}${state.plan?.summary?.reviewRequired?'<p class="sellpia-sync-error">전체 행 수가 크게 줄었습니다. 원본 범위 확인 전에는 반영할 수 없습니다.</p>':''}`;
    }
    function visibility(){panel.hidden=doc.getElementById('source-select')?.value!=='sellpia';}
    start.addEventListener('click',async()=>{try{await controller.run(options.getPolicy?.(mode.value)||{mode:mode.value});}catch(error){render({...controller.getState(),label:'동기화 시작 실패',error:error.message,busy:false});}});
    cancel.addEventListener('click',async()=>{try{await controller.cancel();}catch(error){render({...controller.getState(),error:error.message});}});
    doc.getElementById('source-select')?.addEventListener('change',visibility);
    visibility();render(controller.getState());
    return controller;
  }
  return Object.freeze({mount});
});
