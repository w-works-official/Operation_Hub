import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';

const require=createRequire(process.env.CODEX_NODE_MODULES?`${process.env.CODEX_NODE_MODULES}/seller-workflow-modes.cjs`:import.meta.url);
const {chromium}=require('playwright');
const workflow=fs.readFileSync(new URL('../mockups/operations-hub/seller-file-workflow-v2.js',import.meta.url),'utf8');

const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:process.platform==='win32'?{channel:'msedge'}:{})});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.setContent('<!doctype html><body><main><div id="jobs" class="page"><div class="page-head"><h2>jobs</h2></div></div></main></body>');
 await page.evaluate(()=>{
  window.workflowCalls=[];
  window.SystemV3Data={
   loadAuxiliarySellerFiles:async()=>({rows:[]}),
   loadLatestSellerOriginalStatus:async()=>[{source:'smartstore',available:true},{source:'makeshop',available:true}],
   loadTagCatalog:async()=>({rows:[{tag_id:7,tag_name:'가격 대상',option_count:2}]}),
   loadAllTagScopeSkus:async({tagId})=>({tagId,skus:['SKU-A','SKU-B'],count:2,datasetVersion:'v1'})
  };
  const scopeSummary={selectedSkuCount:2,matchedOptionCount:3,changedOptionCount:1,unchangedOptionCount:2,unmatchedSkuCount:0,blockedCount:0,preservedCount:0,outputRowCount:2};
  window.SystemV3SellerExportBridge={
   previewTargetAll:async args=>(workflowCalls.push(['previewTargetAll',args]),{planFingerprint:'all-fingerprint',scopeSummary,diagnostics:{sku_count:2,query_count:1}}),
   previewChangedOnly:async args=>(workflowCalls.push(['previewChangedOnly',args]),{planFingerprint:'changed-fingerprint',scopeSummary,diagnostics:{sku_count:2,query_count:1}}),
   runTargetAll:async args=>(workflowCalls.push(['runTargetAll',args]),{scopeSummary,title:'전체 대상 파일'}),
   runChangedOnly:async args=>(workflowCalls.push(['runChangedOnly',args]),{scopeSummary,title:'변경분 파일'}),
   previewPriceOnly:async args=>(workflowCalls.push(['previewPriceOnly',args]),{planFingerprint:'price-fingerprint',scopeSummary}),
   previewStockOnly:async args=>(workflowCalls.push(['previewStockOnly',args]),{planFingerprint:'stock-fingerprint',scopeSummary}),
   runPriceOnly:async args=>(workflowCalls.push(['runPriceOnly',args]),{scopeSummary,title:'가격-only'}),
   runStockOnly:async args=>(workflowCalls.push(['runStockOnly',args]),{scopeSummary,title:'재고-only'})
  };
  window.SystemV3SellerExport={};window.AblyPlayautoExport={};window.AblyPriceProjection={};
 });
 await page.addScriptTag({content:workflow});
 await page.waitForSelector('#export-workflow-v2');

 assert.equal(await page.locator('[data-standard-output-mode="smartstore"]').inputValue(),'target_all');
 assert.equal(await page.locator('[data-standard-preview="smartstore"]').count(),1);
 assert.equal(await page.locator('[data-standard-run="smartstore"]').count(),1);
 assert.equal(await page.locator('[data-standard-full-preview="smartstore"]').locator('..').evaluate(node=>node.closest('details')!==null),true);
 assert.equal(await page.locator('[data-standard-carrier-run="smartstore"]').locator('..').evaluate(node=>node.closest('details')!==null),true);
 assert.equal(await page.locator('[data-standard-recalculate="smartstore"]').locator('..').evaluate(node=>node.closest('details')!==null),true);
 assert.equal(await page.locator('[data-standard-output-mode="ably"]').inputValue(),'target_all');
 assert.match(await page.locator('.seller-output-contract').innerText(),/전체 행은 유지/);

 await page.locator('[data-standard-preview="smartstore"]').click();
 await page.waitForFunction(()=>window.workflowCalls.some(([name])=>name==='previewTargetAll'));
 const combinedPreviewArgs=await page.evaluate(()=>window.workflowCalls.find(([name])=>name==='previewTargetAll')[1]);
 assert.equal(combinedPreviewArgs.stockSource,'available_stock');
 assert.equal(combinedPreviewArgs.includePrice,true);
 assert.equal(combinedPreviewArgs.includeStock,true);
 assert.equal(await page.locator('[data-standard-stock-source-wrap="smartstore"]').isVisible(),true,'combined mode exposes the common stock basis');
 assert.match(await page.locator('[data-standard-result="smartstore"]').innerText(),/선택 SKU 2 · 매칭 옵션 3 · 변경 옵션 1 · 변경 없음 2/);

 await page.locator('[data-standard-output-mode="smartstore"]').selectOption('changed_only');
 await page.locator('[data-standard-run="smartstore"]').click();
 assert.equal(await page.evaluate(()=>window.workflowCalls.some(([name])=>name==='runChangedOnly')),false,'a mode change must invalidate the prior preview');
 assert.match(await page.locator('[data-standard-result="smartstore"]').innerText(),/미리보기를 먼저 확인/);

 await page.locator('[data-seller-scope-mode="smartstore"]').selectOption('tag');
 await page.locator('[data-seller-scope-tag="smartstore"]').selectOption('7');
 await page.locator('[data-standard-stock-source="smartstore"]').selectOption('stock');
 await page.locator('[data-standard-preview="smartstore"]').click();
 await page.waitForFunction(()=>window.workflowCalls.some(([name,args])=>name==='previewChangedOnly'&&args.skus?.length===2));
 const previewArgs=await page.evaluate(()=>window.workflowCalls.filter(([name])=>name==='previewChangedOnly').at(-1)[1]);
 assert.deepEqual(previewArgs.skus,['SKU-A','SKU-B']);
 assert.equal(previewArgs.stockSource,'stock');
 assert.equal(previewArgs.includeStock,true);
 await page.locator('[data-standard-run="smartstore"]').click();
 await page.waitForFunction(()=>window.workflowCalls.some(([name])=>name==='runChangedOnly'));
 const runArgs=await page.evaluate(()=>window.workflowCalls.filter(([name])=>name==='runChangedOnly').at(-1)[1]);
 assert.equal(runArgs.mode,'changed_only');
 assert.deepEqual(errors,[]);
 console.log('PASS seller workflow target/output modes, advanced actions, scope summaries, and preview invalidation');
}finally{await browser.close();}
