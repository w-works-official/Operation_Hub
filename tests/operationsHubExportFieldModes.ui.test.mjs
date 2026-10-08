import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';

const require=createRequire(process.env.CODEX_NODE_MODULES?`${process.env.CODEX_NODE_MODULES}/export-field-ui.cjs`:import.meta.url);
const {chromium}=require('playwright');
const workflow=fs.readFileSync(new URL('../mockups/operations-hub/seller-file-workflow-v2.js',import.meta.url),'utf8');

const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:process.platform==='win32'?{channel:'msedge'}:{})});
const chooseRadio=(page,selector,value)=>page.locator(selector).locator('..').locator(`.seller-choice-options input[type="radio"][value="${value}"]`).check();
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.setContent('<!doctype html><body><main><div id="jobs" class="page"><div class="page-head"><h2>jobs</h2></div></div></main></body>');
 await page.evaluate(()=>{
  window.SystemV3Data={
   loadAuxiliarySellerFiles:async()=>({rows:[]}),
   loadLatestSellerOriginalStatus:async()=>[],
   loadTagCatalog:async()=>({rows:[]})
  };
  window.SystemV3SellerExport={};
  window.AblyPlayautoExport={};
  window.AblyPriceProjection={};
 });
 await page.addScriptTag({content:workflow});
 await page.waitForSelector('#export-workflow-v2');

 assert.deepEqual(await page.locator('[data-export-field-preset]').allTextContents(),['가격 + 재고','가격만','재고만']);
 assert.deepEqual(await page.locator('[data-standard-field-mode="smartstore"] option').allTextContents(),['가격 + 재고','가격만','재고만']);
 assert.deepEqual(await page.locator('[data-ably-field-mode] option').allTextContents(),['가격 + 재고','가격만','재고만']);

 await page.locator('[data-export-field-preset="stock_only"]').click();
 assert.equal(await page.locator('[data-standard-field-mode="smartstore"]').inputValue(),'stock_only');
 assert.equal(await page.locator('[data-standard-field-mode="makeshop"]').inputValue(),'stock_only');
 assert.equal(await page.locator('[data-ably-field-mode]').inputValue(),'stock_only');
 assert.equal(await page.locator('[data-standard-stock-source-wrap="smartstore"]').isVisible(),true);
 assert.equal(await page.locator('[data-ably-stock-source-wrap]').isVisible(),true);
 assert.equal(await page.locator('[data-standard-price-mode="smartstore"]').isDisabled(),true);
 assert.equal(await page.locator('[data-standard-recalculate="smartstore"]').isVisible(),false);
 assert.equal(await page.locator('[data-export-field-preset="stock_only"]').getAttribute('aria-pressed'),'true');

 await page.locator('[data-export-field-preset="price_only"]').click();
 assert.equal(await page.locator('[data-standard-field-mode="smartstore"]').inputValue(),'price_only');
 assert.equal(await page.locator('[data-ably-field-mode]').inputValue(),'price_only');
 assert.equal(await page.locator('[data-standard-stock-source-wrap="smartstore"]').isVisible(),false);
 assert.equal(await page.locator('[data-standard-price-mode="smartstore"]').isEnabled(),true);
 await page.locator('[data-standard-recalculate="smartstore"]').evaluate(button=>{button.closest('details').open=true;});
 assert.equal(await page.locator('[data-standard-recalculate="smartstore"]').isVisible(),true);
 assert.match(await page.locator('[data-seller-notice]').nth(0).innerText(),/재고.*원본 그대로 보존/);

 await page.locator('[data-export-field-preset="price_stock"]').click();
 assert.equal(await page.locator('[data-standard-field-mode="smartstore"]').inputValue(),'price_stock');
 assert.equal(await page.locator('[data-ably-field-mode]').inputValue(),'option_stock');
 assert.equal(await page.locator('[data-export-field-preset="price_stock"]').getAttribute('aria-pressed'),'true');

 await chooseRadio(page,'[data-standard-field-mode="smartstore"]','stock_only');
 assert.equal(await page.locator('[data-export-field-preset][aria-pressed="true"]').count(),0,'mixed card modes must not claim one global preset is active');
 assert.deepEqual(errors,[]);
 console.log('PASS seller export presets and per-card price/stock controls stay synchronized in the rendered UI');
}finally{await browser.close();}
