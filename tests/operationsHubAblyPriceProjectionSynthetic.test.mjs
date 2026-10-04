import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const context={console};context.globalThis=context;vm.createContext(context);
vm.runInContext(fs.readFileSync('mockups/operations-hub/ably-price-projection.js','utf8'),context);
const P=context.AblyPriceProjection;
const plain=value=>JSON.parse(JSON.stringify(value));
const clone=value=>structuredClone(value);

function row(sku,optionPrice,index,{rowNo=2,selected=false,base=30000,primary=`option-${index}`,secondary='',seller='sellpia_SYNTH'}={}){
 return {source_row_no:rowNo,option_index:index,seller_management_code:seller,primary_option_name:primary,secondary_option_value:secondary,base_price:base,option_price:optionPrice,resolution:{sku,method:'direct_sku'},_inScope:selected,_status:'ready',_error:'',_changedFields:[]};
}
function policy(strategy,id='tag-a',active=true){return {tag_id:id,tag_name:id,strategy,document_id:`doc-${id}`,document_version:2,active};}
function resolved(strategy,...policies){return P.resolveCarrierPolicy({tagPolicies:policies.length?policies:[policy(strategy)]});}
function project(rows,{mode='sellpia_source',targets=new Map(),strategy=null,legacyBase=null,policyResult=null,allowLowerMiddle=false}={}){
 const policyByRow=new Map();
 for(const item of rows)if(strategy||policyResult)policyByRow.set(item.source_row_no,policyResult||resolved(strategy));
 const legacyRulesBaseBySku=new Map();
 if(legacyBase!==null)for(const item of rows.filter(item=>item._inScope))legacyRulesBaseBySku.set(item.resolution?.sku,legacyBase);
 return P.projectProductRows(rows,{priceMode:mode,targetFinalBySku:targets,policyByRow,legacyRulesBaseBySku,allowLowerMiddle});
}
function finals(rows){return rows.map(item=>item.target_base_price+item.target_option_price);}
function blocked(rows,pattern=null){assert.ok(rows.every(item=>item._status==='conflict'));assert.ok(rows.every(item=>!Object.hasOwn(item,'target_base_price')&&!Object.hasOwn(item,'target_option_price')));if(pattern)assert.match(rows[0]._error,pattern);}
function assertFinals(rows,expected){assert.deepEqual(finals(rows),expected);rows.forEach((item,index)=>assert.equal(item.target_base_price+item.target_option_price,expected[index]));}

test('deterministic A-R synthetic product cases',()=>{
 // A — odd option count.
 for(const strategy of ['lowest','lower_middle']){
  const values=[40000,50000,60000],representative=P.selectRepresentativeBase(values,strategy);
  assert.equal(representative,strategy==='lowest'?40000:50000);
  assert.deepEqual(P.projectionMetrics(representative,values).optionDeltas,strategy==='lowest'?[0,10000,20000]:[-10000,0,10000]);
 }
 // B — even lower-middle uses the lower median.
 assert.equal(P.selectRepresentativeBase([40000,50000,60000,70000],'lower_middle'),50000);
 // C — partial export preserves every unselected final.
 {
  const rows=[row('C-1',0,0,{selected:true}),row('C-2',3500,1),row('C-3',9000,2)];
  project(rows,{mode:'rules',targets:new Map([['C-1',32000]]),legacyBase:32000});
  assertFinals(rows,[32000,33500,39000]);assert.deepEqual(rows.map(item=>item.target_option_price),[0,1500,7000]);
 }
 // D — repeated Sellpia SKU keeps carrier-local add-on in both price modes.
 for(const mode of ['rules','sellpia_source']){
  const rows=[row('D-1',0,0,{selected:true,base:75000,secondary:'no-ball'}),row('D-1',15000,1,{selected:true,base:75000,secondary:'heavy locking ball'})];
  project(rows,{mode,targets:new Map([['D-1',82000]]),legacyBase:mode==='rules'?82000:null});
  assertFinals(rows,[82000,97000]);assert.deepEqual(rows.map(item=>item.carrier_addon_delta),[0,15000]);
 }
 // E — one option.
 {
  const rows=[row('E-1',0,0,{selected:true,base:50000})];project(rows,{targets:new Map([['E-1',55000]])});assertFinals(rows,[55000]);assert.equal(rows[0].target_option_price,0);
 }
 // F — all equal prices remain equal for every representative strategy that is download-safe.
 for(const strategy of ['lowest','preserve_existing_base']){
  const rows=[0,1,2].map(index=>row(`F-${index}`,0,index,{selected:index===0,base:50000}));
  project(rows,{targets:new Map([['F-0',50000]]),strategy});assertFinals(rows,[50000,50000,50000]);assert.ok(rows.every(item=>item.target_option_price===0));
 }
 // G — duplicate values and input order do not affect lower-middle.
 assert.equal(P.selectRepresentativeBase([50000,40000,60000,40000,50000],'lower_middle'),50000);
 // H — large spreads are measured without borrowing another platform's range rule.
 {
  const metrics=P.projectionMetrics(10000,[10000,100000]);assert.deepEqual(plain(metrics),{representativeBase:10000,targetFinals:[10000,100000],optionDeltas:[0,90000],minFinal:10000,maxFinal:100000,minDelta:0,maxDelta:90000});
  const middle=P.projectionMetrics(50000,[10000,100000]);assert.equal(middle.minDelta,-40000);assert.throws(()=>P.validateAblyProjection(middle),/음수 옵션가/);
 }
 // I — missing identity.
 {
  const rows=[row('I-1',0,0,{selected:true}),row('I-2',1000,1)];rows[1].resolution={sku:null,method:'unresolved'};project(rows,{targets:new Map([['I-1',32000]])});blocked(rows,/identity가 불완전/);
 }
 // J — duplicate carrier identity.
 {
  const rows=[row('J-1',0,0,{selected:true,primary:'same'}),row('J-2',1000,1,{primary:'same'})];project(rows,{targets:new Map([['J-1',32000]])});blocked(rows,/옵션값이 파일에 중복/);
 }
 // K/L/M — missing, duplicate and negative no-ball anchors.
 for(const fixture of [
  {secondary:['heavy','18K heavy'],prices:[0,15000],reason:/기준 노볼 옵션을 찾을 수 없습니다/},
  {secondary:['no-ball','노볼'],prices:[0,15000],reason:/기준 노볼 옵션이 중복/},
  {secondary:['no-ball','heavy'],prices:[15000,0],reason:/차이가 비정상/}
 ]){
  const rows=fixture.prices.map((price,index)=>row('VARIANT-1',price,index,{selected:true,secondary:fixture.secondary[index]}));project(rows,{targets:new Map([['VARIANT-1',82000]])});blocked(rows,fixture.reason);
 }
 // N — one SKU cannot span two physical rows.
 {
  const rows=[row('N-1',0,0,{selected:true,rowNo:20}),row('N-1',0,0,{selected:true,rowNo:21})];project(rows,{targets:new Map([['N-1',40000]])});blocked(rows,/서로 다른 PlayAuto 상품 행에 중복/);
 }
 // O/P/Q/R — conflict, duplicate same policy, unrelated and inactive tags.
 {
  const conflict=P.resolveCarrierPolicy({tagPolicies:[policy('lowest','tag-a'),policy('lower_middle','tag-b')]});assert.equal(conflict.status,'conflict');
  const rows=[row('O-1',0,0,{selected:true})];project(rows,{targets:new Map([['O-1',32000]]),policyResult:conflict});blocked(rows,/정책 충돌/);
  const duplicate=P.resolveCarrierPolicy({tagPolicies:[policy('lowest','tag-a'),policy('lowest','tag-b')]});assert.equal(duplicate.status,'resolved');assert.equal(duplicate.strategy,'lowest');
  const unrelated=P.resolveCarrierPolicy({tagPolicies:[null],fallbackStrategy:'legacy_rules'});assert.equal(unrelated.strategy,'legacy_rules');
  const inactive=P.resolveCarrierPolicy({tagPolicies:[policy('lowest','tag-off',false)],fallbackStrategy:'legacy_rules'});assert.equal(inactive.strategy,'legacy_rules');
 }
});
function selectionIndices(count,kind){
 if(kind==='first')return new Set([0]);if(kind==='last')return new Set([count-1]);if(kind==='middle')return new Set([Math.floor((count-1)/2)]);
 if(kind==='half')return new Set(Array.from({length:Math.ceil(count/2)},(_,index)=>index));
 if(kind==='alternating')return new Set(Array.from({length:count},(_,index)=>index).filter(index=>index%2===0));
 if(kind==='all')return new Set(Array.from({length:count},(_,index)=>index));
 return new Set(Array.from({length:count-1},(_,index)=>index));
}

test('partial-selection matrix preserves unselected siblings for 5-20 option products',()=>{
 for(const count of [5,9,12,20])for(const pattern of ['first','last','middle','half','alternating','all','all_but_one'])for(const mode of ['rules','sellpia_source']){
  const selected=selectionIndices(count,pattern),base=20000;
  const rows=Array.from({length:count},(_,index)=>row(`SEL-${count}-${index}`,index*1700,index,{selected:selected.has(index),base,rowNo:100+count}));
  const targets=new Map(rows.filter(item=>item._inScope).map(item=>[item.resolution.sku,base+5000+item.option_index*1900]));
  const before=rows.map(item=>base+item.option_price);
  const legacyBase=mode==='rules'?Math.min(...rows.map(item=>item._inScope?targets.get(item.resolution.sku):base+item.option_price)):null;
  project(rows,{mode,targets,strategy:mode==='sellpia_source'?'lowest':null,legacyBase});
  assert.ok(rows.every(item=>item._status==='ready'),`${count}/${pattern}/${mode}`);
  rows.forEach((item,index)=>assert.equal(item.target_base_price+item.target_option_price,item._inScope?targets.get(item.resolution.sku):before[index],`${count}/${pattern}/${mode}/${index}`));
 }
});

function rng(seed){let value=seed>>>0;return()=>{value=(value+0x6D2B79F5)>>>0;let next=value;next=Math.imul(next^(next>>>15),next|1);next^=next+Math.imul(next^(next>>>7),next|61);return((next^(next>>>14))>>>0)/4294967296;};}
const pick=(random,array)=>array[Math.floor(random()*array.length)];
const integer=(random,min,max)=>min+Math.floor(random()*(max-min+1));
function shuffle(random,values){const result=[...values];for(let index=result.length-1;index>0;index--){const other=integer(random,0,index);[result[index],result[other]]=[result[other],result[index]];}return result;}
function stableKey(item){return `${item.source_row_no}|${item.option_index}|${item.resolution?.sku}|${item.secondary_option_value}`;}
function projectedMap(rows){return new Map(rows.map(item=>[stableKey(item),{final:item.target_base_price+item.target_option_price,base:item.target_base_price,option:item.target_option_price,status:item._status}]));}

test('randomized valid products satisfy projection invariants and permutation metamorphism',()=>{
 const seed=0xA81B2026,random=rng(seed),iterations=1500;
 for(let iteration=0;iteration<iterations;iteration++){
  const count=integer(random,1,50),base=integer(random,10,800)*100,mode=pick(random,['rules','sellpia_source']),strategy=pick(random,['lowest','preserve_existing_base',mode==='rules'?'legacy_rules':'lowest']);
  const pricePool=Array.from({length:Math.max(2,Math.ceil(count/3))},()=>integer(random,0,900)*100);
  const rows=Array.from({length:count},(_,index)=>row(`R${iteration}-${index}`,pick(random,pricePool),index,{base,rowNo:1000+iteration,selected:false,primary:`random-${iteration}-${index}`}));
  if(count>=2&&random()<0.28){
   const first=integer(random,0,count-2),addon=integer(random,1,300)*100,sku=rows[first].resolution.sku,anchor=pick(random,[0,integer(random,0,200)*100]);
   rows[first].option_price=anchor;rows[first].secondary_option_value='no-ball';rows[first+1].resolution.sku=sku;rows[first+1].primary_option_name=rows[first].primary_option_name;rows[first+1].secondary_option_value='heavy locking ball';rows[first+1].option_price=anchor+addon;
  }
  const skus=[...new Set(rows.map(item=>item.resolution.sku))],selectedSkus=new Set(skus.filter(()=>random()<0.5));if(!selectedSkus.size)selectedSkus.add(pick(random,skus));
  for(const item of rows)item._inScope=selectedSkus.has(item.resolution.sku);
  const targets=new Map([...selectedSkus].map(sku=>[sku,base+integer(random,0,1200)*100]));
  const expected=rows.map(item=>item._inScope?targets.get(item.resolution.sku)+(rows.filter(row=>row.resolution.sku===item.resolution.sku).length>1?item.option_price-Math.min(...rows.filter(row=>row.resolution.sku===item.resolution.sku).map(row=>row.option_price)):0):base+item.option_price);
  let legacyBase=null;if(strategy==='legacy_rules')legacyBase=Math.min(...expected);
  const options={mode,targets,strategy:strategy==='legacy_rules'?null:strategy,legacyBase};
  const original=clone(rows),permuted=shuffle(random,clone(rows));
  try{
   project(rows,options);project(permuted,options);
   assert.ok(rows.every(item=>item._status==='ready'));
   rows.forEach((item,index)=>{
    const actual=item.target_base_price+item.target_option_price;assert.equal(actual,expected[index]);
    if(!item._inScope)assert.equal(actual,base+item.option_price);
    else assert.equal(actual,targets.get(item.resolution.sku)+Number(item.carrier_addon_delta||0));
   });
   const representative=strategy==='lowest'?Math.min(...expected):strategy==='preserve_existing_base'?base:legacyBase;
   assert.ok(rows.every(item=>item.target_base_price===representative));
   const normalMap=projectedMap(rows),permutedMap=projectedMap(permuted);assert.deepEqual(plain([...permutedMap].sort()),plain([...normalMap].sort()));
   const baselinePolicy=P.resolveCarrierPolicy({tagPolicies:[policy('lowest','one')]});
   const duplicatePolicy=P.resolveCarrierPolicy({tagPolicies:[policy('lowest','one'),policy('lowest','two'),null]});
   assert.equal(baselinePolicy.strategy,duplicatePolicy.strategy);
  }catch(error){throw new Error(`random valid counterexample seed=${seed} iteration=${iteration} input=${JSON.stringify({mode,strategy,base,targets:[...targets],rows:original})}\n${error.stack||error}`);}
 }
});

test('randomized lower-middle calculation is deterministic and remains download-blocked',()=>{
 const seed=0x1A2B3C4D,random=rng(seed),iterations=300;
 for(let iteration=0;iteration<iterations;iteration++){
  const count=integer(random,1,50),values=Array.from({length:count},()=>integer(random,1,2000)*100),expected=[...values].sort((a,b)=>a-b)[Math.floor((count-1)/2)];
  assert.equal(P.selectRepresentativeBase(values,'lower_middle'),expected);assert.equal(P.selectRepresentativeBase(shuffle(random,values),'lower_middle'),expected);
  const metrics=P.projectionMetrics(expected,values);assert.equal(metrics.representativeBase,expected);assert.equal(metrics.minDelta,Math.min(...values)-expected);
  const rows=values.map((value,index)=>row(`LM-${iteration}-${index}`,value-values[0],index,{base:values[0],selected:index===0,rowNo:3000+iteration}));
  project(rows,{targets:new Map([[rows[0].resolution.sku,values[0]]]),strategy:'lower_middle'});blocked(rows,/계산·미리보기만 지원/);
 }
});

test('randomized invalid products fail closed without NaN, undefined or zero fallback writes',()=>{
 const seed=0xBADF00D,random=rng(seed),iterations=500,kinds=['missing_identity','duplicate_identity','missing_anchor','double_anchor','negative_addon','cross_row_sku','policy_conflict','missing_option','inconsistent_base','missing_target'];
 for(let iteration=0;iteration<iterations;iteration++){
  const kind=kinds[iteration%kinds.length],rowNo=5000+iteration,rows=[row(`BAD-${iteration}-1`,0,0,{selected:true,rowNo,primary:'first'}),row(`BAD-${iteration}-2`,1000,1,{rowNo,primary:'second'})],targets=new Map([[rows[0].resolution.sku,40000]]);let policyResult=null;
  if(kind==='missing_identity')rows[1].resolution={sku:null,method:'unresolved'};
  if(kind==='duplicate_identity')rows[1].primary_option_name=rows[0].primary_option_name;
  if(kind==='missing_anchor'){rows[1].resolution.sku=rows[0].resolution.sku;rows[0].secondary_option_value='heavy';rows[1].secondary_option_value='18K heavy';}
  if(kind==='double_anchor'){rows[1].resolution.sku=rows[0].resolution.sku;rows[0].secondary_option_value='no-ball';rows[1].secondary_option_value='노볼';}
  if(kind==='negative_addon'){rows[1].resolution.sku=rows[0].resolution.sku;rows[0].secondary_option_value='no-ball';rows[1].secondary_option_value='heavy';rows[0].option_price=15000;rows[1].option_price=0;}
  if(kind==='cross_row_sku'){rows[1].resolution.sku=rows[0].resolution.sku;rows[1].source_row_no=rowNo+1;rows[1]._inScope=true;}
  if(kind==='policy_conflict')policyResult=P.resolveCarrierPolicy({tagPolicies:[policy('lowest','a'),policy('lower_middle','b')]});
  if(kind==='missing_option')rows[1].option_price=null;
  if(kind==='inconsistent_base')rows[1].base_price=rows[0].base_price+1;
  if(kind==='missing_target')targets.clear();
  try{
   project(rows,{targets,policyResult});blocked(rows);
   assert.ok(rows.every(item=>!Number.isNaN(item.target_base_price)&&!Number.isNaN(item.target_option_price)));
  }catch(error){throw new Error(`random invalid counterexample seed=${seed} iteration=${iteration} kind=${kind} input=${JSON.stringify(rows)}\n${error.stack||error}`);}
 }
});

test('nine valid physical products remain exportable beside one blocked product',()=>{
 const rows=[];for(let group=0;group<9;group++)rows.push(row(`MIX-${group}`,group*1000,0,{selected:true,rowNo:7000+group,base:30000,primary:`safe-${group}`}));
 rows.push(row('MIX-BAD',0,0,{selected:true,rowNo:7010,primary:'duplicate'}),row('MIX-BAD-2',1000,1,{rowNo:7010,primary:'duplicate'}));
 const targets=new Map(rows.filter(item=>item._inScope).map(item=>[item.resolution.sku,50000+item.option_price]));project(rows,{targets});
 assert.equal(rows.filter(item=>item._status==='ready').length,9);assert.equal(rows.filter(item=>item._status==='conflict').length,2);
 assert.ok(rows.slice(0,9).every(item=>item.target_base_price+item.target_option_price===targets.get(item.resolution.sku)));
});
