import test from 'node:test';
import assert from 'node:assert/strict';
await import('../mockups/operations-hub/representative-price.js');
await import('../mockups/operations-hub/rule-registry.js');
const {calculate,metadata}=globalThis.HubRepresentativePrice;
function fixture(values=[4000,5000,6000],selection='lower_middle'){
 const product_identity='sellpia-product:fixture',rule={...metadata,product_identity,id:'representative-rule',tag_id:'representative-tag',version:1,is_active:true,selection};
 const options=values.map((value,i)=>({sku:'fixture-'+(i+1),option_identity:'option-'+(i+1),product_identity,calculated_base_price:{field:'calculated_base_price',value,status:'calculated',freshness:'fresh',generation_id:4,input_fingerprint:'fp-'+i,current_input_fingerprint:'fp-'+i,lineage_valid:true,rule_versions:[{id:'base-'+i,version:2}],active_rule_versions:[{id:'base-'+i,version:2}]}}));
 return {product_identity,membership:{product_identity,complete:true,options:options.map(({sku,option_identity})=>({sku,option_identity})),fingerprint:'membership-v1',current_fingerprint:'membership-v1'},assignments:[rule],options};
}
test('representative lower-middle selects a real price for odd/even option counts and lowest preserves zero',()=>{
 assert.equal(calculate(fixture()).value,5000);assert.equal(calculate(fixture([4000,5000,6000,7000])).value,5000);
 assert.equal(calculate(fixture([6000,4000,5000],'lowest')).value,4000);assert.equal(calculate(fixture([0,4000],'lowest')).value,0);
 const tie=calculate(fixture([5000,5000,7000]));assert.deepEqual(tie.selected_options,['fixture-1','fixture-2']);
 assert.equal(tie.shadow_only,true);assert.equal(tie.production_target,false);
});
test('representative direct input requires exactly one explicit SKU or option identity in the product',()=>{
 const f=fixture();f.assignments[0].selection='direct';f.assignments[0].direct_identity={sku:'fixture-3'};assert.equal(calculate(f).value,6000);
 f.assignments[0].direct_identity={option_identity:'option-1'};assert.equal(calculate(f).value,4000);
 for(const identity of [{},{sku:'other-product'},{sku:'fixture-1',option_identity:'option-1'}]){f.assignments[0].direct_identity=identity;assert.equal(calculate(f).status,'blocked');}
});
test('stale or legacy stored base values cannot contribute or silently shrink the product',()=>{
 const f=fixture();f.options[1].calculated_base_price.freshness='stale';let r=calculate(f);assert.equal(r.status,'stale');assert.equal(r.value,null);
 f.options[1].calculated_base_price.freshness='fresh';f.options[1].calculated_base_price.current_input_fingerprint='changed';assert.equal(calculate(f).status,'stale');
 f.options[1].calculated_base_price.current_input_fingerprint='fp-1';f.options[1].calculated_base_price.active_rule_versions=[];assert.equal(calculate(f).status,'blocked');
 f.options[1].calculated_base_price.value=null;assert.equal(calculate(f).status,'blocked');
});
test('complete product membership and exact unique identities are required',()=>{
 for(const mutate of [f=>f.options.pop(),f=>f.options.push(structuredClone(f.options[0])),f=>f.options[0].product_identity='foreign',f=>f.options[0].option_identity='unknown',f=>f.membership.complete=false,f=>f.membership.current_fingerprint='v2',f=>f.membership.options[1].option_identity='option-1']){
  const f=fixture();mutate(f);const r=calculate(f);assert.equal(r.status,'blocked');assert.equal(r.value,null);
 }
});
test('product representative ownership is exclusive and each option requires current Rule lineage',()=>{
 const f=fixture();assert.equal(calculate(f).status,'calculated','different current option base Rules are explicit valid inputs');
 f.assignments.push({...f.assignments[0],id:'second'});assert.equal(calculate(f).status,'blocked');f.assignments.pop();
 f.options[0].calculated_base_price.active_rule_versions[0].version=3;assert.equal(calculate(f).status,'blocked');
 f.options[0].calculated_base_price.active_rule_versions[0].version=2;f.options[0].calculated_base_price.lineage_valid=false;assert.equal(calculate(f).status,'blocked');
});
test('product proof signature retains all option generations, Rule versions and membership without order dependence',()=>{
 const f=fixture(),original=calculate(f).input_signature;f.options.reverse();f.membership.options.reverse();assert.equal(calculate(f).input_signature,original);
 f.options[0].calculated_base_price.generation_id=5;assert.notEqual(calculate(f).input_signature,original);
 f.options[0].calculated_base_price.generation_id=4;f.assignments[0].version=2;assert.notEqual(calculate(f).input_signature,original);
});
test('shadow pipeline composes inbound, option base, product representative, seller price and discount without production routing',()=>{
 const M=globalThis.HubRuleRegistry,base=[53500,53500,55500].map(v=>M.transform(M.transform(v,{steps:[{op:'subtract',value:7500}]}),{steps:[{op:'multiply',value:2}]}));
 const representative=calculate(fixture(base));assert.equal(representative.value,92000);
 const seller=M.transform(representative.value,{steps:[{op:'add',value:2000}]}),final=M.transform(seller,{steps:[{op:'subtract',value:2000}]});assert.equal(seller,94000);assert.equal(final,92000);
});
