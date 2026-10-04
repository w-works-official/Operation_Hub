import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
await import('../mockups/operations-hub/tag-price-workspace.js');
const calculate=globalThis.TagPriceModel.calculate;
const base={enabled:true,basis:'purchase',multiplier:1,add:0,unit:1,rounding:'nearest'};
test('legacy formula selection permits distinct outputs and platform scopes without global single-tag restriction',()=>{
 const products={sku:{sellpia_source_purchase_price:10000,__profile:{sku_tags:[{tag_id:'inbound'},{tag_id:'base'},{tag_id:'smart'},{tag_id:'makes'}]}}};
 const formulas={inbound:{...base,output_field:'actual_inbound_cost',multiplier:.5},base:{...base,output_field:'calculated_base_price',multiplier:2},smart:{...base,output_field:'platform_registration_price',scope:'smartstore',add:2000},makes:{...base,output_field:'platform_registration_price',scope:'makeshop',add:3000}};
 assert.equal(calculate('sku',products,formulas,{}).value,20000);
 assert.equal(calculate('sku',products,formulas,{},[],{output_field:'actual_inbound_cost',scope:''}).value,5000);
 assert.equal(calculate('sku',products,formulas,{},[],{output_field:'platform_registration_price',scope:'smartstore'}).value,12000);
 products.sku.__profile.sku_tags.push({tag_id:'rival'});formulas.rival={...base,output_field:'actual_inbound_cost',name:'rival inbound'};
 assert.throws(()=>calculate('sku',products,formulas,{},[],{output_field:'actual_inbound_cost',scope:''}),/actual_inbound_cost.*2개.*rival inbound/);
 assert.equal(calculate('sku',products,formulas,{}).value,20000);
});
const source=fs.readFileSync('mockups/operations-hub/data-service.js','utf8');
function extract(name){const start=source.indexOf('  async function '+name+'(');assert.ok(start>=0,name);const rest=source.slice(start+2),end=rest.slice(2).search(/\n  (?:async )?function /);return end<0?rest:rest.slice(0,end+2);}
test('stored inbound history requires its own active output owner even while another formula remains',async()=>{
 const rows=[{sku:'inactive',field:'actual_inbound_cost',status:'calculated',value:48000,rule_versions:[{id:'old',version:17,name:'old inbound'}],active_output_rules:[],generation_id:17},{sku:'active',field:'actual_inbound_cost',status:'calculated',value:5000,rule_versions:[{id:'inbound',version:1,name:'old Rule name'}],active_output_rules:[{id:'inbound',tag_id:'half',tag_name:'renamed half',output_field:'actual_inbound_cost'}],generation_id:9}];
 const context={cleanText:v=>String(v??'').trim(),throwIfAborted:()=>{},loadCalculatedResults:async()=>({rows}),loadStoredMatrixPrices:async()=>({rows:[],activePriceRules:[]}),console};
 vm.createContext(context);vm.runInContext(extract('attachStoredCalculatedPrices')+'\nthis.read=attachStoredCalculatedPrices',context);
 const values=await context.read([{sellpia_sku_code:'inactive',actual_inbound_cost:null,__profile:{sku_tags:[{tag_id:'base',tag_name:'base x2',tag_group:'가격 수식'}]}},{sellpia_sku_code:'active',actual_inbound_cost:null,__profile:{sku_tags:[{tag_id:'half',tag_name:'renamed half',tag_group:'가격 수식'}]}}]);
 assert.equal(values[0].__hubInternalPrices,undefined);assert.equal(values[0].actual_inbound_cost,null);
 assert.equal(values[1].__hubInternalPrices.actual_inbound_cost.value,5000);
 assert.deepEqual(JSON.parse(JSON.stringify(values[1].__hubInternalPrices.actual_inbound_cost.ruleNames)),['renamed half']);
 assert.equal(values[1].__hubInternalPrices.actual_inbound_cost.generationId,9);
});
test('tag rename adapter uses session-gated name-only RPC with expected name and never direct table writes',async()=>{
 const calls=[],context={cleanText:v=>String(v??'').trim(),requireOperationsHubSessionToken:()=> 'mock-session',readableDatabaseError:e=>e,db:{rpc:async(name,args)=>{calls.push({name,args});return {data:{tag_id:args.p_tag_id,tag_name:args.p_name},error:null};}}};
 vm.createContext(context);vm.runInContext(extract('renameProductTag')+'\nthis.rename=renameProductTag',context);
 const result=await context.rename({id:'stable-tag',name:' renamed ',expectedName:'original'});
 assert.equal(result.tag_id,'stable-tag');assert.equal(result.tag_name,'renamed');assert.equal(calls[0].name,'hub_product_tag_rename_v1');assert.equal(calls[0].args.p_expected_name,'original');assert.equal(calls[0].args.p_session_token,'mock-session');
 assert.equal('p_rule' in calls[0].args,false);assert.equal('p_color' in calls[0].args,false);
});
