import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const nodeModules=process.env.CODEX_NODE_MODULES;
assert.ok(nodeModules,'CODEX_NODE_MODULES must point to bundled runtime dependencies');
const require=createRequire(path.join(nodeModules,'inventory-tab-browser.cjs'));
const {chromium}=require('playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const xlsxBrowserScript=process.env.XLSX_BROWSER_SCRIPT||path.join(root,'work','inventory-qa','xlsx.full.min.js');
assert.ok(fs.existsSync(xlsxBrowserScript),'XLSX_BROWSER_SCRIPT or work/inventory-qa/xlsx.full.min.js is required for the real Ably workflow path');
const xlsxSource=fs.readFileSync(xlsxBrowserScript,'utf8');
const jszipSource=fs.readFileSync(require.resolve('jszip/dist/jszip.min.js'),'utf8');
const mimeTypes=new Map([
 ['.css','text/css; charset=utf-8'],['.html','text/html; charset=utf-8'],['.js','text/javascript; charset=utf-8'],
 ['.mjs','text/javascript; charset=utf-8'],['.svg','image/svg+xml'],['.woff2','font/woff2']
]);

function createStaticServer(){
 const missing=[];
 const server=http.createServer((request,response)=>{
  let pathname;
  try{pathname=decodeURIComponent(new URL(request.url||'/', 'http://127.0.0.1').pathname);}
  catch{response.writeHead(400).end('Bad request');return;}
  let relative=pathname.replace(/^\/+/,'' );if(!relative||pathname.endsWith('/'))relative+='index.html';
  const candidate=path.resolve(root,relative);
  if(candidate!==root&&!candidate.startsWith(root+path.sep)){response.writeHead(403).end('Forbidden');return;}
  let real;
  try{real=fs.realpathSync(candidate);if(real!==root&&!real.startsWith(root+path.sep))throw Error('outside root');if(!fs.statSync(real).isFile())throw Error('not a file');}
  catch{missing.push(pathname);response.writeHead(404).end('Not found');return;}
  if(request.method!=='GET'&&request.method!=='HEAD'){response.writeHead(405,{allow:'GET, HEAD'}).end();return;}
  response.writeHead(200,{'content-type':mimeTypes.get(path.extname(real).toLowerCase())||'application/octet-stream','cache-control':'no-store','x-content-type-options':'nosniff'});
  if(request.method==='HEAD')response.end();else fs.createReadStream(real).pipe(response);
 });
 return {server,missing};
}

async function listen(server){
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 return `http://127.0.0.1:${server.address().port}`;
}

test('inventory page moves the live export workspace and preserves stock-only requests offline',async t=>{
 const {server,missing}=createStaticServer();
 const origin=await listen(server);
 const browser=await chromium.launch({channel:'msedge',headless:true});
 t.after(async()=>{await browser.close();if(server.listening){server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}});
 const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true}),pageErrors=[],consoleErrors=[],externalRequests=[],productionRequests=[];
 page.setDefaultTimeout(8000);
 page.on('pageerror',error=>pageErrors.push(error.message));
 page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
 page.on('requestfailed',request=>{if(new URL(request.url()).origin===origin)pageErrors.push(`local request failed: ${request.method()} ${new URL(request.url()).pathname}`);});
 await page.addInitScript(()=>{try{sessionStorage.removeItem('system-v3-operations-session-v1');}catch{}});
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin===origin){await route.continue();return;}
  if(url.hostname==='cdn.jsdelivr.net'&&url.pathname.includes('@supabase/supabase-js')){
   await route.fulfill({status:200,contentType:'application/javascript',body:`window.supabase={createClient:function(){return {rpc:async function(){return {data:null,error:{message:'offline test stub'}}},from:function(){const query={select:function(){return query},eq:function(){return query},in:function(){return query},overlaps:function(){return query},contains:function(){return query},order:function(){return query},limit:function(){return query},range:function(){return Promise.resolve({data:[],error:null,count:0})},then:function(resolve,reject){return Promise.resolve({data:[],error:null,count:0}).then(resolve,reject)}};return query}}}};`});return;
  }
  if(url.hostname==='cdn.jsdelivr.net'&&url.pathname.includes('/xlsx@')){await route.fulfill({status:200,contentType:'application/javascript',body:xlsxSource});return;}
  if(url.hostname==='cdn.jsdelivr.net'&&url.pathname.includes('/jszip@')){await route.fulfill({status:200,contentType:'application/javascript',body:jszipSource});return;}
  if(url.hostname==='cdnjs.cloudflare.com'){await route.fulfill({status:200,contentType:'text/css',body:''});return;}
  if(url.hostname==='supabase.co'||url.hostname.endsWith('.supabase.co'))productionRequests.push(`${route.request().method()} ${url.origin}${url.pathname}`);
  else externalRequests.push(`${route.request().method()} ${url.origin}${url.pathname}`);
  await route.abort('blockedbyclient');
 });

 await page.goto(`${origin}/mockups/operations-hub/`,{waitUntil:'load'});
 assert.equal(await page.locator('#operations-auth-gate').isVisible(),true,'the production login gate remains visible on the real page');
 assert.equal(await page.locator('#operations-app-shell').getAttribute('aria-hidden'),'true');
 assert.equal(await page.locator('#operations-app-shell').evaluate(element=>element.inert),true);
 // Test-only reveal of the real shell; do not create an auth session or call login.
 await page.evaluate(()=>{
  document.getElementById('operations-auth-gate').hidden=true;
  const shell=document.getElementById('operations-app-shell');shell.inert=false;shell.removeAttribute('inert');shell.setAttribute('aria-hidden','false');
  document.body.classList.remove('operations-auth-locked');
 });
 await page.locator('.nav-item[data-page="matching"]').waitFor({state:'visible'});
 assert.equal(await page.locator('.nav-item[data-page="inventory"]').isVisible(),true,'new Inventory entry renders in the production sidebar');
 await page.locator('.nav-item[data-page="jobs"]').click();
 await page.locator('#export-workflow-v2').waitFor({state:'attached'});
 await page.evaluate(()=>{window.__inventoryWorkflowNode=document.getElementById('export-workflow-v2');});

 await page.evaluate(()=>{
  const data=window.SystemV3Data;
  window.SystemV3Data={...data,
   loadTagCatalog:async()=>({rows:[{tag_id:'fixture-tag',tag_name:'fixture tag',option_count:2}]}),
   loadTagMembers:async({tagId})=>({count:2,rows:tagId==='fixture-tag'?[{sellpia_sku_code:'TAG-2'},{sellpia_sku_code:'TAG-1'}]:[]}),
   loadPlayautoSellpiaCatalog:async()=>[{sellpia_sku_code:'10000-1',sellpia_product_code:'10000',sellpia_product_name:'fixture',sellpia_option_name:'별',own_sku:'fixture'}],
   loadCarrierSellerMappings:async()=>({rows:[]}),
   loadSellpiaStockSourcesForExport:async({skus})=>{
    window.__inventoryStockReads??=[];window.__inventoryStockReads.push([...skus]);
    return {snapshotId:'fixture-stock',rows:[{sku:'10000-1',sellpia_current_stock:12,sellpia_available_stock:-6}],bySku:new Map([['10000-1',{sellpia_current_stock:12,sellpia_available_stock:-6}]])};
   },
   recordStockExportAudit:async args=>{window.__inventoryStockAudit=args;return {ok:true};}
  };
  window.HubMatrixShadowEnabled=false;
  window.__inventoryBridgeCalls=[];window.__inventoryBridgeDelay=false;window.__lastInventoryFingerprint='';
  const record=(kind,args)=>window.__inventoryBridgeCalls.push({kind,source:args.source,skus:args.skus==null?null:[...args.skus],stockSource:args.stockSource??null,mode:args.mode??null,expectedPlanFingerprint:args.expectedPlanFingerprint??null});
  window.SystemV3SellerExportBridge={
   previewStockOnly:async args=>{record('preview',args);if(window.__inventoryBridgeDelay){window.__inventoryBridgeDelay=false;await new Promise(resolve=>window.__finishInventoryPreview=resolve);}const planFingerprint=`fixture-plan-${window.__inventoryBridgeCalls.length}`;window.__lastInventoryFingerprint=planFingerprint;return {planFingerprint,stockSource:args.stockSource,plans:[{preview:[]}],diagnostics:{sku_count:args.skus?.size||0,query_count:0}};},
   runStockOnly:async args=>{record('run',args);return {title:'Fixture output',progressDetail:'Offline bridge stub',diagnostics:{sku_count:args.skus?.size||0,query_count:0}};}
  };
 });
 await page.locator('[data-standard-price-mode="ably"]').selectOption('sellpia_source');
 await page.evaluate(()=>document.querySelector('.nav-item[data-page="inventory"]').click());
 await page.waitForFunction(()=>document.querySelector('#inventory')?.classList.contains('active-page'));
 await page.waitForFunction(()=>document.querySelector('#export-workflow-v2')?.parentElement?.id==='inventory-export-host');
 assert.equal(await page.locator('#jobs .export-hub').count(),0,'moving the shared workspace does not recreate the legacy Jobs exporter');
 assert.equal(await page.locator('#inventory h2').textContent(),'재고 관리');
 assert.equal(await page.locator('#export-workflow-v2').count(),1);
 assert.equal(await page.locator('#inventory-export-host #export-workflow-v2').count(),1);
 assert.equal(await page.evaluate(()=>window.__inventoryWorkflowNode===document.getElementById('export-workflow-v2')),true,'inventory uses the exact same live workspace DOM node');
 assert.equal(await page.locator('#export-workflow-v2 [data-standard-field-mode]').count(),2);
 assert.deepEqual(await page.locator('#export-workflow-v2 [data-standard-field-mode]').evaluateAll(nodes=>nodes.map(node=>node.value)),['stock_only','stock_only'],'inventory entry defaults both standard seller channels to stock-only');
 assert.equal(await page.locator('#export-workflow-v2 [data-ably-field-mode]').inputValue(),'stock_only');
 assert.equal(await page.locator('[data-standard-price-mode="ably"]').inputValue(),'rules','inventory entry resets a previous sellpia-source price mode so the Ably stock workflow remains available');
 assert.deepEqual(await page.locator('[data-inventory-target]').evaluateAll(nodes=>nodes.map(node=>node.checked)),[true,true,true]);
 for(const source of ['smartstore','makeshop','ably'])assert.equal(await page.locator(`[data-seller-panel="${source}"]`).isVisible(),true,`${source} card is visible when selected`);
 await page.locator('[data-inventory-target="makeshop"]').uncheck();
 assert.equal(await page.locator('[data-seller-panel="makeshop"]').isVisible(),false,'global seller target hides its card in inventory view');
 await page.locator('[data-inventory-target="makeshop"]').check();
 assert.equal(await page.locator('[data-seller-panel="makeshop"]').isVisible(),true);

 await page.locator('input[name="inventory-stock-source"][value="stock"]').check();
 assert.deepEqual(await page.locator('#export-workflow-v2 [data-standard-stock-source]').evaluateAll(nodes=>nodes.map(node=>node.value)),['stock','stock']);
 assert.equal(await page.locator('#export-workflow-v2 [data-ably-stock-source]').inputValue(),'stock');
 await page.locator('input[name="inventory-stock-source"][value="available_stock"]').check();
 assert.deepEqual(await page.locator('#export-workflow-v2 [data-standard-stock-source]').evaluateAll(nodes=>nodes.map(node=>node.value)),['available_stock','available_stock']);
 assert.equal(await page.locator('#export-workflow-v2 [data-ably-stock-source]').inputValue(),'available_stock');

 async function previewAndRun(scope,skus,source='smartstore'){
  const mode=page.locator(`[data-seller-scope-mode="${source}"]`);
  await mode.selectOption(scope);
  if(scope==='manual')await page.locator(`[data-seller-scope-manual="${source}"]`).fill(skus.join(', '));
  if(scope==='tag'){
   await page.waitForFunction(()=>document.querySelector('[data-seller-scope-tag="smartstore"] option[value="fixture-tag"]'));
   await page.locator(`[data-seller-scope-tag="${source}"]`).selectOption('fixture-tag');
  }
  const prior=await page.evaluate(()=>window.__inventoryBridgeCalls.length);
  await page.locator(`[data-standard-preview="${source}"]`).click();
  await page.waitForFunction(prior=>window.__inventoryBridgeCalls.length===prior+1,prior);
  await page.locator(`[data-standard-run="${source}"]`).click();
  await page.waitForFunction(prior=>window.__inventoryBridgeCalls.length===prior+2,prior);
  return page.evaluate(prior=>window.__inventoryBridgeCalls.slice(prior),prior);
 }

 const all=await previewAndRun('all',null);
 assert.deepEqual(all.map(call=>[call.kind,call.source,call.skus,call.stockSource,call.mode]),[['preview','smartstore',null,'available_stock','changed_only'],['run','smartstore',null,'available_stock','changed_only']]);
 assert.equal(all[1].expectedPlanFingerprint,all[0].expectedPlanFingerprint||await page.evaluate(()=>window.__lastInventoryFingerprint));
 const manual=await previewAndRun('manual',['SKU-B','SKU-A']);
 assert.deepEqual(manual.map(call=>call.skus),[['SKU-B','SKU-A'],['SKU-B','SKU-A']]);
 assert.equal(manual[1].expectedPlanFingerprint,await page.evaluate(()=>window.__lastInventoryFingerprint));
 const tagged=await previewAndRun('tag',null);
 assert.deepEqual(tagged.map(call=>call.skus),[['TAG-2','TAG-1'],['TAG-2','TAG-1']]);
 assert.equal(tagged[0].stockSource,'available_stock');
 assert.equal(tagged[1].expectedPlanFingerprint,await page.evaluate(()=>window.__lastInventoryFingerprint));
 const otherSource=await previewAndRun('all',null,'makeshop');
 assert.ok(otherSource.every(call=>call.source==='makeshop'),'selected platform is sent through preview and generate');

 // Exercise the actual PlayAuto stock-only file input, parser, preview, and generator with an in-memory fixture.
 const fixtureBytes=await page.evaluate(()=>{
  const row=Array(35).fill('');row[0]='에이블리';row[1]='fixture-account';row[2]='sellpia_10000';row[3]='원본 상품';row[4]='seller-product-1';row[5]=2800;
  row[9]='조합형';row[10]='옵션';row[11]='별';row[16]='sellpia_10000-1';row[17]='sellpia_10000-1';row[21]=0;row[22]=30;row[23]=3;row[24]=10;row[34]='판매중';
  const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([AblyStockExport.headers,row]),'옵션기본');
  return Array.from(new Uint8Array(XLSX.write(book,{bookType:'xlsx',type:'array'})));
 });
 await page.locator('[data-carrier-input="playauto_option"]').setInputFiles({name:'inventory-fixture.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(fixtureBytes)});
 await page.locator('#export-preview-generate').waitFor({state:'visible',timeout:15000});
 assert.match(await page.locator('#export-preview-counts').innerText(),/1/,'Ably stock-only preview renders one selected fixture row');
 assert.match(await page.locator('#export-preview-rows').innerText(),/10000-1/);
 const downloadPromise=page.waitForEvent('download');
 await page.locator('#export-preview-generate').click();
 const download=await downloadPromise;
 assert.match(download.suggestedFilename(),/재고_가용재고기준.*\.xlsx$/,'Ably generates its stock-only workbook from the selected available-stock source');
 assert.deepEqual(await page.evaluate(()=>window.__inventoryStockReads),[['10000-1'],['10000-1']],'Ably preview and generation re-read the same scoped stock source');
 assert.equal(await page.evaluate(()=>window.__inventoryStockAudit?.stockSource),'available_stock');
 assert.equal(await page.evaluate(()=>window.__inventoryStockAudit?.itemCount),1);

 // The original Jobs location sends the same request/output contract as Inventory.
 await page.evaluate(()=>document.querySelector('.nav-item[data-page="jobs"]').click());
 await page.waitForFunction(()=>document.querySelector('#export-workflow-v2')?.parentElement?.id==='jobs');
 assert.equal(await page.evaluate(()=>window.__inventoryWorkflowNode===document.getElementById('export-workflow-v2')),true,'returning to Jobs preserves the same workspace DOM node');
 const jobsAll=await previewAndRun('all',null);
 const payload=call=>({kind:call.kind,source:call.source,skus:call.skus,stockSource:call.stockSource,mode:call.mode});
 assert.deepEqual(jobsAll.map(payload),all.map(payload),'Jobs and Inventory emit identical all-scope preview/generate payloads');
 assert.equal(jobsAll[1].expectedPlanFingerprint,jobsAll[0].expectedPlanFingerprint||await page.evaluate(()=>window.__lastInventoryFingerprint));

 // A busy preview holds the one workspace on Jobs until the operation settles.
 await page.evaluate(()=>{window.__inventoryBridgeDelay=true;});
 const beforeBusy=await page.evaluate(()=>window.__inventoryBridgeCalls.length);
 await page.locator('[data-standard-preview="smartstore"]').click();
 await page.waitForFunction(()=>window.__systemV3DirectExportBusy===true);
 await page.evaluate(()=>document.querySelector('.nav-item[data-page="inventory"]').click());
 await page.waitForFunction(()=>!document.getElementById('inventory-transfer-status').hidden);
 assert.equal(await page.locator('#export-workflow-v2').evaluate(node=>node.parentElement.id),'jobs','workspace stays on Jobs while an export is busy');
 assert.equal(await page.locator('[data-inventory-target]').first().isDisabled(),true);
 await page.evaluate(()=>window.__finishInventoryPreview());
 await page.waitForFunction(()=>window.__systemV3DirectExportBusy===false&&document.querySelector('#export-workflow-v2')?.parentElement?.id==='inventory-export-host');
 assert.equal(await page.locator('#inventory-transfer-status').isHidden(),true);
 assert.equal(await page.evaluate(()=>window.__inventoryBridgeCalls.length),beforeBusy+1);

 await page.evaluate(()=>document.querySelector('.nav-item[data-page="jobs"]').click());
 await page.waitForFunction(()=>document.querySelector('#export-workflow-v2')?.parentElement?.id==='jobs');
 assert.equal(await page.locator('#jobs .page-head').evaluate(head=>head.nextElementSibling.id),'export-workflow-v2','same workspace returns directly below the Jobs header');
 assert.equal(await page.locator('#export-workflow-v2 [data-standard-preview="smartstore"]').isVisible(),true,'original export controls remain available on Jobs');
 await page.evaluate(()=>document.querySelector('.nav-item[data-page="inventory"]').click());
 await page.waitForFunction(()=>document.querySelector('#inventory')?.classList.contains('active-page'));
 for(const input of await page.locator('[data-inventory-target]').all())if(!(await input.isChecked()))await input.check();
 await page.locator('input[name="inventory-stock-source"][value="available_stock"]').check();
 assert.equal(await page.locator('.nav-item[data-page="matching"]').isVisible(),true,'Matrix navigation remains available alongside the new tab');

 assert.deepEqual(missing,[],'all local page assets load');
 assert.deepEqual(pageErrors,[],'the real page has no uncaught browser errors');
 assert.deepEqual(consoleErrors,[],'the real page has no console errors');
 assert.deepEqual(productionRequests,[],'no Supabase project endpoint was contacted');
 assert.deepEqual(externalRequests,[],'all external network requests are blocked or locally stubbed');
 if(process.env.INVENTORY_QA_OUTPUT){
  fs.mkdirSync(process.env.INVENTORY_QA_OUTPUT,{recursive:true});
  await page.screenshot({path:path.join(process.env.INVENTORY_QA_OUTPUT,'inventory-tab-browser.png'),fullPage:true});
 }
 console.log('PASS real Operations Hub inventory navigation, shared export workspace, stock source propagation, preview/generate scope parity, and busy-state behavior');
});
