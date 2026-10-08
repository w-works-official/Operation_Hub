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
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.setContent(`<!doctype html><main id="inventory">
    <input type="radio" name="inventory-stock-source" value="available_stock" checked>
    <input type="radio" name="inventory-stock-source" value="stock">
    <div id="inventory-sellpia-dropzone"><input id="inventory-sellpia-files" type="file" accept=".xlsx" multiple></div><ul id="inventory-sellpia-file-list"></ul><button id="inventory-sellpia-clear-files">전체 삭제</button>
    <p id="inventory-sellpia-file-status"></p>
    <p id="inventory-ably-mapping-status"></p>
    <section id="inventory-update-preview" data-state="idle"><b id="inventory-preview-title"></b><span id="inventory-preview-message"></span>
      <dl id="inventory-preview-summary" hidden>${['files','read-rows','valid-skus','changed','unchanged','unconfirmed','duplicate-same','duplicate-conflict','errors','blocked-skus','blocked-rows'].map(id=>`<dd id="inventory-preview-${id}"></dd>`).join('')}</dl>
    </section>
    <div id="inventory-blocked-report" hidden><p id="inventory-blocked-report-summary"></p><button id="inventory-blocked-preview-download">차단 목록 저장</button></div>
    <p id="inventory-download-destination-name"></p><p id="inventory-download-destination-hint" hidden></p><button id="inventory-choose-destination">폴더 선택</button><button id="inventory-clear-destination">기본 폴더</button>
    <button id="inventory-batch-run" disabled>재고 반영 후 판매처 파일 4개 생성</button>
    <div id="inventory-batch-status" hidden><b id="inventory-batch-title"></b><progress id="inventory-batch-progress" max="100" hidden></progress><p id="inventory-batch-detail"></p></div>
    <div id="inventory-batch-result" hidden></div></main>`);
  await page.evaluate(()=>{
    window.__mappingReady=true;window.__mappingChecks=0;
    window.__fourFiles=names=>({files:names.map(name=>({name,fileName:name,blob:new Blob(['individual XLSX fixture'],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})})),blockedRows:[],blockedFile:null,warnings:[]});
    let bridge={};
    const preflight=async()=>{window.__mappingChecks++;if(!window.__mappingReady)throw Error('검증된 에이블리 매핑이 없습니다.');return {ready:true,eligibleCount:3,reviewCount:1,excludedCount:0,templateFile:new File(['fixture'],'official-template.xlsx')};};
    Object.defineProperty(window,'SystemV3SellerExportBridge',{configurable:true,get:()=>bridge,set:value=>{bridge={preflightInventoryMappings:preflight,...value};}});
    window.SystemV3SellerExportBridge={};
  });
  await page.addScriptTag({path:path.join(root,'tests/vendor/xlsx-0.18.5.full.min.js')});
  await page.addScriptTag({path:path.join(root,'mockups/operations-hub/sellpia-inventory-count.js')});
  await page.addScriptTag({path:path.join(root,'mockups/operations-hub/inventory-file-downloads.js')});
  await page.addScriptTag({path:uiPath});
  t.after(async()=>{await context.close();await browser.close();assert.deepEqual(errors,[],'fixture has no browser script errors');});
  return page;
}
const xlsx=(name,contents='fixture')=>({name,mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(contents)});

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

test('preview conflicts and invalid rows exclude only their SKUs, while no valid SKU disables generation but retains its report',async t=>{
  const page=await fixture(t);
  await page.evaluate(()=>{window.__previewCounts={duplicateConflictCount:0,errorRowCount:0};window.__blockedRows=[];window.SystemV3Data={previewSellpiaInventoryCount:async()=>({fingerprint:'partial-row-proof',baseSnapshotId:'fixture-snapshot',blockedRows:window.__blockedRows,blockedSkus:window.__blockedRows.map(row=>row.sellpia_sku_code),summary:{fileCount:1,readRowCount:4,validSkuCount:2,changedSkuCount:1,unchangedSkuCount:1,unknownSkuCount:0,duplicateSameCount:0,blockedSkuCount:window.__blockedRows.length?1:0,blockedRowCount:window.__blockedRows.length,...window.__previewCounts}})};});
  await page.locator('#inventory-sellpia-files').setInputFiles(xlsx('count.xlsx'));
  await page.waitForFunction(()=>document.querySelector('#inventory-batch-run')?.disabled===false);
  await page.evaluate(()=>{window.__previewCounts={duplicateConflictCount:1,errorRowCount:0};window.__blockedRows=[2,3].map(source_row_no=>({stage:'inventory_input',source:'sellpia',sellpia_sku_code:'duplicate',file_name:'count-conflict.xlsx',source_row_no,status:'duplicate_sku',reason:'conflicting repeated SKU'}));});
  await page.locator('#inventory-sellpia-files').setInputFiles(xlsx('count-conflict.xlsx'));
  await page.waitForFunction(()=>document.querySelector('#inventory-preview-duplicate-conflict')?.textContent==='1'&&document.querySelector('#inventory-update-preview')?.dataset.state==='success');
  assert.equal(await page.locator('#inventory-batch-run').isDisabled(),false,'normal SKU rows remain eligible despite duplicate-group exclusions');
  assert.equal(await page.locator('#inventory-preview-blocked-rows').textContent(),'2');assert.equal(await page.locator('#inventory-blocked-report').isHidden(),false);
  await page.evaluate(()=>{window.__previewCounts={validSkuCount:0,changedSkuCount:0,unchangedSkuCount:0,duplicateConflictCount:0,errorRowCount:1};window.__blockedRows=[{stage:'inventory_input',source:'sellpia',sellpia_sku_code:'invalid',file_name:'count-invalid.xlsx',source_row_no:2,status:'invalid',reason:'bad number'}];});
  await page.locator('#inventory-sellpia-files').setInputFiles(xlsx('count-invalid.xlsx'));
  await page.waitForFunction(()=>document.querySelector('#inventory-preview-summary')?.hidden===false&&document.querySelector('#inventory-preview-errors')?.textContent==='1');
  assert.equal(await page.locator('#inventory-batch-run').isDisabled(),true);
  assert.equal(await page.locator('#inventory-blocked-preview-download').isDisabled(),false,'all-blocked inputs still have a reviewable report');
  const download=page.waitForEvent('download');await page.locator('#inventory-blocked-preview-download').click();assert.equal((await download).suggestedFilename(),'재고_차단목록.xlsx');
});

test('update flow locks every control, prevents duplicate clicks, and downloads four individual seller files',async t=>{
  const page=await fixture(t);
  await page.evaluate(()=>{window.__batchCalls=0;window.__downloadClicks=0;window.__finishBatch=null;window.__expectedPreview={fingerprint:'fixture-fingerprint',baseSnapshotId:'fixture-snapshot',summary:{validSkuCount:2,changedSkuCount:2}};
    window.SystemV3Data={previewSellpiaInventoryCount:async()=>window.__expectedPreview};
    const click=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){window.__downloadClicks++;return click.call(this);};
    window.SystemV3SellerExportBridge={runInventoryUpdateBatch:async({files,expectedPreview,stockSource,onProgress})=>{window.__batchCalls++;window.__batchArgs={files:files.map(item=>item.name),previewFingerprint:expectedPreview.fingerprint,stockSource};onProgress({message:'셀피아 원본 반영 중',percent:25});await new Promise(resolve=>window.__finishBatch=resolve);return window.__fourFiles(['smartstore-a.xlsx','smartstore-b.xlsx','makeshop.xlsx','에이블리_재고 수량 변경.xlsx']);}};
  });
  await page.locator('#inventory-sellpia-files').setInputFiles([xlsx('count-a.xlsx'),xlsx('count-b.xlsx')]);
  await page.waitForFunction(()=>document.querySelector('#inventory-batch-run')?.disabled===false);
  await page.locator('input[name="inventory-stock-source"][value="stock"]').check();
  await page.locator('#inventory-batch-run').click();
  await page.waitForFunction(()=>window.__batchCalls===1);
  for(const selector of ['#inventory-sellpia-files','input[name="inventory-stock-source"][value="stock"]','#inventory-batch-run','#inventory-sellpia-clear-files','#inventory-choose-destination','#inventory-clear-destination','#inventory-blocked-preview-download'])assert.equal(await page.locator(selector).isDisabled(),true,`${selector} is locked while work is running`);
  await page.locator('#inventory-batch-run').click({force:true});
  assert.equal(await page.evaluate(()=>window.__batchCalls),1,'a second click cannot start concurrent work');
  assert.equal(await page.locator('#inventory-batch-detail').textContent(),'셀피아 원본 반영 중');
  await page.evaluate(()=>window.__finishBatch());
  await page.waitForFunction(()=>document.querySelector('#inventory-batch-result')?.hidden===false);
  assert.deepEqual(await page.evaluate(()=>window.__batchArgs),{files:['count-a.xlsx','count-b.xlsx'],previewFingerprint:'fixture-fingerprint',stockSource:'stock'});
  assert.equal(await page.evaluate(()=>window.__downloadClicks),4);
  assert.equal(await page.locator('#inventory-batch-title').textContent(),'재고 반영 및 판매처 파일 생성 완료');
  assert.deepEqual(await page.locator('#inventory-batch-result li span').allTextContents(),['smartstore-a.xlsx','smartstore-b.xlsx','makeshop.xlsx','에이블리_재고 수량 변경.xlsx']);
  assert.match(await page.locator('#inventory-batch-result').textContent(),/판매처 XLSX 4개 다운로드 요청/);
  assert.equal(await page.locator('#inventory-batch-run').isDisabled(),false);
});

test('post-update file-generation failure exposes retry-only path and file additions clear it',async t=>{
  const page=await fixture(t);
  await page.evaluate(()=>{window.__updates=0;window.__retries=0;window.__downloadClicks=0;
    window.SystemV3Data={previewSellpiaInventoryCount:async()=>({fingerprint:'retry-fingerprint',baseSnapshotId:'fixture-snapshot',summary:{validSkuCount:1,changedSkuCount:1,duplicateConflictCount:0,errorRowCount:0}})};
    const click=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){window.__downloadClicks++;return click.call(this);};
    window.SystemV3SellerExportBridge={runInventoryUpdateBatch:async()=>{window.__updates++;const error=Error('fixture file-generation failure');error.uploaded=true;error.retryAvailable=true;throw error;},retryInventoryBatchExport:async({stockSource})=>{window.__retries++;window.__retryArgs={stockSource};return window.__fourFiles(['a.xlsx','b.xlsx','c.xlsx','d.xlsx']);}};
  });
  await page.locator('#inventory-sellpia-files').setInputFiles(xlsx('count.xlsx'));
  await page.waitForFunction(()=>document.querySelector('#inventory-batch-run')?.disabled===false);
  await page.locator('#inventory-batch-run').click();
  await page.waitForFunction(()=>document.querySelector('#inventory-batch-run')?.textContent==='판매처 파일 다시 생성');
  assert.match(await page.locator('#inventory-batch-detail').textContent(),/DB 재고 반영은 완료됐지만 파일 저장에 실패했습니다/);
  assert.equal(await page.evaluate(()=>window.__downloadClicks),0,'failed generation does not create a partial download');
  await page.locator('#inventory-batch-run').click();
  await page.waitForFunction(()=>window.__retries===1&&document.querySelector('#inventory-batch-result')?.hidden===false);
  assert.equal(await page.evaluate(()=>window.__updates),1,'retry never uploads Sellpia files again');
  assert.deepEqual(await page.evaluate(()=>window.__retryArgs),{stockSource:'available_stock'});
  assert.equal(await page.evaluate(()=>window.__downloadClicks),4);
  await page.locator('#inventory-sellpia-files').setInputFiles(xlsx('replacement-count.xlsx'));
  await page.waitForFunction(()=>document.querySelector('#inventory-preview-title')?.textContent==='재고 반영 미리보기 완료');
  assert.equal(await page.locator('#inventory-batch-run').textContent(),'재고 반영 후 판매처 파일 4개 생성','adding files invalidates the export-only retry state');
  assert.equal(await page.locator('#inventory-sellpia-file-list li').count(),2,'a new selection accumulates with the existing count file');
});

test('pending preview rejects replacement selection, and a later failed preview cannot reuse the previous proof',async t=>{
  const page=await fixture(t);
  await page.evaluate(()=>{window.__previewCount=0;window.__firstPreviewResolve=null;window.SystemV3Data={previewSellpiaInventoryCount:async files=>{window.__previewCount++;if(files[0].name==='slow.xlsx')return new Promise(resolve=>window.__firstPreviewResolve=resolve);throw Error('fixture preview failure');}};});
  await page.locator('#inventory-sellpia-files').setInputFiles(xlsx('slow.xlsx'));
  await page.waitForFunction(()=>window.__firstPreviewResolve!==null);
  assert.equal(await page.locator('#inventory-sellpia-files').isDisabled(),true);
  await page.locator('#inventory-sellpia-files').setInputFiles(xlsx('broken.xlsx'));
  assert.equal(await page.evaluate(()=>window.__previewCount),1,'a programmatic change on the locked picker cannot supersede the pending preview');
  assert.match(await page.locator('#inventory-sellpia-file-list').textContent(),/slow.xlsx/);assert.doesNotMatch(await page.locator('#inventory-sellpia-file-list').textContent(),/broken.xlsx/);
  await page.evaluate(()=>window.__firstPreviewResolve({fingerprint:'slow-file-proof',baseSnapshotId:'fixture-snapshot',summary:{fileCount:1,validSkuCount:1,changedSkuCount:1,duplicateConflictCount:0,errorRowCount:0}}));
  await page.waitForFunction(()=>document.querySelector('#inventory-batch-run')?.disabled===false);
  await page.locator('#inventory-sellpia-clear-files').click();await page.locator('#inventory-sellpia-files').setInputFiles(xlsx('broken.xlsx'));
  await page.waitForFunction(()=>document.querySelector('#inventory-preview-title')?.textContent==='재고 반영 미리보기 실패');
  assert.equal(await page.evaluate(()=>window.__previewCount),2);assert.match(await page.locator('#inventory-preview-message').textContent(),/fixture preview failure/);
  assert.equal(await page.locator('#inventory-batch-run').isDisabled(),true);
});

test('each result file and report can be saved again from its retained Blob with correct destination status and no bridge or preview regeneration',async t=>{
  for(const destination of ['browser','directory']){
    const page=await fixture(t);
    await page.evaluate(kind=>{
      window.__updates=0;window.__previews=0;window.__prepares=0;window.__savedGroups=[];window.__finishSave=null;window.__failSave=false;
      window.SystemV3Data={previewSellpiaInventoryCount:async()=>{window.__previews++;return {fingerprint:'retained-file-proof',baseSnapshotId:'fixture-snapshot',summary:{validSkuCount:1,changedSkuCount:1}};}};
      window.__retainedOutput={...window.__fourFiles(['a.xlsx','b.xlsx','c.xlsx','d.xlsx']),blockedFile:{blob:new Blob(['blocked-report fixture']),fileName:'재고_차단목록.xlsx',rowCount:1}};
      window.SystemV3SellerExportBridge={runInventoryUpdateBatch:async()=>{window.__updates++;return window.__retainedOutput;},retryInventoryBatchExport:async()=>{throw Error('result download must not regenerate files');}};
      window.HubInventoryFileDownloads={
        async loadDestination(){return {supported:kind==='directory',configured:kind==='directory',persistent:true,name:kind==='directory'?'QA folder':'브라우저 기본 다운로드 폴더'};},
        async prepareDestination(){window.__prepares++;return {kind};},
        async saveFiles(files){window.__savedGroups.push(files);if(files.length===1)await new Promise(resolve=>window.__finishSave=resolve);if(window.__failSave)throw Error('synthetic retained save failed');return {destination:kind,savedCount:files.length};}
      };
    },destination);
    await page.locator('#inventory-sellpia-files').setInputFiles(xlsx('count.xlsx'));await page.waitForFunction(()=>document.querySelector('#inventory-batch-run')?.disabled===false);
    await page.locator('#inventory-batch-run').click();await page.waitForFunction(()=>document.querySelector('#inventory-batch-result')?.hidden===false);
    assert.equal(await page.locator('[data-redownload-index]').count(),5);assert.match(await page.locator('#inventory-batch-result').textContent(),destination==='directory'?/판매처 XLSX 4개 저장 완료/:/판매처 XLSX 4개 다운로드 요청/);
    const mappingChecks=await page.evaluate(()=>window.__mappingChecks);
    await page.locator('[data-redownload-index="4"]').click();await page.waitForFunction(()=>window.__savedGroups.length===2&&window.__finishSave!==null);
    assert.equal(await page.locator('[data-redownload-index]').evaluateAll(nodes=>nodes.every(node=>node.disabled)),true);assert.equal(await page.locator('#inventory-sellpia-files').isDisabled(),true);assert.equal(await page.locator('#inventory-batch-run').isDisabled(),true);
    await page.locator('[data-redownload-index="4"]').evaluate(node=>node.dispatchEvent(new MouseEvent('click',{bubbles:true})));assert.equal(await page.evaluate(()=>window.__prepares),2);
    assert.deepEqual(await page.evaluate(()=>window.__savedGroups.map(files=>files.map(file=>file.fileName))),[['a.xlsx','b.xlsx','c.xlsx','d.xlsx','재고_차단목록.xlsx'],['재고_차단목록.xlsx']]);
    assert.equal(await page.evaluate(()=>window.__savedGroups[1][0].blob===window.__retainedOutput.blockedFile.blob),true,'report retry uses the original generated Blob');
    await page.evaluate(()=>window.__finishSave());await page.waitForFunction(()=>document.querySelector('#inventory-batch-status')?.dataset.state==='success'&&!document.querySelector('[data-redownload-index="4"]')?.disabled);
    assert.equal(await page.locator('#inventory-batch-title').textContent(),destination==='directory'?'파일 저장 완료':'다운로드 요청 완료');
    await page.evaluate(()=>{window.__finishSave=null;window.__failSave=true;});await page.locator('[data-redownload-index="0"]').click();await page.waitForFunction(()=>window.__finishSave!==null);
    assert.equal(await page.evaluate(()=>window.__savedGroups[2][0].blob===window.__retainedOutput.files[0].blob),true,'seller retry also retains its exact generated Blob');
    await page.evaluate(()=>window.__finishSave());await page.waitForFunction(()=>document.querySelector('#inventory-batch-title')?.textContent==='파일 다시 받기 실패');
    assert.match(await page.locator('#inventory-batch-detail').textContent(),/synthetic retained save failed/);assert.equal(await page.locator('[data-redownload-index="0"]').isDisabled(),false);
    assert.equal(await page.evaluate(()=>window.__updates),1);assert.equal(await page.evaluate(()=>window.__previews),1);assert.equal(await page.evaluate(()=>window.__mappingChecks),mappingChecks);
    assert.equal(await page.locator('#inventory-batch-result').isHidden(),false,'a one-file save failure preserves all generated result files');
  }
});
