import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {webcrypto} from 'node:crypto';
import {QueueProtocol,MemoryQueueStore,sha256} from '../supabase/functions/operations-hub-sellpia-sync/protocol.mjs';
import {createHandler} from '../supabase/functions/operations-hub-sellpia-sync/handler.mjs';
const require=createRequire(import.meta.url),parser=require('../mockups/operations-hub/sellpia-source-parser.js'),contract=require('../mockups/operations-hub/sellpia-sync-contract.js'),client=require('../mockups/operations-hub/sellpia-sync-client.js');
const serviceSource=fs.readFileSync(new URL('../mockups/operations-hub/data-service.js',import.meta.url),'utf8');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const baseline=id(1),other=id(2),company='https://w-works-official.github.io',apiOrigin='https://bpgvqmtsjgegnrdzmpep.supabase.co';
// Artificial source rows and session only. All fetches below are in-process.
async function fixture(){
  const headers=['#','상품코드','자사코드','상품명','옵션명','재고','가용재고','품절','단종','판매가','안전재고','매입처코드','매입처','매입처그룹','매입처주소','상가명','매입처전화','매입상품명','매입옵션명','매입가','수수료','매입처부가세','발주단위','최소발주수량'];
  const files=[1,2,3].map(n=>new File([headers.join(',')+'\n'+headers.map(h=>({'#':n,'상품코드':`${100+n}-1`,'상품명':'SYNTHETIC ONLY','옵션명':'fixture','재고':7,'가용재고':-1,'판매가':100,'안전재고':0,'매입가':40,'수수료':0,'발주단위':1,'최소발주수량':1}[h]??'')).join(',')+'\n'],`part-${n}.csv`,{type:'text/csv'}));
  const bytes=await Promise.all(files.map(f=>f.arrayBuffer()));
  const manifest={source:'sellpia',collectionMode:'official_download',mode:'full',includeAll:true,filters:[],expectedRowCount:3,files:await Promise.all(files.map(async(f,i)=>({ordinal:i+1,name:f.name,size:f.size,sha256:await sha256(bytes[i])})))};
  const parsed=await parser.parseSellpiaFiles(files,{mode:'full',strictNumeric:true});assert.equal(parsed.valid,true);
  return {files,bytes,manifest,parsed};
}
function loadService(fetch,db={}){
  const context={console,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,AbortController,URL,File,Blob,crypto:webcrypto,setTimeout,clearTimeout,performance,supabase:{createClient:()=>db},fetch};
  context.window=context;context.globalThis=context;vm.createContext(context);vm.runInContext(serviceSource,context);
  context.SystemV3Data.setOperationsHubSessionToken('a'.repeat(64));return context.SystemV3Data;
}
async function mockClient(options={}){
  const f=await fixture(),calls=[];let job={jobId:id(10),requestId:id(11),mode:'full',applicationMode:'patch',selectedFields:{inventory:true,price:true,basePrice:true,purchasePrice:true,basic:false,status:false},baselineSnapshotId:baseline,state:'queued',applyProduction:false},latest=baseline,poll=0,attempt=0;
  const data={loadLatestSellpiaOriginalStatus:async()=>({stateSnapshotId:latest,boundary:'signed-read-v1'}),
    sellpiaSyncRequest:async(action,body)=>{calls.push({action,body});if(action==='availability')return {enabled:true,applyEnabled:false,runner:{online:true,status:'connected'}};if(action==='history')return {jobs:[]};if(action==='enqueue'){if(options.lostEnqueue&&attempt++===0)throw Object.assign(new Error('response lost'),{name:'AbortError'});job={...job,...body};return {job};}if(action==='status')return {job:{...job,jobId:options.wrongStatusJob?other:job.jobId,state:'collected'}};return {ok:true};},
    loadSellpiaSyncArtifacts:async()=>({files:f.files,manifest:f.manifest}),loadSellpiaSyncBaselineRows:async()=>({snapshotId:baseline,rows:f.parsed.rows}),
    uploadSellpiaSnapshot:async()=>{throw Error('PRODUCTION CALL FORBIDDEN');}};
  const c={...contract,compareRows:(...args)=>{const r=contract.compareRows(...args);if(options.driftAfterComparison)latest=other;return r;}};
  const controller=client.createController({data,contract:c,crypto:webcrypto,sleep:async()=>{poll++;assert.ok(poll<10);}});
  return {...f,data,controller,calls};
}
test('actual frontend data-service, queue handler and parser agree on top-level manifest and bounded receipt',async()=>{
  const f=await fixture(),store=new MemoryQueueStore(),queue=new QueueProtocol(store),calls=[];
  const handler=createHandler({queue,store,enabled:true,workerId:'qa-pc',workerToken:'synthetic-review-worker-credential-only',guardSession:async()=>true,storage:{assertPrivate:async()=>{},signDownload:async path=>`${apiOrigin}/storage/v1/object/sign/seller-originals/${path}?token=synthetic`}});
  const data=loadService(async(url,options={})=>{
    calls.push({url:String(url),options});
    if(String(url).includes('/storage/')){assert.equal(options.headers,undefined);assert.equal(options.credentials,'omit');assert.equal(options.referrerPolicy,'no-referrer');const n=Number(new URL(url).pathname.match(/\/(\d)\.csv$/)?.[1]);return new Response(f.bytes[n-1],{headers:{'Content-Type':'text/csv'}});}
    assert.equal(options.headers['x-sellpia-sync-worker-token'],undefined);assert.equal(options.headers.Authorization,undefined);
    const body=JSON.parse(options.body),response=await handler(new Request(url,{...options,headers:{...options.headers,origin:company}}));
    if(body.action==='enqueue'&&response.ok){const claim=await queue.dispatch('claim',{}, {kind:'worker',workerId:'qa-pc'});const auth={jobId:claim.job.jobId,leaseToken:claim.leaseToken};const init=await queue.dispatch('upload-init',{...auth,collectionManifest:f.manifest},{kind:'worker',workerId:'qa-pc'});await queue.dispatch('upload-finalize',{...auth,verifiedArtifacts:init.manifest.map(x=>({...x,verified:true}))},{kind:'worker',workerId:'qa-pc'});}
    return response;
  });
  const created=await data.sellpiaSyncRequest('enqueue',{requestId:id(20),mode:'full',baselineSnapshotId:baseline,selectedFields:{...contract.FULL_FIELDS},applyProduction:true});assert.equal(created.job.applyProduction,false);
  const artifacts=await data.loadSellpiaSyncArtifacts(created.job.jobId);assert.deepEqual(JSON.parse(JSON.stringify(artifacts.manifest)),f.manifest);
  const plan=await contract.prepare(artifacts.files,{manifest:artifacts.manifest,baselineSnapshotId:baseline,crypto:webcrypto});assert.equal(plan.valid,true);
  const comparison=contract.compareRows(plan.parsed.rows,f.parsed.rows);
  const receipt=await data.sellpiaSyncRequest('receipt',{jobId:created.job.jobId,receipt:{valid:true,rowCount:plan.rowCount,state:'previewed',sourceFingerprint:plan.sourceFingerprint,baselineSnapshotId:baseline,summary:{...plan.summary,comparison:comparison.summary}}});assert.equal(receipt.job.state,'previewed');
  assert.ok(!JSON.stringify(receipt.job.receipt).includes('SYNTHETIC ONLY'));assert.ok(calls.every(c=>!c.url.includes('upload-init')&&!c.url.includes('hub_sellpia_upload')));
});
test('frontend refuses missing operator session before any queue fetch',async()=>{let calls=0;const data=loadService(async()=>{calls++;throw Error('unexpected');});data.setOperationsHubSessionToken('');await assert.rejects(data.sellpiaSyncRequest('enqueue',{}),e=>e.code==='OPERATIONS_AUTH_REQUIRED');assert.equal(calls,0);});
test('backend disabled message remains actionable in frontend error',async()=>{const data=loadService(async()=>new Response(JSON.stringify({ok:false,code:'DISABLED',message:'원본 동기화 서버는 아직 활성화되지 않았습니다.'}),{status:503}));await assert.rejects(data.sellpiaSyncRequest('enqueue',{}),e=>e.code==='DISABLED'&&e.message.includes('활성화'));});
test('different job identity returned during status polling stops before receipt',async()=>{const f=await mockClient({wrongStatusJob:true});const r=await f.controller.run();assert.equal(r.stage,'failed');assert.equal(f.calls.some(x=>x.action==='receipt'),false);});
test('lost enqueue response is reconciled with the same frozen request ID',async()=>{const f=await mockClient({lostEnqueue:true});await f.controller.run();await f.controller.run();const ids=f.calls.filter(x=>x.action==='enqueue').map(x=>x.body.requestId);assert.equal(ids.length,2);assert.equal(ids[0],ids[1]);});
test('baseline drift immediately after comparison stops before completed receipt',async()=>{const f=await mockClient({driftAfterComparison:true});const r=await f.controller.run();assert.equal(r.stage,'stale');assert.equal(f.calls.some(x=>x.action==='receipt'),false);});
test('default client apply is blocked even if caller changes the local display state',async()=>{const f=await mockClient();await f.controller.run();const display=f.controller.getState();display.job.applyProduction=true;await assert.rejects(f.controller.apply(),e=>e.code==='PRODUCTION_APPLY_DISABLED');});
test('frontend runtime has no worker credentials, PC profile, remote debugging or service role access',async()=>{for(const name of ['sellpia-sync-client.js','sellpia-sync-workspace.js','sellpia-sync-contract.js']){const source=fs.readFileSync(new URL(`../mockups/operations-hub/${name}`,import.meta.url),'utf8');assert.doesNotMatch(source,/SELLPIA_SYNC_WORKER_TOKEN|SUPABASE_SERVICE_ROLE_KEY|x-sellpia-sync-worker-token|remote-debugging|storageState\(|\.cookies\(/);}
  const html=fs.readFileSync(new URL('../mockups/operations-hub/index.html',import.meta.url),'utf8');assert.doesNotMatch(html,/<script[^>]+(?:tools\/sellpia-sync|operations-hub-sellpia-sync|runner\.mjs)/);assert.match(html,/id="sellpia-sync-apply"[^>]*disabled/);assert.match(html,/id="mock-upload-btn"/);
});
test('full original manual parser contract remains independent from the new sync prepare guard',async()=>{const f=await fixture();const old=await parser.parseSellpiaFiles(f.files,{mode:'full'});assert.equal(old.valid,true);assert.equal(old.rowCount,3);assert.equal(old.rows[0].available_stock,-1);assert.equal((await parser.parseSellpiaFiles(f.files.slice(0,2),{mode:'full'})).valid,false);assert.equal((await parser.parseSellpiaFiles(f.files.slice(0,1),{mode:'patch'})).valid,true);});
test('workspace escapes file or server text and preserves unknown counts as unknown',()=>{
  const workspace=require('../mockups/operations-hub/sellpia-sync-workspace.js'),elements=new Map();let render;
  for(const name of ['sellpia-sync-panel','sellpia-sync-start','sellpia-sync-cancel','sellpia-sync-apply','sellpia-sync-mode','sellpia-sync-result','source-select'])elements.set(name,{dataset:{},value:name==='source-select'?'sellpia':'full',addEventListener(){},innerHTML:''});
  workspace.mount({document:{getElementById:name=>elements.get(name)},client:{createController:options=>{render=options.onState;assert.equal(options.productionEnabled,false);return {getState:()=>({stage:'idle'})};}}});
  render({stage:'failed',error:'<img src=x onerror=unexpected()>',plan:{mode:'full',fields:{inventory:true},parsed:{rows:[],duplicateSkuCount:0},summary:{rowCount:0}},comparison:{summary:{changedCount:null,unchangedCount:null,addedCount:0,removedCount:0}}});
  const html=elements.get('sellpia-sync-result').innerHTML;assert.ok(!html.includes('<img'));assert.ok(html.includes('&lt;img'));assert.ok(html.includes('미확인'));assert.equal(elements.get('sellpia-sync-apply').disabled,true);
});
