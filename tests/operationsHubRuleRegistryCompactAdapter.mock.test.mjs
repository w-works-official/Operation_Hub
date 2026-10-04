import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../mockups/operations-hub/data-service.js',import.meta.url),'utf8');
const start=source.indexOf('  async function ruleRegistry('),end=source.indexOf('  async function assignRules(',start);
assert.ok(start>=0&&end>start);
const plain=value=>JSON.parse(JSON.stringify(value));
function adapter(result){
 const calls=[];
 const context={db:{async rpc(name,args){calls.push({name,args:plain(args)});return result;}},requireOperationsHubSessionToken:()=> 'test-session',readableDatabaseError:error=>Object.assign(new Error(error.message),error)};
 vm.createContext(context);vm.runInContext(source.slice(start,end)+'\nthis.registry=ruleRegistry;',context);
 return {registry:context.registry,calls};
}
test('actual compact list adapter expands all 23760 assignments with scopes, origin and version',async()=>{
 const groups=[
  {rule_id:'common',target_field:'basis_sku_price',scope:'',assigned_tag_id:'tag',entries:Array.from({length:23758},(_,i)=>['SKU'+i,1])},
  {rule_id:'registration',target_field:'platform_registration_price',scope:'smartstore',assigned_tag_id:null,entries:[['SKU23758',3]]},
  {rule_id:'discount',target_field:'platform_discount_price',scope:'makeshop',assigned_tag_id:'other-tag',entries:[['SKU23759',7]]}
 ];
 const data={rules:[{id:'common'},{id:'registration'},{id:'discount'}],dependencies:[{child_sku:'SKU23759',parent_sku:'SKU0',relation_valid:true}],assignment_groups:groups};
 const before=plain(data);const {registry,calls}=adapter({data,error:null});const actual=await registry('list');
 assert.equal(actual.assignments.length,23760);assert.equal(new Set(actual.assignments.map(a=>a.sku)).size,23760);
 const expected=groups.flatMap(({entries,...fields})=>entries.map(([sku,version])=>({...fields,sku,version})));
 assert.deepEqual(plain(actual.assignments),expected);assert.deepEqual(plain(actual.rules),data.rules);assert.deepEqual(plain(actual.dependencies),data.dependencies);
 assert.equal(actual.assignment_groups,undefined);assert.deepEqual(data,before,'normalization does not mutate RPC payload');
 assert.deepEqual(calls,[{name:'hub_rule_registry_list_v2',args:{p_session_token:'test-session'}}]);
});
test('actual save adapter retains original v1 arguments and response',async()=>{
 const rule={id:'shared-rule',version:4,config:{steps:[{op:'add',value:300}]}};
 const response={...rule,version:5};const {registry,calls}=adapter({data:response,error:null});
 assert.equal(await registry('save',rule),response);
 assert.deepEqual(calls,[{name:'hub_rule_registry_v1',args:{p_session_token:'test-session',p_action:'save',p_rule:rule}}]);
});
test('compact read errors propagate without falling back to large v1 payload',async()=>{
 const {registry,calls}=adapter({data:null,error:{message:'canceling statement due to statement timeout',code:'57014'}});
 await assert.rejects(registry('list'),error=>error.code==='57014'&&error.message.includes('statement timeout'));
 assert.equal(calls.length,1);assert.equal(calls[0].name,'hub_rule_registry_list_v2');
});
