// Native multi-session completion serialization; isolated local DB only.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createNativeSqlRunner,sqlLiteral as L,sqlJson as J} from './operationsHubSellpiaSyncOperationalNativeSql.mjs';
import {QueueProtocol,sha256} from '../supabase/functions/operations-hub-sellpia-sync/protocol.mjs';
import {RpcQueueStore} from '../supabase/functions/operations-hub-sellpia-sync/rpc-store.mjs';
const session='isolated-operator',actor={kind:'browser',username:'isolated'},worker={kind:'worker',workerId:'qa-native-race-pc'};
const outputs=path.resolve(process.env.SELLPIA_QA_OUTPUT_DIRECTORY||'');
const result={verifiedAt:new Date().toISOString(),scope:'Separate native PostgreSQL completion sessions, same pinned local baseline',productionWrites:0,storageCalls:0,status:'running'};
let stage='scope';
async function main(){
 if(process.argv[2]!=='--run-isolated-native'||path.basename(outputs)!=='outputs')throw Error('QA_EXPLICIT_OPT_IN_REQUIRED');
 const prior=JSON.parse(await fs.readFile(path.join(outputs,'sellpia-native-operational-27k-qa-20261013.json'),'utf8'));
 assert.equal(prior.status,'passed');
 const db=await createNativeSqlRunner();result.database=db.identity;
 const sql=async expression=>(await db.json('select to_jsonb('+expression+')')).data;
 const rpc=async(name,args)=>sql(`public.${name}(${args.join(',')})`);
 const runtime=async(action,body={},enabled=false)=>rpc('hub_sellpia_sync_runtime_v1',[L(action),J(body),L(session),String(enabled)]);
 const retry=process.argv.includes('--restart-failed-race');
 if(retry){const previous=JSON.parse(await fs.readFile(path.join(outputs,'sellpia-native-completion-concurrency-20261013.json'),'utf8'));assert.equal(previous.status,'failed');assert.equal(previous.database.database,'operation_hub_sync_qa');
  const stale=await sql("coalesce((select jsonb_agg(job_id) from operations_private.sellpia_sync_jobs where state='applying' and body->'collectionManifest'->>'expectedRowCount'='3' and body->'collectionManifest'->'files'->0->>'name'='isolated-race-1.csv'),'[]'::jsonb)");
  for(const id of stale){await db.call(`update operations_private.sellpia_sync_apply_scopes set expires_at=clock_timestamp()-interval '1 second' where job_id=${L(id)}::uuid;`);assert.equal((await runtime('status',{jobId:id})).job.state,'failed');}result.restartedFailedFixtureWithoutReset=true;
 }
 const baseline=await sql("(select jsonb_build_object('id',snapshot_id,'rows',valid_row_count) from public.sellpia_stock_snapshots where upload_status='ready' order by completed_at desc nulls last,created_at desc,snapshot_id desc limit 1)");
 if(!retry)assert.equal(baseline.id,prior.checks.find(c=>c.id==='C04').snapshotId);assert.equal(baseline.rows,27278);result.baseline=baseline;
 const rows=await sql("(select jsonb_agg(jsonb_build_object('sellpia_sku_code',sellpia_sku_code,'stock',stock+10,'available_stock',available_stock-10,'integrated_available_stock',integrated_available_stock,'safety_stock',safety_stock,'source_row_no',source_row_no,'raw_payload',raw_payload)) from (select * from public.sellpia_stock_snapshot_rows where snapshot_id=(select snapshot_id from public.sellpia_stock_snapshots where upload_status='ready' order by completed_at desc nulls last,created_at desc,snapshot_id desc limit 1) order by sellpia_sku_code limit 3)r)");
 assert.equal(rows.length,3);
 const beforeManual=await sql("jsonb_build_object('master',(select md5(jsonb_agg(to_jsonb(r) order by sellpia_sku_code)::text) from public.operations_hub_sku_operational_master r),'mappings',(select md5(jsonb_agg(to_jsonb(r) order by import_id)::text) from review.final_excel_mapping_import r),'aux',(select md5(jsonb_agg(to_jsonb(r) order by domain)::text) from operations_private.qa_manual_aux r))");
 const bytes=new TextEncoder().encode('x\n');const files=await Promise.all([1,2,3].map(async n=>({ordinal:n,name:`isolated-race-${n}.csv`,size:bytes.length,sha256:await sha256(bytes)})));
 const selected={inventory:true,price:false,basePrice:false,purchasePrice:false,basic:false,status:false};
 const client={rpc:async(name,{p_action,p_payload})=>{assert.equal(name,'hub_sellpia_sync_queue_v1');try{return {data:(await db.json(`begin;set local role service_role;select public.hub_sellpia_sync_queue_v1(${L(p_action)},${J(p_payload)});commit;`)).data,error:null};}catch(error){return {data:null,error};}}};
 const queue=new QueueProtocol(new RpcQueueStore(client));
 stage='stage-sync';const {job}=await queue.dispatch('enqueue',{requestId:randomUUID(),mode:'full',applicationMode:'patch',selectedFields:selected,baselineSnapshotId:baseline.id},actor);result.syncJobId=job.jobId;
 const claim=await queue.dispatch('claim',{},worker),scope={jobId:job.jobId,leaseToken:claim.leaseToken};
 const {manifest}=await queue.dispatch('upload-init',{...scope,collectionManifest:{source:'sellpia',collectionMode:'official_download',mode:'full',includeAll:true,filters:[],expectedRowCount:3,files}},worker);
 await queue.dispatch('upload-finalize',{...scope,verifiedArtifacts:manifest.map(f=>({...f,verified:true}))},worker);
 const fingerprint=await sha256('isolated-native-concurrent-source-'+job.requestId);
 await queue.dispatch('receipt',{jobId:job.jobId,receipt:{valid:true,rowCount:3,sourceFingerprint:fingerprint,baselineSnapshotId:baseline.id,summary:{mode:'patch',rowCount:3,reviewRequired:false,comparison:{baselineRowCount:27278,newRowCount:3,addedCount:0,removedCount:0,unknownCount:0}}}},actor);
 await db.call('update operations_private.sellpia_sync_config set apply_enabled=true,approved_source_fingerprint=null');
 const token=randomUUID();await runtime('apply-init',{jobId:job.jobId,sourceFingerprint:fingerprint,tokenHash:await sha256(token)},true);
 const uploadFiles=files.map(f=>({name:f.name,size:f.size,sha256:f.sha256,mime_type:'text/csv'}));
 const sync=await rpc('hub_sellpia_sync_upload_begin_v1',[L(session),L(job.jobId)+'::uuid',L(token),L(job.requestId)+'::uuid',L('patch'),J(uploadFiles),J(selected),'3']);
 const manual=await rpc('hub_original_upload_intent_begin_v2',[L(session),L(randomUUID())+'::uuid',L('patch'),J(uploadFiles),J(selected),'3']);result.stagedIds={syncSnapshot:sync.snapshot_id,syncIntent:sync.intent_id,manualSnapshot:manual.snapshot_id,manualIntent:manual.intent_id};
 async function stageRows(intent,payload){
  await rpc('hub_original_upload_intent_uploaded_v1',[L(session),L(intent.intent_id)+'::uuid',J(intent.manifest.map(f=>({path:f.path,size:f.size,type:'text/csv',object_id:randomUUID(),etag:'local-race-metadata'})))]);
  const r=await rpc('hub_sellpia_upload_rows_v2',[L(session),L(intent.intent_id)+'::uuid',J(payload)]);assert.equal(r.inserted_count,3);
 }
 await stageRows(sync,rows.map(r=>({...r,stock:r.stock+10})));await stageRows(manual,rows);
 stage='manual-completion-lock';
 // SQL transaction keeps the actual completion's advisory lock after ready write.
 const manualPending=db.json(`begin;set local application_name='operation_hub_sync_qa_manual_race';select public.hub_sellpia_upload_complete_v2(${L(session)},${L(manual.intent_id)}::uuid);select pg_sleep(3);commit;`);
 const waitUntil=async predicate=>{for(let i=0;i<35;i++){if(await predicate())return true;await new Promise(resolve=>setTimeout(resolve,30));}return false;};
 const holding=await waitUntil(async()=>await sql("exists(select 1 from pg_locks l join pg_stat_activity a using(pid) where a.datname='operation_hub_sync_qa' and a.application_name='operation_hub_sync_qa_manual_race' and l.locktype='advisory' and l.granted)"));assert.equal(holding,true);result.actualManualCompletionAdvisoryLockObserved=true;
 stage='concurrent-sync-wait';
 const syncPending=db.json(`set application_name='operation_hub_sync_qa_sync_race';select public.hub_sellpia_upload_complete_v2(${L(session)},${L(sync.intent_id)}::uuid);`).then(value=>({ok:true,value}),error=>({ok:false,reason:error.safeReason}));
 const waiting=await waitUntil(async()=>await sql("exists(select 1 from pg_locks l join pg_stat_activity a using(pid) where a.datname='operation_hub_sync_qa' and a.application_name='operation_hub_sync_qa_sync_race' and l.locktype='advisory' and not l.granted)"));assert.equal(waiting,true);result.separateSyncSessionWaitingOnActualAdvisoryLock=true;
 const completed=await manualPending;assert.equal(completed.data.status,'ready');assert.equal(completed.data.row_count,27278);
 const refused=await syncPending;assert.equal(refused.ok,false);assert.equal(refused.reason,'baseline snapshot changed');
 result.manualCompletion='ready';result.staleSyncCompletion='baseline snapshot changed';
 stage='after-race-proof';
 const after=await sql(`jsonb_build_object('latest',(select snapshot_id from public.sellpia_stock_snapshots where upload_status='ready' order by completed_at desc nulls last,created_at desc,snapshot_id desc limit 1),'readyRows',(select valid_row_count from public.sellpia_stock_snapshots where snapshot_id=${L(manual.snapshot_id)}::uuid),'staleState',(select upload_status from public.sellpia_stock_snapshots where snapshot_id=${L(sync.snapshot_id)}::uuid),'staleStagedRows',(select count(*) from public.sellpia_stock_snapshot_rows where snapshot_id=${L(sync.snapshot_id)}::uuid),'changedRows',(select count(*) from public.sellpia_stock_snapshot_rows a join public.sellpia_stock_snapshot_rows b on a.sellpia_sku_code=b.sellpia_sku_code and b.snapshot_id=${L(baseline.id)}::uuid where a.snapshot_id=${L(manual.snapshot_id)}::uuid and a.stock is distinct from b.stock))`);
 assert.equal(after.latest,manual.snapshot_id);assert.equal(after.readyRows,27278);assert.equal(after.staleState,'uploading');assert.equal(after.staleStagedRows,3);assert.equal(after.changedRows,3);result.after=after;
 const nowManual=await sql("jsonb_build_object('master',(select md5(jsonb_agg(to_jsonb(r) order by sellpia_sku_code)::text) from public.operations_hub_sku_operational_master r),'mappings',(select md5(jsonb_agg(to_jsonb(r) order by import_id)::text) from review.final_excel_mapping_import r),'aux',(select md5(jsonb_agg(to_jsonb(r) order by domain)::text) from operations_private.qa_manual_aux r))");assert.deepEqual(nowManual,beforeManual);result.separateManualFixturesPreserved=true;
 const matrix=await sql("operations_private.refresh_operations_hub_matrix_core('isolated-native-race-qa')");assert.equal(matrix.status,'completed');assert.equal(matrix.core_row_count,27278);assert.equal(matrix.sellpia_snapshot_id,manual.snapshot_id);result.matrix={rowCount:matrix.core_row_count,snapshot:matrix.sellpia_snapshot_id};
 await db.call(`update operations_private.sellpia_sync_apply_scopes set expires_at=clock_timestamp()-interval '1 second' where job_id=${L(job.jobId)}::uuid;update operations_private.sellpia_sync_config set apply_enabled=false,approved_source_fingerprint=null;`);
 assert.equal((await runtime('status',{jobId:job.jobId})).job.state,'failed');result.finalLocalApplyEnabled=false;result.staleApplyReservationExpired=true;
 result.status='passed';result.completedAt=new Date().toISOString();result.limitations=['Three-row synthetic numeric patches on existing isolated source identities; no actual original recollection or 27k reimport.','One actual native two-session manual patch versus guarded sync patch case. It does not prove every possible full/inventory/abort interleaving.','Storage uses SQL metadata fixtures; signed HTTP Storage was not exercised.'];
 await fs.writeFile(path.join(outputs,'sellpia-native-completion-concurrency-20261013.json'),JSON.stringify(result,null,2));
 await fs.writeFile(path.join(outputs,'sellpia-native-completion-concurrency-20261013.txt'),['격리 native PostgreSQL 실제 두 세션 완료 경쟁 검증',
 '동일 27,278행 baseline에 기존 manual patch intent와 scoped sync patch intent를 3행씩 기존 RPC로 준비했다.',
 'manual 실제 complete 함수가 ready 변경과 shared advisory lock을 보유한 SQL transaction에서 sync를 별도 psql 연결로 완료 요청했다.',
 'pg_locks에서 manual granted advisory lock과 sync ungranted advisory wait를 각각 관측했다. manual commit 후 stale sync는 baseline snapshot changed로 거부됐다.',
 '최신 ready는 manual 완료 snapshot이고 27,278행을 유지했다. stale sync snapshot은 uploading 상태와 staging 3행만 남으며 ready로 승격되지 않았다.',
 '실제 Matrix를 새 ready snapshot으로 27,278행 재구축했고 별도 수동 master/매핑/태그·규칙·가격 fixture를 보존했다.',
 '로컬 stale scope를 만료시키고 apply flag false로 복원했다. 운영 쓰기 0, Storage HTTP 호출 0.',...result.limitations].join('\n')+'\n');
 console.log(JSON.stringify({status:'passed',separateSessions:true,lockHolderObserved:holding,lockWaiterObserved:waiting,staleCompletionRejected:true,readyRows:27278,productionWrites:0}));
}
main().catch(async error=>{result.status='failed';result.stage=stage;result.reason=error.safeReason||(/^QA_[A-Z0-9_]+$/.test(error.message)?error.message:'assertion_or_runtime_failure');if(path.basename(outputs)==='outputs')await fs.writeFile(path.join(outputs,'sellpia-native-completion-concurrency-20261013.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({status:'failed',stage,reason:result.reason,numericActual:typeof error.actual==='number'?error.actual:null}));process.exitCode=1;});
