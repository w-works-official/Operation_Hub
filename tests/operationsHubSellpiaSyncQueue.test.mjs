import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {QueueProtocol,MemoryQueueStore,LEASE_MS,MAX_FILE_BYTES,MAX_TOTAL_BYTES,sha256,normalizeManifest,normalizeEnqueue,allowedOrigin,secureWorkerRequest,publicJob,verifyArtifactBytes} from '../supabase/functions/operations-hub-sellpia-sync/protocol.mjs';
import {createHandler} from '../supabase/functions/operations-hub-sellpia-sync/handler.mjs';
import {RpcQueueStore} from '../supabase/functions/operations-hub-sellpia-sync/rpc-store.mjs';

// All credentials, bytes and IDs in this test are artificial. No operating
// product file, account, session, token, Supabase project or network is used.
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const browser={kind:'browser'},worker={kind:'worker',workerId:'qa-pc'};
const credentials={workerToken:'synthetic-worker-credential-for-tests-only',workerId:'qa-pc'};
function setup(){let clock=1_700_000_000_000,seq=100;const store=new MemoryQueueStore({now:()=>clock});const queue=new QueueProtocol(store,{randomUUID:()=>id(++seq),randomToken:()=>`synthetic-lease-${++seq}`});return {store,queue,advance:n=>{clock+=n;}};}
const enqueue=(q,n=1,extra={})=>q.dispatch('enqueue',{requestId:id(n),...extra},browser);
async function claimed(x){const {job}=await enqueue(x.queue);const claim=await x.queue.dispatch('claim',{},worker);return {...claim,job,jobId:job.jobId,workerId:worker.workerId};}
async function proof(){const bytes=[new TextEncoder().encode('first'),new TextEncoder().encode('second'),new TextEncoder().encode('third')];return {bytes,manifest:{source:'sellpia',collectionMode:'official_download',mode:'full',includeAll:true,filters:[],expectedRowCount:3,files:await Promise.all(bytes.map(async(b,i)=>({ordinal:i+1,name:`part-${i+1}.csv`,size:b.byteLength,sha256:await sha256(b)})))}};}
async function staged(x){const c=await claimed(x),p=await proof();const init=await x.queue.dispatch('upload-init',{...c,collectionManifest:p.manifest},worker);return {c,p,init};}
function http(x,overrides={}){const p={signUpload:async path=>({signedUrl:`https://stage.invalid/${path}?token=synthetic`,token:'synthetic'}),signDownload:async(path,ttl)=>`https://stage.invalid/${path}?ttl=${ttl}`,assertPrivate:async()=>{},assertObjects:async()=>{},readBytes:async()=>new ArrayBuffer(0)};return createHandler({queue:x.queue,store:x.store,guardSession:async()=>true,storage:p,enabled:true,...credentials,...overrides});}
function request(action,body={},headers={},url='https://queue.invalid/functions/v1/operations-hub-sellpia-sync'){return new Request(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({action,...body})});}
const operatorHeaders={origin:'https://w-works-official.github.io','x-operations-hub-session':'a'.repeat(64)};
const workerHeaders={'x-sellpia-sync-worker-token':credentials.workerToken};

test('default mode is full and production apply is forced false even when requested',async()=>{const x=setup();const r=await enqueue(x.queue,1,{applyProduction:true});assert.equal(r.job.applyProduction,false);assert.equal(r.job.mode,'full');assert.ok(Object.values(r.job.selectedFields).every(Boolean));});
test('patch requires explicit fields and cannot silently select all',()=>{assert.throws(()=>normalizeEnqueue({requestId:id(1),mode:'patch'}),/명시/);assert.throws(()=>normalizeEnqueue({requestId:id(1),mode:'patch',selectedFields:{unknown:true}}));assert.equal(normalizeEnqueue({requestId:id(1),mode:'patch',selectedFields:{inventory:true}}).selectedFields.price,false);});
test('automatic queue rejects an unsupported patch job before persisting or claiming it',async()=>{const x=setup();await assert.rejects(enqueue(x.queue,1,{mode:'patch',selectedFields:{inventory:true}}),e=>e.code==='AUTOMATION_FULL_ONLY');assert.equal(x.store.jobs.length,0);});
test('same request ID and canonical payload is idempotent under concurrent enqueue',async()=>{const x=setup();const a=await Promise.all(Array.from({length:15},()=>enqueue(x.queue)));assert.equal(new Set(a.map(r=>r.job.jobId)).size,1);assert.equal(x.store.jobs.length,1);});
test('request cancellation before enqueue creates one tombstone and blocks every late enqueue',async()=>{
  const x=setup(),body={requestId:id(1),baselineSnapshotId:id(9)};
  const cancelled=await x.queue.dispatch('cancel-request',body,browser);assert.equal(cancelled.job.state,'cancelled');assert.equal(cancelled.job.applyProduction,false);
  const replies=await Promise.all(Array.from({length:10},()=>x.queue.dispatch('enqueue',{...body,mode:'full',selectedFields:{inventory:true,price:true,basePrice:true,purchasePrice:true,basic:true,status:true}},browser)));
  assert.ok(replies.every(r=>r.deduplicated&&r.job.jobId===cancelled.job.jobId&&r.job.state==='cancelled'));
  assert.equal((await x.queue.dispatch('cancel-request',body,browser)).job.jobId,cancelled.job.jobId);
  assert.equal(x.store.jobs.length,1);assert.equal((await x.queue.dispatch('claim',{},worker)).job,null);
});
test('request cancellation after a lost enqueue reply revokes the existing collecting lease',async()=>{
  const x=setup(),c=await claimed(x);
  const cancelled=await x.queue.dispatch('cancel-request',{requestId:c.job.requestId},browser);
  assert.equal(cancelled.job.jobId,c.jobId);assert.equal(cancelled.job.state,'cancelled');assert.equal(x.store.jobs[0].leaseHash,null);assert.equal(x.store.jobs[0].leaseExpiresAt,null);
  await assert.rejects(x.queue.dispatch('heartbeat',c,worker),e=>e.code==='LEASE_LOST');
  assert.equal((await enqueue(x.queue)).job.state,'cancelled');
});
test('changed request payload cannot cancel a different frozen scope or bypass browser authority',async()=>{
  const x=setup();await enqueue(x.queue,1,{baselineSnapshotId:id(9)});
  await assert.rejects(x.queue.dispatch('cancel-request',{requestId:id(1),baselineSnapshotId:id(8)},browser),e=>e.code==='CONFLICT');
  await assert.rejects(x.queue.dispatch('cancel-request',{requestId:id(1),baselineSnapshotId:id(9)},worker),e=>e.code==='UNAUTHORIZED');
  assert.equal(x.store.jobs[0].state,'queued');
});
test('changed payload with the same request ID is rejected without modifying the job',async()=>{const x=setup();await enqueue(x.queue);await assert.rejects(enqueue(x.queue,1,{baselineSnapshotId:id(9)}),e=>e.code==='CONFLICT');assert.equal(x.store.jobs[0].baselineSnapshotId,null);});
test('concurrent claims yield exactly one global active worker and job',async()=>{const x=setup();await Promise.all([enqueue(x.queue,1),enqueue(x.queue,2)]);const claims=await Promise.all(Array.from({length:12},()=>x.queue.dispatch('claim',{},worker)));assert.equal(claims.filter(r=>r.job).length,1);assert.equal(x.store.jobs.filter(r=>r.state==='collecting').length,1);});
test('active lease blocks another worker and preserves the first lease',async()=>{const x=setup();const c=await claimed(x);await enqueue(x.queue,2);assert.equal((await x.queue.dispatch('claim',{}, {...worker,workerId:'other'})).job,null);assert.equal((await x.queue.dispatch('heartbeat',c,worker)).job.state,'collecting');});
test('wrong worker or lease cannot report or heartbeat',async()=>{const x=setup();const c=await claimed(x);await assert.rejects(x.queue.dispatch('heartbeat',{...c,leaseToken:'wrong'},worker),e=>e.code==='LEASE_LOST');await assert.rejects(x.queue.dispatch('report',{...c,state:'failed'}, {...worker,workerId:'other'}),e=>e.code==='LEASE_LOST');});
test('expired lease is terminal and a late writer cannot complete after next claim',async()=>{const x=setup();const c=await claimed(x);await enqueue(x.queue,2);x.advance(LEASE_MS+1);const n=await x.queue.dispatch('claim',{},worker);assert.notEqual(n.job.jobId,c.jobId);assert.equal(x.store.jobs[0].state,'failed');await assert.rejects(x.queue.dispatch('heartbeat',c,worker),e=>e.code==='LEASE_LOST');});
test('heartbeat extends a live lease but never resurrects an expired lease',async()=>{const x=setup();const c=await claimed(x);x.advance(30_000);assert.ok((await x.queue.dispatch('heartbeat',c,worker)).leaseExpiresAt>c.leaseExpiresAt);x.advance(LEASE_MS+1);await assert.rejects(x.queue.dispatch('heartbeat',c,worker));});
test('cancel revokes collecting authority and is idempotent',async()=>{const x=setup();const c=await claimed(x);await x.queue.dispatch('cancel',{jobId:c.jobId},browser);await assert.rejects(x.queue.dispatch('report',{...c,state:'failed'},worker));assert.equal((await x.queue.dispatch('cancel',{jobId:c.jobId},browser)).job.state,'cancelled');});
test('worker report cannot manufacture collected state or include raw errors',async()=>{const x=setup();const c=await claimed(x);await assert.rejects(x.queue.dispatch('report',{...c,state:'collected'},worker));await assert.rejects(x.queue.dispatch('report',{...c,state:'failed',summary:{message:'raw session detail'}},worker));assert.equal(x.store.jobs[0].state,'collecting');});
test('needs_login terminates lease and remains a distinct result',async()=>{const x=setup();const c=await claimed(x);const r=await x.queue.dispatch('report',{...c,state:'needs_login',summary:{errorCode:'LOGIN_REQUIRED'}},worker);assert.equal(r.job.state,'needs_login');assert.equal(x.store.jobs[0].leaseHash,null);});
test('full proof rejects partial count mode, filters, missing files, paths and duplicates',async()=>{const {manifest:m}=await proof();for(const change of [{includeAll:false},{filters:['category']},{expectedRowCount:0},{files:m.files.slice(0,2)},{files:m.files.map(f=>({...f,name:'../unsafe.csv'}))},{files:m.files.map(f=>({...f,name:'same.csv'}))}])assert.throws(()=>normalizeManifest({...m,...change},'full'));});
test('manifest respects per-file and total bounds before allocating bytes',async()=>{const {manifest:m}=await proof();assert.throws(()=>normalizeManifest({...m,files:m.files.map(f=>({...f,size:MAX_FILE_BYTES+1}))},'full'));assert.throws(()=>normalizeManifest({...m,files:m.files.map(f=>({...f,size:Math.floor(MAX_TOTAL_BYTES/3)+1}))},'full'));});
test('server-owned staging paths do not use a supplied folder or source filename',async()=>{const x=setup(),{init}=await staged(x);assert.deepEqual(init.manifest.map(f=>f.path),[1,2,3].map(n=>`sellpia-sync/${init.job.jobId}/${n}.csv`));});
test('manifest is immutable across retry and mismatched init rolls back',async()=>{const x=setup(),{c,p}=await staged(x);await x.queue.dispatch('upload-init',{...c,collectionManifest:p.manifest},worker);await assert.rejects(x.queue.dispatch('upload-init',{...c,collectionManifest:{...p.manifest,expectedRowCount:4}},worker));assert.equal(x.store.jobs[0].collectionManifest.expectedRowCount,3);});
test('actual byte verification checks size and digest sequentially',async()=>{const x=setup(),{p,init}=await staged(x);let active=0,maximum=0;const out=await verifyArtifactBytes(init.manifest,async f=>{active++;maximum=Math.max(maximum,active);await Promise.resolve();active--;return p.bytes[f.ordinal-1].buffer;});assert.equal(maximum,1);assert.ok(out.every(f=>f.verified));await assert.rejects(verifyArtifactBytes(init.manifest,async()=>new TextEncoder().encode('wrong').buffer));});
test('verified finalize is idempotent and cannot apply an operational snapshot',async()=>{const x=setup(),{c,p,init}=await staged(x);const verifiedArtifacts=await verifyArtifactBytes(init.manifest,async f=>p.bytes[f.ordinal-1].buffer);const a=await x.queue.dispatch('upload-finalize',{...c,verifiedArtifacts},worker);x.advance(LEASE_MS+1);const b=await x.queue.dispatch('upload-finalize',c,worker);assert.equal(a.job.state,'collected');assert.equal(b.deduplicated,true);assert.equal(b.job.applyProduction,false);});
test('unverified declaration cannot become collected',async()=>{const x=setup(),{c,init}=await staged(x);await assert.rejects(x.queue.dispatch('upload-finalize',{...c,verifiedArtifacts:init.manifest},worker));assert.equal(x.store.jobs[0].state,'collecting');});
test('public status never exposes a lease hash, token or worker authority',async()=>{const x=setup();await claimed(x);const j=publicJob(x.store.jobs[0]);assert.equal('leaseHash' in j,false);assert.equal('leaseToken' in j,false);assert.equal('completedLeaseHash' in j,false);assert.equal('workerId' in j,false);});
test('receipt requires a collected job and exact parsed row count',async()=>{const x=setup(),{c,p,init}=await staged(x);await assert.rejects(x.queue.dispatch('receipt',{jobId:c.jobId,receipt:{valid:true,rowCount:3}},browser));const verifiedArtifacts=await verifyArtifactBytes(init.manifest,async f=>p.bytes[f.ordinal-1].buffer);await x.queue.dispatch('upload-finalize',{...c,verifiedArtifacts},worker);await assert.rejects(x.queue.dispatch('receipt',{jobId:c.jobId,receipt:{valid:true,rowCount:2}},browser));assert.equal((await x.queue.dispatch('receipt',{jobId:c.jobId,receipt:{valid:true,rowCount:3}},browser)).job.state,'previewed');});
test('company and loopback origins are exact; personal Pages and disguised hosts fail',()=>{assert.ok(allowedOrigin('https://w-works-official.github.io'));assert.ok(allowedOrigin('http://localhost:54321'));for(const o of ['https://kimhyein0214-dot.github.io','https://w-works-official.github.io.attacker.invalid','null',''])assert.equal(allowedOrigin(o),false);assert.equal(secureWorkerRequest('http://external.invalid',''),false);assert.equal(secureWorkerRequest('https://queue.invalid','https://w-works-official.github.io'),false);});
test('HTTP default disabled rejects before any session, queue or storage work',async()=>{const x=setup();let calls=0;const h=http(x,{enabled:false,guardSession:async()=>{calls++;return true;}});const r=await h(request('enqueue',{requestId:id(1)},operatorHeaders));assert.equal(r.status,503);assert.equal(calls,0);assert.equal(x.store.jobs.length,0);});
test('HTTP operator origin, session and worker credential are separate guards',async()=>{const x=setup(),h=http(x,{guardSession:async()=>false});assert.equal((await h(request('enqueue',{requestId:id(1)},operatorHeaders))).status,401);assert.equal((await h(request('enqueue',{requestId:id(1)}, {...operatorHeaders,origin:'https://attacker.invalid'}))).status,403);assert.equal((await h(request('claim',{workerId:'qa-pc'},operatorHeaders))).status,401);assert.equal((await http(x)(request('claim',{workerId:'qa-pc'},workerHeaders))).status,200);});
test('HTTP partial automation is a 400 policy error, not a queue availability error',async()=>{const x=setup(),r=await http(x)(request('enqueue',{requestId:id(1),mode:'patch',selectedFields:{inventory:true}},operatorHeaders));assert.equal(r.status,400);assert.equal((await r.json()).code,'AUTOMATION_FULL_ONLY');assert.equal(x.store.jobs.length,0);});
test('HTTP requestId cancellation requires an operating session and is idempotent after lost replies',async()=>{
  const x=setup(),body={requestId:id(1)};
  assert.equal((await http(x,{guardSession:async()=>false})(request('cancel-request',body,operatorHeaders))).status,401);assert.equal(x.store.jobs.length,0);
  const first=await http(x)(request('cancel-request',body,operatorHeaders));assert.equal(first.status,200);const a=await first.json();assert.equal(a.job.state,'cancelled');
  const retry=await (await http(x)(request('enqueue',body,operatorHeaders))).json();assert.equal(retry.job.jobId,a.job.jobId);assert.equal(retry.job.state,'cancelled');assert.equal(retry.deduplicated,true);
});
test('HTTP rejects forged verification, arbitrary paths and oversized request',async()=>{const x=setup(),h=http(x);assert.equal((await h(request('enqueue',{requestId:id(1),path:'elsewhere'},operatorHeaders))).status,400);assert.equal((await h(request('upload-finalize',{workerId:'qa-pc',jobId:id(1),verifiedArtifacts:[]},workerHeaders))).status,400);assert.equal((await h(request('enqueue',{requestId:id(1),ignored:'x'.repeat(65536)},operatorHeaders))).status,400);});
test('HTTP artifact verification loses to cancellation during download',async()=>{const x=setup(),{c,p}=await staged(x);let reads=0;const h=http(x,{storage:{assertPrivate:async()=>{},assertObjects:async()=>{},readBytes:async()=>{await x.queue.dispatch('cancel',{jobId:c.jobId},browser);return p.bytes[reads++].buffer;}}});const r=await h(request('upload-finalize',c,workerHeaders));assert.equal(r.status,409);assert.equal(x.store.jobs[0].state,'cancelled');});
test('download signatures require verified artifacts and expire in five minutes',async()=>{const x=setup(),{c,p,init}=await staged(x);const h=http(x);assert.equal((await h(request('artifacts',{jobId:c.jobId},operatorHeaders))).status,409);const verifiedArtifacts=await verifyArtifactBytes(init.manifest,async f=>p.bytes[f.ordinal-1].buffer);await x.queue.dispatch('upload-finalize',{...c,verifiedArtifacts},worker);const r=await h(request('artifacts',{jobId:c.jobId},operatorHeaders));const body=await r.json();assert.equal(body.expiresIn,300);assert.equal(body.artifacts.length,3);assert.ok(body.artifacts.every(f=>f.signedUrl.endsWith('ttl=300')));});
test('receipt persists bounded comparison counters, canonicalizes retry and rejects raw rows',async()=>{
  const x=setup(),{c,p,init}=await staged(x);const verifiedArtifacts=await verifyArtifactBytes(init.manifest,async f=>p.bytes[f.ordinal-1].buffer);await x.queue.dispatch('upload-finalize',{...c,verifiedArtifacts},worker);
  const receipt={valid:true,rowCount:3,state:'previewed',sourceFingerprint:'b'.repeat(64),baselineSnapshotId:null,summary:{source:'sellpia',mode:'full',fileCount:3,rowCount:3,expectedRowCount:3,productionApply:false,comparison:{newRowCount:3,changedCount:1,unchangedCount:2,unknownCount:0,fieldCounts:{inventory:1}}}};
  const a=await x.queue.dispatch('receipt',{jobId:c.jobId,receipt},browser);assert.equal(a.job.receipt.summary.comparison.changedCount,1);
  await x.queue.dispatch('receipt',{jobId:c.jobId,receipt:{...receipt,summary:Object.fromEntries(Object.entries(receipt.summary).reverse())}},browser);
  await assert.rejects(x.queue.dispatch('receipt',{jobId:c.jobId,receipt:{...receipt,summary:{rows:[{sku:'synthetic'}]}}},browser));
  await assert.rejects(x.queue.dispatch('receipt',{jobId:c.jobId,receipt:{...receipt,baselineSnapshotId:id(999)}},browser));
});
test('HTTP upload/finalize/download/receipt roundtrip validates exact bytes and returns independent proof',async()=>{
  const x=setup(),{c,p}=await staged(x);let reads=0;const h=http(x,{storage:{assertPrivate:async()=>{},assertObjects:async()=>{},readBytes:async()=>p.bytes[reads++].buffer,signDownload:async()=> 'https://stage.invalid/signed'}});
  assert.equal((await h(request('upload-finalize',c,workerHeaders))).status,200);
  const artifacts=await (await h(request('artifacts',{jobId:c.jobId},operatorHeaders))).json();assert.deepEqual(artifacts.manifest,p.manifest);
  assert.equal((await h(request('receipt',{jobId:c.jobId,receipt:{valid:true,rowCount:3,sourceFingerprint:'c'.repeat(64)}},operatorHeaders))).status,200);
  assert.equal((await h(request('upload-finalize',c,workerHeaders))).status,200,'lost finalize response can be retried after browser preview');assert.equal(reads,3);
});

test('SQL proposal runs only in local PGlite: invoker ACL, CAS races and late lease commit',async t=>{
  const db=new PGlite();t.after(()=>db.close());
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
  await db.exec(await fs.readFile(new URL('../docs/sellpia-sync-schema-proposal.sql',import.meta.url),'utf8'));
  await db.exec('set role anon');await assert.rejects(db.query("select public.hub_sellpia_sync_queue_v1('read','{}')"));await assert.rejects(db.query('select * from operations_private.sellpia_sync_jobs'));
  await db.exec('reset role;set role authenticated');await assert.rejects(db.query("select public.hub_sellpia_sync_queue_v1('read','{}')"));
  await db.exec('reset role;set role service_role');
  const client={rpc:async(_name,{p_action,p_payload})=>{try{return {data:(await db.query('select public.hub_sellpia_sync_queue_v1($1,$2::jsonb) as result',[p_action,JSON.stringify(p_payload)])).rows[0].result,error:null};}catch(error){return {data:null,error};}}};
  const store=new RpcQueueStore(client),queue=new QueueProtocol(store);
  const a=await Promise.all([enqueue(queue),enqueue(queue)]);assert.equal(a[0].job.jobId,a[1].job.jobId);
  const claims=await Promise.all([queue.dispatch('claim',{},worker),queue.dispatch('claim',{},worker)]);assert.equal(claims.filter(c=>c.job).length,1);
  const c=claims.find(c=>c.job),body={jobId:c.job.jobId,workerId:worker.workerId,leaseToken:c.leaseToken};
  const snapshot=await store.read({jobId:body.jobId});
  const leaseGuard={jobId:body.jobId,workerId:worker.workerId,leaseHash:await sha256(body.leaseToken)};
  await db.exec("update operations_private.sellpia_sync_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where state='collecting'");
  await assert.rejects(store.command('apply',{expectedRevision:snapshot.revision,changed:[{...snapshot.jobs[0],summary:{phase:'verified'}}],leaseGuard}),e=>e.code==='LEASE_LOST');
  await db.exec('reset role');
  assert.equal((await db.query("select count(*)::integer n from pg_catalog.pg_tables where schemaname='public' and tablename like 'sellpia%'")).rows[0].n,0);
});

test('local SQL CAS serializes late enqueue versus request cancellation in both commit orders',async t=>{
  const db=new PGlite();t.after(()=>db.close());
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
  await db.exec(await fs.readFile(new URL('../docs/sellpia-sync-schema-proposal.sql',import.meta.url),'utf8'));
  await db.exec('set role service_role');let conflicts=0;
  const client={rpc:async(_name,{p_action,p_payload})=>{try{return {data:(await db.query('select public.hub_sellpia_sync_queue_v1($1,$2::jsonb) as result',[p_action,JSON.stringify(p_payload)])).rows[0].result,error:null};}catch(error){if(error.code==='40001')conflicts++;return {data:null,error};}}};
  for(const [iteration,firstAction] of ['enqueue','cancel-request'].entries()){
    const body={requestId:id(20+iteration),baselineSnapshotId:id(9)},store=new RpcQueueStore(client),queue=new QueueProtocol(store);
    const originalRead=store.read.bind(store);let reads=0,release;const gate=new Promise(resolve=>{release=resolve;});
    store.read=async selector=>{const snapshot=await originalRead(selector);if(selector.requestId===body.requestId&&reads++<2){if(reads===2)release();await gate;}return snapshot;};
    // Both writers read the same revision before either commit; the loser
    // retries its CAS against the now-persisted immutable request identity.
    const actions=[firstAction,firstAction==='enqueue'?'cancel-request':'enqueue'];
    await Promise.all(actions.map(action=>queue.dispatch(action,body,browser)));
    const snapshot=await store.read({requestId:body.requestId}),jobs=snapshot.jobs.filter(j=>j.requestId===body.requestId);
    assert.equal(jobs.length,1);assert.equal(jobs[0].state,'cancelled');assert.equal(jobs[0].leaseHash,null);assert.equal(jobs[0].applyProduction,false);
    const late=await queue.dispatch('enqueue',body,browser);assert.equal(late.job.jobId,jobs[0].jobId);assert.equal(late.job.state,'cancelled');
    assert.equal((await queue.dispatch('claim',{},worker)).job,null);
  }
  assert.ok(conflicts>=2,'both races must exercise the SQL retry path');
  await db.exec('reset role');assert.equal((await db.query("select count(*)::integer n from pg_catalog.pg_tables where schemaname='public' and tablename like 'sellpia%'")).rows[0].n,0);
});
