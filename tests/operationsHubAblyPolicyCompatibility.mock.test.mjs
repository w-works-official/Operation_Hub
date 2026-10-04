import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const context={console};context.globalThis=context;vm.createContext(context);
vm.runInContext(fs.readFileSync('mockups/operations-hub/ably-price-projection.js','utf8'),context);
const P=context.AblyPriceProjection,plain=value=>JSON.parse(JSON.stringify(value));

function rows(){return [0,1,2].map((index)=>({source_row_no:2,option_index:index,seller_management_code:'sellpia_COMPAT',primary_option_name:`option-${index}`,secondary_option_value:'',base_price:40000,option_price:index*10000,resolution:{sku:`COMPAT-${index}`,method:'direct_sku'},_inScope:true,_status:'ready',_error:'',_changedFields:[]}));}
function policyDocument(strategy){return strategy?{id:'policy',title:'carrier-policy:tag:tag-a',version:3,body:{version:1,carriers:{ably:{representativeStrategy:strategy}}}}:{id:'policy',title:'carrier-policy:tag:tag-a',version:4,body:{version:1,carriers:{}}};}
function tagPolicy(strategy){return P.normalizePolicyDocument(policyDocument(strategy),{tag_id:'tag-a',tag_name:'일반 태그',is_active:true});}
function canonical(items){return items.map(item=>({sku:item.resolution.sku,base:item.target_base_price,option:item.target_option_price,final:item.target_base_price+item.target_option_price}));}
function project(items,{mode='rules',targets,tagPolicies=[],allowLowerMiddle=false}={}){
 const policyByRow=new Map([[2,P.resolveCarrierPolicy({tagPolicies,fallbackStrategy:mode==='rules'?'legacy_rules':'lowest',fallbackSource:'legacy fallback'})]]),legacyRulesBaseBySku=new Map();
 if(mode==='rules')for(const item of items)legacyRulesBaseBySku.set(item.resolution.sku,40000);
 P.projectProductRows(items,{priceMode:mode,targetFinalBySku:targets,policyByRow,legacyRulesBaseBySku,allowLowerMiddle});return items;
}

test('no carrier policy preserves the legacy rules I/T/final projection',()=>{
 const items=rows(),targets=new Map(items.map(item=>[item.resolution.sku,item.base_price+item.option_price]));
 const expected=items.map(item=>({sku:item.resolution.sku,base:40000,option:item.option_price,final:40000+item.option_price}));
 assert.deepEqual(canonical(project(items,{targets})),expected);
});

test('an ordinary tag without a carrier document is identical to no tag',()=>{
 const targets=new Map(rows().map(item=>[item.resolution.sku,item.base_price+item.option_price]));
 const withoutTag=canonical(project(rows(),{targets})),withOrdinaryTag=canonical(project(rows(),{targets,tagPolicies:[P.normalizePolicyDocument(null,{tag_id:'plain',tag_name:'일반 태그'})].filter(Boolean)}));
 assert.deepEqual(withOrdinaryTag,withoutTag);
});

test('explicit lower-middle changes only the representative projection and keeps final prices',()=>{
 const items=rows(),targets=new Map(items.map(item=>[item.resolution.sku,item.base_price+item.option_price])),result=project(items,{targets,tagPolicies:[tagPolicy('lower_middle')],allowLowerMiddle:true});
 assert.deepEqual(canonical(result),[{sku:'COMPAT-0',base:50000,option:-10000,final:40000},{sku:'COMPAT-1',base:50000,option:0,final:50000},{sku:'COMPAT-2',base:50000,option:10000,final:60000}]);
});

test('removing a carrier policy returns to the exact legacy projection',()=>{
 const targets=new Map(rows().map(item=>[item.resolution.sku,item.base_price+item.option_price])),legacy=canonical(project(rows(),{targets})),removed=canonical(project(rows(),{targets,tagPolicies:[tagPolicy('')].filter(Boolean)}));
 assert.deepEqual(removed,legacy);
});

test('sellpia_source without policy preserves legacy lowest projection',()=>{
 const items=rows(),targets=new Map([['COMPAT-0',42000],['COMPAT-1',51000],['COMPAT-2',63000]]),result=project(items,{mode:'sellpia_source',targets});
 assert.deepEqual(canonical(result),[{sku:'COMPAT-0',base:42000,option:0,final:42000},{sku:'COMPAT-1',base:42000,option:9000,final:51000},{sku:'COMPAT-2',base:42000,option:21000,final:63000}]);
});

test('sellpia_source bypass and carrier policy remain independent',()=>{
 const items=rows(),targets=new Map([['COMPAT-0',42000],['COMPAT-1',51000],['COMPAT-2',63000]]),result=project(items,{mode:'sellpia_source',targets,tagPolicies:[tagPolicy('lower_middle')],allowLowerMiddle:true});
 assert.deepEqual(plain(canonical(result)),[{sku:'COMPAT-0',base:51000,option:-9000,final:42000},{sku:'COMPAT-1',base:51000,option:0,final:51000},{sku:'COMPAT-2',base:51000,option:12000,final:63000}]);
 assert.ok(result.every(item=>item._projection.priceMode==='sellpia_source'&&item._projection.policy.strategy==='lower_middle'));
});
