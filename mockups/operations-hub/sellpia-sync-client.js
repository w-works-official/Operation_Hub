(function(global,factory){
  const api=factory(global);
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  global.SystemV3SellpiaSyncClient=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(global){
  'use strict';
  const labels=Object.freeze({connecting:'셀피아 연결 확인',queued:'실행기 연결 대기',collecting:'최신 원본 수집 중',collected:'파일 완전성 검사 중',validating:'SKU 검증 중',comparing:'기존 데이터와 비교 중',previewed:'검증 완료 · 반영 승인 대기',applying:'DB 반영 중',db_ready:'원본 반영 완료 · 매트릭스 확인 중',matrix_failed:'원본 반영 완료 · 매트릭스 재확인 필요',matrix_pending:'매트릭스 재구성 중',complete:'동기화 완료',completed:'동기화 완료',needs_login:'셀피아 재로그인 필요',failed:'동기화 실패',cancelled:'동기화 취소',cancel_pending:'취소 결과 확인 필요',stale:'기준 원본 변경 · 다시 수집 필요',apply_unknown:'DB 반영 결과 확인 필요'});
  const clean=v=>String(v??'').trim();
  const DEFAULT_FIELDS=Object.freeze({inventory:true,price:true,basePrice:true,purchasePrice:true,basic:false,status:false});
  function stopped(message,code){return Object.assign(new Error(message),{code});}
  function createController(options={}){
    const data=options.data,contract=options.contract||global.SystemV3SellpiaSyncContract;
    const emit=typeof options.onState==='function'?options.onState:()=>{};
    const sleep=options.sleep||(ms=>new Promise(resolve=>global.setTimeout(resolve,ms)));
    const now=options.now||Date.now;
    let state={stage:'idle',busy:false,job:null,pendingRequestId:null,plan:null,comparison:null,result:null,error:'',collectionTime:null,availability:null,history:[],overviewError:'',overviewBusy:false};
    let generation=0,activePromise=null,applyPromise=null,cancelPromise=null,planFiles=null,pendingEnqueue=null,activeAbort=null;
    let pendingStorage=options.pendingStorage;
    if(pendingStorage===undefined)try{pendingStorage=global.sessionStorage;}catch(error){pendingStorage=null;}
    const pendingKey='system-v3-sellpia-sync-pending-request-v1';
    const applicationKey='system-v3-sellpia-sync-pending-application-v1';
    try{const saved=JSON.parse(pendingStorage?.getItem(pendingKey)||'null');if(saved?.requestId&&['full','patch'].includes(saved.mode)&&saved.applyProduction===false)pendingEnqueue=saved;}catch(error){/* An invalid local hint never grants execution authority. */}
    state.pendingRequestId=pendingEnqueue?.requestId||null;
    if(pendingEnqueue?.cancelRequested===true)Object.assign(state,{stage:'cancel_pending',error:'서버의 취소 결과를 확인하지 못했습니다. 취소를 다시 눌러 확인해주세요.'});
    try{const hint=JSON.parse(pendingStorage?.getItem(applicationKey)||'null');if(hint?.jobId&&/^[0-9a-f-]{36}$/i.test(hint.jobId)&&['full','patch'].includes(hint.applicationMode))Object.assign(state,{job:hint,stage:'apply_unknown',error:'이전 반영 결과를 서버에서 다시 확인해주세요.'});}catch(error){/* Stored hints never grant apply permission. */}
    function saveApplication(job){try{if(job)pendingStorage?.setItem(applicationKey,JSON.stringify({jobId:job.jobId,mode:'full',applicationMode:job.applicationMode,selectedFields:job.selectedFields,baselineSnapshotId:job.baselineSnapshotId}));else pendingStorage?.removeItem(applicationKey);}catch(error){/* Server status remains authoritative. */}}
    function savePending(value){pendingEnqueue=value;try{if(value)pendingStorage?.setItem(pendingKey,JSON.stringify(value));else pendingStorage?.removeItem(pendingKey);}catch(error){/* In-memory identity still prevents repeat clicks in this tab. */}publish({pendingRequestId:value?.requestId||null});}
    function requestBody(value){return {requestId:value.requestId,mode:'full',applicationMode:value.applicationMode||value.mode,selectedFields:value.selectedFields,baselineSnapshotId:value.baselineSnapshotId??null,applyProduction:false};}
    function sameFields(a,b){return Object.keys(contract.FULL_FIELDS).every(key=>Boolean(a?.[key])===Boolean(b?.[key]));}
    function sameScope(job,body){return job?.mode==='full'&&(job.applicationMode||job.mode)===body.applicationMode&&clean(job.baselineSnapshotId)===clean(body.baselineSnapshotId)&&sameFields(job.selectedFields,body.selectedFields);}
    function publish(patch){state={...state,...patch};emit({...state,label:labels[state.stage]||'동기화 대기'});return state;}
    function assertCurrent(ticket){if(ticket!==generation)throw stopped('취소되었거나 새 작업으로 교체되었습니다.','CANCELLED');}
    function snapshotOf(value){return clean(value?.stateSnapshotId||value?.snapshotId);}
    function reviewApproved(){const fingerprint=state.availability?.applicationPolicy?.approvedSourceFingerprint;return typeof fingerprint==='string'&&/^[a-f0-9]{64}$/.test(fingerprint)&&fingerprint===state.plan?.sourceFingerprint;}
    function policyOf(policy={}){
      const applicationMode=policy.applicationMode||policy.mode||'patch';
      if(!['full','patch'].includes(applicationMode))throw stopped('전체 교체 또는 부분 갱신을 선택해주세요.','INVALID_MODE');
      const supplied=policy.fields??DEFAULT_FIELDS;
      if(!supplied||typeof supplied!=='object'||Array.isArray(supplied)||Object.entries(supplied).some(([key,value])=>!Object.hasOwn(contract.FULL_FIELDS,key)||typeof value!=='boolean'))throw stopped('반영할 필드 정책을 확인해주세요.','INVALID_FIELDS');
      const fields=Object.fromEntries(Object.keys(contract.FULL_FIELDS).map(key=>[key,supplied[key]===true]));
      fields.price=fields.basePrice=fields.price||fields.basePrice;
      if(applicationMode==='full'&&!Object.values(fields).every(Boolean))throw stopped('전체 교체는 모든 원본 필드를 바꿉니다. 모든 항목을 명시적으로 선택해주세요.','FULL_FIELDS_REQUIRED');
      if(!Object.values(fields).some(Boolean))throw stopped('반영할 항목을 하나 이상 선택해주세요.','INVALID_FIELDS');
      return {applicationMode,fields};
    }
    async function refreshOverview(){
      publish({overviewBusy:true,overviewError:''});
      try{
        const availability=await data.sellpiaSyncRequest('availability',{});
        const history=await data.sellpiaSyncRequest('history',{});
        publish({availability,history:Array.isArray(history.jobs)?history.jobs:[],overviewBusy:false});
        if(!state.job&&availability.activeJob&&['applying','db_ready','matrix_failed'].includes(availability.activeJob.state))publish({job:availability.activeJob,stage:availability.activeJob.state==='applying'?'apply_unknown':'matrix_pending'});
        return availability;
      }catch(error){publish({overviewBusy:false,overviewError:clean(error.message)||'연결 상태를 확인하지 못했습니다.'});throw error;}
    }
    async function run(policy={}){
      if(activePromise||state.busy)return activePromise||{...state};
      if(state.stage==='cancel_pending')throw stopped('이전 작업의 취소 결과가 불명확합니다. 취소를 다시 눌러 확인해주세요.','CANCEL_UNCONFIRMED');
      if(['apply_unknown','matrix_pending'].includes(state.stage))throw stopped('이전 반영 결과를 먼저 확인해주세요. 원본을 다시 업로드하지 않습니다.','APPLY_UNCONFIRMED');
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
        const {applicationMode,fields}=policyOf(policy);
        const availability=await refreshOverview();assertCurrent(ticket);
        if(['applying','db_ready','matrix_failed'].includes(availability.activeJob?.state))throw stopped('이전 반영 결과를 먼저 확인해주세요.','APPLY_UNCONFIRMED');
        if(availability.enabled!==true)throw stopped('원본 수집 서버가 아직 활성화되지 않았습니다. 수동 업로드를 사용해주세요.','COLLECTION_DISABLED');
        if(availability.runner?.status==='needs_login')throw stopped('회사 PC의 실행기 브라우저에서 셀피아에 다시 로그인해주세요.','NEEDS_LOGIN');
        if(availability.runner?.online===false)throw stopped('회사 PC 실행기가 오프라인입니다. 연결 상태를 확인한 뒤 다시 실행해주세요.','RUNNER_OFFLINE');
        const automatic=policy.execution==='auto';
        if(automatic&&(availability.applyEnabled!==true||policy.automaticApproved!==true&&(typeof options.confirmApply!=='function'||await options.confirmApply({automatic:true,applicationMode,fields})!==true)))throw stopped('자동 반영은 서버 허용과 이번 실행 승인이 필요합니다.','APPROVAL_REQUIRED');
        const baseline=await data.loadLatestSellpiaOriginalStatus();assertCurrent(ticket);
        if(baseline?.boundary!=='signed-read-v1')throw stopped('보안 원본 조회 경계를 확인하지 못했습니다.','SECURE_BASELINE_REQUIRED');
        const requestId=pendingEnqueue?.requestId||(options.crypto||global.crypto)?.randomUUID?.();
        if(!requestId)throw stopped('안전한 작업 ID를 생성할 수 없습니다.','REQUEST_ID_REQUIRED');
        const enqueueBody=pendingEnqueue?requestBody(pendingEnqueue):{requestId,mode:'full',applicationMode,selectedFields:fields,baselineSnapshotId:snapshotOf(baseline)||null,applyProduction:false};
        savePending(enqueueBody);
        const created=await data.sellpiaSyncRequest('enqueue',enqueueBody,{signal:abort.signal});
        assertCurrent(ticket);let job=created.job;
        if(!job?.jobId)throw stopped('작업 요청 응답이 완전하지 않습니다.','INVALID_JOB');
        // Reused active jobs must have the same frozen scope as this click.
        if(!sameScope(job,enqueueBody))throw stopped('다른 원본 정책의 작업이 이미 실행 중입니다.','JOB_SCOPE_CONFLICT');
        publish({job});
        if((job.applicationMode||job.mode)!==applicationMode||!sameFields(job.selectedFields,fields)||clean(job.baselineSnapshotId)!==snapshotOf(baseline))throw stopped('이전 실행 요청 중 기준 원본이나 반영 정책이 바뀌었습니다. 이전 작업을 확인해주세요.','STALE_BASELINE');
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
        const collection=await contract.prepare(collected.files,{mode:'full',fields:{...contract.FULL_FIELDS},manifest:collected.manifest,requestId:job.requestId||requestId,baselineSnapshotId:snapshotOf(baseline)||null,XLSX:options.XLSX||global.XLSX},progress=>{if(ticket===generation)publish({detail:progress?.detail||progress?.title||''});});assertCurrent(ticket);
        const plan={...collection,mode:applicationMode,fields,collectionMode:'full',summary:{...collection.summary,mode:applicationMode,collectionMode:'full',fieldPolicy:applicationMode==='full'?'sellpia-full-source-v1':'sellpia-selected-fields-v1'}};
        if(!plan.valid)throw stopped((plan.errors||[]).join(' '),'INVALID_COLLECTION');
        planFiles=collected.files;
        publish({stage:'comparing',plan});
        const baselineData=await data.loadSellpiaSyncBaselineRows();assertCurrent(ticket);
        if(snapshotOf(baselineData)!==snapshotOf(baseline))throw stopped('비교 중 기준 셀피아 원본이 변경됐습니다.','STALE_BASELINE');
        if(!Array.isArray(baselineData.rows)||typeof contract.compareRows!=='function')throw stopped('기존 원본의 SKU 비교 자료를 확인하지 못했습니다.','BASELINE_COMPARISON_REQUIRED');
        const comparison=contract.compareRows(plan.parsed.rows,baselineData.rows,{mode:applicationMode,fields});
        if(comparison.valid===false)throw stopped((comparison.errors||[]).join(' '),'INVALID_BASELINE');
        const comparedStatus=await data.loadLatestSellpiaOriginalStatus();assertCurrent(ticket);
        if(comparedStatus.boundary!=='signed-read-v1'||snapshotOf(comparedStatus)!==snapshotOf(baseline))throw stopped('원본 비교 중 기준 snapshot이 변경됐습니다.','STALE_BASELINE');
        const baselineCount=baselineData.rows.length;
        const limits=availability.applicationPolicy||{},reviewReasons=[];
        const maxAdded=Number.isSafeInteger(limits.maxAddedCount)&&limits.maxAddedCount>=0?limits.maxAddedCount:100;
        const addedRatio=typeof limits.maxAddedRatio==='number'&&limits.maxAddedRatio>=0&&limits.maxAddedRatio<=1?limits.maxAddedRatio:0.05;
        const maxRemoved=Number.isSafeInteger(limits.maxRemovedCount)&&limits.maxRemovedCount>=0?limits.maxRemovedCount:0;
        if(baselineCount<1)reviewReasons.push('source_baseline_unknown');
        if(baselineCount>0&&plan.rowCount<baselineCount*0.8)reviewReasons.push('source_row_count_drop');
        if(comparison.summary.addedCount>Math.max(maxAdded,Math.floor(baselineCount*addedRatio)))reviewReasons.push('source_sku_added');
        if(comparison.summary.removedCount>maxRemoved)reviewReasons.push('source_sku_removed');
        plan.summary={...plan.summary,reviewRequired:reviewReasons.length>0,reviewReasons};
        await data.sellpiaSyncRequest('receipt',{jobId:job.jobId,receipt:{valid:true,rowCount:plan.rowCount,state:'previewed',sourceFingerprint:plan.sourceFingerprint,summary:{...plan.summary,comparison:comparison.summary},baselineSnapshotId:plan.baselineSnapshotId}},{signal:abort.signal});assertCurrent(ticket);
        savePending(null);
        publish({stage:'previewed',busy:false,plan,comparison,detail:'수집·검증 완료. 선택한 반영 정책의 변경 내용을 확인해주세요.'});
        if(automatic&&plan.summary.reviewRequired&&!reviewApproved())return publish({detail:'원본 변화의 서버 검토 승인이 필요해 자동 반영을 보류했습니다.'});
        if(automatic)return await apply({automaticApproved:true});
        return {...state};
      }catch(error){
        if(ticket!==generation)return {...state};
        if(['apply_unknown','matrix_pending'].includes(state.stage)){publish({busy:false,error:clean(error.message)});return {...state};}
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
    async function finishMatrix(result,fields,applyToken){
      publish({stage:'matrix_pending',busy:true,result,error:''});
      try{
        await data.waitForSellpiaMatrixRebuild(result.snapshotId,progress=>publish({detail:progress?.detail||''}));
        let completion;
        try{completion=await options.afterApply?.(result,fields);}catch(error){completion={warning:'원본과 매트릭스는 반영됐지만 화면·가격 계산 후처리를 다시 확인해야 합니다.'};}
        const acknowledgement=await data.sellpiaSyncRequest('apply-progress',{jobId:state.job.jobId,...(applyToken?{applyToken}:{}),state:'complete',snapshotId:result.snapshotId});
        if(acknowledgement.job?.jobId!==state.job.jobId||!['complete','completed'].includes(acknowledgement.job.state)||acknowledgement.job.applySnapshotId!==result.snapshotId||acknowledgement.job.importStatus!=='ready')throw stopped('서버의 snapshot·매트릭스 완료 증명을 확인하지 못했습니다.','COMPLETION_UNCONFIRMED');
        saveApplication(null);
        const completed=publish({stage:'completed',busy:false,job:acknowledgement.job||state.job,result:{...result,completion},detail:completion?.warning||'원본 반영과 매트릭스 재구성이 완료됐습니다.'});
        refreshOverview().catch(()=>{});
        return completed;
      }catch(error){
        data.sellpiaSyncRequest('apply-progress',{jobId:state.job.jobId,...(applyToken?{applyToken}:{}),state:'matrix_failed',snapshotId:result.snapshotId}).catch(()=>{});
        publish({stage:'matrix_pending',busy:false,error:clean(error.message),result});throw error;
      }
    }
    async function recover(){
      if(applyPromise)return applyPromise;
      if(!state.job?.jobId||!['apply_unknown','matrix_pending'].includes(state.stage))throw stopped('다시 확인할 반영 작업이 없습니다.','RECOVERY_NOT_REQUIRED');
      applyPromise=(async()=>{
        publish({busy:true,error:'',detail:'기존 snapshot과 매트릭스 상태를 조회합니다. 원본을 재업로드하지 않습니다.'});
        try{
          const status=await data.sellpiaSyncRequest('status',{jobId:state.job.jobId}),job=status.job;
          if(job?.jobId!==state.job.jobId)throw stopped('반영 상태의 작업 식별자가 다릅니다.','INVALID_JOB');
          if(state.plan&&!sameScope(job,{applicationMode:state.plan.mode,selectedFields:state.plan.fields,baselineSnapshotId:state.plan.baselineSnapshotId}))throw stopped('기존 반영 정책을 확인하지 못했습니다.','JOB_SCOPE_CONFLICT');
          publish({job});
          if(job.state==='failed'&&(['failed','aborted','expired'].includes(job.importStatus)||job.importStatus!=='ready'&&job.summary?.errorCode==='APPLY_SCOPE_EXPIRED')){
            saveApplication(null);planFiles=null;
            return publish({stage:'failed',busy:false,result:null,error:'서버가 이전 반영의 실패·종료를 확인했습니다. 새 수집은 별도 작업으로 시작해주세요.'});
          }
          if(!job.applySnapshotId||!['db_ready','matrix_failed','complete','completed'].includes(job.state)||job.importStatus!=='ready')return publish({stage:'apply_unknown',busy:false,error:'기존 DB 반영의 완료 여부가 아직 확정되지 않았습니다. 서버 상태를 다시 확인해주세요.'});
          const result={snapshotId:job.applySnapshotId,intentId:job.importIntentId,uploadMode:job.applicationMode,rowCount:job.rowCount||job.receipt?.rowCount,uploadedRowCount:job.receipt?.rowCount,affectedSkus:[],recovered:true};
          return await finishMatrix(result,job.selectedFields);
        }catch(error){publish({busy:false,error:clean(error.message)});throw error;}
      })().finally(()=>{applyPromise=null;});
      return applyPromise;
    }
    async function apply({automaticApproved=false}={}){
      if(applyPromise)return applyPromise;
      if(state.availability?.applyEnabled!==true||state.stage!=='previewed'||state.plan?.summary?.reviewRequired&&!reviewApproved()||state.comparison?.summary?.unknownCount||!planFiles)throw stopped('서버의 반영 허용과 원본 검토 승인이 필요합니다.','PRODUCTION_APPLY_DISABLED');
      applyPromise=(async()=>{
        if(!automaticApproved&&(typeof options.confirmApply!=='function'||await options.confirmApply({...state})!==true))throw stopped('원본 반영 승인이 필요합니다.','APPROVAL_REQUIRED');
        const plan=state.plan;
        const current=await data.loadLatestSellpiaOriginalStatus();
        if(current.boundary!=='signed-read-v1'||snapshotOf(current)!==clean(plan.baselineSnapshotId))throw stopped('기준 원본이 변경돼 반영할 수 없습니다.','STALE_BASELINE');
        publish({stage:'applying',busy:true,error:''});
        saveApplication(state.job);
        let result,approvalAcknowledged=false;
        try{
          const approval=await data.sellpiaSyncRequest('apply-init',{jobId:state.job.jobId,sourceFingerprint:plan.sourceFingerprint});
          if(approval.job?.jobId!==state.job.jobId||approval.job?.applyProduction!==true||!approval.applyToken||!sameScope(approval.job,{applicationMode:plan.mode,selectedFields:plan.fields,baselineSnapshotId:plan.baselineSnapshotId}))throw stopped('서버의 반영 승인 범위를 확인하지 못했습니다.','INVALID_APPLY_APPROVAL');
          approvalAcknowledged=true;
          publish({job:approval.job});
          if(approval.recoverIntentId||approval.snapshotId||approval.job.importIntentId)throw stopped('기존 반영 intent가 있습니다. 상태 확인으로 복구해주세요.','APPLY_UNCONFIRMED');
          result=await data.uploadSellpiaSnapshot(planFiles,{...plan.fields,mode:plan.mode,requestId:approval.requestId||plan.requestId,synchronizationJob:true,syncJobId:state.job.jobId,syncApplyToken:approval.applyToken},progress=>publish({detail:progress?.detail||progress?.title||''}));
          publish({stage:'matrix_pending',result});
          await data.sellpiaSyncRequest('apply-progress',{jobId:state.job.jobId,applyToken:approval.applyToken,state:'matrix_wait',snapshotId:result.snapshotId});
          return await finishMatrix(result,plan.fields,approval.applyToken);
        }catch(error){
          if(!approvalAcknowledged&&(error.code==='APPLY_DISABLED'||[400,401,403,409].includes(error.httpStatus))){saveApplication(null);publish({stage:'previewed',busy:false,error:clean(error.message)});}
          else publish({stage:result?.snapshotId?'matrix_pending':'apply_unknown',busy:false,error:clean(error.message),result:result||null});
          throw error;
        }
      })().finally(()=>{applyPromise=null;});
      return applyPromise;
    }
    return Object.freeze({run,cancel,apply:()=>apply(),recover,refreshOverview,getState:()=>({...state}),labels});
  }
  return Object.freeze({createController,labels});
});
