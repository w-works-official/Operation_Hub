import test from 'node:test';
import assert from 'node:assert/strict';
import '../mockups/operations-hub/rule-registry.js';
import '../mockups/operations-hub/discount-price-math.js';
import '../mockups/operations-hub/platform-rule-service.js';

const api=globalThis.HubPlatformRules;
const sources=['smartstore','makeshop','ably'];
const rule=(id,target,source,steps=[],extra={})=>({id,name:id,target_field:target,source_field:source,scope:'ably',input_origin:'self',version:1,is_active:true,config:{steps},...extra});

function fixture(){
 const rules=[
  rule('registration','platform_registration_price','basis_sku_price',[{op:'add',value:1000}]),
  rule('discount','platform_discount_price','platform_registration_price',[{op:'subtract',value:500}]),
  rule('option','platform_option_price','platform_option_input',[{op:'add',value:300}]),
  rule('final','platform_final_price','platform_final_input',[{op:'add',value:200}]),
 ];
 const assignments=[];
 const products=['A','B'].map(sku=>({
  sellpia_sku_code:sku,
  system_base_price:5000,
  __sellerPriceComponents:{ably:{seller_product_code:'seller-product',seller_option_code:sku,source_base_price:4000,source_option_price:0,source_final_price:4000,source_discount_terms:[]}},
  __sellerDrafts:{},
 }));
 for(const product of products)for(const r of rules)assignments.push({sku:product.sellpia_sku_code,rule_id:r.id,target_field:r.target_field,scope:'ably',version:1});
 const registry={rules,assignments,dependencies:[]};
 const config={id:'platform',title:'registry-platform:ably',version:1,body:{source:'ably',mode:'forward',anchor:'lowest',registration_rule_id:null,discount_rule_id:null}};
 const qa={writes:0,generations:0};
 globalThis.SystemV3Data={
  ruleRegistry:async()=>structuredClone(registry),
  workDocument:async()=>structuredClone(config),
  loadRulePlatformSiblings:async()=>products.map(p=>p.sellpia_sku_code),
  loadFormulaProducts:async skus=>structuredClone(products.filter(p=>skus.includes(p.sellpia_sku_code))),
  beginCalculationGeneration:async()=>{qa.generations++;throw Error('candidate must not start persistence');},
  upsertCalculatedPriceResults:async()=>{qa.writes++;throw Error('candidate must not persist');},
 };
 const setDraft=(sku,values)=>{products.find(p=>p.sellpia_sku_code===sku).__sellerDrafts['ably:sellpia_sale_price']={
  change_id:17,status:'pending',pricing_input_mode:'option',base_price_source:'source',option_price_source:'original',
  price_base_after:9000,price_option_after:0,price_final_after:9000,price_discount_terms_after:[],price_discount_terms_before:[],...values,
 };};
 const removeFinalRule=()=>{registry.rules=registry.rules.filter(r=>r.id!=='final');registry.assignments=registry.assignments.filter(a=>a.rule_id!=='final');};
 const calculate=(context={})=>api.calculate(['A'],'ably',context);
 return {products,registry,qa,setDraft,removeFinalRule,calculate};
}

test('1 default calculation continues to preserve a manual option draft',async()=>{
 const f=fixture();f.removeFinalRule();f.setDraft('A',{option_price_source:'manual',price_option_after:125});
 const result=await f.calculate();assert.deepEqual(result.errors,[]);assert.equal(result.rows.find(r=>r.sku==='A').platformOption,125);
});

test('2 explicit candidate ignores a manual option draft but applies the active option Rule',async()=>{
 const f=fixture();f.removeFinalRule();f.setDraft('A',{option_price_source:'manual',price_option_after:125});
 const result=await f.calculate({ignoreManualIntent:true});assert.deepEqual(result.errors,[]);assert.equal(result.rows.find(r=>r.sku==='A').platformOption,300);
});

test('3 explicit candidate ignores a fixed manual final-price draft',async()=>{
 const f=fixture();f.setDraft('A',{pricing_input_mode:'final',option_price_source:'manual',price_option_after:800,price_final_after:7777});
 const result=await f.calculate({ignoreManualIntent:true});const row=result.rows.find(r=>r.sku==='A');
 assert.deepEqual(result.errors,[]);assert.equal(row.platformBase,6000);assert.equal(row.platformDiscount,500);assert.equal(row.platformOption,500);assert.equal(row.platformFinal,6000);
});

test('4 explicit candidate ignores a manual base-price draft and uses current registered Rule output',async()=>{
 const f=fixture();f.setDraft('A',{base_price_source:'manual',price_base_after:7777});
 const result=await f.calculate({ignoreManualIntent:true});assert.deepEqual(result.errors,[]);assert.ok(result.rows.every(r=>r.platformBase===6000));
});

test('5 explicit candidate ignores manual discount terms but keeps the active discount Rule',async()=>{
 const f=fixture();f.setDraft('A',{price_discount_terms_after:[{term_key:'basic',is_baseline:true,input_source:'manual',unit:'amount',value:1000,rounding_unit:1,rounding_mode:'nearest'}]});
 const result=await f.calculate({ignoreManualIntent:true});assert.deepEqual(result.errors,[]);assert.ok(result.rows.every(r=>r.platformDiscount===500));
});

test('6 explicit candidate ignores legacy tag-derived draft fields without disabling Rules',async()=>{
 const f=fixture();f.setDraft('A',{pricing_input_mode:'rule_tags',base_price_source:'tag',option_price_source:'tag',price_base_after:1234,price_option_after:432,price_final_after:1666});
 const result=await f.calculate({ignoreManualIntent:true});assert.deepEqual(result.errors,[]);assert.equal(result.rows.find(r=>r.sku==='A').platformFinal,6000);
});

test('7 explicit candidate uses current source input after it changes, not draft after-values',async()=>{
 const f=fixture();f.products.forEach(p=>{p.system_base_price=7000;});f.setDraft('A',{base_price_source:'manual',price_base_after:11111});
 const result=await f.calculate({ignoreManualIntent:true});assert.deepEqual(result.errors,[]);assert.ok(result.rows.every(r=>r.platformBase===8000));
});

test('8 explicit candidate still follows the assigned final Rule and includes Rule versions',async()=>{
 const f=fixture();f.setDraft('A',{pricing_input_mode:'final',price_final_after:99999});
 const result=await f.calculate({ignoreManualIntent:true});const row=result.rows.find(r=>r.sku==='A');
 assert.deepEqual(result.errors,[]);assert.equal(row.platformFinal,6000);assert.ok(row.versions.some(v=>v.id==='final'&&v.version===1));
});

test('9 candidate input remains product-group complete for shared registration and discount values',async()=>{
 const f=fixture();f.setDraft('A',{base_price_source:'manual',price_base_after:12000});
 const result=await f.calculate({ignoreManualIntent:true});assert.deepEqual(result.errors,[]);assert.deepEqual(result.rows.map(r=>r.sku).sort(),['A','B']);
 assert.ok(result.rows.every(r=>r.platformBase===6000&&r.platformDiscount===500&&r.platformFinal===6000));
});

test('10 candidate mode is pure and opt-in; ordinary draft-aware behavior remains available',async()=>{
 const f=fixture();f.removeFinalRule();f.setDraft('A',{option_price_source:'manual',price_option_after:125});
 const candidate=await f.calculate({ignoreManualIntent:true});const ordinary=await f.calculate();
 assert.equal(candidate.rows.find(r=>r.sku==='A').platformOption,300);assert.equal(ordinary.rows.find(r=>r.sku==='A').platformOption,125);
 assert.equal(f.qa.generations,0);assert.equal(f.qa.writes,0);
});
