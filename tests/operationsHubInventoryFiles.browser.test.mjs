import assert from 'node:assert/strict';
import fs from 'node:fs';
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
    <input id="inventory-ably-file" type="file" accept=".xlsx">
    <p id="inventory-file-status"></p>
    <button id="inventory-batch-run">재고 파일 4개 ZIP 생성</button>
    <div id="inventory-batch-status" hidden><b id="inventory-batch-title"></b><progress id="inventory-batch-progress" max="100" hidden></progress><p id="inventory-batch-detail"></p></div>
    <div id="inventory-batch-result" hidden></div></main>`);
  await page.addScriptTag({path:uiPath});
  t.after(async()=>{await context.close();await browser.close();});
  return page;
}

test('missing PlayAuto source shows the exact guidance and never calls the bridge',async t=>{
  const page=await fixture(t);
  await page.evaluate(()=>{window.__batchCalls=0;window.SystemV3SellerExportBridge={runInventoryBatch(){window.__batchCalls++;}};});
  await page.locator('#inventory-batch-run').click();
  assert.equal(await page.locator('#inventory-batch-detail').textContent(),'에이블리 PlayAuto 원본 파일을 먼저 선택해주세요.');
  assert.equal(await page.evaluate(()=>window.__batchCalls),0);
});

test('batch locks controls, prevents duplicate work, and downloads one four-file ZIP',async t=>{
  const page=await fixture(t);
  await page.evaluate(()=>{
    window.__batchCalls=0;window.__downloadClicks=0;
    const click=HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click=function(){window.__downloadClicks++;return click.call(this);};
    window.SystemV3SellerExportBridge={runInventoryBatch:async({file,stockSource,onProgress})=>{
      window.__batchCalls++;window.__batchArgs={fileName:file.name,stockSource};
      onProgress({message:'원본 1/4 처리 중',percent:25});
      await new Promise(resolve=>window.__finishBatch=resolve);
      return {blob:new Blob(['zip-fixture'],{type:'application/zip'}),fileName:'재고_4개.zip',files:['smartstore-a.xlsx','smartstore-b.xlsx','makeshop.xlsx','ably.xlsx'],warnings:[]};
    }};
  });
  await page.locator('#inventory-ably-file').setInputFiles({name:'PlayAuto.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from('fixture')});
  await page.locator('input[name="inventory-stock-source"][value="stock"]').check();
  await page.locator('#inventory-batch-run').click();
  await page.waitForFunction(()=>window.__batchCalls===1);
  assert.equal(await page.locator('#inventory-batch-run').isDisabled(),true);
  assert.equal(await page.locator('#inventory-ably-file').isDisabled(),true);
  assert.equal(await page.locator('input[name="inventory-stock-source"][value="available_stock"]').isDisabled(),true);
  await page.locator('#inventory-batch-run').click({force:true});
  assert.equal(await page.evaluate(()=>window.__batchCalls),1,'a second click cannot start a concurrent batch');
  assert.equal(await page.locator('#inventory-batch-detail').textContent(),'원본 1/4 처리 중');
  await page.evaluate(()=>window.__finishBatch());
  await page.waitForFunction(()=>document.querySelector('#inventory-batch-result')?.hidden===false);
  assert.equal(await page.evaluate(()=>window.__batchArgs.stockSource),'stock');
  assert.equal(await page.evaluate(()=>window.__downloadClicks),1,'the batch creates exactly one browser download');
  assert.equal(await page.locator('#inventory-batch-title').textContent(),'재고 파일 생성 완료');
  assert.deepEqual(await page.locator('#inventory-batch-result li').allTextContents(),['smartstore-a.xlsx','smartstore-b.xlsx','makeshop.xlsx','ably.xlsx']);
  assert.equal(await page.locator('#inventory-batch-run').isDisabled(),false,'controls unlock after completion');
});

test('bridge errors unlock controls and do not download',async t=>{
  const page=await fixture(t);
  await page.evaluate(()=>{window.__downloadClicks=0;const click=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){window.__downloadClicks++;return click.call(this);};window.SystemV3SellerExportBridge={runInventoryBatch:async()=>{throw Error('blocked fixture');}};});
  await page.locator('#inventory-ably-file').setInputFiles({name:'PlayAuto.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from('fixture')});
  await page.locator('#inventory-batch-run').click();
  await page.waitForFunction(()=>document.querySelector('#inventory-batch-title')?.textContent==='재고 파일 생성 중단');
  assert.match(await page.locator('#inventory-batch-detail').textContent(),/blocked fixture/);
  assert.equal(await page.evaluate(()=>window.__downloadClicks),0);
  assert.equal(await page.locator('#inventory-batch-run').isDisabled(),false);
});
