import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {fileURLToPath} from 'node:url';
const root=new URL('../mockups/operations-hub/',import.meta.url),browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage();await page.route('**/*',r=>r.abort());await page.setContent('<html><body><main id="price-rules"></main></body></html>');
 await page.evaluate(()=>{window.qa={platform:false,loads:[],calls:[]};const sku=i=>'sku-'+String(i).padStart(5,'0');window.SystemV3Data={ruleRegistry:async()=>{const target=qa.platform?'platform_registration_price':'calculated_base_price',scope=qa.platform?'smartstore':'';return {rules:[{id:'large',name:'23,760 baseline',target_field:target,source_field:'source_base_price',input_origin:'self',scope,version:1,is_active:true,config:{steps:[{op:'add',value:0}]}}],assignments:Array.from({length:23760},(_,i)=>({sku:sku(i),rule_id:'large',target_field:target,scope})),dependencies:[]};},loadFormulaProducts:async skus=>{qa.loads.push(skus.length);return skus.map(s=>({sellpia_sku_code:s,display_name:'상품 '+s,sellpia_source_sale_price:1000}));}};window.HubPlatformRules={calculate:async(skus,source)=>{qa.calls.push({length:skus.length,source});return {rows:skus.map(sku=>({sku,product:{display_name:'상품 '+sku},value:1000,platformBase:1000})),errors:[]};}};});
 for(const name of ['rule-registry.js','rule-workspace.js'])await page.addScriptTag({path:fileURLToPath(new URL(name,root))});
 await page.evaluate(()=>{HubPriceWorkspace.state.selected='large';return HubPriceWorkspace.refresh();});
 assert.deepEqual(await page.evaluate(()=>qa.loads),[200]);assert.equal(await page.locator('#rw-preview tr').count(),200);assert.match(await page.locator('#rw-preview-count').innerText(),/전체 23,760 SKU · 미리보기 200개\(최대 200\) · 표시 결과 오류 0/);assert.doesNotMatch(await page.locator('#rw-status').innerText(),/2,000개를 넘/);
 await page.locator('#rw-preview-filter').fill('sku-23759');await page.waitForFunction(()=>!HubPriceWorkspace.state.busy);
 assert.deepEqual(await page.evaluate(()=>qa.loads),[200,1]);assert.equal(await page.locator('#rw-preview tr').count(),1);assert.match(await page.locator('#rw-preview').innerText(),/sku-23759/);assert.match(await page.locator('#rw-preview-count').innerText(),/전체 23,760 SKU · 검색 1개 · 미리보기 1개/);
 await page.evaluate(()=>{qa.platform=true;return HubPriceWorkspace.refresh();});
 assert.deepEqual(await page.evaluate(()=>qa.calls),[{length:200,source:'smartstore'}]);assert.equal(await page.locator('#rw-preview tr').count(),200);
 await page.locator('#rw-preview-filter').fill('sku-23759');await page.waitForFunction(()=>!HubPriceWorkspace.state.busy);assert.deepEqual(await page.evaluate(()=>qa.calls),[{length:200,source:'smartstore'},{length:1,source:'smartstore'}]);assert.equal(await page.locator('#rw-preview tr').count(),1);
 console.log('PASS 23,760 assignments refresh loads200 internal rows / platform requests200, explicitly labels total vs bounded preview, SKU search reaches last assigned row with1 request; no global conflict claim.');
}finally{await browser.close();}
