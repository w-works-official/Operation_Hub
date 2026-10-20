import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../mockups/operations-hub/matrix-price-edit-policy.js',import.meta.url),'utf8');
function harness(read=async()=>({rules:[],assignments:[]})){
 const window={SystemV3Data:{ruleRegistry:read}};vm.runInNewContext(source,{window});return window.HubMatrixPriceEditPolicy;
}
const product=(sku='A',extra={})=>({sellpia_sku_code:sku,...extra});
function registry(definitions){return {rules:definitions.map(([sku,field,scope='',extra={}],index)=>({id:'r'+index,name:field,is_active:true,target_field:field,scope,...extra})),assignments:definitions.map(([sku,field,scope=''],index)=>({sku,target_field:field,scope,rule_id:'r'+index})),dependencies:[]};}

test('unknown ownership fails closed only for price outputs and permits raw starting inputs',()=>{
 const policy=harness();
 for(const field of ['sellpia_purchase_price','sellpia_order_unit','sellpia_minimum_order_unit','system_stock','sellpia_own_code'])assert.equal(policy.policy(product(),{field}).locked,false);
 for(const field of ['actual_inbound_cost','system_base_price'])assert.equal(policy.policy(product(),{field}).locked,true);
 assert.equal(policy.policy(product(),{source:'smartstore',component:'base'}).known,false);
});

test('active internal outputs and inherited intermediate base stay locked even on calculation errors',()=>{
 const policy=harness();policy.setRegistry(registry([['A','actual_inbound_cost']]));
 const row=product('A',{__hubInternalPrices:{actual_inbound_cost:{error:'calculation failed'}}});
 for(const field of ['actual_inbound_cost','basis_sku_price','system_base_price'])assert.equal(policy.policy(row,{field}).locked,true);
 assert.equal(policy.policy(row,{field:'sellpia_purchase_price'}).locked,false);
 assert.equal(policy.policy(product('B'),{field:'system_base_price'}).locked,false);
});

test('discount-only assignment keeps seller base and option inputs editable and locks dependent final',()=>{
 const policy=harness();policy.setRegistry(registry([['A','platform_discount_price','smartstore']]));
 for(const component of ['base','option'])assert.equal(policy.policy(product(),{source:'smartstore',component}).locked,false);
 for(const component of ['discount','final'])assert.equal(policy.policy(product(),{source:'smartstore',component}).locked,true);
 assert.equal(policy.policy(product(),{source:'makeshop',component:'final'}).locked,false);
});

test('registration formula owns its downstream discounts, option projection and final',()=>{
 const policy=harness();policy.setRegistry(registry([['A','platform_registration_price','smartstore']]));
 for(const component of ['base','discount','option','final'])assert.equal(policy.policy(product(),{source:'smartstore',component}).locked,true);
});

test('option and final rules lock their actual implicit outputs without locking unrelated inputs',()=>{
 const policy=harness();policy.setRegistry(registry([['A','platform_option_price','smartstore'],['B','platform_final_price','smartstore']]));
 for(const sku of ['A','B']){
  for(const component of ['option','final'])assert.equal(policy.policy(product(sku),{source:'smartstore',component}).locked,true);
  for(const component of ['base','discount'])assert.equal(policy.policy(product(sku),{source:'smartstore',component}).locked,false);
 }
});

test('inactive, mismatched and historical result ownership cannot override a current empty registry',()=>{
 const policy=harness();policy.setRegistry(registry([['A','calculated_base_price','',{is_active:false}]]));
 const row=product('A',{__hubInternalPrices:{calculated_base_price:{activeOutputRules:[{name:'old formula'}],versions:[{id:'old'}]}},__hubActivePriceRules:{smartstore:true}});
 assert.equal(policy.policy(row,{field:'system_base_price'}).locked,false);
 assert.equal(policy.policy(row,{source:'smartstore',component:'base'}).locked,false);
 const invalid=registry([['A','calculated_base_price']]);invalid.assignments[0].target_field='basis_sku_price';policy.setRegistry(invalid);
 assert.equal(policy.policy(row,{field:'system_base_price'}).locked,false);
});

test('bounded internal metadata can lock while registry loads and an explicit empty ownership list is clear',()=>{
 const policy=harness();
 assert.equal(policy.policy(product('A',{__hubInternalPrices:{actual_inbound_cost:{activeOutputRules:[{name:'half',output_field:'actual_inbound_cost'}],error:'failed'}}}),{field:'system_base_price'}).locked,true);
 assert.equal(policy.policy(product('A',{__hubInternalPrices:{calculated_base_price:{activeOutputRules:[],versions:[{id:'old'}]}}}),{field:'system_base_price'}).locked,false);
});

test('active legacy inbound tag is independent of unified registry, but stale tag ids are not ownership',()=>{
 const policy=harness();policy.setRegistry(registry([]));
 assert.equal(policy.policy(product('A',{actual_inbound_cost_mode:'formula',inbound_cost_formula_tag_id:1,inbound_cost_formula_tag_name:'Half'}),{field:'actual_inbound_cost'}).locked,true);
 assert.equal(policy.policy(product('A',{actual_inbound_cost_mode:'formula',inbound_cost_formula_tag_id:1}),{field:'actual_inbound_cost'}).locked,false);
});

test('registry hydration coalesces concurrent reads and explicit refresh catches a newly assigned output',async()=>{
 let calls=0,value=registry([]);const policy=harness(async()=>{calls++;return value;});
 await Promise.all([policy.ensure(),policy.ensure(),policy.ensure()]);assert.equal(calls,1);
 value=registry([['A','calculated_base_price']]);await policy.ensure({force:true});assert.equal(calls,2);
 assert.equal(policy.policy(product(),{field:'system_base_price'}).locked,true);
});

test('logout/reset ignores late ownership replies and a failed read never unlocks unknown prices',async()=>{
 let release;const policy=harness(()=>new Promise(resolve=>{release=resolve;}));const pending=policy.ensure();policy.reset();release(registry([]));await pending;
 assert.equal(policy.ready,false);assert.equal(policy.policy(product(),{field:'system_base_price'}).locked,true);
 const failed=harness(async()=>{throw Error('network unavailable');});await assert.rejects(failed.ensure(),/network/);
 assert.equal(failed.policy(product(),{source:'smartstore',component:'final'}).locked,true);
 assert.equal(failed.policy(product(),{field:'sellpia_purchase_price'}).locked,false);
});
