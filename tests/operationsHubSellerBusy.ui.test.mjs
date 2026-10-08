import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';

const require=createRequire(process.env.CODEX_NODE_MODULES?`${process.env.CODEX_NODE_MODULES}/seller-busy.cjs`:import.meta.url);
const {chromium}=require('playwright');
const workflow=fs.readFileSync(new URL('../mockups/operations-hub/seller-file-workflow-v2.js',import.meta.url),'utf8');
const chooseRadio=(page,selector,value)=>page.locator(selector).locator('..').locator(`.seller-choice-options input[type="radio"][value="${value}"]`).check();
let browser;
test.before(async()=>{browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:process.platform==='win32'?{channel:'msedge'}:{})});});
test.after(async()=>{await browser?.close();});

async function fixture(t){
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 t.after(async()=>{assert.deepEqual(errors,[]);await page.close();});
 page.on('pageerror',error=>errors.push(error.message));
 await page.setContent('<!doctype html><main><div id="jobs" class="page"><div class="page-head"><h2>jobs</h2></div></div></main>');
 await page.evaluate(()=>{
  window.pendingPreviews=[];window.pendingRuns=[];window.ablyReads=[];window.pendingAblyReads=[];window.ablyBuilds=[];window.downloads=[];window.stockAudits=[];
  if(!window.crypto.randomUUID)Object.defineProperty(window.crypto,'randomUUID',{value:()=>`fixture-${Date.now()}`});
  window.ablyStock=9;window.ablySnapshot='snapshot-1';window.decisionProof='proof-1';
  const summary={selectedSkuCount:1,matchedOptionCount:1,changedOptionCount:1,unchangedOptionCount:0,unmatchedSkuCount:0,blockedCount:0,preservedCount:0,outputRowCount:1};
  const delayed=(list,name,args)=>new Promise(resolve=>list.push({name,args,resolve}));
  const preview=name=>args=>delayed(window.pendingPreviews,name,args),run=name=>args=>delayed(window.pendingRuns,name,args);
  window.resolvePreview=(index,fingerprint)=>pendingPreviews[index].resolve({planFingerprint:fingerprint,scopeSummary:summary,diagnostics:{sku_count:1,query_count:1},stockSource:pendingPreviews[index].args.stockSource,plans:[]});
  window.resolveRun=index=>pendingRuns[index].resolve({scopeSummary:summary,title:'fixture XLSX ready'});
  window.SystemV3SellerExportBridge={previewTargetAll:preview('target_all'),previewChangedOnly:preview('changed_only'),previewFullOriginal:preview('full_original'),previewPriceOnly:preview('price_only'),previewStockOnly:preview('stock_only'),runTargetAll:run('target_all'),runChangedOnly:run('changed_only'),runFullOriginal:run('full_original'),runPriceOnly:run('price_only'),runStockOnly:run('stock_only')};
  window.SystemV3Data={
   loadAuxiliarySellerFiles:async()=>({rows:[]}),loadLatestSellerOriginalStatus:async()=>[{source:'smartstore',available:true},{source:'makeshop',available:true}],
   loadTagCatalog:async()=>({rows:[]}),loadPlayautoSellpiaCatalog:async()=>[],loadCarrierSellerMappings:async()=>({rows:[]}),
   loadCurrentPriceDecisions:async()=>({rows:[]}),loadCarrierMatrixTargets:async()=>({rows:[{sku:'SKU-A'}]}),loadAblyCarrierPoliciesForSkus:async()=>({rows:[],fingerprint:'[]'}),
   loadSellpiaStockSourcesForExport:async()=>({snapshotId:window.ablySnapshot,bySku:new Map([['SKU-A',{sellpia_current_stock:window.ablyStock,sellpia_available_stock:window.ablyStock}]])}),
   recordStockExportAudit:async args=>window.stockAudits.push(args)
  };
  window.HubCurrentPriceDecisionResolver={normalize:()=>new Map(),proof:()=>window.decisionProof,attach(){},decisionForMapping:()=>null,assertProof(before,after){if(before!==after)throw Error('current decision changed');}};
  window.HubCurrentPriceExport={carrierPriceState:()=>({safe:true}),matrixPriceTarget:()=>({base:1000,option:50,final:1050}),matrixStockTarget:()=>window.ablyStock};
  window.AblyPriceProjection={resolveCarrierPolicy:()=>({strategy:'legacy_rules',sourceLabel:'fixture'}),projectProductRows(items){for(const item of items){item.target_base_price=1000;item.target_option_price=50;}}};
  window.AblyPlayautoExport={
   async readTemplate(file){window.ablyReads.push(file.name);if(window.deferAblyReads)await new Promise(resolve=>window.pendingAblyReads.push(resolve));return {type:file.name.includes('product')?'product_price_option':'option_price_stock',items:[{source_row_no:2,option_index:0,seller_product_code:'P',seller_option_code:'O',sellpia_product_code:'CATALOG',base_price:1000,option_price:50,sales_quantity:2}]};},
   resolveRows:items=>items.map(item=>({...item,resolution:{sku:'SKU-A',method:'verified_solution_code'}})),
   prepareStockOnlyRow:(item,row)=>({...item,target_stock:row.sellpia_available_stock}),
   buildProductPriceOption:async()=>{window.ablyBuilds.push('product');return new Blob(['fixture']);},buildOptionPriceStock:async()=>{window.ablyBuilds.push('option');return new Blob(['fixture']);}
  };
  window.SystemV3SellerExport={downloadBlob:(blob,name)=>window.downloads.push({name,size:blob.size}),conflictCsv:()=>''};
 });
 await page.addScriptTag({content:workflow});await page.waitForSelector('#export-workflow-v2');
 return page;
}
const primary=(source,action)=>`[data-standard-${action}="${source}"]`;
const card=source=>`[data-standard-source="${source}"]`;
async function dispatchClicks(page,selectors){await page.evaluate(selectors=>{for(const selector of selectors)document.querySelector(selector).dispatchEvent(new MouseEvent('click',{bubbles:true}));},selectors);}
async function controlsLocked(page,source){const controls=await page.locator(`${card(source)} button,${card(source)} input,${card(source)} select,${card(source)} textarea`).evaluateAll(nodes=>nodes.map(node=>({tag:node.tagName,disabled:node.disabled})));assert.ok(controls.length>10);assert.ok(controls.every(node=>node.disabled),`${source} controls must all remain disabled`);}
async function ablyCriteriaLocked(page){
 const selectors=['[data-seller-scope-mode="ably"]','[data-seller-scope-manual="ably"]','[data-seller-scope-tag="ably"]','[data-ably-field-mode]','[data-ably-stock-source]','[data-standard-price-mode="ably"]','[data-standard-output-mode="ably"]'];
 for(const selector of selectors)assert.equal(await page.locator(selector).isDisabled(),true,`${selector} should lock while its preview is pending`);
 for(const selector of ['[data-seller-scope-mode="ably"]','[data-ably-field-mode]','[data-ably-stock-source]','[data-standard-price-mode="ably"]','[data-standard-output-mode="ably"]'])
  assert.equal(await page.locator(selector).locator('..').locator('.seller-choice-options input[type="radio"]').evaluateAll(nodes=>nodes.every(node=>node.disabled)),true,`${selector} radio choices should lock while preview is pending`);
 assert.equal(await page.locator('[data-carrier-pick="playauto_option"]').isDisabled(),true,'advanced file picker locks while preview is pending');
 assert.equal(await page.locator('[data-carrier-input="playauto_option"]').isDisabled(),true,'advanced file input locks while preview is pending');
 assert.equal(await page.locator('[data-ably-standard-preview]').isDisabled(),true);assert.equal(await page.locator('[data-ably-standard-run]').isDisabled(),true);
}
async function ablyCriteriaUnlocked(page){
 for(const selector of ['[data-seller-scope-mode="ably"]','[data-seller-scope-tag="ably"]','[data-ably-field-mode]','[data-ably-stock-source]','[data-standard-output-mode="ably"]','[data-carrier-pick="playauto_option"]','[data-carrier-input="playauto_option"]','[data-ably-standard-preview]','[data-ably-standard-run]'])
  assert.equal(await page.locator(selector).isDisabled(),false,`${selector} should unlock after the Ably job ends`);
}
async function readyPreview(page,source,index,fingerprint){await page.locator(primary(source,'preview')).click();await page.waitForFunction(index=>pendingPreviews.length>index,index);await page.evaluate(({index,fingerprint})=>resolvePreview(index,fingerprint),{index,fingerprint});await page.waitForFunction(source=>document.querySelector(`[data-standard-preview="${source}"]`).disabled===false,source);}
const carrierFile=name=>({name,mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from('UI fixture')});

for(const source of ['smartstore','makeshop']){
 test(`${source} pending ordinary preview blocks duplicate preview and generation without unlocking the card`,async t=>{
  const page=await fixture(t);await page.locator(primary(source,'preview')).click();await page.waitForFunction(()=>pendingPreviews.length===1);
  await controlsLocked(page,source);assert.equal(await page.evaluate(()=>__systemV3DirectExportBusy),true);
  await dispatchClicks(page,[primary(source,'preview'),primary(source,'preview'),primary(source,'run'),primary(source,'run')]);
  await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));
  assert.equal(await page.evaluate(()=>pendingPreviews.length),1);assert.equal(await page.evaluate(()=>pendingRuns.length),0);await controlsLocked(page,source);
  await page.evaluate(()=>resolvePreview(0,'first-fingerprint'));await page.waitForFunction(source=>!document.querySelector(`[data-standard-preview="${source}"]`).disabled,source);
  assert.equal(await page.evaluate(()=>__systemV3DirectExportBusy),false);assert.match(await page.locator(`[data-standard-result="${source}"]`).innerText(),/선택 SKU 1/);
 });

 test(`${source} late preview cannot replace newer criteria or its generation fingerprint`,async t=>{
  const page=await fixture(t);await page.locator(primary(source,'preview')).click();await page.waitForFunction(()=>pendingPreviews.length===1);
  await page.evaluate(source=>{const mode=document.querySelector(`[data-standard-output-mode="${source}"]`);mode.value='changed_only';mode.dispatchEvent(new Event('change',{bubbles:true}));},source);
  assert.equal(await page.evaluate(()=>pendingPreviews[0].args.isCurrent()),false);
  await page.locator(primary(source,'preview')).click();await page.waitForFunction(()=>pendingPreviews.length===2);
  await page.evaluate(()=>resolvePreview(0,'STALE-fingerprint'));await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));await controlsLocked(page,source);
  await page.evaluate(()=>resolvePreview(1,'NEW-fingerprint'));await page.waitForFunction(source=>!document.querySelector(`[data-standard-preview="${source}"]`).disabled,source);
  await page.locator(primary(source,'run')).click();await page.waitForFunction(()=>pendingRuns.length===1);
  assert.deepEqual(await page.evaluate(()=>({name:pendingRuns[0].name,fingerprint:pendingRuns[0].args.expectedPlanFingerprint})),{name:'changed_only',fingerprint:'NEW-fingerprint'});
  await page.evaluate(()=>resolveRun(0));await page.waitForFunction(source=>!document.querySelector(`[data-standard-run="${source}"]`).disabled,source);
 });

 test(`${source} generation holds scope, fields, output and advanced controls until completion and prevents duplicate actions`,async t=>{
  const page=await fixture(t);await readyPreview(page,source,0,'generation-fingerprint');
  await page.locator(primary(source,'run')).click();await page.waitForFunction(()=>pendingRuns.length===1);await controlsLocked(page,source);
  await dispatchClicks(page,[primary(source,'run'),primary(source,'preview'),`[data-standard-full-preview="${source}"]`]);await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));
  assert.equal(await page.evaluate(()=>pendingRuns.length),1);assert.equal(await page.evaluate(()=>pendingPreviews.length),1);await controlsLocked(page,source);
  await page.evaluate(()=>resolveRun(0));await page.waitForFunction(source=>!document.querySelector(`[data-standard-run="${source}"]`).disabled,source);
  assert.equal(await page.locator(`[data-standard-output-mode="${source}"]`).isDisabled(),false);
  await page.locator(primary(source,'run')).click();await page.waitForFunction(source=>!document.querySelector(`[data-standard-run="${source}"]`).disabled,source);
  assert.equal(await page.evaluate(()=>pendingRuns.length),1,'completed generation consumes the old preview');
  assert.match(await page.locator(`[data-standard-result="${source}"]`).innerText(),/미리보기를 먼저 확인/);
 });
}

test('Ably ordinary actions stay visible, use both compatible price-only roles, and open missing/unsupported stock prerequisites',async t=>{
 const page=await fixture(t),ordinaryPreview=page.locator('[data-standard-preview],[data-ably-standard-preview]'),ordinaryRun=page.locator('[data-standard-run],[data-ably-standard-run]');
 assert.equal(await ordinaryPreview.count(),3);assert.equal(await ordinaryRun.count(),3);assert.equal(await page.locator('[data-ably-standard-preview]').evaluate(node=>node.closest('details')===null),true);
 await page.locator('[data-ably-standard-preview]').click();assert.match(await page.locator('[data-ably-action-status]').innerText(),/공식 파일이 없습니다.*고급 기능/);
 assert.equal(await page.locator('[data-standard-source="ably"] .seller-advanced').evaluate(node=>node.open),true);
 await chooseRadio(page,'[data-ably-field-mode]','price_only');await page.locator('[data-carrier-input="playauto_product"]').setInputFiles(carrierFile('product.xlsx'));
 await page.waitForFunction(()=>document.querySelector('[data-ably-action-status]').textContent.includes('판매가 + 옵션가 미리보기 완료'));
 await chooseRadio(page,'[data-ably-field-mode]','stock_only');const productReadCount=await page.evaluate(()=>ablyReads.length);
 await page.locator('[data-carrier-input="playauto_product"]').setInputFiles(carrierFile('product-stock-unsupported.xlsx'));
 assert.equal(await page.evaluate(()=>ablyReads.length),productReadCount,'stock-only never reads a product-price carrier');
 assert.match(await page.locator('[data-ably-action-status]').innerText(),/현재 선택한 필드 모드에 맞지 않습니다/);
 await page.locator('[data-ably-standard-preview]').click();assert.match(await page.locator('[data-ably-action-status]').innerText(),/옵션가 \+ 재고 공식 파일이 없습니다/);
 await chooseRadio(page,'[data-ably-field-mode]','price_only');
 await page.locator('[data-carrier-input="playauto_option"]').setInputFiles(carrierFile('option.xlsx'));await page.waitForFunction(()=>document.querySelector('[data-ably-action-status]').textContent.includes('옵션가 + 재고 미리보기 완료'));
 await page.locator('[data-ably-standard-preview]').click();await page.waitForFunction(()=>ablyReads.length===3);
 assert.deepEqual(await page.evaluate(()=>ablyReads),['product.xlsx','option.xlsx','option.xlsx']);
 await page.waitForFunction(()=>document.querySelector('[data-ably-progress]').dataset.state==='done');
 await chooseRadio(page,'[data-ably-field-mode]','stock_only');
 await page.locator('[data-ably-standard-run]').click();assert.equal(await page.evaluate(()=>downloads.length),0,'criteria invalidation removes the previous compatible preview');
 assert.match(await page.locator('[data-ably-action-status]').innerText(),/미리보기를 먼저 확인/);
 assert.equal(await ordinaryPreview.count(),3);assert.equal(await ordinaryRun.count(),3);
});

test('Ably ordinary generation rechecks the stock snapshot and blocks a changed preview before serialization or download',async t=>{
 const page=await fixture(t);await chooseRadio(page,'[data-ably-field-mode]','stock_only');
 await page.locator('[data-standard-source="ably"] .seller-advanced').evaluate(node=>node.open=true);
 await page.locator('[data-carrier-input="playauto_option"]').setInputFiles(carrierFile('option.xlsx'));await page.waitForFunction(()=>document.querySelector('[data-ably-action-status]').textContent.includes('미리보기 완료'));
 assert.equal(await page.locator('#export-preview-generate').isDisabled(),false);assert.equal(await page.evaluate(()=>ablyReads.length),1);
 await page.evaluate(()=>{window.ablyStock=12;window.ablySnapshot='snapshot-2';});await page.locator('[data-ably-standard-run]').click();
 await page.waitForFunction(()=>document.querySelector('#export-workflow-status').textContent.includes('가격/재고 상태가 변경되었습니다'));
 assert.equal(await page.evaluate(()=>ablyReads.length),2);assert.equal(await page.evaluate(()=>ablyBuilds.length),0);assert.equal(await page.evaluate(()=>downloads.length),0);assert.equal(await page.evaluate(()=>stockAudits.length),0);
});

test('Ably pending preview locks its criteria and advanced picker, leaves cancel enabled, and unlocks on completion',async t=>{
 const page=await fixture(t);await page.locator('[data-standard-source="ably"] .seller-advanced').evaluate(node=>node.open=true);
 await page.evaluate(()=>window.deferAblyReads=true);await page.locator('[data-carrier-input="playauto_option"]').setInputFiles(carrierFile('option-finish.xlsx'));
 await page.waitForFunction(()=>pendingAblyReads.length===1);await ablyCriteriaLocked(page);
 assert.equal(await page.locator('[data-ably-progress-cancel]').isDisabled(),false,'the in-flight job remains cancellable');
 await page.evaluate(()=>pendingAblyReads[0]());await page.waitForFunction(()=>document.querySelector('[data-ably-action-status]').textContent.includes('미리보기 완료'));
 await ablyCriteriaUnlocked(page);assert.equal(await page.locator('[data-ably-progress-cancel]').isDisabled(),true,'cancel is disabled after the job finishes');
});

test('changing Ably field mode while a file read is pending cancels the old job and ignores its late preview',async t=>{
 const page=await fixture(t);await page.locator('[data-standard-source="ably"] .seller-advanced').evaluate(node=>node.open=true);
 await page.evaluate(()=>window.deferAblyReads=true);await page.locator('[data-carrier-input="playauto_option"]').setInputFiles(carrierFile('option-stale.xlsx'));
 await page.waitForFunction(()=>pendingAblyReads.length===1);await ablyCriteriaLocked(page);
 await page.evaluate(()=>{const mode=document.querySelector('[data-ably-field-mode]');mode.value='price_only';mode.dispatchEvent(new Event('change',{bubbles:true}));});
 await ablyCriteriaUnlocked(page);assert.equal(await page.locator('[data-ably-progress-cancel]').isDisabled(),true);
 await page.evaluate(()=>pendingAblyReads[0]());await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));
 assert.equal(await page.locator('#export-preview-v2').isHidden(),true,'the old carrier read cannot expose a preview for stale criteria');
 assert.equal(await page.evaluate(()=>ablyBuilds.length),0);assert.equal(await page.evaluate(()=>downloads.length),0);
 assert.match(await page.locator('[data-ably-action-status]').innerText(),/가격-only/);
});

test('Ably serialization keeps card settings and shared presets locked, then unlocks after success or failure',async t=>{
 const presets='[data-export-field-preset]';
 const prepare=async name=>{
  const page=await fixture(t);await chooseRadio(page,'[data-ably-field-mode]','stock_only');await page.locator('[data-standard-source="ably"] .seller-advanced').evaluate(node=>node.open=true);
  await page.locator('[data-carrier-input="playauto_option"]').setInputFiles(carrierFile(name));await page.waitForFunction(()=>document.querySelector('[data-ably-action-status]').textContent.includes('미리보기 완료'));
  await page.evaluate(()=>{window.AblyPlayautoExport.buildOptionPriceStock=()=>new Promise((resolve,reject)=>{window.pendingBuildStarted=true;window.resolveAblyBuild=()=>resolve(new Blob(['serialized']));window.rejectAblyBuild=()=>reject(Error('fixture serialization failure'));});});
  await page.locator('[data-ably-standard-run]').click();await page.waitForFunction(()=>window.pendingBuildStarted===true);
  await ablyCriteriaLocked(page);assert.deepEqual(await page.locator(presets).evaluateAll(nodes=>nodes.map(node=>node.disabled)),[true,true,true]);
  assert.equal(await page.locator('[data-ably-progress-cancel]').isDisabled(),false,'serialization remains cancellable');
  return page;
 };
 const success=await prepare('option-success.xlsx');await success.evaluate(()=>resolveAblyBuild());
 await success.waitForFunction(()=>downloads.length===1||document.querySelector('[data-ably-progress]').dataset.state==='error');
 assert.equal(await success.evaluate(()=>downloads.length),1,await success.locator('[data-ably-progress-detail]').innerText());await ablyCriteriaUnlocked(success);
 assert.deepEqual(await success.locator(presets).evaluateAll(nodes=>nodes.map(node=>node.disabled)),[false,false,false]);
 assert.equal(await success.locator('[data-ably-progress-cancel]').isDisabled(),true);

 const failure=await prepare('option-failure.xlsx');await failure.evaluate(()=>rejectAblyBuild());
 await failure.waitForFunction(()=>document.querySelector('[data-ably-progress]').dataset.state==='error');await ablyCriteriaUnlocked(failure);
 assert.deepEqual(await failure.locator(presets).evaluateAll(nodes=>nodes.map(node=>node.disabled)),[false,false,false]);
 assert.equal(await failure.locator('[data-ably-progress-cancel]').isDisabled(),true);
});

test('cancelling Ably while stock audit is pending blocks download when the audit later resolves',async t=>{
 const page=await fixture(t);await chooseRadio(page,'[data-ably-field-mode]','stock_only');await page.locator('[data-standard-source="ably"] .seller-advanced').evaluate(node=>node.open=true);
 await page.locator('[data-carrier-input="playauto_option"]').setInputFiles(carrierFile('option-audit-cancel.xlsx'));
 await page.waitForFunction(()=>document.querySelector('[data-ably-action-status]').textContent.includes('미리보기 완료'));
 await page.evaluate(()=>{
  window.AblyPlayautoExport.buildOptionPriceStock=async()=>new Blob(['serialized']);
  window.SystemV3Data.recordStockExportAudit=args=>{window.stockAudits.push(args);return new Promise(resolve=>window.releaseStockAudit=resolve);};
 });
 await page.locator('[data-ably-standard-run]').click();await page.waitForFunction(()=>window.releaseStockAudit);
 await ablyCriteriaLocked(page);assert.equal(await page.locator('[data-ably-progress-cancel]').isDisabled(),false);
 await page.locator('[data-ably-progress-cancel]').click();await ablyCriteriaUnlocked(page);
 await page.evaluate(()=>window.releaseStockAudit({ok:true}));await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));
 assert.equal(await page.evaluate(()=>stockAudits.length),1);assert.equal(await page.evaluate(()=>downloads.length),0,'a cancelled audit continuation cannot download the generated workbook');
 assert.equal(await page.locator('[data-ably-progress]').getAttribute('data-state'),'cancelled');
});

test('an old Ably build rejection after a replacement preview cannot overwrite the new preview state',async t=>{
 const page=await fixture(t);await chooseRadio(page,'[data-ably-field-mode]','stock_only');await page.locator('[data-standard-source="ably"] .seller-advanced').evaluate(node=>node.open=true);
 await page.locator('[data-carrier-input="playauto_option"]').setInputFiles(carrierFile('option-old-build.xlsx'));
 await page.waitForFunction(()=>document.querySelector('[data-ably-action-status]').textContent.includes('미리보기 완료'));
 await page.evaluate(()=>{window.pendingAblyBuilds=[];window.AblyPlayautoExport.buildOptionPriceStock=()=>new Promise((resolve,reject)=>window.pendingAblyBuilds.push({resolve,reject}));});
 await page.locator('[data-ably-standard-run]').click();await page.waitForFunction(()=>pendingAblyBuilds.length===1);await ablyCriteriaLocked(page);
 await page.locator('[data-ably-progress-cancel]').click();await ablyCriteriaUnlocked(page);
 await page.locator('[data-carrier-input="playauto_option"]').setInputFiles(carrierFile('option-new-preview.xlsx'));
 await page.waitForFunction(()=>ablyReads.length===3&&document.querySelector('[data-ably-progress]').dataset.state==='done');
 await page.evaluate(()=>pendingAblyBuilds[0].reject(Error('late old build failure')));await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));
 assert.equal(await page.locator('[data-ably-progress]').getAttribute('data-state'),'done','old rejected serialization must not replace the newer job panel');
 assert.equal(await page.locator('#export-preview-v2').isHidden(),false,'the new preview remains visible');
 assert.match(await page.locator('[data-ably-action-status]').innerText(),/미리보기 완료/);
 assert.equal(await page.evaluate(()=>downloads.length),0);await ablyCriteriaUnlocked(page);
});

test('shared field presets remain locked until both standard seller previews and the pending Ably file job finish',async t=>{
 const page=await fixture(t),presets=page.locator('[data-export-field-preset]');
 await chooseRadio(page,'[data-ably-field-mode]','stock_only');await page.locator('[data-standard-source="ably"] .seller-advanced').evaluate(node=>node.open=true);
 await page.evaluate(()=>window.deferAblyReads=true);await page.locator('[data-carrier-input="playauto_option"]').setInputFiles(carrierFile('option.xlsx'));
 await page.waitForFunction(()=>pendingAblyReads.length===1);assert.deepEqual(await presets.evaluateAll(nodes=>nodes.map(node=>node.disabled)),[true,true,true]);
 await page.locator(primary('smartstore','preview')).click();await page.locator(primary('makeshop','preview')).click();await page.waitForFunction(()=>pendingPreviews.length===2);
 await page.evaluate(()=>resolvePreview(0,'smartstore-current'));await page.waitForFunction(()=>!document.querySelector('[data-standard-preview="smartstore"]').disabled);
 assert.equal(await page.evaluate(()=>__systemV3DirectExportBusy),true);await controlsLocked(page,'makeshop');assert.deepEqual(await presets.evaluateAll(nodes=>nodes.map(node=>node.disabled)),[true,true,true]);
 await page.evaluate(()=>resolvePreview(1,'makeshop-current'));await page.waitForFunction(()=>!document.querySelector('[data-standard-preview="makeshop"]').disabled);
 assert.equal(await page.evaluate(()=>__systemV3DirectExportBusy),false);assert.deepEqual(await presets.evaluateAll(nodes=>nodes.map(node=>node.disabled)),[true,true,true],'Ably processing keeps the shared presets locked after standard cards finish');
 await page.evaluate(()=>pendingAblyReads[0]());await page.waitForFunction(()=>document.querySelector('[data-ably-progress]').dataset.state==='done');
 assert.deepEqual(await presets.evaluateAll(nodes=>nodes.map(node=>node.disabled)),[false,false,false]);
});
