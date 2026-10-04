import test from 'node:test';
import assert from 'node:assert/strict';
import '../mockups/operations-hub/rule-registry.js';
import '../mockups/operations-hub/discount-price-math.js';
import '../mockups/operations-hub/platform-rule-service.js';
const api=globalThis.HubPlatformRules;
const rule=(id,target,source,steps=[])=>({id,name:id,target_field:target,source_field:source,scope:'ably',input_origin:'self',version:1,is_active:true,config:{steps}});
function fixture(){
 const registry={rules:[rule('identity-registration','platform_registration_price','basis_sku_price'),rule('identity-discount','platform_discount_price','platform_registration_price')],assignments:[],dependencies:[]};
 const config={id:'settings',title:'registry-platform:ably',version:1,body:{source:'ably',mode:'forward',anchor:'lowest',registration_rule_id:'identity-registration',discount_rule_id:'identity-discount'}};
 const product=sku=>({sellpia_sku_code:sku,system_base_price:5400,__sellerPriceComponents:{ably:{seller_product_code:'p',seller_option_code:sku,source_base_price:5400,source_option_price:0,source_final_price:5400,source_discount_terms:[]}},__sellerDrafts:{}});
 const products=[product('A'),product('B')];let configured=true,loads=0;
 globalThis.SystemV3Data={ruleRegistry:async()=>structuredClone(registry),workDocument:async action=>action==='list'?(configured?[{id:config.id,title:config.title}]:[]):['get','get_title'].includes(action)?(configured?structuredClone(config):null):{},loadRulePlatformSiblings:async()=>products.map(p=>p.sellpia_sku_code),loadFormulaProducts:async skus=>{loads++;return structuredClone(products.filter(p=>skus.includes(p.sellpia_sku_code)));}};
 const draft=(sku,changes)=>products.find(p=>p.sellpia_sku_code===sku).__sellerDrafts['ably:sellpia_sale_price']={change_id:1,status:'pending',pricing_input_mode:'option',base_price_source:'source',option_price_source:'original',price_base_after:5400,price_option_after:0,price_final_after:5400,price_discount_terms_after:[],price_discount_terms_before:[],...changes};
 return {registry,config,products,draft,calculate:()=>api.calculate(['A'],'ably'),disable:()=>{configured=false;registry.assignments=[];},loads:()=>loads};
}
test('manual option preserves only300 and derives current final instead of stale draft final',async()=>{
 const f=fixture();f.draft('A',{option_price_source:'manual',price_option_after:300,price_final_after:99999});
 let r=await f.calculate();assert.deepEqual(r.errors,[]);let a=r.rows.find(r=>r.sku==='A');assert.equal(a.platformOption,300);assert.equal(a.platformFinal,5700);
 f.products.forEach(p=>p.system_base_price=6000);r=await f.calculate();a=r.rows.find(r=>r.sku==='A');assert.equal(a.platformFinal,6300);assert.equal(a.platformOption,300);
});
test('explicit final input is fixed and derives option from latest discounted base',async()=>{
 const f=fixture();f.draft('A',{pricing_input_mode:'final',option_price_source:'manual',price_option_after:300,price_final_after:7000});
 f.registry.rules.push(rule('final','platform_final_price','platform_final_input',[{op:'add',value:500}]));f.registry.assignments.push({sku:'A',rule_id:'final',scope:'ably',target_field:'platform_final_price'});
 const r=await f.calculate();assert.deepEqual(r.errors,[]);const a=r.rows.find(r=>r.sku==='A');assert.equal(a.platformFinal,7000);assert.equal(a.platformOption,1600);
});
test('manual common base propagates productwide and percentage rule is recalculated',async()=>{
 const f=fixture();f.registry.rules[1].config.steps=[{op:'multiply',value:0.9}];
 f.draft('A',{base_price_source:'manual',price_base_after:6000,option_price_source:'manual',price_option_after:300});
 const r=await f.calculate();assert.deepEqual(r.errors,[]);assert.ok(r.rows.every(r=>r.platformBase===6000&&r.platformDiscount===600));assert.equal(r.rows.find(r=>r.sku==='A').platformFinal,5700);
});
test('real manual discount overrides rule while tag-generated derived drafts are ignored',async()=>{
 const f=fixture();f.draft('A',{base_price_source:'tag',option_price_source:'tag',pricing_input_mode:'rule_tags',price_base_after:999,price_option_after:99,price_final_after:1098});
 let r=await f.calculate();assert.equal(r.rows.find(r=>r.sku==='A').platformFinal,5400);
 f.draft('A',{price_discount_terms_after:[{term_key:'basic',is_baseline:true,input_source:'manual',unit:'percent',value:10,rounding_unit:1,rounding_mode:'nearest'}]});
 r=await f.calculate();assert.deepEqual(r.errors,[]);assert.ok(r.rows.every(r=>r.platformDiscount===540&&r.platformFinal===4860));
});
test('conflicting manual group bases and option versus final rule fail clearly',async()=>{
 const f=fixture();f.draft('A',{base_price_source:'manual',price_base_after:6000});f.draft('B',{base_price_source:'manual',price_base_after:7000});
 let r=await f.calculate();assert.ok(r.errors.every(r=>/수동 판매가/.test(r.error)));assert.equal(r.errors.length,2);
 f.products[1].__sellerDrafts={};f.draft('A',{option_price_source:'manual',price_option_after:300});
 f.registry.rules.push(rule('final','platform_final_price','platform_final_input',[{op:'add',value:500}]));f.registry.assignments.push({sku:'A',rule_id:'final',scope:'ably',target_field:'platform_final_price'});
 r=await f.calculate();assert.match(r.errors.find(r=>r.sku==='A').error,/수동 옵션가와 최종가격 Rule/);
});
test('matrix projection uses shared effective calculation and leaves unconfigured products unchanged',async()=>{
 const f=fixture();f.draft('A',{option_price_source:'manual',price_option_after:300});
 let projected=await api.projectRows(f.products);assert.equal(projected[0].__hubRulePrices.ably.platformFinal,5700);assert.deepEqual(projected[0].__hubRulePrices.ably.ruleNames,['identity-registration','identity-discount']);assert.equal(projected[0].__sellerPriceComponents.ably.source_final_price,5400);
 f.disable();const priorLoads=f.loads();projected=await api.projectRows(f.products);assert.equal(projected[0],f.products[0]);assert.equal(f.loads(),priorLoads);
});
test('supplied calculation context and matrix projection do not redownload registry assignments',async()=>{
 const f=fixture();let registryReads=0;
 const read=globalThis.SystemV3Data.ruleRegistry;globalThis.SystemV3Data.ruleRegistry=async(...args)=>{registryReads++;return read(...args);};
 const direct=await api.calculate(['A'],'ably',{registry:f.registry,config:f.config});assert.deepEqual(direct.errors,[]);assert.equal(registryReads,0);
 const projected=await api.projectRows(f.products);assert.equal(projected[0].__hubRulePrices.ably.platformFinal,5400);assert.equal(registryReads,1);
});
