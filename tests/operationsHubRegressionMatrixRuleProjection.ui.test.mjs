import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {chromium} from 'playwright';
await import('../mockups/operations-hub/rule-registry.js');
await import('../mockups/operations-hub/discount-price-math.js');
await import('../mockups/operations-hub/platform-rule-service.js');
const sources=['smartstore','makeshop','ably'];
const rules=[{id:'test-system-base',name:'전체 테스트 태그',is_active:true,version:4,target_field:'calculated_base_price',source_field:'basis_sku_price',input_origin:'self',scope:'',config:{steps:[{op:'multiply',value:1}]}}];
const registry={rules,assignments:['one','two'].map(sku=>({sku,rule_id:'test-system-base',target_field:'calculated_base_price',scope:'',version:1})),dependencies:[]};
const components=(sku)=>Object.fromEntries(sources.map(source=>[source,{seller_product_code:'product',seller_option_code:sku,source_base_price:4000,source_option_price:sku==='one'?0:500,source_final_price:sku==='one'?4000:4500,source_discount_terms:[]}]));
const products=['one','two'].map((sku,index)=>({sellpia_sku_code:sku,system_base_price:10000+index*2000,system_stock:10,__sellerPriceComponents:components(sku),...Object.fromEntries(sources.flatMap(source=>[[source+'_product_code','product'],[source+'_price',sku==='one'?4000:4500],[source+'_stock',10]]))}));
let reads=0,registryReads=0;const siblingSources=[];
globalThis.SystemV3Data={
 async ruleRegistry(){registryReads++;return structuredClone(registry);},
 async workDocument(action,kind,payload){const docs=sources.map(source=>({id:source,title:'registry-platform:'+source,body:{source,mode:'reverse',anchor:'lowest',registration_rule_id:null,discount_rule_id:null}}));return structuredClone(action==='list'?docs:docs.find(d=>d.id===payload.id));},
 async loadRulePlatformSiblings(skus,source){siblingSources.push(source);return ['one','two'];},
 async loadFormulaProducts(skus){reads++;return structuredClone(products.filter(p=>skus.includes(p.sellpia_sku_code)));},
};
const inputBefore=JSON.stringify(products);
let projected=await HubPlatformRules.projectRows(products);
assert.equal(JSON.stringify(products),inputBefore,'projection must not mutate source rows');
assert.equal(registryReads,1,'internal and all platform calculations reuse one registry snapshot');
assert.deepEqual(siblingSources,sources,'each platform resolves its own product siblings once');
assert.equal(reads,1+siblingSources.length,'one internal-base source read plus one product-group read per platform');
for(const row of projected){assert.equal(row.__hubInternalPrices.calculated_base_price.value,row.system_base_price);assert.deepEqual(row.__hubInternalPrices.calculated_base_price.ruleNames,['전체 테스트 태그']);}
for(const row of projected)for(const source of sources){assert.equal(row.__hubRulePrices[source].platformFinal,row.system_base_price);assert.deepEqual(row.__hubRulePrices[source].ruleNames,['전체 테스트 태그']);}
for(const source of sources){products[1].__sellerDrafts??={};products[1].__sellerDrafts[source+':sellpia_sale_price']={change_id:7,pricing_input_mode:'option',base_price_source:'rule',option_price_source:'manual',price_base_after:4000,price_option_after:300,price_final_after:4300,status:'pending'};}
projected=await HubPlatformRules.projectRows(products);
for(const source of sources){assert.equal(projected[1].__hubRulePrices[source].platformBase,10000);assert.equal(projected[1].__hubRulePrices[source].platformOption,300);assert.equal(projected[1].__hubRulePrices[source].platformFinal,10300,'manual option300 derives from latest calculated base10000, not stale draftbase4000');}

const app=fs.readFileSync(new URL('../mockups/operations-hub/app.js',import.meta.url),'utf8');
const context={discountPriceMath:globalThis.SystemV3DiscountPriceMath,escapeHtml:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),matchState:()=>({key:'matched',label:'매칭'}),sellerIdentityCells:()=>'',formatNullableNumber:v=>v==null?'—':Number(v).toLocaleString('ko-KR'),calculateNativeDiscountedBase:base=>base,nativeDiscountSummary:()=>'',matrixDiscountSummary:()=>({summary:'할인 없음',hasDiscount:false,detail:''})};
vm.createContext(context);
vm.runInContext(app.slice(app.indexOf('function internalBasePriceText('),app.indexOf('function sellpiaProductGroupKey('))+'\nthis.render=channelInventoryCells;',context);
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage();await page.route('**/*',route=>route.abort());
 await page.setContent('<table><tbody><tr><td>'+context.systemOperationalCell(projected[1],'system_base_price','기준가격',12000)+'</td></tr></tbody></table>');
 const internal=page.locator('.system-master-cell');
 assert.equal(await internal.locator('b').innerText(),'12,000','internal base displays this SKU result, not the platform group anchor10000');
 assert.match(await internal.innerText(),/수식 결과 · 전체 테스트 태그/);assert.match(await internal.innerText(),/원본 저장값 12,000/);
 assert.equal(await internal.getAttribute('data-value'),'12000','inline edit still targets the stored source value');
 assert.equal(await internal.getAttribute('data-field-key'),'system_base_price');
 for(const source of sources){
  await page.setContent('<table><tbody><tr>'+context.render(projected[1],source,source)+'</tr></tbody></table>');
  // The shadow calculation is 10000/10300 above. Before production cutover,
  // this renderer preserves the saved draft tuple 4000/4300 as instructed.
  assert.equal(await page.locator('.price-component-base').getAttribute('data-value'),'4000');
  assert.equal(await page.locator('.price-component-final').getAttribute('data-value'),'4300');
  assert.equal(await page.locator('.price-component-final').getAttribute('data-option-price'),'300');
  assert.equal(await page.locator('.price-rule-badge').innerText(),'fx ↻');
  assert.match(await page.locator('.price-component-base').getAttribute('title'),/전체 테스트 태그/);
  if(source!=='ably')assert.equal(await page.locator('.price-component-option').getAttribute('data-value'),'300');
 }
 const withoutSource=structuredClone(projected[0]);withoutSource.smartstore_price=null;withoutSource.__sellerPriceComponents.smartstore.source_final_price=null;
 await page.setContent('<table><tbody><tr>'+context.render(withoutSource,'smartstore','스마트스토어')+'</tr></tbody></table>');
 assert.equal(await page.locator('.price-component-final').count(),1,'valid calculated price must remain visible even when original source price is unavailable');
 assert.equal(await page.locator('.price-component-final').getAttribute('data-value'),'10000');
}finally{await browser.close();}
console.log('PASS internal base result and original edit target, all three platform DOM prices, one registry snapshot, source immutability, manual option300 and missing source-price display');
