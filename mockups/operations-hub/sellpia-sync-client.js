(function(global,factory){
  const api=factory(global);
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  global.SystemV3SellpiaSyncClient=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(global){
  'use strict';
  const labels=Object.freeze({connecting:'셀피아 연결 확인',queued:'실행기 연결 대기',collecting:'최신 원본 수집 중',collected:'파일 완전성 검사 중',validating:'SKU 검증 중',comparing:'기존 데이터와 비교 중',previewed:'검증 완료 · 반영 승인 대기',applying:'DB 반영 중',matrix_pending:'매트릭스 재구성 중',completed:'동기화 완료',needs_login:'셀피아 재로그인 필요',failed:'동기화 실패',cancelled:'동기화 취소',cancel_pending:'취소 결과 확인 필요',stale:'기준 원본 변경 · 다시 수집 필요',apply_unknown:'DB 반영 결과 확인 필요'});
  const clean=v=>String(v??'').trim();
  function stopped(message,code){return Object.assign(new Error(message),{code});}
  function createController(options={}){
    const data=options.data,contract=options.contract||global.SystemV3SellpiaSyncContract;
    const emit=typeof options.onState==='function'?options.onState:()=>{};
    const sleep=options.sleep||(ms=>new Promise(resolve=>global.setTimeout(resolve,ms)));
    const now=options.now||Date.now;
    let state={stage:'idle',busy:false,job:null,pendingRequestId:null,plan:null,comparison:null,result:null,error:'',collectionTime:null};
    let generation=0,activePromise=null,applyPromise=null,cancelPromise=null,planFiles=null,pendingEnqueue=null,activeAbort=null;
    let pendingStorage=options.pendingStorage;
    if(pendingStorage===undefined)try{pendingStorage=global.sessionStorage;}catch(error){pendingStorage=null;}
    const pendingKey='system-v3-sellpia-sync-pending-request-v1';
    try{const saved=JSON.parse(pendingStorage?.getItem(pendingKey)||'null');if(saved?.requestId&&['full','patch'].includes(saved.mode)&&saved.applyProduction===false)pendingEnqueue=saved;}catch(error){/* An invalid local hint never grants execution authority. */}
    state.pendingRequestId=pendingEnqueue?.requestId||null;
    if(pendingEnqueue?.cancelRequested===true)Object.assign(state,{stage:'cancel_pending',error:'서버의 취소 결과를 확인하지 못했습니다. 취소를 다시 눌러 확인해주세요.'});
    function savePending(value){pendingEnqueue=value;try{if(value)pendingStorage?.setItem(pendingKey,JSON.stringify(value));else pendingStorage?.removeItem(pendingKey);}catch(error){/* In-memory identity still prevents repeat clicks in this tab. */}publish({pendingRequestId:value?.requestId||null});}
    function requestBody(value){return {requestId:value.requestId,mode:value.mode,selectedFields:value.selectedFields,baselineSnapshotId:value.baselineSnapshotId??null,applyProduction:false};}
    function sameFields(a,b){return Object.keys(contract.FULL_FIELDS).every(key=>Boolean(a?.[key])===Boolean(b?.[key]));}
    function sameScope(job,body){return job?.mode===body.mode&&clean(job.baselineSnapshotId)===clean(body.baselineSnapshotId)&&sameFields(job.selectedFields,body.selectedFields);}
    function publish(patch){state={...state,...patch};emit({...state,label:labels[state.stage]||'동기화 대기'});return state;}
    function assertCurrent(ticket){if(ticket!==generation)throw stopped('취소되었거나 새 작업으로 교체되었습니다.','CANCELLED');}
    function snapshotOf(value){return clean(value?.stateSnapshotId||value?.snapshotId);}
    async function run(policy={}){
      if(activePromise||state.busy)return activePromise||{...state};
      if(state.stage==='cancel_pending')throw stopped('이전 작업의 취소 결과가 불명확합니다. 취소를 다시 눌러 확인해주세요.','CANCEL_UNCONFIRMED');
      if(applyPromise)throw stopped('DB 반영 결과가 확인될 때까지 새 작업을 시작할 수 없습니다.','APPLY_IN_PROGRESS');
      const ticket=++generation;
      const task=collect(policy,ticket).finally(()=>{if(activePromise===task)activePromise=null;});
      activePromise=task;
      return activePromise;
    }
    async function collect(policy,ticket){
      const abort=new AbortController();activeAbort=abort;
      planFiles=null;
      publish({stage:'connecting',busy:true,job:null,plan:null,comparison:null,result:null,error:''});
      try{
        if(!data?.sellpiaSyncRequest||!data?.loadLatestSellpiaOriginalStatus||!contract?.prepare)throw stopped('원본 동기화 모듈을 불러오지 못했습니다.','MODULE_MISSING');
        const mode=policy.mode||'full',fields=mode==='full'?{...contract.FULL_FIELDS}:{...policy.fields};
        if(!['full','patch'].includes(mode))throw stopped('전체 교체 또는 부분 갱신을 선택해주세요.','INVALID_MODE');
        if(mode!=='full')throw stopped('자동 동기화는 전체 원본만 지원합니다. 부분 갱신은 기존 수동 업로드를 사용해주세요.','AUTOMATION_FULL_ONLY');
        const baseline=await data.loadLatestSellpiaOriginalStatus();assertCurrent(ticket);
        if(baseline?.boundary!=='signed-read-v1')throw stopped('보안 원본 조회 경계를 확인하지 못했습니다.','SECURE_BASELINE_REQUIRED');
        const requestId=pendingEnqueue?.requestId||(options.crypto||global.crypto)?.randomUUID?.();
        if(!requestId)throw stopped('안전한 작업 ID를 생성할 수 없습니다.','REQUEST_ID_REQUIRED');
        const enqueueBody=pendingEnqueue?requestBody(pendingEnqueue):{requestId,mode,selectedFields:fields,baselineSnapshotId:snapshotOf(baseline)||null,applyProduction:false};
        savePending(enqueueBody);
        const created=await data.sellpiaSyncRequest('enqueue',enqueueBody,{signal:abort.signal});
        assertCurrent(ticket);let job=created.job;
        if(!job?.jobId)throw stopped('작업 요청 응답이 완전하지 않습니다.','INVALID_JOB');
        // Reused active jobs must have the same frozen scope as this click.
        if(!sameScope(job,enqueueBody))throw stopped('다른 원본 정책의 작업이 이미 실행 중입니다.','JOB_SCOPE_CONFLICT');
        publish({job});
        if(job.mode!==mode||!sameFields(job.selectedFields,fields)||clean(job.baselineSnapshotId)!==snapshotOf(baseline))throw stopped('이전 실행 요청 중 기준 원본이나 반영 정책이 바뀌었습니다. 이전 작업을 확인해주세요.','STALE_BASELINE');
        const jobIdentity={...job};
        const started=now(),timeoutMs=options.timeoutMs??900000;
        while(!['collected','previewed','failed','needs_login','cancelled'].includes(job.state)){
          publish({stage:job.state==='collecting'?'collecting':'queued',job});
          if(now()-started>timeoutMs)throw stopped('원본 수집 대기 시간이 초과되었습니다. 작업 이력을 확인해주세요.','COLLECTION_TIMEOUT');
          await sleep(options.pollMs??2000);assertCurrent(ticket);
          const status=await data.sellpiaSyncRequest('status',{jobId:jobIdentity.jobId},{signal:abort.signal});assertCurrent(ticket);job=status.job;
          if(!job?.jobId)throw stopped('작업 상태를 확인하지 못했습니다.','INVALID_JOB');
          if(job.jobId!==jobIdentity.jobId||!sameScope(job,enqueueBody))throw stopped('작업 상태의 식별자나 원본 정책이 변경됐습니다.','JOB_SCOPE_CONFLICT');
        }
        publish({job});
        if(['failed','needs_login','cancelled'].includes(job.state)){savePending(null);throw stopped(job.state==='needs_login'?'회사 PC의 실행기 브라우저에서 셀피아에 다시 로그인해주세요.':job.state==='cancelled'?'수집 작업이 취소되었습니다.':clean(job.error)||'원본 수집에 실패했습니다.',job.state.toUpperCase());}
        publish({stage:'collected',collectionTime:job.collectedAt||job.updatedAt||null});
        const collected=await data.loadSellpiaSyncArtifacts(job.jobId,{signal:abort.signal});assertCurrent(ticket);
        const current=await data.loadLatestSellpiaOriginalStatus();assertCurrent(ticket);
        if(current.boundary!=='signed-read-v1'||snapshotOf(current)!==snapshotOf(baseline))throw stopped('수집 중 기준 셀피아 원본이 변경됐습니다. 다시 동기화해주세요.','STALE_BASELINE');
        publish({stage:'validating'});
        const plan=await contract.prepare(collected.files,{mode,fields,manifest:collected.manifest,requestId:job.requestId||requestId,baselineSnapshotId:snapshotOf(baseline)||null,XLSX:options.XLSX||global.XLSX},progress=>{if(ticket===generation)publish({detail:progress?.detail||progress?.title||''});});assertCurrent(ticket);
        if(!plan.valid)throw stopped((plan.errors||[]).join(' '),'INVALID_COLLECTION');
        planFiles=collected.files;
        publish({stage:'comparing',plan});
        const baselineData=await data.loadSellpiaSyncBaselineRows();assertCurrent(ticket);
        if(snapshotOf(baselineData)!==snapshotOf(baseline))throw stopped('비교 중 기준 셀피아 원본이 변경됐습니다.','STALE_BASELINE');
        if(!Array.isArray(baselineData.rows)||typeof contract.compareRows!=='function')throw stopped('기존 원본의 SKU 비교 자료를 확인하지 못했습니다.','BASELINE_COMPARISON_REQUIRED');
        const comparison=contract.compareRows(plan.parsed.rows,baselineData.rows,{mode,fields});
        if(comparison.valid===false)throw stopped((comparison.errors||[]).join(' '),'INVALID_BASELINE');
        const comparedStatus=await data.loadLatestSellpiaOriginalStatus();assertCurrent(ticket);
        if(comparedStatus.boundary!=='signed-read-v1'||snapshotOf(comparedStatus)!==snapshotOf(baseline))throw stopped('원본 비교 중 기준 snapshot이 변경됐습니다.','STALE_BASELINE');
        const baselineCount=baselineData.rows.length;
        if(mode==='full'&&baselineCount>0&&plan.rowCount<baselineCount*0.8)plan.summary={...plan.summary,reviewRequired:true,reviewReasons:['source_row_count_drop']};
        await data.sellpiaSyncRequest('receipt',{jobId:job.jobId,receipt:{valid:true,rowCount:plan.rowCount,state:'previewed',sourceFingerprint:plan.sourceFingerprint,summary:{...plan.summary,comparison:comparison.summary},baselineSnapshotId:plan.baselineSnapshotId}},{signal:abort.signal});assertCurrent(ticket);
        savePending(null);
        return publish({stage:'previewed',busy:false,plan,comparison,detail:'수집·검증 완료. 개발 검증 모드에서는 운영 DB에 반영하지 않습니다.'});
      }catch(error){
        if(ticket!==generation)return {...state};
        const stage=error.code==='NEEDS_LOGIN'?'needs_login':error.code==='CANCELLED'?'cancelled':error.code==='STALE_BASELINE'?'stale':'failed';
        publish({stage,busy:false,error:clean(error.message)||'동기화에 실패했습니다.',failedStage:state.stage});return {...state};
      }
    }
    async function cancel(){
      if(applyPromise)throw stopped('DB 반영 중에는 중단 대신 결과 확인이 필요합니다.','APPLY_IN_PROGRESS');
      if(cancelPromise)return cancelPromise;
      const jobId=state.job?.jobId,pending=pendingEnqueue?requestBody(pendingEnqueue):state.job?.requestId?requestBody(state.job):null;++generation;
      activeAbort?.abort();activePromise=null;
      planFiles=null;
      if(!jobId&&!pending)return publish({stage:'cancelled',busy:false,plan:null,error:''});
      // Persist cancellation intent before the request. A lost enqueue reply
      // must be cancelled atomically by requestId, never by a read-then-cancel.
      if(pending)savePending({...pending,cancelRequested:true});
      publish({stage:'cancel_pending',busy:false,plan:null,error:''});
      cancelPromise=(async()=>{
        try{
          const result=await data.sellpiaSyncRequest(jobId?'cancel':'cancel-request',jobId?{jobId}:pending);
          if(!result?.job||result.job.state!=='cancelled'||(jobId?result.job.jobId!==jobId:result.job.requestId!==pending.requestId||!sameScope(result.job,pending)))throw stopped('서버의 취소 응답이 요청과 다릅니다.','CANCEL_UNCONFIRMED');
          savePending(null);
          return publish({stage:'cancelled',busy:false,job:result.job,plan:null,error:''});
        }catch(error){publish({stage:'cancel_pending',busy:false,plan:null,error:'서버의 취소 결과를 확인하지 못했습니다. 취소를 다시 눌러 확인해주세요.'});throw stopped(state.error,'CANCEL_UNCONFIRMED');}
      })().finally(()=>{cancelPromise=null;});
      return cancelPromise;
    }
    async function apply(){
      if(applyPromise)return applyPromise;
      // Both a release-level server permission and a reviewed UI approval are
      // required. The shipped preview endpoint never grants this permission.
      if(options.productionEnabled!==true||state.job?.applyProduction!==true||state.stage!=='previewed'||state.plan?.summary?.reviewRequired||state.comparison?.summary?.unknownCount)throw stopped('Production 반영은 승인 전 비활성화되어 있습니다.','PRODUCTION_APPLY_DISABLED');
      if(typeof options.confirmApply!=='function'||await options.confirmApply({...state})!==true)throw stopped('원본 반영 승인이 필요합니다.','APPROVAL_REQUIRED');
      applyPromise=(async()=>{
        const plan=state.plan;
        const current=await data.loadLatestSellpiaOriginalStatus();
        if(current.boundary!=='signed-read-v1'||snapshotOf(current)!==clean(plan.baselineSnapshotId))throw stopped('기준 원본이 변경돼 반영할 수 없습니다.','STALE_BASELINE');
        publish({stage:'applying',busy:true,error:''});
        let result;
        try{
          result=await data.uploadSellpiaSnapshot(planFiles,{...plan.fields,mode:plan.mode,requestId:plan.requestId,synchronizationJob:true},progress=>publish({detail:progress?.detail||progress?.title||''}));
          publish({stage:'matrix_pending',result});
          await data.waitForSellpiaMatrixRebuild(result.snapshotId,progress=>publish({detail:progress?.detail||''}));
          const completion=await options.afterApply?.(result,plan.fields);
          return publish({stage:'completed',busy:false,result:{...result,completion}});
        }catch(error){publish({stage:result?.snapshotId?'matrix_pending':'apply_unknown',busy:false,error:clean(error.message),result:result||null});throw error;}
      })().finally(()=>{applyPromise=null;});
      return applyPromise;
    }
    return Object.freeze({run,cancel,apply,getState:()=>({...state}),labels});
  }
  return Object.freeze({createController,labels});
});
