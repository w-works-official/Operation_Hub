import assert from 'node:assert/strict';
import test from 'node:test';
import '../mockups/operations-hub/discount-price-math.js';
import '../mockups/operations-hub/product-price-adjustment.js';

const api=globalThis.HubProductPriceAdjustment,math=globalThis.SystemV3DiscountPriceMath;
const basic=value=>({term_key:'basic',term_type:'basic',value,unit:'amount',is_baseline:true,rounding_mode:'nearest',rounding_unit:1,title:'즉시할인 기본할인'});
const other=(key,value,extra={})=>({term_key:key,term_type:key,value,unit:'amount',is_baseline:false,rounding_mode:'nearest',rounding_unit:1,...extra});
function fixture({base=9000,terms=[basic(1000)],finals=[3000,7000,10500],originalOptions=[0,100],productCode='13805953338',count=finals.length}={}){
 const discounted=math.discountedBase(base,terms);
 const rows=Array.from({length:count},(_,index)=>{
  const raw={source_file_name:index%2?'original-b.xlsx':'original-a.xlsx',base_price:base,untouched:'raw evidence'};
  for(const key of ['basic','mobile','reservation','multi_buy']){const term=terms.find(value=>value.term_key===key);raw[`smartstore_${key}_discount_value`]=term?.value??null;raw[`smartstore_${key}_discount_unit`]=term?(term.unit==='percent'?'%':'원'):null;}
  const option=originalOptions[index%originalOptions.length];
  return {row:{product_code:productCode,option_code:`option-${index+1}`,base_price:base,discounted_base_price:discounted,option_price:option,final_price:discounted+option,discount_terms:structuredClone(terms),source_row_no:index+2,raw_payload:raw},final:finals[index%finals.length],proof:{source:index===0?'dependency':index===1?'seller_original':'rules',event:null,sku:`sku-${index+1}`}};
 });
 return {source:'smartstore',productCode,rows};
}
const draft=(group,basePrice,basicDiscount)=>({source:'smartstore',productCode:group.productCode,basePrice,basicDiscount});
const plan=(group,basePrice,basicDiscount)=>api.plan({...group,draft:draft(group,basePrice,basicDiscount)});

test('explicit common base and basic discount preserve every already fixed option final',()=>{
 const group=fixture(),before=structuredClone(group),result=plan(group,9000,2000);
 assert.equal(result.discountedBase,7000);assert.equal(result.discountedBasePrice,7000);
 assert.deepEqual(result.rows.map(row=>[row.final,row.option]),[[3000,-4000],[7000,0],[10500,3500]]);
 assert.ok(result.rows.every(row=>result.discountedBase+row.option===row.final&&row.option===row.optionPrice));
 assert.deepEqual(result.rows.map(row=>row.proof),group.rows.map(row=>row.proof));assert.deepEqual(group,before);
 assert.deepEqual(result.draft,draft(group,9000,2000));assert.equal(result.valid,true);
});

test('all 218 siblings across two files retain final, raw tuple and decision/dependency proof',()=>{
 const group=fixture({count:218}),before=structuredClone(group),result=plan(group,9000,2000);
 assert.equal(result.rows.length,218);assert.deepEqual(result.rows.map(row=>row.final),group.rows.map(row=>row.final));
 assert.deepEqual(result.rows.map(row=>row.row),group.rows.map(row=>row.row));assert.deepEqual(group,before);
 assert.equal(new Set(result.rows.map(row=>row.row.option_code)).size,218);
});

test('mobile, reservation and multi-buy amount/percent conditions and opaque metadata remain unchanged',()=>{
 const terms=[basic(1000),other('mobile',7.5,{unit:'percent',writable:false,title:'모바일'}),other('reservation',300,{period_text:'2026.10.22~2026.10.30',active:true}),other('multi_buy',500,{condition_value:3,condition_unit:'개',private_metadata:{review:'keep'}})];
 const group=fixture({terms}),before=structuredClone(group),result=plan(group,9000,2000);
 assert.deepEqual(result.terms.filter(term=>term.term_key!=='basic'),terms.filter(term=>term.term_key!=='basic'));
 assert.deepEqual(group,before);assert.equal(result.terms.find(term=>term.term_key==='basic').value,2000);
});

test('an explicit amount basic discount may be created and zero removes only the basic term',()=>{
 const group=fixture({terms:[other('mobile',300)],finals:[3000,7000,10500]});
 const added=plan(group,9000,2000);assert.equal(added.terms.find(term=>term.term_key==='basic').value,2000);
 assert.equal(added.terms.find(term=>term.term_key==='basic').is_baseline,true);assert.equal(added.discountedBase,7000);
 const zeroGroup=fixture({terms:[other('mobile',300)],finals:[6000,8000,10000]});
 const removed=plan(zeroGroup,8000,0);assert.equal(removed.terms.some(term=>term.term_key==='basic'),false);assert.equal(removed.discountedBase,8000);
 assert.deepEqual(removed.terms,[other('mobile',300)]);
 const existing=fixture({terms:[basic(1000),other('mobile',300)],finals:[6000,8000,10000]});assert.equal(plan(existing,8000,0).terms.some(term=>term.term_key==='basic'),false);
});

test('existing basic percent can explicitly become an amount without changing any final or other term',()=>{
 const group=fixture({base:20000,terms:[{...basic(10),unit:'percent'},other('mobile',200)],finals:[18000,19000]});
 const result=plan(group,25000,7000);assert.equal(result.discountedBase,18000);assert.deepEqual(result.rows.map(row=>row.final),[18000,19000]);
 assert.equal(result.terms[0].unit,'amount');assert.equal(result.terms[0].value,7000);assert.deepEqual(result.terms[1],other('mobile',200));
 assert.equal(api.analyze(group).current.basicDiscount,2000,'the amount-only editor shows the effective current basic amount');
});

test('zero base, zero basic discount and zero fixed final are explicit valid amounts',()=>{
 const group=fixture({base:0,terms:[],finals:[0],originalOptions:[0]});const result=plan(group,0,0);
 assert.equal(result.discountedBase,0);assert.equal(result.rows[0].option,0);assert.deepEqual(result.terms,[]);
 assert.deepEqual(api.recommend(group).draft,draft(group,0,0));
});

test('draft values reject blank, fractional, negative, loose numeric, unsafe and identity-changing input',()=>{
 const group=fixture();
 for(const value of ['',null,undefined,true,-1,1.1,Infinity,Number.MAX_SAFE_INTEGER+1,'1.1','1e4',' 9000 ','9,000','-0']){
  assert.equal(api.validate(group,draft(group,value,0)).valid,false,`base ${String(value)}`);
  assert.equal(api.validate(group,draft(group,9000,value)).valid,false,`discount ${String(value)}`);
 }
 assert.equal(api.validate(group,draft(group,'9000','2000')).valid,true);
 assert.equal(api.validate(group,draft(group,9000,9001)).valid,false);
 for(const changed of [{source:'makeshop'},{productCode:'other'},{optionPrice:1}])assert.equal(api.validate(group,{...draft(group,9000,2000),...changed}).valid,false);
 assert.throws(()=>api.plan({...group,draft:{...draft(group,9000,2000),source:'ably'}}),/판매처·상품코드/);
});

test('the option bounds apply symmetrically at the 50 percent allowance rounded down to ten won',()=>{
 const group=fixture({base:9001,finals:[2500,7000,11500]});assert.deepEqual(plan(group,9001,2001).rows.map(row=>row.option),[-4500,0,4500]);
 for(const finals of [[2499,7000,11500],[2500,7000,11501]])assert.equal(api.validate(fixture({base:9001,finals}),draft(group,9001,2001)).valid,false);
 const rounded=fixture({base:9019,finals:[2500,7000,11500]});assert.equal(api.validate(rounded,draft(rounded,9019,2019)).valid,true);
 assert.equal(api.validate(fixture({base:9019,finals:[2490,7000,11510]}),draft(group,9019,2019)).valid,false);
});

test('analyze and recommendation propose a valid draft without applying or changing the input group',()=>{
 const group=fixture({base:1000,terms:[],finals:[100,20000]}),before=structuredClone(group),analysis=api.analyze(group);
 assert.equal(analysis.editable,true);assert.equal(analysis.needsAdjustment,true);assert.equal(analysis.optionCount,2);
 assert.deepEqual(analysis.current,{basePrice:1000,basicDiscount:0,discountedBase:1000,terms:[]});
 assert.ok(analysis.recommendedDraft);const validated=api.validate(group,analysis.recommendedDraft);assert.equal(validated.valid,true);
 assert.deepEqual(validated.rows.map(row=>row.final),[100,20000]);assert.deepEqual(group,before);
 assert.deepEqual(api.recommend(group).draft,analysis.recommendedDraft);assert.deepEqual(api.inspect(group),analysis);
 const healthy=fixture({finals:[4000,8000,10500]});assert.equal(api.analyze(healthy).needsAdjustment,false);
});

test('invalid option bounds retain a readonly calculation preview without an applicable proof',()=>{
 const group=fixture(),preview=api.validate(group,draft(group,9000,1000));
 assert.equal(preview.valid,false);assert.equal(preview.editable,true);assert.equal(preview.discountedBasePrice,8000);
 assert.deepEqual(preview.rows.map(row=>row.optionPrice),[-5000,-1000,2500]);assert.ok(preview.errors.length);assert.equal(Object.hasOwn(preview,'proof'),false);
 assert.throws(()=>plan(group,9000,1000),/옵션가/);assert.equal(api.validate(group,draft(group,'',1000)).rows,undefined,'unreadable input does not manufacture a calculation preview');
});

test('an option-bearing product must include a zero-price option even when every option is within bounds',()=>{
 const group=fixture({finals:[3000,10500]}),before=structuredClone(group),result=api.validate(group,draft(group,9000,2000));
 assert.equal(result.valid,false);assert.deepEqual(result.rows.map(row=>row.option),[-4000,3500]);assert.ok(result.errors.some(value=>value.includes('추가금 0원')));
 assert.throws(()=>plan(group,9000,2000),/추가금 0원/);assert.equal(Object.hasOwn(result,'proof'),false);
 const proposed=api.recommend(group);assert.equal(proposed.valid,true);assert.ok(proposed.rows.some(row=>row.option===0));
 assert.ok(group.rows.some(row=>row.final===proposed.discountedBase));assert.deepEqual(group,before);
});

test('new manual plans reject negative options below 2,000 won and recommend an encodable fixed-final anchor',()=>{
 const group=fixture({base:1500,terms:[],finals:[1000,1500],originalOptions:[0,100]});
 const invalid=api.validate(group,draft(group,1500,0));assert.equal(invalid.valid,false);assert.ok(invalid.errors.some(value=>value.includes('2,000원 미만')));
 const proposed=api.recommend(group);assert.equal(proposed.valid,true);assert.ok(proposed.rows.some(row=>row.option===0));
 assert.ok(proposed.draft.basePrice>=2000||proposed.rows.every(row=>row.option>=0));assert.deepEqual(proposed.rows.map(row=>row.final),[1000,1500]);
});

test('an optionless single product requires discounted base to equal its fixed final',()=>{
 const group=fixture({finals:[6000],originalOptions:[0]});group.rows[0].row.option_code='';
 assert.equal(plan(group,9000,3000).rows[0].option,0);
 const invalid=api.validate(group,draft(group,9000,2000));assert.equal(invalid.valid,false);assert.ok(invalid.errors.some(value=>value.includes('옵션 없는 상품')));
 assert.equal(api.recommend(group).discountedBase,6000);
});

test('protected blockers, ambiguous mappings, duplicate identities and missing targets cannot be unlocked by a draft',()=>{
 for(const change of [
  group=>{group.blockedReason='공통 차단 유지';},group=>{group.rows[0].mappingAmbiguous=true;},
  group=>{group.rows[0].row.mapping_valid=false;},group=>{group.rows[0].blockedReason='상위 가격 증거 오류';},
  group=>{group.rows.push(structuredClone(group.rows[0]));},group=>{delete group.rows[1].final;},
  group=>{group.rows[0].row.product_code='another-product';},group=>{group.rows[0].row.source_row_no=0;},
  group=>{group.rows[0].row.raw_payload.source_file_name='';},
 ]){
  const group=fixture();change(group);assert.equal(api.analyze(group).editable,false);assert.equal(api.recommend(group).valid,false);assert.equal(api.validate(group,draft(group,9000,2000)).valid,false);
 }
});

test('unreadable raw discounts, unequal shared tuples and invalid original math stay blocked',()=>{
 for(const change of [
  group=>{group.rows[0].row.discount_terms=null;},group=>{delete group.rows[0].row.raw_payload.smartstore_basic_discount_value;},
  group=>{group.rows[0].row.raw_payload.smartstore_basic_discount_unit=null;},group=>{group.rows[0].row.raw_payload.smartstore_basic_discount_value=2000;},
  group=>{group.rows[0].row.final_price++;},group=>{group.rows[1].row.base_price++;},
  group=>{group.rows[0].row.discounted_base_price++;},group=>{group.rows[0].row.option_price=null;},
 ]){const group=fixture();change(group);assert.equal(api.validate(group,draft(group,9000,2000)).valid,false);}
});

test('unknown terms, extra baseline discounts, unsupported rounding and readonly basic flags fail closed',()=>{
 for(const change of [
  terms=>{terms.push(other('unknown',10,{unit:'percent'}));},terms=>{terms.push({...other('mobile',10),is_baseline:true});},
  terms=>{terms.push({...terms[0]});},terms=>{terms[0].rounding_mode='down';terms[0].rounding_unit=10;},
  ...['active','is_active','writable','is_writable'].map(flag=>terms=>{terms[0][flag]=false;}),
  terms=>{terms[0].writable='false';},terms=>{terms[0].unit='unknown';},
 ]){
  const terms=[basic(1000)];change(terms);const group=fixture({terms});assert.equal(api.analyze(group).editable,false);assert.equal(api.validate(group,draft(group,9000,2000)).valid,false);
 }
});

test('proof binds normalized draft, every fixed final, original raw evidence and opaque decision metadata canonically',()=>{
 const group=fixture(),original=plan(group,9000,2000);
 assert.equal(plan(group,'9000','2000').proof,original.proof);
 const reversed={...group,rows:[...group.rows].reverse()};assert.equal(plan(reversed,9000,2000).proof,original.proof);
 for(const change of [
  value=>{value.rows[0].final++;},value=>{value.rows[1].proof.event=9;},value=>{value.rows[1].row.raw_payload.untouched='changed';},
 ]){const changed=structuredClone(group);change(changed);assert.notEqual(plan(changed,9000,2000).proof,original.proof);}
 assert.notEqual(plan(group,10000,3000).proof,original.proof);
});

test('original objects, Maps and readonly term objects remain immutable and output rows are isolated copies',()=>{
 const group=fixture();group.rows[0].proof=new Map([['event',7],['nested',{source:'rule'}]]);
 const before=structuredClone(group);for(const entry of group.rows){Object.freeze(entry.row.discount_terms[0]);Object.freeze(entry.row.raw_payload);Object.freeze(entry.row);Object.freeze(entry);}
 const result=plan(group,9000,2000);assert.deepEqual(group,before);assert.ok(result.rows[0].proof instanceof Map);
 result.rows[0].row.raw_payload.untouched='output-only';result.rows[0].proof.get('nested').source='output-only';result.terms[0].value=123;
 assert.deepEqual(group,before);
});
