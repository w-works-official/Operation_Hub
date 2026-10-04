import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context={console};context.globalThis=context;vm.createContext(context);
vm.runInContext(fs.readFileSync('mockups/operations-hub/ably-price-projection.js','utf8'),context);
const P=context.AblyPriceProjection;
const plain=value=>JSON.parse(JSON.stringify(value));
const policy=(strategy,tagId='tag-1',active=true)=>P.normalizePolicyDocument({id:'doc-'+tagId,version:3,title:`carrier-policy:tag:${tagId}`,body:{version:1,carriers:{ably:{representativeStrategy:strategy}}}},{tag_id:tagId,tag_name:'태그 '+tagId,is_active:active});

{
 const none=P.resolveCarrierPolicy({tagPolicies:[],fallbackStrategy:'legacy_rules',fallbackSource:'legacy fallback'});
 assert.deepEqual(plain({status:none.status,strategy:none.strategy,source:none.source}),{status:'resolved',strategy:'legacy_rules',source:'legacy'});
 for(const strategy of ['lowest','lower_middle','preserve_existing_base'])assert.equal(P.resolveCarrierPolicy({tagPolicies:[policy(strategy)]}).strategy,strategy);
 assert.equal(P.resolveCarrierPolicy({tagPolicies:[null],fallbackStrategy:'lowest'}).strategy,'lowest','unrelated tag documents are ignored');
 assert.equal(P.resolveCarrierPolicy({tagPolicies:[policy('lowest','inactive',false)],fallbackStrategy:'legacy_rules'}).strategy,'legacy_rules','inactive tag policies are ignored');
 assert.equal(P.resolveCarrierPolicy({tagPolicies:[policy('lowest','a'),policy('lowest','b')]}).status,'resolved','duplicate identical policies deduplicate');
 const conflict=P.resolveCarrierPolicy({tagPolicies:[policy('lowest','a'),policy('lower_middle','b')]});
 assert.equal(conflict.status,'conflict');assert.match(conflict.reason,/정책 충돌/);
}

assert.equal(P.selectRepresentativeBase([40,50,60],'lower_middle'),50);
assert.equal(P.selectRepresentativeBase([70,40,60,50],'lower_middle'),50);
assert.equal(P.selectRepresentativeBase([60,40,50,50],'lower_middle'),50,'duplicates and input order remain deterministic');
const lowerMetrics=P.projectionMetrics(50,[40,50,60]);assert.throws(()=>P.validateAblyProjection(lowerMetrics),/음수 옵션가/);assert.equal(P.validateAblyProjection(lowerMetrics,{allowNegative:true}).minDelta,-10);

function row(sku,optionPrice,optionIndex,{sourceRow=6,selected=false,secondary='',base=30000}={}){
 return {source_row_no:sourceRow,option_index:optionIndex,seller_management_code:'sellpia_PHYSICAL',primary_option_name:sku,secondary_option_value:secondary,base_price:base,option_price:optionPrice,resolution:{sku,method:'direct_sku'},_inScope:selected,_status:'ready',_error:''};
}
function finals(rows){return rows.map(item=>item.target_base_price+item.target_option_price);}
function assertExact(rows,expected){assert.deepEqual(finals(rows),expected);rows.forEach((item,index)=>assert.equal(item.target_base_price+item.target_option_price,expected[index]));}

{
 const rows=[row('A',0,0,{selected:true}),row('B',3500,1),row('C',9000,2)];
 P.projectProductRows(rows,{priceMode:'rules',targetFinalBySku:new Map([['A',32000]]),legacyRulesBaseBySku:new Map([['A',32000]])});
 assertExact(rows,[32000,33500,39000]);
 assert.deepEqual(rows.map(item=>item.target_option_price),[0,1500,7000]);
 assert.equal(rows[1]._preserveUnselected,true);assert.equal(rows[2]._preserveUnselected,true);
}

{
 const rows=[row('A',0,0,{selected:true}),row('B',3500,1),row('C',9000,2)];
 P.projectProductRows(rows,{priceMode:'sellpia_source',targetFinalBySku:new Map([['A',32000]])});
 assertExact(rows,[32000,33500,39000]);
}

{
 const rows=[row('A',0,0,{selected:true}),row('B',3500,1)];
 const preserve=P.resolveCarrierPolicy({tagPolicies:[policy('preserve_existing_base')]});
 P.projectProductRows(rows,{priceMode:'rules',targetFinalBySku:new Map([['A',32000]]),legacyRulesBaseBySku:new Map([['A',32000]]),policyByRow:new Map([[6,preserve]])});
 assertExact(rows,[32000,33500]);assert.equal(rows[0].target_base_price,30000);assert.deepEqual(rows.map(item=>item.target_option_price),[2000,3500]);
}

{
 const rows=[row('A',0,0,{selected:true}),row('B',3500,1)];
 const conflict=P.resolveCarrierPolicy({tagPolicies:[policy('lowest','a'),policy('preserve_existing_base','b')]});
 P.projectProductRows(rows,{priceMode:'rules',targetFinalBySku:new Map([['A',32000]]),legacyRulesBaseBySku:new Map([['A',32000]]),policyByRow:new Map([[6,conflict]])});
 assert.ok(rows.every(item=>item._status==='conflict'));assert.match(rows[0]._error,/정책 충돌/);
}

for(const priceMode of ['rules','sellpia_source']){
 const rows=[row('SKU',0,0,{selected:true,secondary:'no-ball',base:75000}),row('SKU',15000,1,{selected:true,secondary:'14K 헤비 잠금볼',base:75000})];
 const options={priceMode,targetFinalBySku:new Map([['SKU',82000]])};
 if(priceMode==='rules')options.legacyRulesBaseBySku=new Map([['SKU',82000]]);
 P.projectProductRows(rows,options);assertExact(rows,[82000,97000]);
 assert.deepEqual(rows.map(item=>item.carrier_addon_delta),[0,15000]);
}

{
 const rows=[row('A',0,0,{selected:true}),row('B',10000,1),row('C',20000,2)];
 const lower=P.resolveCarrierPolicy({tagPolicies:[policy('lower_middle')]});
 P.projectProductRows(rows,{priceMode:'sellpia_source',targetFinalBySku:new Map([['A',30000]]),policyByRow:new Map([[6,lower]])});
 assert.ok(rows.every(item=>item._status==='conflict'));
 assert.equal(rows[0]._projection.representativeBase,40000);
 assert.deepEqual(plain(rows[0]._projection.targetFinals),[30000,40000,50000]);
 assert.equal(rows[0]._projection.minDelta,-10000);
 assert.match(rows[0]._error,/계산·미리보기만 지원/);
}

{
 const rows=[row('A',0,0,{selected:true}),row('B',3500,1)];rows[1].resolution={sku:null,method:'unresolved'};
 P.projectProductRows(rows,{priceMode:'rules',targetFinalBySku:new Map([['A',32000]]),legacyRulesBaseBySku:new Map([['A',32000]])});
 assert.ok(rows.every(item=>item._status==='conflict'));assert.match(rows[0]._error,/identity가 불완전/);
}

console.log('PASS Ably common price projection: policy resolution, representative selection, partial exports, carrier add-ons and fail-closed guards.');
