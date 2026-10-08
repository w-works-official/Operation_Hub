import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(path.join(repo,'package.json')),{chromium}=require('playwright');
const XLSX=require(path.join(repo,'tests/vendor/xlsx-0.18.5.full.min.js'));
const ui=fs.readFileSync(path.join(repo,'mockups/operations-hub/inventory-batch-ui.js'),'utf8');
const app=fs.readFileSync(path.join(repo,'mockups/operations-hub/app.js'),'utf8');
const mouseup=app.match(/document\.addEventListener\('mouseup', \(\) => \{[\s\S]*?\n\}\);/)?.[0];
assert.ok(mouseup?.includes("classList.remove('matrix-cell-selecting')"),'include the actual shared mouseup handler');
let browser;
test.before(async()=>{browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:process.platform==='win32'?{channel:'msedge'}:{})});});
test.after(async()=>{await browser?.close();});

function inventoryFile(name='zero-change.xlsx',rows=[['11215-1',2,2]]){const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['상품코드','가용재고','재고'],...rows]),'재고조사');return {name,mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(XLSX.write(book,{type:'buffer',bookType:'xlsx'}))};}
async function fixture(t,{initial=true,deferMappings=true,supported=true,persistent=true,configured=false,uploaded=false,failSaves=0}={}){
 const page=await browser.newPage(),errors=[];t.after(async()=>{assert.deepEqual(errors,[]);await page.close();});page.on('pageerror',error=>errors.push(error.message));
 await page.setContent(`<!doctype html><body class=""><main id="inventory">
  <input type="radio" name="inventory-stock-source" value="available_stock" checked><input type="radio" name="inventory-stock-source" value="stock">
  <div id="inventory-sellpia-dropzone" tabindex="0"><input id="inventory-sellpia-files" type="file" multiple></div><ul id="inventory-sellpia-file-list"></ul><button id="inventory-sellpia-clear-files">전체 삭제</button><p id="inventory-sellpia-file-status"></p><p id="inventory-ably-mapping-status"></p>
  <section id="inventory-update-preview"><b id="inventory-preview-title"></b><span id="inventory-preview-message"></span><dl id="inventory-preview-summary" hidden>${['files','read-rows','valid-skus','changed','unchanged','unconfirmed','duplicate-same','duplicate-conflict','errors','blocked-skus','blocked-rows'].map(id=>`<dd id="inventory-preview-${id}"></dd>`).join('')}</dl></section>
  <div id="inventory-blocked-report" hidden><p id="inventory-blocked-report-summary"></p><button id="inventory-blocked-preview-download">차단 목록 저장</button></div>
  <p id="inventory-download-destination-name"></p><p id="inventory-download-destination-hint" hidden></p><button id="inventory-choose-destination">폴더 선택</button><button id="inventory-clear-destination">기본 폴더</button>
  <button id="inventory-batch-run" disabled>재고 반영 후 판매처 파일 4개 생성</button>
  <div id="inventory-batch-status" hidden><b id="inventory-batch-title"></b><progress id="inventory-batch-progress" hidden></progress><p id="inventory-batch-detail"></p></div><div id="inventory-batch-result" hidden></div>
 </main></body>`);
 await page.addScriptTag({path:path.join(repo,'tests/vendor/xlsx-0.18.5.full.min.js')});
 await page.addScriptTag({path:path.join(repo,'mockups/operations-hub/sellpia-inventory-count.js')});
 await page.evaluate(options=>{
  window.mappingCalls=0;window.pendingMappings=[];window.batchCalls=0;window.retryCalls=0;window.pendingBatches=[];window.downloadCalls=0;window.nativeBatchClicks=0;window.prepareCalls=0;window.savedBatches=[];window.timeline=[];window.previewCalls=[];window.pendingPreviews=[];window.failSaves=options.failSaves;
  window.matrixCellSelection={dragging:false};window.relationCellSelection={dragging:false};window.multiLinkCellSelection={dragging:false};
  window.mappingValue=()=>({ready:true,eligibleCount:5945,reviewCount:0,excludedCount:0,templateFile:new File(['template'],'official.xlsx')});
  window.SystemV3Data={previewSellpiaInventoryCount:async files=>{window.previewCalls.push(files.map(file=>file.name));const parsed=await SystemV3SellpiaInventoryCount.parseFiles(files,{XLSX});const preview=SystemV3SellpiaInventoryCount.buildPreview(parsed,[{sellpia_sku_code:'11215-1',stock:2,available_stock:2},{sellpia_sku_code:'normal-2',stock:2,available_stock:2}],{baseSnapshotId:'zero-change-snapshot'});window.lastPreview=preview;if(window.deferPreviews)await new Promise(resolve=>window.pendingPreviews.push(resolve));return preview;}};
  window.makeBatchOutput=()=>({files:['SS1.xlsx','SS2.xlsx','MS.xlsx','AB.xlsx'].map(name=>({blob:new Blob(['file fixture']),name,fileName:name})),uploaded:options.uploaded,warnings:[],blockedRows:window.lastPreview.blockedRows,blockedFile:null,ablySummary:{eligibleCount:5945}});
  window.SystemV3SellerExportBridge={
   async preflightInventoryMappings(){window.mappingCalls++;window.timeline.push('mapping');if(window.deferMappings)return new Promise(resolve=>window.pendingMappings.push(resolve));return window.mappingValue();},
   async runInventoryUpdateBatch(args){window.batchCalls++;window.timeline.push('batch');window.batchArgs={fingerprint:args.expectedPreview.fingerprint,stockSource:args.stockSource};return new Promise(resolve=>window.pendingBatches.push(()=>resolve(window.makeBatchOutput())));},
   async retryInventoryBatchExport(){window.retryCalls++;window.timeline.push('retry');return window.makeBatchOutput();}
  };
  window.HubInventoryFileDownloads={async loadDestination(){return {supported:options.supported,persistent:options.persistent,configured:options.configured,name:options.configured?'QA folder':'브라우저 기본 다운로드 폴더'};},async prepareDestination(){window.prepareCalls++;window.timeline.push('prepare');if(window.denyPermission)throw Error('쓰기 권한 거부');if(window.deferPermission)await new Promise(resolve=>window.resolvePermission=resolve);return {kind:options.configured?'directory':'browser'};},async saveFiles(files){window.savedBatches.push(files.map(file=>file.fileName||file.name));window.timeline.push('save');if(window.failSaves>0){window.failSaves--;throw Error('synthetic disk full');}window.downloadCalls+=files.length;}};
  HTMLAnchorElement.prototype.click=function(){window.downloadCalls++;};
  document.getElementById('inventory-batch-run').addEventListener('click',()=>window.nativeBatchClicks++);
 },{supported,persistent,configured,uploaded,failSaves});
 await page.addScriptTag({content:mouseup});await page.addScriptTag({content:ui});
 if(initial){await page.locator('#inventory-sellpia-files').setInputFiles(inventoryFile());await page.waitForFunction(()=>document.getElementById('inventory-batch-run').disabled===false);}
 await page.evaluate(value=>window.deferMappings=value,deferMappings);
 return page;
}
async function allLocked(page){assert.equal(await page.locator('#inventory-sellpia-files,input[name="inventory-stock-source"],#inventory-batch-run,#inventory-sellpia-clear-files,#inventory-choose-destination,#inventory-clear-destination,#inventory-blocked-preview-download,[data-remove-file]').evaluateAll(nodes=>nodes.every(node=>node.disabled)),true);}
async function settle(page){await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));}

test('actual shared mouseup class mutation cannot swallow the native inventory batch click',async t=>{
 const page=await fixture(t);const baselineCalls=await page.evaluate(()=>mappingCalls);
 await page.locator('#inventory-batch-run').click();await settle(page);
 assert.equal(await page.evaluate(()=>nativeBatchClicks),1,'mouseup must not disable the target before its click event');
 assert.equal(await page.evaluate(()=>mappingCalls),baselineCalls+1,'only the explicit run preflight starts');
 assert.equal(await page.locator('#inventory-batch-status').isHidden(),false,'show processing before the deferred preflight settles');await allLocked(page);
 await page.evaluate(()=>pendingMappings[0](mappingValue()));await page.waitForFunction(()=>batchCalls===1);
 assert.deepEqual(await page.evaluate(()=>batchArgs),{fingerprint:await page.evaluate(()=>lastPreview.fingerprint),stockSource:'available_stock'});
 await page.evaluate(()=>pendingBatches[0]());await page.waitForFunction(()=>document.getElementById('inventory-batch-result').hidden===false);
 assert.equal(await page.evaluate(()=>downloadCalls),4);assert.equal(await page.locator('#inventory-batch-title').textContent(),'변경 없이 판매처 파일 생성 완료');
});

test('pending preflight locks all criteria, blocks duplicates and ignores unrelated body class changes',async t=>{
 const page=await fixture(t);const baselineCalls=await page.evaluate(()=>mappingCalls);
 await page.locator('#inventory-batch-run').evaluate(node=>node.dispatchEvent(new MouseEvent('click',{bubbles:true})));await page.waitForFunction(()=>pendingMappings.length===1);
 await allLocked(page);assert.equal(await page.locator('#inventory-batch-run').getAttribute('aria-busy'),'true');
 await page.evaluate(()=>{
  document.getElementById('inventory-batch-run').dispatchEvent(new MouseEvent('click',{bubbles:true}));
  document.body.classList.add('matrix-cell-selecting');document.body.classList.remove('matrix-cell-selecting');document.body.classList.add('matrix-column-resizing');
 });await settle(page);
 assert.equal(await page.evaluate(()=>mappingCalls),baselineCalls+1);assert.equal(await page.evaluate(()=>batchCalls),0);await allLocked(page);
 await page.evaluate(()=>pendingMappings[0](mappingValue()));await page.waitForFunction(()=>batchCalls===1);await allLocked(page);
 await page.locator('#inventory-batch-run').evaluate(node=>node.dispatchEvent(new MouseEvent('click',{bubbles:true})));await settle(page);assert.equal(await page.evaluate(()=>batchCalls),1);
 await page.evaluate(()=>pendingBatches[0]());await page.waitForFunction(()=>!document.getElementById('inventory-batch-run').disabled);
});

test('mapping refresh observes the actual authentication unlock transition and ignores other body classes',async t=>{
 const page=await fixture(t);const baselineCalls=await page.evaluate(()=>mappingCalls);
 await page.evaluate(()=>{document.body.classList.add('matrix-cell-selecting');document.body.classList.remove('matrix-cell-selecting');});await settle(page);
 assert.equal(await page.evaluate(()=>mappingCalls),baselineCalls);
 await page.evaluate(()=>document.body.classList.add('operations-auth-locked'));await settle(page);assert.equal(await page.evaluate(()=>mappingCalls),baselineCalls);
 await page.evaluate(()=>document.body.classList.remove('operations-auth-locked'));await page.waitForFunction(()=>pendingMappings.length===1);assert.equal(await page.evaluate(()=>mappingCalls),baselineCalls+1);
 await page.evaluate(()=>pendingMappings[0](mappingValue()));await page.waitForFunction(()=>document.getElementById('inventory-batch-run').disabled===false);assert.equal(await page.evaluate(()=>batchCalls),0);
});

test('directory permission resolves before mapping or write and pending permission locks every input against duplicate actions',async t=>{
 const page=await fixture(t),baseline=await page.evaluate(()=>mappingCalls);
 await page.evaluate(()=>window.deferPermission=true);await page.locator('#inventory-batch-run').click();await page.waitForFunction(()=>!!window.resolvePermission);
 await allLocked(page);assert.equal(await page.evaluate(()=>mappingCalls),baseline);assert.equal(await page.evaluate(()=>batchCalls),0);
 await page.locator('#inventory-batch-run').evaluate(node=>node.dispatchEvent(new MouseEvent('click',{bubbles:true})));assert.equal(await page.evaluate(()=>prepareCalls),1);
 await page.evaluate(()=>resolvePermission());await page.waitForFunction(()=>pendingMappings.length===1);
 await page.evaluate(()=>pendingMappings[0](mappingValue()));await page.waitForFunction(()=>batchCalls===1);
 assert.deepEqual(await page.evaluate(()=>timeline.slice(-3)),['prepare','mapping','batch']);
 await page.evaluate(()=>pendingBatches[0]());await page.waitForFunction(()=>!document.getElementById('inventory-batch-run').disabled);
});

test('permission denial prevents mapping preflight and the inventory bridge and leaves the confirmed preview reusable',async t=>{
 const page=await fixture(t,{deferMappings:false}),baseline=await page.evaluate(()=>mappingCalls);
 await page.evaluate(()=>window.denyPermission=true);await page.locator('#inventory-batch-run').click();await page.waitForFunction(()=>document.getElementById('inventory-batch-status').dataset.state==='error');
 assert.equal(await page.evaluate(()=>mappingCalls),baseline);assert.equal(await page.evaluate(()=>batchCalls),0);
 assert.match(await page.locator('#inventory-batch-detail').textContent(),/쓰기 권한 거부/);assert.equal(await page.locator('#inventory-batch-run').isDisabled(),false);
});

test('selection adds files cumulatively, retains distinct files with identical metadata, and exposes every same-SKU occurrence in the preview report',async t=>{
 const page=await fixture(t,{deferMappings:false});
 const content=Array.from(inventoryFile('same-name.xlsx',[['normal-2',3,4]]).buffer);
 await page.evaluate(bytes=>{
  const files=[new File([new Uint8Array(bytes)],'same-name.xlsx',{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',lastModified:1234}),new File([new Uint8Array(bytes)],'same-name.xlsx',{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',lastModified:1234})];
  const transfer=new DataTransfer();files.forEach(file=>transfer.items.add(file));const input=document.getElementById('inventory-sellpia-files');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
 },content);
 await page.waitForFunction(()=>document.getElementById('inventory-update-preview').dataset.state==='success'&&window.lastPreview.summary.fileCount===3);
 assert.equal(await page.locator('#inventory-sellpia-file-list li').count(),3);assert.equal(await page.locator('#inventory-preview-duplicate-same').textContent(),'1');assert.equal(await page.locator('#inventory-preview-blocked-rows').textContent(),'2');assert.equal(await page.locator('#inventory-batch-run').isDisabled(),false,'normal first-file SKU remains eligible');
 await page.locator('#inventory-blocked-preview-download').click();await page.waitForFunction(()=>window.downloadCalls===1);
 assert.deepEqual(await page.evaluate(()=>savedBatches[0]),['재고_차단목록.xlsx']);assert.equal(await page.evaluate(()=>batchCalls),0);
 await page.locator('#inventory-batch-run').click();await page.waitForFunction(()=>batchCalls===1);await page.evaluate(()=>pendingBatches[0]());await page.waitForFunction(()=>document.getElementById('inventory-batch-result').hidden===false);
 assert.deepEqual(await page.evaluate(()=>savedBatches[1]),['SS1.xlsx','SS2.xlsx','MS.xlsx','AB.xlsx','재고_차단목록.xlsx']);
 assert.match(await page.locator('#inventory-batch-result').textContent(),/차단 목록 XLSX 다운로드 요청 · 2개 행/);
});

test('drop and picker share the cumulative ten-file cap, per-file removal and clear invalidate the previous preview',async t=>{
 const page=await fixture(t,{initial:false,deferMappings:false});
 const content=Array.from(inventoryFile().buffer);
 await page.evaluate(bytes=>{const transfer=new DataTransfer();for(let index=0;index<11;index++)transfer.items.add(new File([new Uint8Array(bytes)],`count-${index+1}.xlsx`));transfer.items.add(new File(['text'],'unsupported.csv'));document.getElementById('inventory-sellpia-dropzone').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));},content);
 await page.waitForFunction(()=>document.getElementById('inventory-update-preview').dataset.state==='success');
 assert.equal(await page.locator('#inventory-sellpia-file-list li').count(),10);assert.match(await page.locator('#inventory-sellpia-file-status').textContent(),/10\/10/);
 assert.match(await page.locator('#inventory-batch-detail').textContent(),/최대 10개/);assert.match(await page.locator('#inventory-batch-detail').textContent(),/XLSX 파일이 아닙니다/);
 assert.equal(await page.locator('#inventory-batch-run').isDisabled(),true,'ten occurrences of the same SKU have no eligible rows');
 assert.equal(await page.locator('#inventory-blocked-preview-download').isDisabled(),false);
 await page.locator('[data-remove-file]').first().click();await page.waitForFunction(()=>window.lastPreview.summary.fileCount===9&&document.getElementById('inventory-update-preview').dataset.state==='success');
 assert.equal(await page.locator('#inventory-sellpia-file-list li').count(),9);assert.equal(await page.locator('#inventory-preview-blocked-rows').textContent(),'9');
 await page.locator('#inventory-sellpia-clear-files').click();await page.waitForFunction(()=>document.getElementById('inventory-update-preview').dataset.state==='idle');
 assert.equal(await page.locator('#inventory-sellpia-file-list li').count(),0);assert.equal(await page.locator('#inventory-batch-run').isDisabled(),true);assert.equal(await page.locator('#inventory-blocked-report').isHidden(),true);
});

test('pending preview prevents selection and drop mutation until the current result settles',async t=>{
 const page=await fixture(t,{initial:false,deferMappings:false});await page.evaluate(()=>window.deferPreviews=true);
 await page.locator('#inventory-sellpia-files').setInputFiles(inventoryFile());await page.waitForFunction(()=>pendingPreviews.length===1);await allLocked(page);
 const content=Array.from(inventoryFile('late.xlsx',[['normal-2',3,4]]).buffer);
 await page.evaluate(bytes=>{const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array(bytes)],'late.xlsx'));document.getElementById('inventory-sellpia-dropzone').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));document.getElementById('inventory-sellpia-clear-files').dispatchEvent(new MouseEvent('click',{bubbles:true}));},content);
 assert.equal(await page.locator('#inventory-sellpia-file-list li').count(),1);assert.equal(await page.evaluate(()=>previewCalls.length),1);assert.equal(await page.evaluate(()=>batchCalls),0);
 await page.evaluate(()=>pendingPreviews[0]());await page.waitForFunction(()=>document.getElementById('inventory-update-preview').dataset.state==='success');
 assert.equal(await page.locator('#inventory-batch-run').isDisabled(),false);assert.equal(await page.locator('#inventory-preview-files').textContent(),'1');
});

test('a file-save failure after committed upload offers export-only retry and never resubmits the inventory bridge',async t=>{
 const page=await fixture(t,{deferMappings:false,uploaded:true,failSaves:1});await page.locator('#inventory-batch-run').click();await page.waitForFunction(()=>batchCalls===1);await page.evaluate(()=>pendingBatches[0]());
 await page.waitForFunction(()=>document.getElementById('inventory-batch-run').textContent==='판매처 파일 다시 생성');
 assert.equal(await page.locator('#inventory-batch-run').isDisabled(),false);assert.match(await page.locator('#inventory-batch-title').textContent(),/업데이트 완료.*파일 저장 실패/);
 await page.locator('#inventory-batch-run').click();await page.waitForFunction(()=>document.getElementById('inventory-batch-result').hidden===false);
 assert.equal(await page.evaluate(()=>batchCalls),1);assert.equal(await page.evaluate(()=>retryCalls),1);assert.equal(await page.evaluate(()=>prepareCalls),2);assert.equal(await page.evaluate(()=>downloadCalls),4);
 assert.match(await page.locator('#inventory-batch-detail').textContent(),/DB를 다시 변경하지 않았습니다/);
});

test('unsupported folder selection and session-only persistence display their actual destination state',async t=>{
 const unsupported=await fixture(t,{supported:false,deferMappings:false});assert.equal(await unsupported.locator('#inventory-choose-destination').isHidden(),true);assert.equal(await unsupported.locator('#inventory-choose-destination').isDisabled(),true);
 assert.match(await unsupported.locator('#inventory-download-destination-hint').textContent(),/브라우저 기본 다운로드 폴더/);
 const session=await fixture(t,{configured:true,persistent:false,deferMappings:false});assert.equal(await session.locator('#inventory-choose-destination').isHidden(),false);assert.equal(await session.locator('#inventory-clear-destination').isHidden(),false);
 assert.equal(await session.locator('#inventory-download-destination-name').textContent(),'QA folder');assert.match(await session.locator('#inventory-download-destination-hint').textContent(),/세션에서만 기억/);
});
