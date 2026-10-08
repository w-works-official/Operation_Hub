import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(path.join(repo,'package.json')),{chromium}=require('playwright');
const ui=fs.readFileSync(path.join(repo,'mockups/operations-hub/inventory-batch-ui.js'),'utf8');
const app=fs.readFileSync(path.join(repo,'mockups/operations-hub/app.js'),'utf8');
const mouseup=app.match(/document\.addEventListener\('mouseup', \(\) => \{[\s\S]*?\n\}\);/)?.[0];
assert.ok(mouseup?.includes("classList.remove('matrix-cell-selecting')"),'include the actual shared mouseup handler');
let browser;
test.before(async()=>{browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:process.platform==='win32'?{channel:'msedge'}:{})});});
test.after(async()=>{await browser?.close();});

async function fixture(t){
 const page=await browser.newPage(),errors=[];t.after(async()=>{assert.deepEqual(errors,[]);await page.close();});page.on('pageerror',error=>errors.push(error.message));
 await page.setContent(`<!doctype html><body class=""><main id="inventory">
  <input type="radio" name="inventory-stock-source" value="available_stock" checked><input type="radio" name="inventory-stock-source" value="stock">
  <input id="inventory-sellpia-files" type="file" multiple><p id="inventory-sellpia-file-status"></p><p id="inventory-ably-mapping-status"></p>
  <section id="inventory-update-preview"><b id="inventory-preview-title"></b><span id="inventory-preview-message"></span><dl id="inventory-preview-summary" hidden>${['files','read-rows','valid-skus','changed','unchanged','unconfirmed','duplicate-same','duplicate-conflict','errors'].map(id=>`<dd id="inventory-preview-${id}"></dd>`).join('')}</dl></section>
  <button id="inventory-batch-run" disabled>재고 반영 후 4개 ZIP 생성</button>
  <div id="inventory-batch-status" hidden><b id="inventory-batch-title"></b><progress id="inventory-batch-progress" hidden></progress><p id="inventory-batch-detail"></p></div><div id="inventory-batch-result" hidden></div>
 </main></body>`);
 await page.evaluate(()=>{
  window.mappingCalls=0;window.pendingMappings=[];window.batchCalls=0;window.pendingBatches=[];window.downloadCalls=0;window.nativeBatchClicks=0;
  window.matrixCellSelection={dragging:false};window.relationCellSelection={dragging:false};window.multiLinkCellSelection={dragging:false};
  window.mappingValue=()=>({ready:true,eligibleCount:5945,reviewCount:0,excludedCount:0,templateFile:new File(['template'],'official.xlsx')});
  window.SystemV3Data={previewSellpiaInventoryCount:async()=>({fingerprint:'zero-change-fingerprint',baseSnapshotId:'zero-change-snapshot',changedRows:[],summary:{fileCount:1,readRowCount:1,validSkuCount:1,changedSkuCount:0,unchangedSkuCount:1,unknownSkuCount:0,duplicateSameCount:0,duplicateConflictCount:0,errorRowCount:0}})};
  window.SystemV3SellerExportBridge={
   async preflightInventoryMappings(){window.mappingCalls++;if(window.deferMappings)return new Promise(resolve=>window.pendingMappings.push(resolve));return window.mappingValue();},
   async runInventoryUpdateBatch(args){window.batchCalls++;window.batchArgs={fingerprint:args.expectedPreview.fingerprint,stockSource:args.stockSource};return new Promise(resolve=>window.pendingBatches.push(()=>resolve({blob:new Blob(['fourfile fixture']),fileName:'zero-change.zip',files:['SS1.xlsx','SS2.xlsx','MS.xlsx','AB.xlsx'],uploaded:false,warnings:[],ablySummary:{eligibleCount:5945}})));}
  };
  HTMLAnchorElement.prototype.click=function(){window.downloadCalls++;};
  document.getElementById('inventory-batch-run').addEventListener('click',()=>window.nativeBatchClicks++);
 });
 await page.addScriptTag({content:mouseup});await page.addScriptTag({content:ui});
 await page.locator('#inventory-sellpia-files').setInputFiles({name:'zero-change.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from('UI fixture')});
 await page.waitForFunction(()=>document.getElementById('inventory-batch-run').disabled===false);
 await page.evaluate(()=>window.deferMappings=true);
 return page;
}
async function allLocked(page){assert.deepEqual(await page.locator('#inventory-sellpia-files,input[name="inventory-stock-source"],#inventory-batch-run').evaluateAll(nodes=>nodes.map(node=>node.disabled)),[true,true,true,true]);}
async function settle(page){await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));}

test('actual shared mouseup class mutation cannot swallow the native inventory batch click',async t=>{
 const page=await fixture(t);const baselineCalls=await page.evaluate(()=>mappingCalls);
 await page.locator('#inventory-batch-run').click();await settle(page);
 assert.equal(await page.evaluate(()=>nativeBatchClicks),1,'mouseup must not disable the target before its click event');
 assert.equal(await page.evaluate(()=>mappingCalls),baselineCalls+1,'only the explicit run preflight starts');
 assert.equal(await page.locator('#inventory-batch-status').isHidden(),false,'show processing before the deferred preflight settles');await allLocked(page);
 await page.evaluate(()=>pendingMappings[0](mappingValue()));await page.waitForFunction(()=>batchCalls===1);
 assert.deepEqual(await page.evaluate(()=>batchArgs),{fingerprint:'zero-change-fingerprint',stockSource:'available_stock'});
 await page.evaluate(()=>pendingBatches[0]());await page.waitForFunction(()=>document.getElementById('inventory-batch-result').hidden===false);
 assert.equal(await page.evaluate(()=>downloadCalls),1);assert.equal(await page.locator('#inventory-batch-title').textContent(),'변경 없이 ZIP 생성 완료');
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
