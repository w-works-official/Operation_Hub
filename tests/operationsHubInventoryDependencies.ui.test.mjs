import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {createRequire} from 'node:module';

const require=createRequire(process.env.CODEX_NODE_MODULES?`${process.env.CODEX_NODE_MODULES}/inventory-dependencies.cjs`:import.meta.url);
const {chromium}=require('playwright');
const read=name=>fs.readFileSync(new URL(`../mockups/operations-hub/${name}`,import.meta.url),'utf8');
const html=read('index.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi,'');
const file={name:'재고조사.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from('synthetic inventory count')};
const toggle='#inventory-batch-stock-dependencies';
let browser;
test.before(async()=>{browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:process.platform==='win32'?{channel:'msedge'}:{})});});
test.after(async()=>{await browser?.close();});

async function fixture(t){
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 t.after(async()=>{assert.deepEqual(errors,[]);await page.close();});
 await page.setContent(html);const inventory=await page.locator('#inventory').evaluate(node=>node.outerHTML);
 await page.setContent(`<!doctype html><main>${inventory}</main>`);
 await page.addStyleTag({content:read('inventory-batch.css')});
 await page.evaluate(()=>{
  window.previewCalls=0;window.runs=[];window.retries=[];window.revokedUrls=[];window.createdUrls=[];
  const create=URL.createObjectURL,revoke=URL.revokeObjectURL;
  URL.createObjectURL=function(blob){const url=create.call(this,blob);createdUrls.push(url);return url;};
  URL.revokeObjectURL=function(url){revokedUrls.push(url);return revoke.call(this,url);};
  window.countPreview={fingerprint:'count-proof',baseSnapshotId:'raw-snapshot',changedRows:[{sellpia_sku_code:'P',stock:12,available_stock:10}],summary:{fileCount:1,readRowCount:2,validSkuCount:2,changedSkuCount:1,unchangedSkuCount:1}};
  window.SystemV3Data={previewSellpiaInventoryCount:async()=>{previewCalls++;if(window.deferPreview)await new Promise(resolve=>window.releasePreview=resolve);return structuredClone(countPreview);}};
  const result=()=>({uploaded:true,files:['ss1.xlsx','ss2.xlsx','makeshop.xlsx','ably.xlsx'].map(name=>({name,fileName:name,blob:new Blob(['synthetic stock-only output'])})),blockedRows:[],warnings:[]});
  const args=options=>({includeStockDependencies:options.includeStockDependencies,stockSource:options.stockSource,files:options.files?.map(file=>file.name),expectedPreview:options.expectedPreview});
  window.SystemV3SellerExportBridge={
   preflightInventoryMappings:async()=>({ready:true,eligibleCount:2,templateFile:new File(['synthetic'],'template.xlsx')}),
   runInventoryUpdateBatch:async options=>{runs.push(args(options));if(window.failRun){const error=Error('합성 파일 생성 실패');error.uploaded=true;error.retryAvailable=true;throw error;}if(window.deferRun)await new Promise(resolve=>window.releaseRun=resolve);return result();},
   retryInventoryBatchExport:async options=>{retries.push(args(options));return result();}
  };
  window.HubInventoryFileDownloads={
   loadDestination:async()=>({supported:true,configured:false,name:'브라우저 기본 다운로드 폴더'}),
   prepareDestination:async()=>({kind:'browser'}),
   chooseDestination:async()=>{if(window.deferDestination)await new Promise(resolve=>window.releaseDestination=resolve);return {supported:true,configured:false};},
   saveFiles:async files=>({destination:'browser',savedCount:files.length})
  };
 });
 await page.addScriptTag({content:read('inventory-batch-ui.js')});return page;
}
async function ready(page){await page.locator('#inventory-sellpia-files').setInputFiles(file);await page.waitForFunction(()=>document.querySelector('#inventory-batch-run').disabled===false);}
async function run(page){await page.locator('#inventory-batch-run').click();await page.waitForFunction(()=>document.querySelector('#inventory-batch-run').disabled===false);}

test('inventory dependency checkbox is separate, defaults off, and sends explicit false without changing the count preview',async t=>{
 const page=await fixture(t);assert.equal(await page.locator(toggle).isChecked(),false);
 assert.match(await page.locator(toggle).locator('..').innerText(),/개별상품 → 모음전 재고 종속관계 적용/);
 assert.match(await page.locator('#inventory-stock-dependency-help').innerText(),/파일에만 상위 재고 적용 · 하위 원본\/조사기록 유지/);
 assert.match(await page.locator('#inventory-stock-dependency-help').innerText(),/개별 수량 입력 대신 모든 판매처.*1\+1 조합은 별도/);
 await ready(page);await run(page);
 assert.equal(await page.evaluate(()=>runs[0].includeStockDependencies),false);
 assert.equal(await page.evaluate(()=>previewCalls),1);
 assert.deepEqual(await page.evaluate(()=>runs[0].expectedPreview.changedRows),[{sellpia_sku_code:'P',stock:12,available_stock:10}]);
});

test('enabled stock dependency setting reaches initial generation and retry with the same stock basis',async t=>{
 const page=await fixture(t);await ready(page);await page.locator(toggle).check();
 await page.locator('input[name="inventory-stock-source"][value="stock"]').check();await page.evaluate(()=>window.failRun=true);await run(page);
 assert.match(await page.locator('#inventory-batch-run').innerText(),/다시 생성/);
 await run(page);
 assert.deepEqual(await page.evaluate(()=>[runs[0],retries[0]].map(args=>[args.includeStockDependencies,args.stockSource])),[[true,'stock'],[true,'stock']]);
 assert.equal(await page.evaluate(()=>runs.length),1);assert.equal(await page.evaluate(()=>retries.length),1);assert.equal(await page.evaluate(()=>previewCalls),1);
 assert.equal(await page.locator('#inventory-batch-result [data-redownload-index]').count(),4);
});

test('changing the dependency setting invalidates a failed export retry while retaining the DB comparison preview',async t=>{
 const page=await fixture(t);await ready(page);await page.locator(toggle).check();await page.evaluate(()=>window.failRun=true);await run(page);
 await page.locator(toggle).uncheck();assert.doesNotMatch(await page.locator('#inventory-batch-run').innerText(),/다시 생성/);
 assert.equal(await page.locator('#inventory-batch-status').isHidden(),true);assert.equal(await page.locator('#inventory-update-preview').getAttribute('data-state'),'success');
 await page.evaluate(()=>window.failRun=false);await run(page);
 assert.deepEqual(await page.evaluate(()=>runs.map(args=>args.includeStockDependencies)),[true,false]);assert.equal(await page.evaluate(()=>retries.length),0);
 assert.equal(await page.evaluate(()=>previewCalls),1);
});

test('changing the dependency setting clears cached file links and revokes their URLs without re-reading count files',async t=>{
 const page=await fixture(t);await ready(page);await run(page);
 assert.equal(await page.locator('#inventory-batch-result a').count(),4);assert.equal(await page.evaluate(()=>createdUrls.length),4);
 await page.locator(toggle).check();
 assert.equal(await page.locator('#inventory-batch-result').isHidden(),true);assert.equal(await page.locator('#inventory-batch-result a').count(),0);
 assert.equal(await page.evaluate(()=>revokedUrls.length),4);assert.equal(await page.evaluate(()=>previewCalls),1);assert.equal(await page.locator('#inventory-batch-run').isEnabled(),true);
});

test('dependency selection locks with file comparison, generation, and destination selection',async t=>{
 const page=await fixture(t);await page.evaluate(()=>window.deferPreview=true);await page.locator('#inventory-sellpia-files').setInputFiles(file);
 await page.waitForFunction(()=>window.releasePreview);assert.equal(await page.locator(toggle).isDisabled(),true);
 await page.evaluate(()=>releasePreview());await page.waitForFunction(()=>!document.querySelector('#inventory-batch-run').disabled);
 assert.equal(await page.locator(toggle).isEnabled(),true);await page.locator(toggle).check();await page.evaluate(()=>window.deferRun=true);
 await page.locator('#inventory-batch-run').click();await page.waitForFunction(()=>window.releaseRun);assert.equal(await page.locator(toggle).isDisabled(),true);
 assert.equal(await page.evaluate(()=>runs[0].includeStockDependencies),true);await page.evaluate(()=>releaseRun());await page.waitForFunction(()=>!document.querySelector('#inventory-batch-run').disabled);
 await page.evaluate(()=>window.deferDestination=true);await page.locator('#inventory-choose-destination').click();await page.waitForFunction(()=>window.releaseDestination);
 assert.equal(await page.locator(toggle).isDisabled(),true);await page.evaluate(()=>releaseDestination());await page.waitForFunction(()=>!document.querySelector('#inventory-choose-destination').disabled);
 assert.equal(await page.locator(toggle).isEnabled(),true);
});

test('stock dependency label and help remain readable at a narrow viewport',async t=>{
 const page=await fixture(t);await page.setViewportSize({width:390,height:900});const label=page.locator(toggle).locator('..');
 assert.equal(await label.isVisible(),true);const bounds=await label.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=391);
 assert.equal(await label.evaluate(node=>node.scrollWidth<=node.clientWidth+1),true);
 await page.locator(toggle).check();assert.equal(await page.locator(toggle).isChecked(),true);
});
