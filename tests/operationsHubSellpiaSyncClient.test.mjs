import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash,webcrypto} from 'node:crypto';
const require=createRequire(import.meta.url);
const parser=require('../mockups/operations-hub/sellpia-source-parser.js');
const contract=require('../mockups/operations-hub/sellpia-sync-contract.js');
const client=require('../mockups/operations-hub/sellpia-sync-client.js');
const baselineId='11111111-1111-4111-8111-111111111111',jobId='22222222-2222-4222-8222-222222222222';
async function fixture(options={}){
  const headers=Object.values(parser.REQUIRED_HEADERS||{}).map(v=>v[0]);
  // The contract's literal headers are the existing parser's full template.
  const h=headers.length?headers:['#','상품코드','자사코드','상품명','옵션명','재고','가용재고','품절','단종','판매가','안전재고','매입처코드','매입처','매입처그룹','매입처주소','상가명','매입처전화','매입상품명','매입옵션명','매입가','수수료','매입처부가세','발주단위','최소발주수량'];
  const row=n=>h.map(key=>({'#':n,'상품코드':`${1000+n}-1`,'자사코드':'code','상품명':'합성 상품','옵션명':'합성 옵션','재고':3,'가용재고':2,'판매가':100,'안전재고':0,'매입가':50,'수수료':0,'발주단위':1,'최소발주수량':1}[key]??'')).join(',');
  const files=[1,2,3].map(n=>new File([h.join(',')+'\n'+row(n)+'\n'],`part-${n}.csv`,{type:'text/csv'}));
  const manifest={source:'sellpia',collectionMode:'official_download',mode:'full',includeAll:true,filters:[],expectedRowCount:3,files:await Promise.all(files.map(async(file,i)=>({ordinal:i+1,name:file.name,size:file.size,sha256:createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex')})))};
  const parsed=await parser.parseSellpiaFiles(files,{mode:'full',strictNumeric:true});assert.equal(parsed.valid,true,parsed.errors.join(' '));
  const calls=[],states=[];
  let job={jobId,requestId:'33333333-3333-4333-8333-333333333333',mode:'full',applicationMode:'patch',selectedFields:{inventory:true,price:true,basePrice:true,purchasePrice:true,basic:false,status:false},baselineSnapshotId:baselineId,applyProduction:false,state:'queued'};
  let index=0,baselineReads=0;
  const data={
    async loadLatestSellpiaOriginalStatus(){baselineReads++;return {snapshotId:options.stale&&baselineReads>1?'44444444-4444-4444-8444-444444444444':baselineId,boundary:options.insecure?'direct-anon-fallback':'signed-read-v1'};},
    async sellpiaSyncRequest(action,body){calls.push({action,body});if(action==='availability')return {enabled:true,applyEnabled:options.applyEnabled===true,runner:{online:true,status:'connected'}};if(action==='history')return {jobs:[]};if(action==='enqueue'){if(options.offline)throw Error('실행 경계 미배포');job={...job,...body};return {job:{...job,applicationMode:options.scopeConflict?'full':body.applicationMode}};}if(action==='status')return {job:{...job,state:options.needsLogin?'needs_login':index++?'collected':'collecting'}};return {valid:true};},
    async loadSellpiaSyncArtifacts(){return {files,manifest:options.badCount?{...manifest,expectedRowCount:4}:manifest};},
    async loadSellpiaSyncBaselineRows(){return {snapshotId:baselineId,rows:options.unknownBaseline?null:parsed.rows};},
    async uploadSellpiaSnapshot(){calls.push({action:'PRODUCTION_UPLOAD'});throw Error('테스트에서 운영 업로드 금지');},
    async waitForSellpiaMatrixRebuild(){calls.push({action:'MATRIX_WRITE'});},
  };
  const controller=client.createController({data,contract,crypto:webcrypto,sleep:async()=>{},onState:s=>states.push(s.stage),...options.controller});
  return {controller,calls,states,data,files,manifest};
}
test('one click collects three originals, validates and compares, with zero production calls',async()=>{
  const f=await fixture();const result=await f.controller.run();assert.equal(result.stage,'previewed');assert.equal(result.plan.rowCount,3);assert.equal(result.comparison.summary.unchangedCount,3);assert.equal(result.comparison.summary.changedCount,0);assert.equal(f.calls.filter(c=>c.action==='enqueue').length,1);assert.ok(f.states.includes('collecting'));assert.ok(f.states.includes('validating'));assert.ok(f.states.includes('comparing'));assert.ok(!f.calls.some(c=>c.action==='PRODUCTION_UPLOAD'));const receipt=f.calls.find(c=>c.action==='receipt').body.receipt;assert.equal(receipt.valid,true);assert.ok(JSON.stringify(receipt).length<2000);assert.ok(!JSON.stringify(receipt).includes('합성 상품'));
});
test('duplicate click creates one job',async()=>{const f=await fixture();await Promise.all([f.controller.run(),f.controller.run()]);assert.equal(f.calls.filter(c=>c.action==='enqueue').length,1);});
test('selected-field application uses the same complete three-file collection and preserves unselected fields in comparison',async()=>{const f=await fixture();const result=await f.controller.run({applicationMode:'patch',fields:{inventory:true}});assert.equal(result.stage,'previewed');assert.equal(result.plan.collectionMode,'full');assert.equal(result.plan.mode,'patch');assert.equal(result.plan.fields.price,false);assert.equal(result.plan.fields.basic,false);const body=f.calls.find(c=>c.action==='enqueue').body;assert.equal(body.mode,'full');assert.equal(body.applicationMode,'patch');assert.deepEqual(body.selectedFields,{inventory:true,price:false,basePrice:false,purchasePrice:false,basic:false,status:false});});
test('full application requires an explicit complete field policy before collection',async()=>{const f=await fixture();const result=await f.controller.run({applicationMode:'full',fields:{inventory:true}});assert.equal(result.stage,'failed');assert.match(result.error,/모든 항목/);assert.equal(f.calls.length,0);});
for(const [name,option,stage] of [['stale snapshot',{stale:true},'stale'],['malformed expected count',{badCount:true},'failed'],['login expiry',{needsLogin:true},'needs_login'],['insecure baseline',{insecure:true},'failed'],['missing baseline rows',{unknownBaseline:true},'failed'],['different active job scope',{scopeConflict:true},'failed'],['missing queue deployment',{offline:true},'failed']])test(`${name} stops before production upload`,async()=>{const f=await fixture(option);const result=await f.controller.run();assert.equal(result.stage,stage);assert.ok(result.error);assert.ok(!f.calls.some(c=>c.action==='PRODUCTION_UPLOAD'));assert.ok(!f.calls.some(c=>c.action==='receipt'));});
test('default production apply is rejected after successful preview',async()=>{const f=await fixture();await f.controller.run();await assert.rejects(f.controller.apply(),e=>e.code==='PRODUCTION_APPLY_DISABLED');assert.ok(!f.calls.some(c=>c.action==='PRODUCTION_UPLOAD'));});
test('cancellation invalidates a pending status result and prevents late artifact receipt',async()=>{const f=await fixture();let unblock;f.data.sellpiaSyncRequest=async(action,body)=>{f.calls.push({action,body});if(action==='availability')return {enabled:true};if(action==='history')return {jobs:[]};if(action==='enqueue')return {job:{...body,jobId,state:'queued'}};if(action==='status')return await new Promise(resolve=>{unblock=()=>resolve({job:{jobId,state:'collected'}});});if(action==='cancel')return {job:{jobId,state:'cancelled'}};return {};};const task=f.controller.run();for(let i=0;i<30&&!unblock;i++)await new Promise(r=>setImmediate(r));assert.equal(typeof unblock,'function');await f.controller.cancel();unblock();await task;assert.equal(f.controller.getState().stage,'cancelled');assert.ok(!f.calls.some(c=>c.action==='receipt'));});

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const memoryStorage=()=>{const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key),dump:()=>JSON.stringify([...values])};};
async function waitUntil(predicate){for(let i=0;i<40&&!predicate();i++)await new Promise(resolve=>setImmediate(resolve));assert.ok(predicate(),'asynchronous stage was not reached');}

test('cancel before enqueue reply confirms requestId cancellation and ignores a late collected reply',async()=>{
  const f=await fixture(),enqueueReply=deferred(),cancelReply=deferred();let pendingBody;
  f.data.sellpiaSyncRequest=async(action,body)=>{
    f.calls.push({action,body});
    if(action==='availability')return {enabled:true};if(action==='history')return {jobs:[]};
    if(action==='enqueue'){pendingBody=body;return enqueueReply.promise;}
    if(action==='cancel-request')return cancelReply.promise;
    throw Error('late enqueue must not trigger further work');
  };
  const run=f.controller.run();await waitUntil(()=>pendingBody);
  assert.equal(f.controller.getState().job,null);assert.equal(f.controller.getState().pendingRequestId,pendingBody.requestId);
  const cancellation=f.controller.cancel();
  assert.equal(f.controller.getState().stage,'cancel_pending');assert.equal(f.controller.getState().busy,false);
  await assert.rejects(f.controller.run(),e=>e.code==='CANCEL_UNCONFIRMED');
  assert.deepEqual(f.calls.find(c=>c.action==='cancel-request').body,pendingBody);
  cancelReply.resolve({job:{...pendingBody,jobId,state:'cancelled'}});await cancellation;
  enqueueReply.resolve({job:{...pendingBody,jobId,state:'collected'}});await run;
  assert.equal(f.controller.getState().stage,'cancelled');assert.equal(f.controller.getState().pendingRequestId,null);
  assert.equal(f.calls.filter(c=>['enqueue','cancel-request'].includes(c.action)).length,2);assert.ok(!f.calls.some(c=>c.action==='receipt'||c.action==='PRODUCTION_UPLOAD'));
});

test('lost enqueue and cancel replies preserve one cancellation identity across reload',async()=>{
  const storage=memoryStorage(),f=await fixture({controller:{pendingStorage:storage}});let pendingBody;
  f.data.sellpiaSyncRequest=async(action,body)=>{f.calls.push({action,body});if(action==='availability')return {enabled:true};if(action==='history')return {jobs:[]};if(action==='enqueue'){pendingBody=body;throw Error('enqueue reply lost');}if(action==='cancel-request')throw Error('cancel reply lost');throw Error('unexpected action');};
  await f.controller.run();await assert.rejects(f.controller.cancel(),e=>e.code==='CANCEL_UNCONFIRMED');
  assert.equal(f.controller.getState().stage,'cancel_pending');assert.equal(f.controller.getState().pendingRequestId,pendingBody.requestId);
  let retries=0;
  const restarted=client.createController({data:{sellpiaSyncRequest:async(action,body)=>{assert.equal(action,'cancel-request');assert.deepEqual(body,pendingBody);retries++;return {job:{...body,jobId,state:'cancelled'}};}},contract,crypto:webcrypto,pendingStorage:storage});
  assert.equal(restarted.getState().stage,'cancel_pending');await assert.rejects(restarted.run(),e=>e.code==='CANCEL_UNCONFIRMED');
  await restarted.cancel();assert.equal(retries,1);assert.equal(restarted.getState().stage,'cancelled');assert.equal(restarted.getState().pendingRequestId,null);
  assert.equal(client.createController({data:f.data,contract,pendingStorage:storage}).getState().pendingRequestId,null);
});

test('known job cancellation timeout blocks new run and retries that same job',async()=>{
  const f=await fixture(),statusReply=deferred();let job,cancelCount=0;
  f.data.sellpiaSyncRequest=async(action,body)=>{
    f.calls.push({action,body});
    if(action==='availability')return {enabled:true};if(action==='history')return {jobs:[]};
    if(action==='enqueue'){job={...body,jobId,state:'queued'};return {job};}
    if(action==='status')return statusReply.promise;
    if(action==='cancel'){assert.equal(body.jobId,jobId);if(++cancelCount===1)throw Error('cancel response timeout');return {job:{...job,state:'cancelled'}};}
    throw Error('unexpected action');
  };
  const run=f.controller.run();await waitUntil(()=>f.calls.some(c=>c.action==='status'));
  await assert.rejects(f.controller.cancel(),e=>e.code==='CANCEL_UNCONFIRMED');
  assert.equal(f.controller.getState().stage,'cancel_pending');await assert.rejects(f.controller.run(),e=>e.code==='CANCEL_UNCONFIRMED');
  await f.controller.cancel();statusReply.resolve({job:{...job,state:'collected'}});await run;
  assert.equal(cancelCount,2);assert.equal(f.controller.getState().stage,'cancelled');assert.equal(f.calls.filter(c=>c.action==='enqueue').length,1);
});

test('duplicate cancel clicks share one request and malformed cancellation confirmation stays pending',async()=>{
  const f=await fixture({offline:true}),reply=deferred();await f.controller.run();
  f.data.sellpiaSyncRequest=async(action,body)=>{f.calls.push({action,body});assert.equal(action,'cancel-request');return reply.promise;};
  const first=f.controller.cancel(),second=f.controller.cancel();
  reply.resolve({job:{jobId,requestId:'99999999-9999-4999-8999-999999999999',state:'cancelled'}});
  const results=await Promise.allSettled([first,second]);assert.ok(results.every(r=>r.status==='rejected'&&r.reason.code==='CANCEL_UNCONFIRMED'));
  assert.equal(f.calls.filter(c=>c.action==='cancel-request').length,1);assert.equal(f.controller.getState().stage,'cancel_pending');assert.ok(f.controller.getState().pendingRequestId);
});

async function approvedFixture(options={}){
  const storage=memoryStorage(),approvalCalls=[],f=await fixture({applyEnabled:true,controller:{pendingStorage:storage,confirmApply:async state=>{approvalCalls.push(state);return options.approve!==false;}}});
  const request=f.data.sellpiaSyncRequest;let job,applied=false,waits=0;
  const appliedSnapshot='55555555-5555-4555-8555-555555555555';
  f.data.sellpiaSyncRequest=async(action,body)=>{
    if(action==='apply-init'){f.calls.push({action,body});job={...job,applyProduction:true,state:'applying'};return {job,applyToken:'synthetic_scoped_apply_token',requestId:job.requestId};}
    if(action==='apply-progress'){f.calls.push({action,body});job={...job,state:body.state==='complete'?'complete':'db_ready',applySnapshotId:appliedSnapshot,importIntentId:'66666666-6666-4666-8666-666666666666',importStatus:'ready'};return {job};}
    if(action==='status'&&applied){f.calls.push({action,body});return {job:{...job,state:'db_ready',applySnapshotId:appliedSnapshot,importStatus:'ready',importIntentId:'66666666-6666-4666-8666-666666666666'}};}
    const result=await request(action,body);if(result.job)job=result.job;return result;
  };
  f.data.uploadSellpiaSnapshot=async(files,fields)=>{
    f.calls.push({action:'SCOPED_UPLOAD',fields});assert.equal(files.length,3);assert.equal(fields.syncJobId,jobId);assert.equal(fields.syncApplyToken,'synthetic_scoped_apply_token');applied=true;
    if(options.lostComplete)throw Object.assign(new Error('synthetic lost complete response'),{sellpiaIntentId:'66666666-6666-4666-8666-666666666666',sellpiaSnapshotId:appliedSnapshot,sellpiaApplyUnknown:true});
    return {snapshotId:appliedSnapshot,uploadMode:fields.mode,rowCount:3,uploadedRowCount:3,affectedSkus:['1001-1']};
  };
  f.data.waitForSellpiaMatrixRebuild=async snapshot=>{f.calls.push({action:'MATRIX_READ',snapshot});assert.equal(snapshot,appliedSnapshot);if(options.matrixFailure&&waits++===0)throw Error('synthetic Matrix timeout');return {matrix_snapshot_id:snapshot,rebuild_pending:false};};
  return {...f,storage,approvalCalls};
}
test('preview stays read-only even when the server permits apply, then confirmed apply uses the existing scoped upload and Matrix wait',async()=>{
  const f=await approvedFixture();await f.controller.run({applicationMode:'patch',fields:{inventory:true}});
  assert.equal(f.calls.some(c=>c.action==='SCOPED_UPLOAD'||c.action==='apply-init'),false);
  const applied=await f.controller.apply();assert.equal(applied.stage,'completed');assert.equal(f.approvalCalls.length,1);
  const upload=f.calls.find(c=>c.action==='SCOPED_UPLOAD');assert.equal(upload.fields.mode,'patch');assert.equal(upload.fields.price,false);assert.equal(upload.fields.inventory,true);
  assert.equal(f.calls.filter(c=>c.action==='apply-init').length,1);assert.equal(f.calls.filter(c=>c.action==='SCOPED_UPLOAD').length,1);assert.equal(f.calls.filter(c=>c.action==='MATRIX_READ').length,1);
});
test('automatic application requires one explicit approval and applies only after complete preview validation',async()=>{
  const rejected=await approvedFixture({approve:false});const blocked=await rejected.controller.run({execution:'auto',applicationMode:'patch',fields:{inventory:true}});assert.equal(blocked.stage,'failed');assert.equal(rejected.calls.some(c=>c.action==='enqueue'||c.action==='SCOPED_UPLOAD'),false);
  const f=await approvedFixture();const result=await f.controller.run({execution:'auto',applicationMode:'patch',fields:{inventory:true}});
  assert.equal(result.stage,'completed');assert.equal(f.approvalCalls.length,1);assert.equal(f.approvalCalls[0].automatic,true);
  assert.ok(f.calls.findIndex(c=>c.action==='receipt')<f.calls.findIndex(c=>c.action==='apply-init'));
});
test('unknown complete response is recovered by server status and Matrix reads without a second upload or apply-init',async()=>{
  const f=await approvedFixture({lostComplete:true});await f.controller.run();await assert.rejects(f.controller.apply(),/lost complete/);assert.equal(f.controller.getState().stage,'apply_unknown');
  await assert.rejects(f.controller.run(),e=>e.code==='APPLY_UNCONFIRMED');
  assert.equal(f.storage.dump().includes('synthetic_scoped_apply_token'),false);
  const restarted=client.createController({data:f.data,contract,pendingStorage:f.storage,crypto:webcrypto});assert.equal(restarted.getState().stage,'apply_unknown');
  const result=await restarted.recover();assert.equal(result.stage,'completed');assert.equal(result.result.recovered,true);
  assert.equal(f.calls.filter(c=>c.action==='SCOPED_UPLOAD').length,1);assert.equal(f.calls.filter(c=>c.action==='apply-init').length,1);assert.equal(f.calls.filter(c=>c.action==='MATRIX_READ').length,1);
});
test('ready snapshot with Matrix timeout retries only the same Matrix and preserves one import',async()=>{
  const f=await approvedFixture({matrixFailure:true});await f.controller.run();await assert.rejects(f.controller.apply(),/Matrix timeout/);assert.equal(f.controller.getState().stage,'matrix_pending');
  const result=await f.controller.recover();assert.equal(result.stage,'completed');assert.equal(f.calls.filter(c=>c.action==='SCOPED_UPLOAD').length,1);assert.equal(f.calls.filter(c=>c.action==='apply-init').length,1);assert.equal(f.calls.filter(c=>c.action==='MATRIX_READ').length,2);
});
test('baseline changed before approval blocks apply-init and upload',async()=>{
  const f=await approvedFixture();await f.controller.run();f.data.loadLatestSellpiaOriginalStatus=async()=>({snapshotId:'77777777-7777-4777-8777-777777777777',boundary:'signed-read-v1'});
  await assert.rejects(f.controller.apply(),e=>e.code==='STALE_BASELINE');assert.equal(f.calls.some(c=>c.action==='SCOPED_UPLOAD'||c.action==='apply-init'),false);
});
test('duplicate apply clicks share one approval, scoped import and completion',async()=>{
  const f=await approvedFixture(),confirmation=deferred();let confirmations=0;
  const controller=client.createController({data:f.data,contract,crypto:webcrypto,sleep:async()=>{},confirmApply:async()=>{confirmations++;return confirmation.promise;}});
  await controller.run();const first=controller.apply(),second=controller.apply();await waitUntil(()=>confirmations===1);confirmation.resolve(true);
  const results=await Promise.all([first,second]);assert.ok(results.every(result=>result.stage==='completed'));assert.equal(confirmations,1);assert.equal(f.calls.filter(c=>c.action==='apply-init').length,1);assert.equal(f.calls.filter(c=>c.action==='SCOPED_UPLOAD').length,1);
});
test('explicit server denial leaves the validated preview usable and creates no unknown import hint',async()=>{
  const f=await approvedFixture();await f.controller.run();const request=f.data.sellpiaSyncRequest;
  f.data.sellpiaSyncRequest=async(action,body)=>{if(action==='apply-init')throw Object.assign(new Error('synthetic server gate disabled'),{code:'APPLY_DISABLED',httpStatus:409});return request(action,body);};
  await assert.rejects(f.controller.apply(),e=>e.code==='APPLY_DISABLED');assert.equal(f.controller.getState().stage,'previewed');assert.equal(f.calls.some(c=>c.action==='SCOPED_UPLOAD'),false);assert.equal(f.storage.dump().includes('pending-application'),false);
});
for(const [status,online,stage] of [['offline',false,'failed'],['needs_login',true,'needs_login']])test(`runner ${status} prevents enqueue even when collection is enabled`,async()=>{
  const f=await fixture(),request=f.data.sellpiaSyncRequest;f.data.sellpiaSyncRequest=async(action,body)=>action==='availability'?{enabled:true,runner:{online,status}}:request(action,body);
  const result=await f.controller.run();assert.equal(result.stage,stage);assert.ok(result.error);assert.equal(f.calls.some(c=>c.action==='enqueue'||c.action==='PRODUCTION_UPLOAD'),false);
});
test('server membership thresholds pause automatic apply and only an exact server-approved fingerprint can release the reviewed source',async()=>{
  const f=await approvedFixture(),request=f.data.sellpiaSyncRequest,baseline=f.data.loadSellpiaSyncBaselineRows;let approvedSourceFingerprint=null;
  f.data.sellpiaSyncRequest=async(action,body)=>action==='availability'?{enabled:true,applyEnabled:true,runner:{online:true,status:'connected'},applicationPolicy:{maxAddedCount:0,maxAddedRatio:0,maxRemovedCount:0,approvedSourceFingerprint}}:request(action,body);
  f.data.loadSellpiaSyncBaselineRows=async()=>{const value=await baseline();return {...value,rows:value.rows.slice(0,2)};};
  const preview=await f.controller.run({execution:'auto',applicationMode:'patch',fields:{inventory:true}});
  assert.equal(preview.stage,'previewed');assert.equal(preview.plan.summary.reviewRequired,true);assert.deepEqual(preview.plan.summary.reviewReasons,['source_sku_added']);assert.equal(f.calls.some(c=>c.action==='SCOPED_UPLOAD'),false);
  await assert.rejects(f.controller.apply(),e=>e.code==='PRODUCTION_APPLY_DISABLED');
  approvedSourceFingerprint='0'.repeat(64);await f.controller.refreshOverview();await assert.rejects(f.controller.apply(),e=>e.code==='PRODUCTION_APPLY_DISABLED');
  approvedSourceFingerprint=preview.plan.sourceFingerprint;await f.controller.refreshOverview();assert.equal((await f.controller.apply()).stage,'completed');assert.equal(f.calls.filter(c=>c.action==='SCOPED_UPLOAD').length,1);
});
test('full source removals require review while partial application records those same absent SKUs as preserved',async()=>{
  const full=await fixture(),baseline=full.data.loadSellpiaSyncBaselineRows;
  full.data.loadSellpiaSyncBaselineRows=async()=>{const value=await baseline();return {...value,rows:[...value.rows.slice(0,2),{...value.rows[0],sellpia_sku_code:'extra-1'}]};};
  const result=await full.controller.run({applicationMode:'full',fields:{...contract.FULL_FIELDS}});assert.equal(result.stage,'previewed');assert.equal(result.comparison.summary.removedCount,1);assert.deepEqual(result.plan.summary.reviewReasons,['source_sku_removed']);
  const patch=await fixture(),prior=patch.data.loadSellpiaSyncBaselineRows;patch.data.loadSellpiaSyncBaselineRows=async()=>{const value=await prior();return {...value,rows:[...value.rows.slice(0,2),{...value.rows[0],sellpia_sku_code:'extra-1'}]};};
  const partial=await patch.controller.run({applicationMode:'patch',fields:{inventory:true}});assert.equal(partial.stage,'previewed');assert.equal(partial.comparison.summary.removedCount,0);assert.equal(partial.comparison.summary.preservedCount,1);assert.equal(partial.plan.summary.reviewRequired,false);
});
for(const importStatus of ['failed','parsing'])test(`server ${importStatus} recovery never reuploads and only definitive failure unlocks a new collection`,async()=>{
  const f=await approvedFixture({lostComplete:true});await f.controller.run();await assert.rejects(f.controller.apply());const job=f.controller.getState().job,request=f.data.sellpiaSyncRequest;
  f.data.sellpiaSyncRequest=async(action,body)=>action==='status'?{job:{...job,state:importStatus==='failed'?'failed':'applying',importIntentId:'66666666-6666-4666-8666-666666666666',importStatus}}:request(action,body);
  const recovered=await f.controller.recover();assert.equal(recovered.stage,importStatus==='failed'?'failed':'apply_unknown');assert.equal(f.calls.filter(c=>c.action==='SCOPED_UPLOAD').length,1);
  if(importStatus==='failed'){assert.equal(f.storage.dump().includes('pending-application'),false);await f.controller.run();assert.equal(f.calls.filter(c=>c.action==='enqueue').length,2);}
  else await assert.rejects(f.controller.run(),e=>e.code==='APPLY_UNCONFIRMED');
  assert.equal(f.calls.filter(c=>c.action==='SCOPED_UPLOAD').length,1);
});
test('server-confirmed expired apply scope terminates a parsing intent without replaying its upload',async()=>{
  const f=await approvedFixture({lostComplete:true});await f.controller.run();await assert.rejects(f.controller.apply());const job=f.controller.getState().job,request=f.data.sellpiaSyncRequest;
  f.data.sellpiaSyncRequest=async(action,body)=>action==='status'?{job:{...job,state:'failed',importIntentId:'66666666-6666-4666-8666-666666666666',importStatus:'parsing',summary:{errorCode:'APPLY_SCOPE_EXPIRED'}}}:request(action,body);
  assert.equal((await f.controller.recover()).stage,'failed');assert.equal(f.storage.dump().includes('pending-application'),false);
  await f.controller.run();assert.equal(f.calls.filter(c=>c.action==='enqueue').length,2);assert.equal(f.calls.filter(c=>c.action==='SCOPED_UPLOAD').length,1);
});
test('explicit automatic button approval performs one run without an extra confirmation while server apply-off still blocks it',async()=>{
  const f=await approvedFixture();assert.equal((await f.controller.run({execution:'auto',automaticApproved:true,applicationMode:'patch',fields:{inventory:true}})).stage,'completed');assert.equal(f.approvalCalls.length,0);assert.equal(f.calls.filter(c=>c.action==='SCOPED_UPLOAD').length,1);
  const off=await fixture();const result=await off.controller.run({execution:'auto',automaticApproved:true,fields:{inventory:true}});assert.equal(result.stage,'failed');assert.equal(off.calls.some(c=>c.action==='enqueue'||c.action==='PRODUCTION_UPLOAD'),false);
});
test('price-only and basePrice-only application choices freeze the same explicit SQL-compatible sale-price policy',async()=>{
  for(const fields of [{price:true,basePrice:false},{price:false,basePrice:true}]){
    const f=await fixture();const result=await f.controller.run({applicationMode:'patch',fields});assert.equal(result.stage,'previewed');const chosen=f.calls.find(c=>c.action==='enqueue').body.selectedFields;assert.equal(chosen.price,true);assert.equal(chosen.basePrice,true);assert.equal(chosen.purchasePrice,false);
  }
});
