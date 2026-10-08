import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});
const pageErrors=[];
try{
 const page=await browser.newPage({viewport:{width:1180,height:820}});
 page.on('pageerror',error=>pageErrors.push(error.message));
 await page.route('**/*',route=>route.abort());
 await page.setContent('<html><body><section id="decision-host" data-price-decision-panel data-source="smartstore"></section></body></html>');
 await page.addScriptTag({path:path.join(root,'mockups/operations-hub/price-decision-workspace.js')});
 await page.addScriptTag({path:path.join(root,'mockups/operations-hub/ably-price-projection.js')});
 await page.evaluate(()=>{
  const clone=value=>structuredClone(value);
  const currentPrice={base:20000,discounted:18000,option:0,final:18000,terms:[{term_key:'basic',is_baseline:true,unit:'amount',value:2000,rounding_unit:1,rounding_mode:'nearest'}]};
  const rulePrice={base:21500,discounted:19350,option:0,final:19350,terms:[{term_key:'basic',is_baseline:true,input_source:'formula_tag',unit:'percent',value:10,rounding_unit:10,rounding_mode:'down'}]};
  const target=()=>({sku:'SKU-1',seller_option_code:'OPT-1',source_row_no:12,raw_payload:{source_file_name:'latest.xlsx'},price:clone(currentPrice),current_state:{price:clone(currentPrice)}});
  const group=()=>({seller_product_code:'SELLER-1',revision:7,mapping_valid:true,source_observed_at:'2026-10-08T00:00:00Z',sellpia_snapshot_id:'sellpia-snapshot-1',sellpia_prices:{'SKU-1':19500},targets:[target()]});
  const state=window.qa={writes:[],readCalls:0,sourceReads:0,ruleCalls:[],planCalls:0,historyCalls:0,policyCalls:[],applyMode:'success',attempts:0};
  let requestSequence=0;window.crypto.randomUUID=()=>`qa-request-${++requestSequence}`;
  const product={sellpia_sku_code:'SKU-1',smartstore_product_code:'SELLER-1',smartstore_option_code:'OPT-1',sellpia_source_sale_price:19500,sellpia_source_updated_at:'2026-10-08T00:00:00Z',__sellerDrafts:{'smartstore:sellpia_sale_price':{status:'pending',base_price_source:'manual',pricing_input_mode:'final',price_base_after:99999,price_final_after:99999}}};
  window.HubPlatformRules={calculate:async(skus,source,context)=>{state.ruleCalls.push({skus:[...skus],source,context:clone(context)});return {errors:[],rows:[{sku:'SKU-1',platformBase:rulePrice.base,platformDiscount:rulePrice.base-rulePrice.discounted,platformOption:rulePrice.option,platformFinal:rulePrice.final,platformTerms:clone(rulePrice.terms),versions:[{id:'rule-v1',version:4,assignmentVersion:2}]}]};}};
  window.HubCurrentPriceExport={prepareSellpiaSourcePricePlan(source,fileName,carrierRows,mappings,prices,skus){state.planCalls++;const value=prices.get(skus[0]);return {operations:[],preview:carrierRows.map(row=>({product_code:row.product_code,option_code:row.option_code,status:'ready',diff:{price:{after:{base:value,discounted:value,option:0,final:value,discount_terms:[]}}}})),excludedItems:[]};}};
  window.SystemV3Data={
   loadCurrentPriceDecisions:async({source,skus})=>{state.readCalls++;return {rows:[{sku:'SKU-1',source_channel:source,seller_product_code:'SELLER-1',seller_option_code:'OPT-1',price:clone(currentPrice),decision_source:'sellpia_apply',effective_at:'2026-10-07T01:00:00Z',revision:7}],groups:[group()]};},
   loadSellpiaSourcePricesForExport:async({skus})=>{state.sourceReads++;return new Map(skus.map(sku=>[sku,19500]));},
   loadAblyCarrierPoliciesForSkus:async request=>{state.policyCalls.push(clone(request));return {rows:[{sku:'SKU-1',tags:[{tag_id:'policy-middle',tag_name:'Middle',is_active:true,document:{id:'policy-doc',version:4,body:{carriers:{ably:{representativeStrategy:'lower_middle'}}}}}]}],documents:[],fingerprint:'policy-middle-v4'};},
   applyPriceDecision:async request=>{state.attempts++;state.writes.push(clone(request));if(state.applyMode==='fail-once'&&state.attempts===1)throw Error('temporary network error');if(state.applyMode==='stale')throw Error('가격 결정 revision이 변경되었습니다. 다시 확인해주세요.');return {rows:[{sku:'SKU-1',source_channel:request.source,seller_product_code:'SELLER-1',seller_option_code:'OPT-1',price:clone(request.groups[0].targets[0].price),decision_source:request.decisionSource,effective_at:'2026-10-08T00:00:00Z',revision:8}],items:[]};},
   loadPriceDecisionHistory:async()=>{state.historyCalls++;return {events:[{event_id:'event-6',request_id:'request-6',decision_source:'sellpia_apply',actor:'qa',effective_at:'2026-10-06T12:00:00Z',group_revision:6,seller_option_code:'OPT-1',price:clone(currentPrice)}]};},
  };
  window.qaProduct=product;
  window.qaReset=mode=>{state.writes=[];state.readCalls=0;state.sourceReads=0;state.ruleCalls=[];state.planCalls=0;state.historyCalls=0;state.attempts=0;state.applyMode=mode;product.__priceDecisions={};const host=document.getElementById('decision-host');host.dataset.source='smartstore';window.HubPriceDecisionUI.mount(document,product);};
  window.qaReset('success');
 });
 assert.deepEqual(pageErrors,[],'workspace must mount without browser exceptions');

 await page.locator('[data-decision-action="preview-rule"]').click();
 await page.waitForFunction(()=>!document.querySelector('[data-decision-candidate]').hidden||document.querySelector('[data-decision-status]').classList.contains('error'),null,{timeout:5000});
 assert.equal(await page.locator('[data-decision-candidate]').isVisible(),true,await page.locator('[data-decision-status]').innerText());
 assert.equal(await page.locator('[data-decision-action="apply"]').isVisible(),true);
 assert.match(await page.locator('[data-decision-candidate]').innerText(),/19,350/,'Rule preview should show the current calculation candidate');
 assert.equal(await page.evaluate(()=>qa.ruleCalls[0].context.ignoreManualIntent),true,'explicit Rule candidate must ask calculator to ignore prior manual intent');
 assert.equal(await page.evaluate(()=>qa.writes.length),0,'preview must not write a decision');
 const visibleOverlay=await page.evaluate(()=>{
  const decision={sku:'SKU-1',seller_product_code:'SELLER-1',seller_option_code:'OPT-1',decision_source:'sellpia_apply',revision:7,
   price:{base:18900,discounted:18900,option:0,final:18900,terms:[]}};
  const legacy={price:99999,discountedBasePrice:89999,optionPrice:0,finalPrice:99999,terms:[],origin:'draft'};
  return {current:HubPriceDecisionUI.current({...qaProduct,__priceDecisions:{smartstore:[decision]}},'smartstore'),visible:HubPriceDecisionUI.visible(legacy,decision)};
 });
 assert.equal(visibleOverlay.current.price.final,18900,'Matrix current lookup prefers the accepted decision over a stale legacy draft');
 assert.equal(visibleOverlay.visible.effectiveFinalPrice,18900,'the Matrix cell overlay receives the current decision tuple');
 assert.equal(visibleOverlay.visible.priceOrigin,'decision');
 await page.locator('[data-decision-action="apply"]').click();
 assert.equal(await page.evaluate(()=>qa.writes.length),1);
 assert.equal(await page.evaluate(()=>qa.writes[0].decisionSource),'pricing_rule');
 assert.deepEqual(await page.evaluate(()=>qa.writes[0].groups[0].targets[0].price),{base:21500,discounted:19350,option:0,final:19350,terms:[{term_key:'basic',is_baseline:true,input_source:'formula_tag',unit:'percent',value:10,rounding_unit:10,rounding_mode:'down'}]});
 assert.equal(await page.evaluate(()=>qa.writes[0].groups[0].targets[0].intent.input_mode),'explicit_rule');

 await page.evaluate(()=>qaReset('success'));
 await page.locator('[data-decision-action="preview-sellpia"]').click();
 await page.waitForFunction(()=>!document.querySelector('[data-decision-candidate]').hidden||document.querySelector('[data-decision-status]').classList.contains('error'),null,{timeout:5000});
 assert.equal(await page.locator('[data-decision-candidate]').isVisible(),true,await page.locator('[data-decision-status]').innerText());
 assert.equal(await page.evaluate(()=>qa.sourceReads),1,'Sellpia preview should load the current source price');
 assert.equal(await page.evaluate(()=>qa.writes.length),0,'Sellpia preview remains read-only');
 assert.match(await page.locator('[data-decision-candidate]').innerText(),/19,500/);
 await page.locator('[data-decision-action="apply"]').click();
 assert.equal(await page.evaluate(()=>qa.writes[0].decisionSource),'sellpia_apply');
 assert.deepEqual(await page.evaluate(()=>qa.writes[0].groups[0].targets[0].price),{base:19500,discounted:19500,option:0,final:19500,terms:[]});
 assert.equal(await page.evaluate(()=>qa.writes[0].groups[0].targets[0].intent.input_mode),'explicit_sellpia');
 assert.equal(await page.evaluate(()=>qa.writes[0].groups[0].targets[0].intent.source_observed_at),'2026-10-08T00:00:00Z','the exact DB snapshot timestamp is used for candidate intent');
 assert.equal(await page.evaluate(()=>qa.writes[0].groups[0].targets[0].intent.sellpia_snapshot_id),'sellpia-snapshot-1');

 await page.evaluate(()=>qaReset('fail-once'));
 await page.locator('[data-decision-action="preview-rule"]').click();
 await page.locator('[data-decision-action="apply"]').click();
 assert.match(await page.locator('[data-decision-status]').innerText(),/temporary network error/);
 assert.equal(await page.locator('[data-decision-action="apply"]').isVisible(),true,'temporary failure retains the confirmed candidate');
 const firstRequestId=await page.evaluate(()=>qa.writes[0].requestId);
 await page.locator('[data-decision-action="apply"]').click();
 const requestIds=await page.evaluate(()=>qa.writes.map(write=>write.requestId));
 assert.deepEqual(requestIds,[firstRequestId,firstRequestId],'retry must reuse the same idempotency request ID');

 await page.evaluate(()=>qaReset('stale'));
 await page.locator('[data-decision-action="preview-rule"]').click();
 await page.locator('[data-decision-action="apply"]').click();
 assert.match(await page.locator('[data-decision-status]').innerText(),/revision이 변경/);
 assert.equal(await page.locator('[data-decision-action="apply"]').isVisible(),false,'stale revision clears the candidate and requires a fresh preview');

 await page.evaluate(()=>qaReset('success'));
 await page.locator('[data-decision-action="history"]').click();
 await page.locator('[data-decision-action="rollback"]').waitFor();
 assert.equal(await page.evaluate(()=>qa.historyCalls),1);
 await page.locator('[data-decision-action="rollback"][data-event-id="event-6"]').click();
 assert.match(await page.locator('[data-decision-candidate]').innerText(),/이전 결정의 1개 옵션/);
 await page.locator('[data-decision-action="apply"]').click();
 assert.equal(await page.evaluate(()=>qa.writes[0].decisionSource),'rollback');
 assert.equal(await page.evaluate(()=>qa.writes[0].rollbackEventId),'event-6');

 await page.evaluate(()=>{qaProduct.ably_product_code='SELLER-1';qaProduct.ably_option_code='OPT-1';const host=document.getElementById('decision-host');host.dataset.source='ably';HubPriceDecisionUI.mount(document,qaProduct);});
 await page.locator('[data-decision-action="preview-sellpia"]').click();
 await page.waitForFunction(()=>qa.policyCalls.length>0||document.querySelector('[data-decision-status]').classList.contains('error'));
 assert.deepEqual(await page.evaluate(()=>qa.policyCalls),[{skus:['SKU-1']}],'Ably policy reads use the data service object argument');
 assert.match(await page.locator('[data-decision-status]').innerText(),/lower_middle/,'policy rows from the loader are normalized and applied to the candidate projection');
 assert.deepEqual(pageErrors,[],'user actions must not emit uncaught browser errors');
 console.log('PASS price decision workspace browser flow: readonly Rule/Sellpia previews, explicit apply provenance, stable retry ID, stale revision invalidation, and rollback history. Fixture API only.');
}finally{await browser.close();}
