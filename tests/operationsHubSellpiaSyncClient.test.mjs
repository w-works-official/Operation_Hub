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
  const job={jobId,requestId:'33333333-3333-4333-8333-333333333333',mode:'full',selectedFields:{...contract.FULL_FIELDS},baselineSnapshotId:baselineId,applyProduction:false,state:'queued'};
  let index=0,baselineReads=0;
  const data={
    async loadLatestSellpiaOriginalStatus(){baselineReads++;return {snapshotId:options.stale&&baselineReads>1?'44444444-4444-4444-8444-444444444444':baselineId,boundary:options.insecure?'direct-anon-fallback':'signed-read-v1'};},
    async sellpiaSyncRequest(action,body){calls.push({action,body});if(action==='enqueue'){if(options.offline)throw Error('실행 경계 미배포');return {job:{...job,mode:options.scopeConflict?'patch':'full'}};}if(action==='status')return {job:{...job,state:options.needsLogin?'needs_login':index++?'collected':'collecting'}};return {valid:true};},
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
test('partial automation is rejected before enqueue while the manual patch contract remains separate',async()=>{const f=await fixture();const result=await f.controller.run({mode:'patch',fields:{inventory:true}});assert.equal(result.stage,'failed');assert.match(result.error,/수동 업로드/);assert.equal(f.calls.length,0);});
for(const [name,option,stage] of [['stale snapshot',{stale:true},'stale'],['malformed expected count',{badCount:true},'failed'],['login expiry',{needsLogin:true},'needs_login'],['insecure baseline',{insecure:true},'failed'],['missing baseline rows',{unknownBaseline:true},'failed'],['different active job scope',{scopeConflict:true},'failed'],['missing queue deployment',{offline:true},'failed']])test(`${name} stops before production upload`,async()=>{const f=await fixture(option);const result=await f.controller.run();assert.equal(result.stage,stage);assert.ok(result.error);assert.ok(!f.calls.some(c=>c.action==='PRODUCTION_UPLOAD'));assert.ok(!f.calls.some(c=>c.action==='receipt'));});
test('default production apply is rejected after successful preview',async()=>{const f=await fixture();await f.controller.run();await assert.rejects(f.controller.apply(),e=>e.code==='PRODUCTION_APPLY_DISABLED');assert.ok(!f.calls.some(c=>c.action==='PRODUCTION_UPLOAD'));});
test('cancellation invalidates a pending status result and prevents late artifact receipt',async()=>{const f=await fixture();let unblock;f.data.sellpiaSyncRequest=async(action,body)=>{f.calls.push({action,body});if(action==='enqueue')return {job:{jobId,mode:'full',selectedFields:{...contract.FULL_FIELDS},baselineSnapshotId:baselineId,state:'queued'}};if(action==='status')return await new Promise(resolve=>{unblock=()=>resolve({job:{jobId,state:'collected'}});});if(action==='cancel')return {job:{jobId,state:'cancelled'}};return {};};const task=f.controller.run();for(let i=0;i<30&&!unblock;i++)await new Promise(r=>setImmediate(r));assert.equal(typeof unblock,'function');await f.controller.cancel();unblock();await task;assert.equal(f.controller.getState().stage,'cancelled');assert.ok(!f.calls.some(c=>c.action==='receipt'));});

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const memoryStorage=()=>{const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};};
async function waitUntil(predicate){for(let i=0;i<40&&!predicate();i++)await new Promise(resolve=>setImmediate(resolve));assert.ok(predicate(),'asynchronous stage was not reached');}

test('cancel before enqueue reply confirms requestId cancellation and ignores a late collected reply',async()=>{
  const f=await fixture(),enqueueReply=deferred(),cancelReply=deferred();let pendingBody;
  f.data.sellpiaSyncRequest=async(action,body)=>{
    f.calls.push({action,body});
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
  assert.equal(f.calls.length,2);assert.ok(!f.calls.some(c=>c.action==='receipt'||c.action==='PRODUCTION_UPLOAD'));
});

test('lost enqueue and cancel replies preserve one cancellation identity across reload',async()=>{
  const storage=memoryStorage(),f=await fixture({controller:{pendingStorage:storage}});let pendingBody;
  f.data.sellpiaSyncRequest=async(action,body)=>{f.calls.push({action,body});if(action==='enqueue'){pendingBody=body;throw Error('enqueue reply lost');}if(action==='cancel-request')throw Error('cancel reply lost');throw Error('unexpected action');};
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
