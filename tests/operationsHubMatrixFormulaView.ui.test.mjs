import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import {chromium} from 'playwright';

async function fixture(t){
 const root=path.resolve('mockups/operations-hub');
 const server=http.createServer((request,response)=>{
  const file=path.resolve(root,'.'+decodeURIComponent(new URL(request.url,'http://localhost').pathname));
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||fs.statSync(file).isDirectory()){response.writeHead(404).end();return;}
  const extension=path.extname(file);response.setHeader('Content-Type',extension==='.js'?'text/javascript':extension==='.css'?'text/css':'text/html');response.end(fs.readFileSync(file));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:process.platform==='win32'?{channel:'msedge'}:{})}),page=await browser.newPage({viewport:{width:1700,height:1000}}),errors=[];
 page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
 t.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));assert.deepEqual(errors,[]);});
 await page.route('https://**/*',route=>route.fulfill({contentType:'text/javascript',body:'window.supabase={createClient:()=>({rpc:async()=>({data:{}})})};'}));
 await page.addInitScript(()=>{
  const channels=['smartstore','makeshop','ably'];
  const create=sku=>{
   const row={sellpia_sku_code:sku,sellpia_product_name:'수식 표시 비교',sellpia_option_name:sku,system_stock:10,system_base_price:8000,sellpia_source_sale_price:8000,sellpia_sale_price:8000,sellpia_source_stock:10,sellpia_current_stock:10,sellpia_purchase_price:3000,sellpia_source_purchase_price:3000,actual_inbound_cost:1500,actual_inbound_cost_mode:'formula',__hubInternalPrices:{actual_inbound_cost:{value:2500,ruleNames:['실입고가 수식'],activeOutputRules:[{id:'inbound'}]},calculated_base_price:{value:12000,ruleNames:['기준가격 수식'],activeOutputRules:[{id:'base'}]}},__hubActivePriceRules:{},__hubRulePrices:{},__sellerPriceComponents:{},__sellerDrafts:{},__priceDecisions:{}};
   for(const channel of channels){
    Object.assign(row,{[`${channel}_product_code`]:`${channel}-${sku}`,[`${channel}_option_code`]:'O',[`${channel}_match_tier`]:'EXACT',[`${channel}_stock`]:10,[`${channel}_price`]:8200,[`${channel}_base_price`]:8000,[`${channel}_option_price`]:200,[`${channel}_final_price`]:8200});
    row.__hubActivePriceRules[channel]=true;row.__hubRulePrices[channel]={platformBase:14000,platformDiscount:0,platformOption:500,platformFinal:14500,platformTerms:[],ruleNames:['판매처 수식']};
    row.__sellerPriceComponents[channel]={source_base_price:8000,source_discounted_base_price:8000,source_option_price:200,source_final_price:8200,source_discount_terms:[]};
   }
   return row;
  };
  const rows=['A','B','C','D','E','F'].map(create);
  for(const channel of channels){
   rows[1].__priceDecisions[channel]=[{seller_product_code:`${channel}-B`,seller_option_code:'O',price:{base:9000,discounted:9000,option:200,final:9200,terms:[]},revision:2,event_id:`decision-${channel}`,decision_source:'matrix_manual',effective_at:'2026-10-27T00:00:00Z'}];
   rows[2].__sellerDrafts[`${channel}:sellpia_sale_price`]={change_id:`draft-${channel}`,status:'draft',price_base_after:11000,price_discounted_base_after:11000,price_option_after:300,price_final_after:11300,price_discount_terms_after:[]};
  }
  rows[3].__hubInternalPrices.calculated_base_price={value:null,error:'합성 수식 오류',activeOutputRules:[{id:'base'}]};
  rows[4].system_base_price=null;
  rows[5].system_base_price=0;rows[5].actual_inbound_cost=0;rows[5].actual_inbound_cost_mode='';rows[5].__hubInternalPrices={};rows[5].__hubRulePrices={};for(const channel of channels)rows[5].__hubActivePriceRules[channel]=false;
  const rules=[{id:'inbound',scope:'',target_field:'actual_inbound_cost',is_active:true},{id:'base',scope:'',target_field:'calculated_base_price',is_active:true},...channels.map(channel=>({id:channel,scope:channel,target_field:'platform_registration_price',is_active:true}))];
  const assignments=rows.filter(row=>row.sellpia_sku_code!=='F').flatMap(row=>rules.map(rule=>({sku:row.sellpia_sku_code,rule_id:rule.id,scope:rule.scope,target_field:rule.target_field})));
  const state=window.formulaViewFixture={rows,reads:0,calls:[],writes:[],calculations:[],registry:{rules,assignments,dependencies:[]}};
  const expiresAt=new Date(Date.now()+3600000).toISOString();sessionStorage.setItem('system-v3-operations-session-v1',JSON.stringify({token:'a'.repeat(64),expiresAt}));
  const api={mode:'live',pageSize:200,setOperationsHubSessionToken:()=>{},checkOperationsHubSession:async()=>({authenticated:true,expiresAt}),
   loadMatrixGridDataset:async()=>{state.reads++;return {rows:structuredClone(rows),count:rows.length,metrics:{requests:1,bytes:1}};},
   loadMappingSyncStatus:async()=>({}),loadSourceStatus:async()=>({events:[],latest:{}}),loadDashboardMetrics:async()=>({total_sku:rows.length}),
   ruleRegistry:async()=>{state.calls.push('ruleRegistry');return structuredClone(state.registry);},
   loadPendingPurchasePriceRecalculations:async()=>({pendingCount:0,skus:[]}),loadOriginalUploadHistory:async()=>({rows:[],hasMore:false}),loadTagCatalog:async()=>({rows:[]}),loadSellerInventoryPolicies:async()=>[],loadPresets:async()=>[],
   refreshMasterColumnFromSource:async args=>{state.calls.push({name:'sourceRefresh',...args});if(!args.dryRun)state.writes.push(args);return {field_key:args.fieldKey,dry_run:args.dryRun,total_sku_count:6,source_value_count:6,affected_count:0,skipped_count:6,source_missing_count:0};}
  };
  Object.defineProperty(window,'SystemV3Data',{configurable:true,get:()=>new Proxy(api,{get:(target,key)=>key in target?target[key]:/^(save|apply|upsert|upload|remove|delete)/.test(String(key))?async(...args)=>{state.writes.push({name:key,args});return {rows:[],count:0};}:async()=>({rows:[],count:0})}),set:()=>{}});
  Object.defineProperty(window,'HubPriceMaterializer',{configurable:true,get:()=>({materialize:async args=>{state.calculations.push(args);return {};}}),set:()=>{}});
 });
 await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);await page.locator('[data-page="matching"]').first().click();
 await page.waitForFunction(()=>HubMatrixClient?.dataset?.rows.length===6&&document.querySelectorAll('#matrix-body tr[data-sku]').length===6);
 await page.waitForFunction(()=>HubMatrixPriceEditPolicy.ready);
 return page;
}
const toggle='#matrix-formula-view-toggle';
const row=sku=>`#matrix-body tr[data-sku="${sku}"]`;
const base=sku=>`${row(sku)} [data-field-key="system_base_price"]`;
const seller=(sku,channel,component='base')=>`${row(sku)} [data-source="${channel}"][data-price-component="${component}"]`;
const inventory=page=>page.evaluate(()=>({rows:JSON.stringify(HubMatrixClient.dataset.rows),rules:JSON.stringify(formulaViewFixture.registry),reads:formulaViewFixture.reads,calls:formulaViewFixture.calls.length,writes:formulaViewFixture.writes.length,calculations:formulaViewFixture.calculations.length}));

test('formula view defaults on and switches internal and all seller formula prices to stored values without reads, writes or recalculation',async t=>{
 const page=await fixture(t);assert.equal(await page.locator(toggle).getAttribute('aria-pressed'),'true');assert.match(await page.locator(base('A')).innerText(),/12,000/);
 assert.equal(await page.locator(`${row('A')} [data-inbound-cost-edit] b`).innerText(),'2,500');
 for(const channel of ['smartstore','makeshop','ably'])assert.equal(await page.locator(seller('A',channel)).getAttribute('data-value'),'14000');
 const before=await inventory(page);await page.locator(toggle).click();assert.equal(await page.locator(toggle).getAttribute('aria-pressed'),'false');assert.equal(await page.locator(`${base('A')} b`).innerText(),'8,000');
 assert.equal(await page.locator(`${row('A')} [data-inbound-cost-edit] b`).innerText(),'1,500');assert.match(await page.locator(base('A')).innerText(),/원본 저장값/);
 for(const channel of ['smartstore','makeshop','ably'])assert.equal(await page.locator(seller('A',channel)).getAttribute('data-value'),'8000');
 assert.deepEqual(await inventory(page),before);await page.locator(toggle).click();assert.equal(await page.locator(`${base('A')} b`).innerText(),'12,000');assert.deepEqual(await inventory(page),before);
});

test('current manual price decisions and saved operator drafts remain visible when formula display is off',async t=>{
 const page=await fixture(t);await page.locator(toggle).click();
 for(const channel of ['smartstore','makeshop','ably']){
  assert.equal(await page.locator(seller('B',channel)).getAttribute('data-value'),'9000');assert.equal(await page.locator(seller('B',channel,'final')).getAttribute('data-value'),'9200');assert.match(await page.locator(seller('B',channel,'final')).innerText(),/Matrix 수동/);
  assert.equal(await page.locator(seller('C',channel)).getAttribute('data-value'),'11000');assert.equal(await page.locator(seller('C',channel,'final')).getAttribute('data-value'),'11300');assert.match(await page.locator(seller('C',channel,'final')).innerText(),/수정/);
 }
 assert.equal(await page.evaluate(()=>formulaViewFixture.writes.length),0);
});

test('formula output edit locks survive view changes while raw source refresh remains available',async t=>{
 const page=await fixture(t);await page.locator(toggle).click();assert.equal(await page.locator(base('A')).isDisabled(),true);assert.equal(await page.locator(`${row('A')} [data-inbound-cost-edit]`).isDisabled(),true);
 for(const channel of ['smartstore','makeshop','ably'])assert.equal(await page.locator(seller('A',channel)).isDisabled(),true);
 await page.locator(base('A')).dispatchEvent('dblclick');assert.equal(await page.locator(`${base('A')} input`).count(),0);assert.equal(await page.locator('#matrix-bulk-source-refresh-btn').isEnabled(),true);
 await page.locator('#matrix-bulk-source-refresh-btn').click();await page.locator('#bulk-source-refresh-columns input[value="system_base_price"]').check();await page.locator('#bulk-source-refresh-preview-run').click();await page.locator('#bulk-source-refresh-preview').waitFor({state:'visible'});
 assert.equal(await page.evaluate(()=>formulaViewFixture.calls.filter(call=>call.name==='sourceRefresh').length),1);assert.equal(await page.evaluate(()=>formulaViewFixture.writes.length),0);assert.equal(await page.evaluate(()=>formulaViewFixture.calculations.length),0);
});

test('missing stored values, zero and calculation errors stay distinct and a repaint preserves the selected display',async t=>{
 const page=await fixture(t);assert.equal(await page.locator(`${base('D')} b`).innerText(),'계산 오류');await page.locator(toggle).click();
 assert.equal(await page.locator(`${base('D')} b`).innerText(),'8,000');assert.equal(await page.locator(`${base('E')} b`).innerText(),'미설정');assert.equal(await page.locator(`${base('F')} b`).innerText(),'0');
 await page.evaluate(()=>renderLiveMatrixRows(matrixState.rows));assert.equal(await page.locator(toggle).getAttribute('aria-pressed'),'false');assert.equal(await page.locator(`${base('A')} b`).innerText(),'8,000');
 await page.locator(toggle).focus();await page.keyboard.press('Space');assert.equal(await page.locator(toggle).getAttribute('aria-pressed'),'true');assert.equal(await page.locator(`${base('D')} b`).innerText(),'계산 오류');assert.equal(await page.locator(`${base('E')} b`).innerText(),'12,000');assert.equal(await page.locator(`${base('F')} b`).innerText(),'0');
});

test('display toggling preserves pending purchase edits and the exact export price target',async t=>{
 const page=await fixture(t);const purchase=page.locator(`${row('A')} [data-field-key="sellpia_purchase_price"]`);await purchase.dblclick();await purchase.locator('input').fill('3333');await purchase.locator('input').press('Enter');
 const before=await page.evaluate(()=>({pending:SystemV3MatrixEdits.getState(),target:HubCurrentPriceExport.matrixPriceTarget({active_price_rule:true,current_effective_price:HubMatrixClient.dataset.bySku.get('A').__hubRulePrices.smartstore})}));
 await page.locator(toggle).click();assert.equal(await purchase.getAttribute('data-value'),'3333');const after=await page.evaluate(()=>({pending:SystemV3MatrixEdits.getState(),target:HubCurrentPriceExport.matrixPriceTarget({active_price_rule:true,current_effective_price:HubMatrixClient.dataset.bySku.get('A').__hubRulePrices.smartstore})}));
 assert.deepEqual(after,before);assert.equal(after.target.final,14500);assert.equal(await page.evaluate(()=>formulaViewFixture.writes.length),0);assert.equal(await page.evaluate(()=>formulaViewFixture.calculations.length),0);
});
