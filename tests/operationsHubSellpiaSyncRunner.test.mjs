import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {validateConfig, requireReady, SyncError, safeName, inside, digest, acquireLock, safeLog,
  validateJob, validateManifest, validateOriginalFiles, writeJournal, readJournal} from '../tools/sellpia-sync/contracts.mjs';
import {collectOfficial, captureGridDownloads, ensureSession, parseOfficialCount,prepareOfficialDownload,waitForManualAuthentication} from '../tools/sellpia-sync/collector.mjs';
import {WorkerTransport, leaseBinding, validateApiUrl} from '../tools/sellpia-sync/transport.mjs';
import {runClaimedJob, pollWorker} from '../tools/sellpia-sync/worker.mjs';
import {waitForManualLoginClose,parseArguments} from '../tools/sellpia-sync/runner.mjs';
import {QueueProtocol,MemoryQueueStore} from '../supabase/functions/operations-hub-sellpia-sync/protocol.mjs';
import {createHandler} from '../supabase/functions/operations-hub-sellpia-sync/handler.mjs';

const require = createRequire(import.meta.url);
const XLSX = require('./vendor/xlsx-0.18.5.full.min.js');
const headers = ['#','상품코드','자사코드','상품명','옵션명','재고','가용재고','품절','단종','매입처코드','매입처',
  '매입처그룹','매입처주소','상가명','매입처전화','매입상품명','매입옵션명','판매가','매입가','수수료','매입처부가세','안전재고','발주단위','최소발주수량','추가 보존 필드'];
const values = (number,sku = `00123-${number}`) => [number,sku,'00007','합성 상품','합성 옵션',9,-3,'','','SUP-0001','합성 매입처',
  '합성 그룹','합성 주소','합성 상가','000-0000-0000','합성 상품','합성 옵션',3000,1500,10,'Y',2,1,1,'원본 유지'];
const sourceBytes = (number,{xls = false,sku} = {}) => {
  if (!xls) return Buffer.from(`${headers.join(',')}\r\n${values(number,sku).join(',')}\r\n`);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([headers,values(number,sku)]),'합성 원본');
  return Buffer.from(XLSX.write(workbook,{bookType:'biff8',type:'buffer'}));
};
async function fixture(t,{ready = true} = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'operation-hub-sellpia-sync-test-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(),directory);
    assert.ok(relative.startsWith('operation-hub-sellpia-sync-test-') && !relative.includes(path.sep));
    await fs.rm(directory,{recursive:true,force:true});
  });
  const config = validateConfig({profileDirectory:path.join(directory,'profile'),workDirectory:path.join(directory,'runs'),
    verifiedReady:ready,browserChannel:'chromium',timeoutMs:1000,heartbeatIntervalMs:1000,pollIntervalMs:1000,workerId:'fixture-worker',
    ui:{strategy:'grid_csv',format:'csv4',rowsPerFile:10000,settleMs:100,
      authenticatedSelector:'#authenticated',rowCountSelector:'#official-count',rowCountPattern:'^(\\d+)개$',
      loadingSelector:'.loading-indicator2',loadingBackdropSelector:'.loading-fade2'}});
  return {directory,config};
}
async function filesFixture(directory,{xls = false} = {}) {
  await fs.mkdir(directory,{recursive:true});
  return Promise.all([1,2,3].map(async ordinal => {
    const name = `합성-전체-${ordinal}.${xls ? 'xls' : 'csv'}`,bytes = sourceBytes(ordinal,{xls});
    const localPath = path.join(directory,`part-${ordinal}.${xls ? 'xls' : 'csv'}`);
    await fs.writeFile(localPath,bytes);
    return {ordinal,name,size:bytes.length,sha256:digest(bytes),localPath};
  }));
}
function manifest(files,expectedRowCount = 3) {
  return {source:'sellpia',collectionMode:'official_download',mode:'full',includeAll:true,filters:[],expectedRowCount,
    files:files.map(({ordinal,name,size,sha256}) => ({ordinal,name,size,sha256}))};
}
function claim(jobId = 'fixture-job') {
  return {ok:true,job:{jobId,mode:'full',applyProduction:false},leaseToken:'private-lease-fixture',leaseExpiresAt:new Date(Date.now()+120000).toISOString()};
}
function fakeContext() {
  return {closed:0,setDefaultTimeout(){},pages(){return [{}];},async close(){this.closed++;}};
}
const response = (body,status = 200) => new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});

test('unknown official download contract blocks before any browser or queue access',async t => {
  const {config} = await fixture(t,{ready:false});
  assert.throws(() => requireReady(config),{code:'official_download_contract_unverified'});
  let browserCalls = 0, queueCalls = 0;
  await assert.rejects(collectOfficial(config,{jobId:'fixture',openBrowser:async()=>{browserCalls++;}}),{code:'official_download_contract_unverified'});
  await assert.rejects(pollWorker(config,{claim:async()=>{queueCalls++;}},{once:true}),{code:'official_download_contract_unverified'});
  assert.equal(browserCalls,0); assert.equal(queueCalls,0);
});
test('verified config needs async query completion, exact three parts, and isolated runtime paths',async t => {
  const {config} = await fixture(t);
  assert.throws(() => validateConfig({...config,ui:{...config.ui,loadingSelector:null}}),{code:'official_download_contract_incomplete'});
  assert.throws(() => validateConfig({...config,ui:{...config.ui,rowsPerFile:5000}}),{code:'unsupported_official_download_strategy'});
  assert.throws(() => validateConfig({...config,sourceUrl:'https://elsewhere.invalid/'}),{code:'unapproved_source_url'});
  assert.throws(() => validateConfig({...config,workDirectory:path.join(config.profileDirectory,'raw')}),{code:'profile_and_artifacts_must_be_separate'});
  assert.throws(() => validateConfig({...config,ui:{...config.ui,format:'print'}}),{code:'unsupported_official_download_strategy'});
  assert.throws(() => validateConfig({...config,timeoutMs:0}),{code:'invalid_runtime_limit'});
});
test('job scope and lease cannot enable production apply, arbitrary identifiers, or expired ownership',() => {
  assert.throws(() => validateJob({...claim().job,applyProduction:true}),{code:'unsupported_job_scope'});
  assert.throws(() => validateJob({...claim().job,jobId:'../escape'}),{code:'invalid_job_id'});
  assert.throws(() => leaseBinding({...claim(),leaseExpiresAt:new Date(0).toISOString()},'fixture-worker'),{code:'invalid_worker_lease'});
  assert.throws(() => validateApiUrl('http://localhost/functions/v1/operations-hub-sellpia-sync'),{code:'invalid_worker_api_url'});
  assert.throws(() => validateApiUrl('https://project.supabase.co/functions/v1/else'),{code:'invalid_worker_api_url'});
});
test('download names and paths reject Windows traversal and count must be positive official data',() => {
  for (const name of ['../source.xls','CON.xls','part.csv.exe','part .csv/other','blank.csv ']) assert.throws(()=>safeName(name));
  assert.throws(()=>inside(os.tmpdir(),'../outside'),{code:'unsafe_local_path'});
  assert.equal(parseOfficialCount('총 23,818개','^총 ([\\d,]+)개$'),23818);
  for (const value of ['0','1,23','pending','']) assert.throws(()=>parseOfficialCount(value),{code:'official_count_unverified'});
});
test('lock prevents a second runner and checks release ownership',async t => {
  const {config} = await fixture(t);
  const release = await acquireLock(config.workDirectory,'fixture-owner');
  await assert.rejects(acquireLock(config.workDirectory),{code:'runner_already_active'});
  await release();
  const releaseAgain = await acquireLock(config.workDirectory,'second-owner');
  await releaseAgain();
});
test('logs and journals exclude raw error text, tokens, signed URLs, cookies, and passwords',async t => {
  const {config} = await fixture(t),lines = [];
  safeLog('stopped',{code:'safe_code',jobId:'fixture',message:'SECRET!',password:'SECRET!',cookies:'SECRET!',token:'SECRET!',state:'failed'},line=>lines.push(line));
  assert.equal(lines.join('').includes('SECRET!'),false);
  const directory = path.join(config.workDirectory,'fixture'),files = await filesFixture(directory);
  await writeJournal(directory,{jobId:'fixture',state:'collected',files:files.map(file=>({...file,token:'SECRET!',signedUrl:'SECRET!'})),
    collectionManifest:manifest(files),expectedRowCount:3,leaseToken:'SECRET!',cookies:'SECRET!',password:'SECRET!'});
  assert.equal((await fs.readFile(path.join(directory,'journal.json'),'utf8')).includes('SECRET!'),false);
});
test('legacy XLS bytes retain extra columns and validate existing full-source parser without rewriting',async t => {
  const {directory} = await fixture(t),files = await filesFixture(path.join(directory,'xls'),{xls:true});
  const hashes = files.map(file=>file.sha256);
  const checked = await validateOriginalFiles(files,3);
  assert.equal(checked.rowCount,3);
  for (const [index,file] of files.entries()) assert.equal(digest(await fs.readFile(file.localPath)),hashes[index]);
  const workbook = XLSX.read(await fs.readFile(files[0].localPath),{type:'buffer'});
  assert.equal(workbook.Sheets[workbook.SheetNames[0]].Y2.v,'원본 유지');
  await assert.rejects(validateOriginalFiles(files,4),{code:'official_source_validation_failed'});
  await fs.appendFile(files[0].localPath,'tampered');
  await assert.rejects(validateOriginalFiles(files,3),{code:'local_artifact_digest_mismatch'});
});
test('failed second download leaves no collected manifest and does not invent a third part',async t => {
  const {config} = await fixture(t),context = fakeContext();
  await assert.rejects(collectOfficial(config,{jobId:'missing-part',openBrowser:async()=>context,prepare:async()=>3,
    captureDownloads:async(_page,directory)=>{
      await fs.writeFile(path.join(directory,'incomplete-first.csv'),sourceBytes(1));
      throw new SyncError('incomplete_official_download');
    }}),{code:'incomplete_official_download'});
  assert.equal(context.closed,1);
  const journal = await readJournal(path.join(config.workDirectory,'missing-part'));
  assert.equal(journal.state,'failed'); assert.equal(journal.files.length,0); assert.equal(journal.collectionManifest,undefined);
});
test('completed journal retries reuse the same raw bytes and revalidate hashes instead of downloading again',async t => {
  const {config} = await fixture(t),directory = path.join(config.workDirectory,'resume-job'),files = await filesFixture(directory);
  await writeJournal(directory,{jobId:'resume-job',state:'collected',expectedRowCount:3,files,collectionManifest:manifest(files)});
  const result = await collectOfficial(config,{jobId:'resume-job',openBrowser:async()=>{throw Error('must not open browser');}});
  assert.equal(result.resumed,true);
  await fs.appendFile(files[1].localPath,'changed');
  await assert.rejects(collectOfficial(config,{jobId:'resume-job'}),{code:'local_artifact_digest_mismatch'});
});
test('journal cannot substitute a different row count or manifest for already collected raw bytes',async t => {
  const {config} = await fixture(t),directory = path.join(config.workDirectory,'journal-mismatch'),files = await filesFixture(directory);
  await writeJournal(directory,{jobId:'journal-mismatch',state:'collected',expectedRowCount:3,files,collectionManifest:manifest(files,4)});
  await assert.rejects(collectOfficial(config,{jobId:'journal-mismatch'}),{code:'journal_manifest_mismatch'});
});
test('login or security challenge stops collection without credential extraction',async t => {
  const {config} = await fixture(t);
  const page = {url:()=>config.sourceUrl,locator:selector=>({count:async()=>selector.includes('password') ? 1 : 0,isVisible:async()=>true})};
  await assert.rejects(ensureSession(page,config),{code:'needs_login'});
  assert.equal(typeof page.cookies,'undefined'); assert.equal(typeof page.storageState,'undefined');
});
test('signed upload uses only scoped PUT with immutable raw bytes and never forwards worker credentials',async t => {
  const {directory} = await fixture(t),files = await filesFixture(path.join(directory,'raw')),calls = [];
  const collection = {files,collectionManifest:manifest(files)};
  const transport = new WorkerTransport({apiUrl:'https://project.supabase.co/functions/v1/operations-hub-sellpia-sync',workerToken:'PRIVATE-WORKER',
    fetchImpl:async(url,options)=>{
      calls.push({url,options});
      if (options.method === 'PUT') return response({ok:true});
      const body = JSON.parse(options.body);
      if (body.action === 'upload-init') return response({ok:true,manifest:collection.collectionManifest.files.map(file=>({...file,method:'PUT',
        path:`fixture-job/${file.ordinal}`,signedUrl:`https://project.supabase.co/storage/v1/object/upload/sign/private/fixture-job/${file.ordinal}?token=PRIVATE-SIGNED`}))});
      return response({ok:true,job:{state:'collected'}});
    }});
  await transport.uploadCollection(leaseBinding(claim(),'fixture-worker'),collection);
  const puts = calls.filter(call=>call.options.method==='PUT'); assert.equal(puts.length,3);
  for (const [index,call] of puts.entries()) {
    assert.equal(digest(call.options.body),files[index].sha256);
    assert.deepEqual(call.options.headers,{'content-type':'application/octet-stream','x-upsert':'false','cache-control':'max-age=0'});
    assert.equal(call.options.redirect,'error');
  }
  await assert.rejects(transport.uploadSigned({method:'PUT',path:'fixture',signedUrl:'https://attacker.invalid/storage/v1/object/upload/sign/private/fixture?token=x'},Buffer.from('x')),{code:'invalid_signed_upload_url'});
});
test('upload failure cannot finalize or claim collection completed',async t => {
  const {directory} = await fixture(t),files = await filesFixture(path.join(directory,'raw'));let finalized = false;
  const transport = new WorkerTransport({apiUrl:'https://project.supabase.co/functions/v1/operations-hub-sellpia-sync',workerToken:'fixture',fetchImpl:async(_url,options)=>{
    if (options.method==='PUT') return response({error:'not logged'},503);
    const body = JSON.parse(options.body);
    if (body.action==='upload-finalize') finalized = true;
    return response({ok:true,manifest:manifest(files).files.map(file=>({...file,method:'PUT',path:`job/${file.ordinal}`,
      signedUrl:`https://project.supabase.co/storage/v1/object/upload/sign/private/job/${file.ordinal}?token=x`}))});
  }});
  await assert.rejects(transport.uploadCollection(leaseBinding(claim(),'fixture-worker'),{files,collectionManifest:manifest(files)}),{code:'staging_upload_failed'});
  assert.equal(finalized,false);
});
test('lease loss during collection aborts before staging upload and does not report stale ownership',async t => {
  const {config} = await fixture(t);let uploads = 0,reports = 0;
  const transport = {report:async()=>{reports++;},heartbeat:async()=>{throw new SyncError('lease_lost','blocked');},uploadCollection:async()=>{uploads++;}};
  await assert.rejects(runClaimedJob(claim(),config,transport,{log:()=>{},collect:async(_config,{signal})=>{
    await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
    return {expectedRowCount:3};
  }}),{code:'lease_lost'});
  assert.equal(uploads,0); assert.equal(reports,1);
});
test('runner interoperates with actual queue HTTP protocol, numeric leases, signed upload and server digest verification',async t => {
  const {config} = await fixture(t),objects = new Map();
  const store = new MemoryQueueStore(),queue = new QueueProtocol(store);
  const requestId = '00000000-0000-4000-8000-000000000001';
  await queue.dispatch('enqueue',{requestId,mode:'full'},{kind:'browser'});
  const token = 'synthetic-worker-credential-for-runner-tests';
  const storage = {assertPrivate:async()=>{},assertObjects:async()=>{},
    signUpload:async p=>({signedUrl:`https://project.supabase.co/storage/v1/object/upload/sign/private/${p}?token=synthetic`,token:'synthetic'}),
    readBytes:async p=>{const value=objects.get(p);assert.ok(value);return value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength);}};
  const handler = createHandler({queue,store,storage,guardSession:async()=>true,workerToken:token,workerId:config.workerId,enabled:true});
  const transport = new WorkerTransport({apiUrl:'https://project.supabase.co/functions/v1/operations-hub-sellpia-sync',workerToken:token,
    fetchImpl:async(url,options)=>{
      if(options.method==='PUT'){
        assert.equal(options.headers['x-sellpia-sync-worker-token'],undefined);
        objects.set(new URL(url).pathname.split('/private/')[1],Buffer.from(options.body));
        return response({ok:true});
      }
      return handler(new Request(url,options));
    }});
  const owned = await transport.claim(config.workerId);
  assert.equal(typeof owned.leaseExpiresAt,'number');
  const completed = await runClaimedJob(owned,config,transport,{log:()=>{},collect:async(_config,{jobId})=>{
    const directory=path.join(config.workDirectory,jobId),files=await filesFixture(directory);
    await validateOriginalFiles(files,3);
    return {jobId,directory,files,expectedRowCount:3,collectionManifest:manifest(files)};
  }});
  assert.equal(completed.job.state,'collected');assert.equal(completed.job.applyProduction,false);
  assert.equal(objects.size,3);assert.equal(completed.job.collectionManifest.expectedRowCount,3);
  assert.equal((await readJournal(path.join(config.workDirectory,owned.job.jobId))).state,'uploaded');
});
test('manual login resolves when the last page closes even without a context-close event',async()=>{
  const context=new EventEmitter(),pages=[new EventEmitter(),new EventEmitter()];let closed=0;
  context.pages=()=>pages.filter(page=>!page.closed);pages.forEach(page=>{page.isClosed=()=>!!page.closed;});
  const waiting=waitForManualLoginClose(context).then(()=>{closed++;});
  pages[0].closed=true;pages[0].emit('close');await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,0);
  pages[1].closed=true;pages[1].emit('close');await waiting;assert.equal(closed,1);assert.equal(context.listenerCount('page'),0);
});
test('interactive collection flags are explicit and repeat count is bounded',()=>{
  assert.deepEqual(parseArguments(['collect','--config','fixture.json','--login','--repeat','2']),{
    command:'collect',configPath:'fixture.json',once:false,manualLogin:true,repeat:2});
  assert.throws(()=>parseArguments(['worker','--config','fixture.json','--repeat','2']));
  assert.throws(()=>parseArguments(['collect','--config','fixture.json','--repeat','4']));
});
test('safe prepare diagnostics identify the failing stage without exposing raw authentication errors',async t=>{
  const {config}=await fixture(t),steps=[];
  await assert.rejects(prepareOfficialDownload({goto:async()=>{throw Error('PRIVATE_AUTH_VALUE');}},config,undefined,
    async name=>steps.push(name)),{code:'prepare_navigation_failed'});
  assert.deepEqual(steps,['navigation']);assert.equal(JSON.stringify(steps).includes('PRIVATE_AUTH_VALUE'),false);
});
test('manual authentication observes logout marker then navigates in the same context without clicking logout or reading credentials',async t=>{
  const {config}=await fixture(t);let authenticated=false,currentUrl='https://curiouswiz.sellpia.com/auth_fail.html',navigations=0;
  const page={isClosed:()=>false,url:()=>currentUrl,getByRole:()=>({isVisible:async()=>authenticated,click:()=>{throw Error('must not click logout');}}),
    goto:async target=>{assert.equal(target,config.sourceUrl);navigations++;currentUrl=target;},
    locator:selector=>({count:async()=>0,isVisible:async()=>authenticated&&selector===config.ui.authenticatedSelector})};
  const waiting=waitForManualAuthentication({pages:()=>[page]},config,undefined,{pollMs:10});
  setTimeout(()=>{authenticated=true;currentUrl='https://curiouswiz.sellpia.com/dashboard.html';},20);
  assert.equal(await waiting,page);assert.equal(navigations,1);
});
test('two independent collections reuse one caller-owned browser context and preserve both manifests',async t=>{
  const {config}=await fixture(t),context=fakeContext();let opens=0;
  const dependencies={browserContext:context,openBrowser:async()=>{opens++;throw Error('must not open another context');},prepare:async()=>3,
    captureDownloads:async(_page,directory)=>filesFixture(directory)};
  const first=await collectOfficial(config,{...dependencies,jobId:'same-context-first'});
  const second=await collectOfficial(config,{...dependencies,jobId:'same-context-second'});
  assert.equal(first.state,'collected');assert.equal(second.state,'collected');assert.equal(opens,0);assert.equal(context.closed,0);
  assert.notEqual(first.directory,second.directory);assert.deepEqual(first.collectionManifest,second.collectionManifest);
});
test('single-trigger extra download is rejected and all downloads are cancelled without a completed manifest',async t=>{
  const {config,directory}=await fixture(t),page=new EventEmitter();let cancelled=0;
  page.locator=()=>({innerText:async()=> '20003개'});
  page.getByRole=()=>({getByRole:()=>({click:async()=>{
    for(let ordinal=1;ordinal<=4;ordinal++)page.emit('download',{suggestedFilename:()=>`synthetic-${ordinal}.csv`,
      saveAs:async localPath=>fs.writeFile(localPath,sourceBytes(ordinal)),failure:async()=>null,cancel:async()=>{cancelled++;}});
  }})});
  await assert.rejects(captureGridDownloads(page,directory,config,20003),{code:'unexpected_official_download'});
  assert.equal(cancelled,4);assert.equal(page.listenerCount('download'),0);
});
test('actual browser single-trigger grid export preserves double-BOM bytes and aliases three identical suggested names in row order',async t => {
  const {config} = await fixture(t),{chromium} = require('playwright');
  const browser = await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})});
  t.after(()=>browser.close());
  const context = await browser.newContext({acceptDownloads:true});
  const expectedRowCount=20003;
  const originalName='synthetic-same-second.csv';
  const files = [[1,10000],[10001,20000],[20001,20003]].map(([start,end])=>({name:originalName,
    base64:Buffer.from(`\uFEFF\uFEFF${headers.map(header=>`"${header}"`).join(',')}\r\n${Array.from({length:end-start+1},(_v,n)=>values(start+n).join(',')).join('\r\n')}\r\n`).toString('base64')}));
  await context.route('https://curiouswiz.sellpia.com/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><meta charset="utf-8">
    <div id="authenticated">합성 로그인 상태</div><select id="search_type"><option value="1">상품</option><option value="8">전체</option></select>
    <input id="search_key" value="stale"><input id="txt_search" value="stale">
    ${['market_type_req','prd_cate_req','prd_type_req'].map(id=>`<select id="${id}"><option value="old">old filter</option><option value="">전체</option></select>`).join('')}
    ${['group_by_ptitle','select_all','grid_output_selected_chk_pager'].map(id=>`<input type="checkbox" id="${id}" checked>`).join('')}
    <input type="checkbox" id="soldout_include"><input type="checkbox" id="discontinued_include"><button id="search_bt">검색</button>
    <button id="warning" hidden>Ok</button><span id="official-count">20003개</span><div class="loading-indicator2" hidden>조회 중</div><div class="loading-fade2" hidden>조회 중</div><div id="more_searh_PNL"></div>
    <span title="CSV" id="show-download">CSV</span><section role="dialog" aria-label="그리드 다운로드 v1.1.14" hidden>
    <select id="format"><option value="csv">CSV</option><option value="csv4">CSV UTF8</option></select>
    <select id="columns"><option value="">현재 컬럼</option><option value="all">모든 컬럼</option></select><ul class="grid-download-selected-columns"></ul>
    ${['선택된 항목만 다운로드','컬럼 포멧 적용(Beta)','보이는 내역대로 다운로드','그룹핑 합계행 추가'].map(title=>`<input type="checkbox" data-title="${title}" checked>`).join('')}
    <button id="make-download">그리드 다운로드</button></section><script>
    let acknowledged=false;
    document.querySelector('#search_type').onchange=()=>{document.querySelector('#search_key').hidden=true;document.querySelector('#warning').hidden=false;document.querySelector('#search_bt').disabled=true;};
    document.querySelector('#warning').onclick=()=>{acknowledged=true;document.querySelector('#warning').hidden=true;document.querySelector('#search_bt').disabled=false;};
    document.querySelector('#search_bt').onclick=()=>{
      if(!acknowledged||document.querySelector('#search_type').value!=='8'||!document.querySelector('#soldout_include').checked||!document.querySelector('#discontinued_include').checked)throw Error('scope');
      if(['search_key','txt_search'].some(id=>document.getElementById(id).value)||['market_type_req','prd_cate_req','prd_type_req'].some(id=>document.getElementById(id).value)||['group_by_ptitle','select_all','grid_output_selected_chk_pager'].some(id=>document.getElementById(id).checked))throw Error('stale filters');
      document.querySelector('#search_bt').disabled=true;document.querySelectorAll('.loading-indicator2,.loading-fade2').forEach(x=>x.hidden=false);
      setTimeout(()=>{document.querySelector('#official-count').textContent='20003개';document.querySelector('#search_bt').disabled=false;document.querySelectorAll('.loading-indicator2,.loading-fade2').forEach(x=>x.hidden=true);},250);
    };
    document.querySelector('#show-download').onclick=()=>document.querySelector('[role=dialog]').hidden=false;
    document.querySelector('#columns').onchange=()=>{document.querySelector('.grid-download-selected-columns').replaceChildren(...${JSON.stringify(headers)}.map(header=>{const li=document.createElement('li');li.textContent=header;return li;}));};
    document.querySelector('#make-download').onclick=()=>{if(document.querySelector('#format').value!=='csv4'||document.querySelector('#columns').value!=='all'||[...document.querySelectorAll('[data-title]')].some(x=>x.checked))throw Error('wrong export');
      const files=${JSON.stringify(files)};[2,0,1].forEach((fileIndex,index)=>setTimeout(()=>{const file=files[fileIndex],bytes=Uint8Array.from(atob(file.base64),x=>x.charCodeAt(0));const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([bytes]));link.download=file.name;document.body.append(link);link.click();link.remove();},index*50));};</script>`}));
  const result = await collectOfficial({...config,timeoutMs:10000},{jobId:'browser-fixture',openBrowser:async()=>context});
  assert.equal(result.expectedRowCount,expectedRowCount);assert.equal(result.collectionManifest.files.length,3);
  assert.deepEqual(result.files.map(file=>file.rowCount),[10000,10000,3]);
  assert.deepEqual(result.files.map(file=>file.name),[1,2,3].map(ordinal=>`part-${ordinal}-${originalName}`));
  assert.deepEqual(result.files.map(file=>file.originalName),[originalName,originalName,originalName]);
  const journal=await readJournal(result.directory);
  assert.deepEqual(journal.files.map(file=>file.originalName),[originalName,originalName,originalName]);
  assert.deepEqual(journal.collectionManifest.files.map(file=>file.name),result.files.map(file=>file.name));
  for(const [index,file] of result.files.entries()) assert.equal(file.sha256,digest(Buffer.from(files[index].base64,'base64')));
});
