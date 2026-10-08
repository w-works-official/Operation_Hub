import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(path.join(root,'package.json'));
const {chromium}=require('playwright');
const uiPath=path.join(root,'mockups/operations-hub/inventory-batch-ui.js');

async function fixture(t){
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:process.platform==='win32'?{channel:'msedge'}:{})});
  const context=await browser.newContext({acceptDownloads:true});
  const page=await context.newPage();
  await page.setContent(`<!doctype html><main id="inventory">
    <input type="radio" name="inventory-stock-source" value="available_stock" checked>
    <input type="radio" name="inventory-stock-source" value="stock">
    <input id="inventory-sellpia-files" type="file" accept=".xlsx" multiple>
    <p id="inventory-sellpia-file-status"></p>
    <p id="inventory-ably-mapping-status"></p>
    <section id="inventory-update-preview" data-state="idle"><b id="inventory-preview-title"></b><span id="inventory-preview-message"></span>
      <dl id="inventory-preview-summary" hidden>${['files','read-rows','valid-skus','changed','unchanged','unconfirmed','duplicate-same','duplicate-conflict','errors'].map(id=>`<dd id="inventory-preview-${id}"></dd>`).join('')}</dl>
    </section>
    <button id="inventory-batch-run" disabled>재고 반영 후 4개 ZIP 생성</button>
    <div id="inventory-batch-status" hidden><b id="inventory-batch-title"></b><progress id="inventory-batch-progress" max="100" hidden></progress><p id="inventory-batch-detail"></p></div>
    <div id="inventory-batch-result" hidden></div></main>`);
  await page.evaluate(()=>{
    window.__mappingReady=true;window.__mappingChecks=0;
    let bridge={};
    const preflight=async()=>{window.__mappingChecks++;if(!window.__mappingReady)throw Error('검증된 에이블리 매핑이 없습니다.');return {ready:true,eligibleCount:3,reviewCount:1,excludedCount:0,templateFile:new File(['fixture'],'official-template.xlsx')};};
    Object.defineProperty(window,'SystemV3SellerExportBridge',{configurable:true,get:()=>bridge,set:value=>{bridge={preflightInventoryMappings:preflight,...value};}});
    window.SystemV3SellerExportBridge={};
  });
  await page.addScriptTag({path:uiPath});
  t.after(async()=>{await context.close();await browser.close();});
  return page;
}
const xlsx=(name,contents='fixture')=>({name,mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(contents)});
const preview=(overrides={})=>({fingerprint:'fixture-fingerprint',baseSnapshotId:'fixture-snapshot',changedRows:[{sellpia_sku_code:'A-1'}],summary:{fileCount:2,readRowCount:16,validSkuCount:14,changedSkuCount:2,unchangedSkuCount:12,unknownSkuCount:1,duplicateSameCount:3,duplicateConflictCount:0,errorRowCount:0,...overrides}});

test('multi-file selection automatically previews all required counts and gates the final button',async t=>{
  const page=await fixture(t);
  await page.evaluate(()=>{window.__previewCalls=0;window.SystemV3Data={previewSellpiaInventoryCount:async files=>{window.__previewCalls++;return {fingerprint:'f1',summary:{fileCount:files.length,readRowCount:16,validSkuCount:14,changedSkuCount:2,unchangedSkuCount:12,unknownSkuCount:1,duplicateSameCount:3,duplicateConflictCount:0,errorRowCount:0}};}};});
  await page.locator('#inventory-sellpia-files').setInputFiles([xlsx('count-1.xlsx'),xlsx('count-2.xlsx')]);
  await page.waitForFunction(()=>document.querySelector('#inventory-preview-title')?.textContent==='재고 반영 미리보기 완료');
  assert.equal(await page.locator('#inventory-preview-files').textContent(),'2');
  assert.equal(await page.locator('#inventory-preview-read-rows').textContent(),'16');
  assert.equal(await page.locator('#inventory-preview-valid-skus').textContent(),'14');
  assert.equal(await page.locator('#inventory-preview-changed').textContent(),'2');
  assert.equal(await page.locator('#inventory-preview-unchanged').textContent(),'12');
  assert.equal(await page.locator('#inventory-preview-unconfirmed').textContent(),'1');
  assert.equal(await page.locator('#inventory-preview-duplicate-same').textContent(),'3');
  assert.equal(await page.locator('#inventory-preview-duplicate-conflict').textContent(),'0');
  assert.equal(await page.locator('#inventory-preview-errors').textContent(),'0');
  await page.waitForFunction(()=>document.querySelector('#inventory-batch-run')?.disabled===false);
  assert.equal(await page.locator('#inventory-ably-file').count(),0,'DB mappings replace the PlayAuto input');
  assert.equal(await page.evaluate(()=>window.__previewCalls),1,'mapping checks do not re-read inventory files');
  assert.equal(await page.locator('#inventory-batch-run').isDisabled(),false,'a valid preview and prepared mappings enable the final action');
});

test('preview conflicts and fatal rows block the final action',async t=>{
  const page=await fixture(t);
  await page.evaluate(()=>{window.__previewCounts={duplicateConflictCount:0,errorRowCount:0};window.SystemV3Data={previewSellpiaInventoryCount:async()=>({summary:{fileCount:1,readRowCount:4,validSkuCount:2,changedSkuCount:1,unchangedSkuCount:1,unknownSkuCount:0,duplicateSameCount:0,...window.__previewCounts}})};});
  await page.locator('#inventory-sellpia-files').setInputFiles(xlsx('count.xlsx'));
  await page.waitForFunction(()=>document.querySelector('#inventory-batch-run')?.disabled===false);
  await page.evaluate(()=>{window.__previewCounts={duplicateConflictCount:1,errorRowCount:0};});
  await page.locator('#inventory-sellpia-files').setInputFiles(xlsx('count-conflict.xlsx'));
  await page.waitForFunction(()=>document.querySelector('#inventory-preview-title')?.textContent.includes('오류를 확인'));
  assert.equal(await page.locator('#inventory-batch-run').isDisabled(),true);
  await page.evaluate(()=>{window.__previewCounts={duplicateConflictCount:0,errorRowCount:1};});
  await page.locator('#inventory-sellpia-files').setInputFiles(xlsx('count-invalid.xlsx'));
  await page.waitForFunction(()=>document.querySelector('#inventory-preview-summary')?.hidden===false&&document.querySelector('#inventory-preview-errors')?.textContent==='1');
  assert.equal(await page.locator('#inventory-batch-run').isDisabled(),true);
});

test('update flow locks every control, prevents duplicate clicks, and downloads one four-file ZIP',async t=>{
  const page=await fixture(t);
  await page.evaluate(()=>{window.__batchCalls=0;window.__downloadClicks=0;window.__finishBatch=null;window.__expectedPreview={fingerprint:'fixture-fingerprint',summary:{changedSkuCount:2}};
    window.SystemV3Data={previewSellpiaInventoryCount:async()=>window.__expectedPreview};
    const click=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){window.__downloadClicks++;return click.call(this);};
    window.SystemV3SellerExportBridge={runInventoryUpdateBatch:async({files,expectedPreview,stockSource,onProgress})=>{window.__batchCalls++;window.__batchArgs={files:files.map(item=>item.name),previewFingerprint:expectedPreview.fingerprint,stockSource};onProgress({message:'셀피아 원본 반영 중',percent:25});await new Promise(resolve=>window.__finishBatch=resolve);return {blob:new Blob(['zip-fixture'],{type:'application/zip'}),fileName:'재고_4개.zip',files:['smartstore-a.xlsx','smartstore-b.xlsx','makeshop.xlsx','에이블리_재고 수량 변경.xlsx'],warnings:[]};}};
  });
  await page.locator('#inventory-sellpia-files').setInputFiles([xlsx('count-a.xlsx'),xlsx('count-b.xlsx')]);
  await page.waitForFunction(()=>document.querySelector('#inventory-batch-run')?.disabled===false);
  await page.locator('input[name="inventory-stock-source"][value="stock"]').check();
  await page.locator('#inventory-batch-run').click();
  await page.waitForFunction(()=>window.__batchCalls===1);
  for(const selector of ['#inventory-sellpia-files','input[name="inventory-stock-source"][value="stock"]','#inventory-batch-run'])assert.equal(await page.locator(selector).isDisabled(),true,`${selector} is locked while work is running`);
  await page.locator('#inventory-batch-run').click({force:true});
  assert.equal(await page.evaluate(()=>window.__batchCalls),1,'a second click cannot start concurrent work');
  assert.equal(await page.locator('#inventory-batch-detail').textContent(),'셀피아 원본 반영 중');
  await page.evaluate(()=>window.__finishBatch());
  await page.waitForFunction(()=>document.querySelector('#inventory-batch-result')?.hidden===false);
  assert.deepEqual(await page.evaluate(()=>window.__batchArgs),{files:['count-a.xlsx','count-b.xlsx'],previewFingerprint:'fixture-fingerprint',stockSource:'stock'});
  assert.equal(await page.evaluate(()=>window.__downloadClicks),1);
  assert.equal(await page.locator('#inventory-batch-title').textContent(),'재고 반영 및 ZIP 생성 완료');
  assert.deepEqual(await page.locator('#inventory-batch-result li').allTextContents(),['smartstore-a.xlsx','smartstore-b.xlsx','makeshop.xlsx','에이블리_재고 수량 변경.xlsx']);
  assert.equal(await page.locator('#inventory-batch-run').isDisabled(),false);
});

test('post-update ZIP failure exposes retry-only path and file changes clear it',async t=>{
  const page=await fixture(t);
  await page.evaluate(()=>{window.__updates=0;window.__retries=0;window.__downloadClicks=0;
    window.SystemV3Data={previewSellpiaInventoryCount:async()=>({fingerprint:'retry-fingerprint',summary:{changedSkuCount:1,duplicateConflictCount:0,errorRowCount:0}})};
    const click=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){window.__downloadClicks++;return click.call(this);};
    window.SystemV3SellerExportBridge={runInventoryUpdateBatch:async()=>{window.__updates++;const error=Error('fixture ZIP failure');error.uploaded=true;error.retryAvailable=true;throw error;},retryInventoryBatchExport:async({stockSource})=>{window.__retries++;window.__retryArgs={stockSource};return {blob:new Blob(['zip-fixture']),fileName:'retry.zip',files:['a.xlsx','b.xlsx','c.xlsx','d.xlsx']};}};
  });
  await page.locator('#inventory-sellpia-files').setInputFiles(xlsx('count.xlsx'));
  await page.waitForFunction(()=>document.querySelector('#inventory-batch-run')?.disabled===false);
  await page.locator('#inventory-batch-run').click();
  await page.waitForFunction(()=>document.querySelector('#inventory-batch-run')?.textContent==='판매처 파일 다시 생성');
  assert.match(await page.locator('#inventory-batch-detail').textContent(),/DB 재고 반영은 완료됐지만 ZIP은 생성되지 않았습니다/);
  assert.equal(await page.evaluate(()=>window.__downloadClicks),0,'a failed ZIP does not create a partial download');
  await page.locator('#inventory-batch-run').click();
  await page.waitForFunction(()=>window.__retries===1&&document.querySelector('#inventory-batch-result')?.hidden===false);
  assert.equal(await page.evaluate(()=>window.__updates),1,'retry never uploads Sellpia files again');
  assert.deepEqual(await page.evaluate(()=>window.__retryArgs),{stockSource:'available_stock'});
  assert.equal(await page.evaluate(()=>window.__downloadClicks),1);
  await page.locator('#inventory-sellpia-files').setInputFiles(xlsx('replacement-count.xlsx'));
  await page.waitForFunction(()=>document.querySelector('#inventory-preview-title')?.textContent==='재고 반영 미리보기 완료');
  assert.equal(await page.locator('#inventory-batch-run').textContent(),'재고 반영 후 4개 ZIP 생성','changing files invalidates the export-only retry state');
});

test('preview failures disable final action and stale preview results are ignored',async t=>{
  const page=await fixture(t);
  await page.evaluate(()=>{window.__previewCount=0;window.__firstPreviewResolve=null;window.SystemV3Data={previewSellpiaInventoryCount:async files=>{window.__previewCount++;if(files[0].name==='slow.xlsx')return new Promise(resolve=>window.__firstPreviewResolve=resolve);throw Error('fixture preview failure');}};});
  await page.locator('#inventory-sellpia-files').setInputFiles(xlsx('slow.xlsx'));
  await page.waitForFunction(()=>window.__firstPreviewResolve!==null);
  await page.locator('#inventory-sellpia-files').setInputFiles(xlsx('broken.xlsx'));
  await page.waitForFunction(()=>document.querySelector('#inventory-preview-title')?.textContent==='재고 반영 미리보기 실패');
  await page.evaluate(()=>window.__firstPreviewResolve({summary:{fileCount:1,changedSkuCount:1,duplicateConflictCount:0,errorRowCount:0}}));
  await page.waitForTimeout(20);
  assert.equal(await page.locator('#inventory-preview-title').textContent(),'재고 반영 미리보기 실패','the late first response cannot replace the current failure');
  assert.equal(await page.locator('#inventory-batch-run').isDisabled(),true);
});
