import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import '../mockups/operations-hub/rule-registry.js';
import '../mockups/operations-hub/discount-price-math.js';
import '../mockups/operations-hub/platform-rule-service.js';
const api=globalThis.HubPlatformRules;
function fixture(){
 const rule={id:'half',name:'매입가 절반',target_field:'calculated_base_price',source_field:'purchase_price',scope:'',input_origin:'self',version:1,is_active:true,config:{steps:[{op:'divide',value:2}]}};
 const products=[{sellpia_sku_code:'3997-1',sellpia_source_purchase_price:28700,system_base_price:22400},{sellpia_sku_code:'3997-2',sellpia_source_purchase_price:34200,system_base_price:26000},{sellpia_sku_code:'zero',sellpia_source_purchase_price:0,system_base_price:500},{sellpia_sku_code:'missing',system_base_price:1000}];
 const registry={rules:[rule],assignments:products.map(p=>({sku:p.sellpia_sku_code,rule_id:rule.id,target_field:rule.target_field,scope:''})),dependencies:[]};
 let registryReads=0,productReads=0,siblingReads=0;
 globalThis.SystemV3Data={ruleRegistry:async()=>{registryReads++;return structuredClone(registry);},workDocument:async()=>[],loadFormulaProducts:async skus=>{productReads++;return structuredClone(products.filter(p=>skus.includes(p.sellpia_sku_code)));},loadRulePlatformSiblings:async skus=>{siblingReads++;return skus;}};
 return {products,registry,reads:()=>({registryReads,productReads,siblingReads})};
}
test('unlinked SKU internal base shows divide2 results, zero and missing input without mutating sources',async()=>{
 const f=fixture(),before=structuredClone(f.products),rows=await api.projectRows(f.products);
 assert.equal(rows[0].__hubInternalPrices.calculated_base_price.value,14350);
 assert.equal(rows[1].__hubInternalPrices.calculated_base_price.value,17100);
 assert.equal(rows[2].__hubInternalPrices.calculated_base_price.value,0);
 assert.ok(rows[3].__hubInternalPrices.calculated_base_price.error);assert.equal(rows[3].__hubInternalPrices.calculated_base_price.value,undefined);
 assert.deepEqual(rows[0].__hubInternalPrices.calculated_base_price.ruleNames,['매입가 절반']);
 assert.deepEqual(f.products,before);assert.equal(rows[0].system_base_price,22400);assert.equal(rows[0].__hubRulePrices,undefined);
 assert.deepEqual(f.reads(),{registryReads:1,productReads:1,siblingReads:0});
 f.registry.assignments=[];const cleared=await api.projectRows(rows);assert.ok(cleared.every(p=>!p.__hubInternalPrices));
});
test('matrix and drawer show effective result first but edit only original stored value',async()=>{
 const f=fixture(),rows=await api.projectRows(f.products),app=await readFile(new URL('../mockups/operations-hub/app.js',import.meta.url),'utf8');
 const context={escapeHtml:v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;'),formatNullableNumber:v=>v==null?'':Number(v).toLocaleString('ko-KR'),formatLiveTime:()=>'',Date};
 vm.createContext(context);vm.runInContext(app.slice(app.indexOf('function internalBasePriceText('),app.indexOf('function channelInventoryCells(')),context);
 const html=context.systemOperationalCell(rows[0],'system_base_price','시스템 기준가격',22400);
 assert.match(html,/<b>14,350<\/b>/);assert.match(html,/수식 결과 · 매입가 절반/);assert.match(html,/원본 저장값 22,400/);assert.match(html,/data-value="22400"/);assert.match(html,/원본 기준가격 저장값/);
 assert.match(context.internalBasePriceText(rows[0]),/수식 결과 14,350.*저장값 22,400/);
 assert.match(context.systemOperationalCell(rows[3],'system_base_price','기준가격',1000),/<b>계산 오류<\/b>/);
 const storedOnly={...f.products[0],__hubInternalPrices:{calculated_base_price:{value:76600,versions:[{id:'half',version:1}]}}};
 assert.match(context.systemOperationalCell(storedOnly,'system_base_price','기준가격',22400),/<b>76,600<\/b>/);
 assert.match(context.internalBasePriceText(storedOnly),/저장된 수식.*저장값 22,400/);
});
test('calculation accepts supplied product and sibling context without another source fetch',async()=>{
 const f=fixture();f.products[0].__sellerPriceComponents={ably:{seller_product_code:'p',seller_option_code:'o',source_discount_terms:[]}};
 const result=await api.calculate(['3997-1'],'ably',{registry:f.registry,config:{body:{source:'ably',mode:'forward',anchor:'lowest'}},products:Object.fromEntries(f.products.map(p=>[p.sellpia_sku_code,p])),siblings:[]});
 assert.deepEqual(result.errors,[]);assert.equal(result.rows[0].platformFinal,14350);assert.deepEqual(f.reads(),{registryReads:0,productReads:0,siblingReads:0});
});

test('compact base cell marks active formula ownership with detail proof without changing the value or edit target',async()=>{
 const app=await readFile(new URL('../mockups/operations-hub/app.js',import.meta.url),'utf8');
 const shadow=await readFile(new URL('../mockups/operations-hub/matrix-shadow.js',import.meta.url),'utf8');
 const context={escapeHtml:v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;'),formatNullableNumber:v=>v==null?'':Number(v).toLocaleString('ko-KR'),formatLiveTime:()=>'',Date};
 vm.createContext(context);vm.runInContext(shadow,context);
 vm.runInContext(app.slice(app.indexOf('function internalBasePriceText('),app.indexOf('function channelInventoryCells(')),context);
 const product={sellpia_sku_code:'5566-1',system_base_price:80000,__hubInternalPrices:{calculated_base_price:{value:59000,activeOutputRules:[{id:'base-2.2'}],versions:[{id:'base-2.2',version:1}],ruleNames:['14K_실입고가_2.2배율'],generationId:34}},__hubShadow:{smartstore:{internalInputFingerprint:'current',calculated:[{scope:'',field:'calculated_base_price',result_details:{input_fingerprint:'current'}}]}}};
 const before=structuredClone(product),render=p=>context.systemOperationalCell(p,'system_base_price','기준가격',80000),html=render(product);
 assert.match(html,/<b>59,000<\/b>/);assert.match(html,/data-value="80000"/);
 assert.match(html,/<\/button><span class="shadow-markers">/);
 assert.match(html,/class="shadow-marker formula"[^>]*>fx<\/button>/);
 assert.match(html,/title="[^"]*14K_실입고가_2.2배율[^"]*계산 세대: 34[^"]*상태: 최신/);
 assert.deepEqual(product,before);
 const inactive=structuredClone(product);inactive.__hubInternalPrices.calculated_base_price.activeOutputRules=[];
 assert.doesNotMatch(render(inactive),/shadow-marker/);
 assert.doesNotMatch(render({system_base_price:4000}),/shadow-marker/);
 const stale=structuredClone(product);stale.__hubInternalPrices.calculated_base_price.stale=true;
 assert.match(render(stale),/>↻<\/button>/);assert.match(render(stale),/상태: 재계산 필요/);
});
