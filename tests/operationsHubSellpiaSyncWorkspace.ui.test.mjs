import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url),{chromium}=require('playwright');
const html=fs.readFileSync(path.join(repo,'mockups/operations-hub/index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
const app=fs.readFileSync(path.join(repo,'mockups/operations-hub/app.js'),'utf8');
const actualMount=app.slice(app.indexOf('const sellpiaSyncController ='),app.indexOf('function isPatchableUploadSource'));
assert.ok(actualMount.includes('SystemV3SellpiaSyncWorkspace?.mount'));
let browser;
test.before(async()=>{browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})});});
test.after(async()=>{await browser?.close();});
async function fixture(t,options={}){
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  t.after(async()=>{assert.deepEqual(errors,[]);await page.close();});
  await page.route('**/*',route=>route.request().url()==='http://127.0.0.1:9133/hub'?route.fulfill({contentType:'text/html',body:html}):route.abort());
  await page.goto('http://127.0.0.1:9133/hub');
  await page.evaluate(()=>{document.body.classList.remove('operations-auth-locked');const shell=document.getElementById('operations-app-shell');shell.hidden=false;shell.inert=false;shell.setAttribute('aria-hidden','false');document.getElementById('operations-auth-gate').hidden=true;document.getElementById('upload').style.display='block';});
  await page.addStyleTag({path:path.join(repo,'mockups/operations-hub/sellpia-sync-workspace.css')});
  for(const style of ['style.css','ui-scale-base.css','ui-scale-workspaces.css'])await page.addStyleTag({path:path.join(repo,'mockups/operations-hub',style)});
  for(const file of ['sellpia-source-parser.js','sellpia-sync-contract.js','sellpia-sync-client.js','sellpia-sync-workspace.js'])await page.addScriptTag({path:path.join(repo,'mockups/operations-hub',file)});
  await page.evaluate(async options=>{
    const headers=['#','상품코드','자사코드','상품명','옵션명','재고','가용재고','품절','단종','판매가','안전재고','매입처코드','매입처','매입처그룹','매입처주소','상가명','매입처전화','매입상품명','매입옵션명','매입가','수수료','매입처부가세','발주단위','최소발주수량'];
    const row=n=>headers.map(k=>({'#':n,'상품코드':`${1000+n}-1`,'상품명':'합성 상품','옵션명':'합성 옵션','재고':3,'가용재고':2,'판매가':100,'안전재고':0,'매입가':50,'수수료':0,'발주단위':1,'최소발주수량':1}[k]??'')).join(',');
    const files=[1,2,3].map(n=>new File([headers.join(',')+'\n'+row(n)+'\n'],`part-${n}.csv`,{type:'text/csv'}));
    const manifest={source:'sellpia',collectionMode:'official_download',mode:'full',includeAll:true,filters:[],expectedRowCount:3,files:[]};
    for(const [i,f]of files.entries()){const hash=await crypto.subtle.digest('SHA-256',await f.arrayBuffer());manifest.files.push({ordinal:i+1,name:f.name,size:f.size,sha256:[...new Uint8Array(hash)].map(v=>v.toString(16).padStart(2,'0')).join('')});}
    const baseline=(await SystemV3SellpiaSourceParser.parseSellpiaFiles(files,{mode:'full'})).rows;baseline[0].stock=2;
    const snapshotId='11111111-1111-4111-8111-111111111111';let job,statusCalls=0;
    window.calls=[];window.productionCalls=0;
    window.SystemV3Data={
      loadLatestSellpiaOriginalStatus:async()=>({snapshotId,boundary:'signed-read-v1'}),
      sellpiaSyncRequest:async(action,body)=>{window.calls.push({action,body});if(action==='enqueue'){if(options.missingEndpoint)throw Error('동기화 서버가 아직 배포되지 않았습니다.');job={jobId:'22222222-2222-4222-8222-222222222222',requestId:body.requestId,selectedFields:body.selectedFields,mode:body.mode,baselineSnapshotId:snapshotId,applyProduction:false,state:'queued'};return {job};}if(action==='status')return {job:{...job,state:options.needsLogin?'needs_login':++statusCalls===1?'collecting':'collected'}};return {valid:true};},
      loadSellpiaSyncArtifacts:async()=>({files,manifest}),
      loadSellpiaSyncBaselineRows:async()=>({snapshotId,rows:baseline}),
      uploadSellpiaSnapshot:async()=>{window.productionCalls++;throw Error('운영 반영 금지');}
    };
  },options);
  await page.addScriptTag({content:'const liveData=window.SystemV3Data;\n'+actualMount});
  return page;
}
test('actual Hub panel and app binding complete one click preview without manual file selection or production writes',async t=>{
  const page=await fixture(t);
  // The deployed worker contract collects the complete source. Keep unsupported
  // partial automation out of this control while preserving manual partial upload.
  assert.deepEqual(await page.locator('#sellpia-sync-mode option').evaluateAll(es=>es.map(e=>e.value)),['full']);
  assert.equal(await page.locator('input[name="seller-upload-mode"][value="patch"]').count(),1);
  await page.locator('#sellpia-sync-start').click();
  await page.waitForFunction(()=>document.getElementById('sellpia-sync-result').dataset.stage==='previewed');
  assert.equal(await page.locator('#mock-file').evaluate(el=>el.files.length),0);
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.action==='enqueue').length),1);
  assert.equal(await page.evaluate(()=>productionCalls),0);
  assert.match(await page.locator('#sellpia-sync-result').innerText(),/변경 SKU\s+1/);
  assert.match(await page.locator('#sellpia-sync-result').innerText(),/동일값 SKU\s+2/);
  assert.match(await page.locator('#sellpia-sync-result').innerText(),/전체 교체/);
  assert.equal(await page.locator('#sellpia-sync-apply').isDisabled(),true);
  assert.equal(await page.locator('#mock-upload-btn').count(),1);
  if(process.env.SELLPIA_SYNC_QA_SCREENSHOT)await page.locator('#sellpia-sync-panel').screenshot({path:process.env.SELLPIA_SYNC_QA_SCREENSHOT});
});
test('login expiration displays the required PC reauthentication step and never offers apply',async t=>{
  const page=await fixture(t,{needsLogin:true});await page.locator('#sellpia-sync-start').click();await page.waitForFunction(()=>document.getElementById('sellpia-sync-result').dataset.stage==='needs_login');assert.match(await page.locator('#sellpia-sync-result').innerText(),/회사 PC.*로그인/);assert.equal(await page.evaluate(()=>productionCalls),0);assert.equal(await page.locator('#sellpia-sync-apply').isDisabled(),true);
});
test('undeployed queue gives an actionable failure; manual uploads and seller selection remain available',async t=>{
  const page=await fixture(t,{missingEndpoint:true});await page.locator('#sellpia-sync-start').click();await page.waitForFunction(()=>document.getElementById('sellpia-sync-result').dataset.stage==='failed');assert.match(await page.locator('#sellpia-sync-result').innerText(),/아직 배포/);assert.equal(await page.locator('#sellpia-sync-start').isDisabled(),false);await page.locator('#source-select').selectOption('ably');assert.equal(await page.locator('#sellpia-sync-panel').isHidden(),true);assert.equal(await page.locator('#mock-file').count(),1);assert.equal(await page.evaluate(()=>productionCalls),0);
});
