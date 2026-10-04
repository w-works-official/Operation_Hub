import test from 'node:test';
import assert from 'node:assert/strict';
import '../mockups/operations-hub/rule-registry.js';
const H=globalThis.HubRuleRegistry;
const rule=(id,target='calculated_base_price',source='purchase_price',origin='self',steps=[{op:'multiply',value:3}],scope='')=>({id,name:id,target_field:target,source_field:source,input_origin:origin,scope,config:{steps},version:1,is_active:true});
const assignment=(sku,r)=>({sku,rule_id:r.id,target_field:r.target_field,scope:r.scope,version:1});
const products={A:{sellpia_source_purchase_price:1000,system_base_price:7000},B:{sellpia_source_purchase_price:2000,system_base_price:8000},C:{sellpia_source_purchase_price:3000,system_base_price:9000}};
test('ordered rounding remains at the requested position',()=>{
 const steps=H.parseSteps('*1.25;round up 100;+33');assert.equal(H.transform(1001,{steps}),1333);
 assert.equal(H.transform(1001,{steps:H.parseSteps('*1.25;+33;round up 100')}),1300);
 assert.deepEqual(H.parseSteps(H.stepsText(steps)),steps);
});
test('invalid and missing configuration cannot silently calculate',()=>{
 for(const config of [null,{}, {steps:null},{steps:[{}]},{steps:[{op:'divide',value:0}]},{steps:[{op:'round',unit:0,rounding:'up'}]}])assert.throws(()=>H.transform(100,config));
 assert.throws(()=>H.transform(100,{steps:[{op:'multiply',value:0.333}]}),/정수/);
 assert.throws(()=>H.transform(100,{steps:[],min:200,max:100}),/최저/);
});
test('forward and automatic reverse arithmetic are paired',()=>{
 const plus={steps:H.parseSteps('+2000')},minus={steps:H.parseSteps('-2000')};
 assert.equal(H.transform(8000,plus),10000);assert.equal(H.inverse(10000,plus),8000);
 assert.equal(H.transform(10000,minus),8000);assert.equal(H.inverse(8000,minus),10000);
 assert.equal(H.inverse(15000,{steps:H.parseSteps('*0.9'),unit:1,rounding:'nearest'}),16667);
 assert.equal(H.inverse(100,{steps:H.parseSteps('round up 100')}),1);
 assert.equal(H.inverse(15000,{steps:H.parseSteps('*0.9;round nearest 100')}),16612);
 assert.equal(H.transform(H.inverse(10000,{steps:H.parseSteps('round up 100;+2000')}),{steps:H.parseSteps('round up 100;+2000')}),10000);
 assert.throws(()=>H.inverse(105,{steps:H.parseSteps('round up 100')}),/찾지 못/);
});
test('parent computed result flows through child own centralized rule',()=>{
 const parent=rule('parent'),child=rule('child','calculated_base_price','calculated_base_price','parent',H.parseSteps('*2;+50'));
 const graph={products,rules:[parent,child],assignments:[assignment('A',parent),assignment('B',child)],dependencies:[{child_sku:'B',parent_sku:'A',source_field:'calculated_base_price',target_field:'calculated_base_price',scope:'',rule_id:'child'}]};
 assert.equal(H.createEvaluator(graph).evaluate('B').value,6050);
 parent.config={steps:H.parseSteps('*4')};parent.version=2;
 const latest=H.createEvaluator(graph).evaluate('B');assert.equal(latest.value,8050);assert.equal(latest.versions[0].version,2);
});
test('independent SKU and platform stages coexist and scope correctly',()=>{
 const inbound=rule('inbound','actual_inbound_cost','purchase_price','self',H.parseSteps('+100'));
 const basis=rule('basis','basis_sku_price','actual_inbound_cost','self',H.parseSteps('*2'));
 const base=rule('base','calculated_base_price','basis_sku_price','self',H.parseSteps('+500'));
 const reg=rule('reg','platform_registration_price','calculated_base_price','self',H.parseSteps('+2000'),'ably');
 const disc=rule('disc','platform_discount_price','platform_registration_price','self',H.parseSteps('-2000'),'ably');
 const rules=[inbound,basis,base,reg,disc],graph={products,rules,assignments:rules.map(r=>assignment('A',r))};
 const e=H.createEvaluator(graph);assert.equal(e.evaluate('A','platform_discount_price','ably').value,2700);
 assert.equal(e.evaluate('A','platform_registration_price','ably').value,4700);assert.equal(H.validateGraph(graph).results.length,5);
});
test('same stage conflicts, absent parents, self links and cycles fail',()=>{
 const r=rule('r','calculated_base_price','calculated_base_price','parent',H.parseSteps('+10'));
 const ref=(child,parent)=>({child_sku:child,parent_sku:parent,source_field:r.source_field,target_field:r.target_field,scope:'',rule_id:r.id});
 const graph={products,rules:[r],assignments:[assignment('A',r)],dependencies:[ref('A','B')]};
 assert.throws(()=>H.createEvaluator({...graph,assignments:[...graph.assignments,...graph.assignments]}),/여러 개/);
 assert.throws(()=>H.createEvaluator({...graph,dependencies:[ref('A','B'),ref('A','C')]}),/여러 개/);
 assert.throws(()=>H.createEvaluator({...graph,dependencies:[ref('A','missing')]}).evaluate('A'),/원본 없음/);
 assert.throws(()=>H.createEvaluator({...graph,dependencies:[ref('A','A')]}).evaluate('A'),/자기 자신/);
 assert.throws(()=>H.createEvaluator({...graph,assignments:[assignment('A',r),assignment('B',r)],dependencies:[ref('A','B'),ref('B','A')]}).evaluate('A'),/순환/);
 assert.throws(()=>H.createEvaluator({...graph,dependencies:[{...ref('A','B'),relation_valid:false}]}).evaluate('A'),/해제/);
});
test('shared rule source edit detects newly introduced field cycle',()=>{
 const first=rule('first','actual_inbound_cost','purchase_price'),second=rule('second','calculated_base_price','actual_inbound_cost');
 const graph={products,rules:[first,second],assignments:[assignment('A',first),assignment('A',second)]};
 assert.equal(H.validateGraph(graph).valid,true);first.source_field='calculated_base_price';assert.throws(()=>H.validateGraph(graph),/순환/);
});
test('reference field override and upstream fallback pipeline remain independent',()=>{
 const inbound=rule('inbound','actual_inbound_cost','purchase_price','self',H.parseSteps('+100'));
 const child=rule('child','calculated_base_price','purchase_price','parent',H.parseSteps('*2'));
 const graph={products,rules:[inbound,child],assignments:[assignment('A',inbound),assignment('B',child)],dependencies:[{child_sku:'B',parent_sku:'A',source_field:'calculated_base_price',target_field:'calculated_base_price',scope:'',rule_id:'child'}]};
 const e=H.createEvaluator(graph);assert.equal(e.evaluate('A').value,1100);assert.equal(e.evaluate('B').value,2200);
 inbound.source_field='calculated_base_price';assert.throws(()=>H.createEvaluator(graph).evaluate('A'),/순환/);
});
test('completed scoped platform stages feed option and final rules with signed options',()=>{
 const option=rule('option','platform_option_price','platform_registration_price','self',H.parseSteps('-10500'),'ably');
 const final=rule('final','platform_final_price','platform_option_price','self',H.parseSteps('+8000'),'ably');
 const resolvedValues=new Map([[H.key('A','platform_registration_price','ably'),{value:10000,versions:[{id:'registration',version:4}],trace:[{sku:'A',field:'platform_registration_price',value:10000}]}]]);
 const graph={products,rules:[option,final],assignments:[assignment('A',option),assignment('A',final)],resolvedValues};
 const e=H.createEvaluator(graph),optionResult=e.evaluate('A','platform_option_price','ably');assert.equal(optionResult.value,-500);assert.equal(optionResult.versions[0].version,4);
 resolvedValues.set(H.key('A','platform_option_price','ably'),optionResult);
 assert.equal(e.evaluate('A','platform_final_price','ably').value,7500);
 resolvedValues.set(H.key('A','platform_final_price','ably'),{value:7777});assert.equal(e.evaluate('A','platform_final_price','ably').value,7777);
 assert.throws(()=>H.transform(10000,{steps:H.parseSteps('-10500')}),/0 이상/);
 assert.equal(H.transform(10000,{steps:H.parseSteps('-10500')},{allowNegative:true}),-500);
 assert.throws(()=>e.evaluate('A','platform_registration_price','smartstore'),/미배정/);
});
test('virtual option/final stage inputs are scoped source-only values',()=>{
 const option=rule('virtual-option','platform_option_price','platform_option_input','self',H.parseSteps('-100'),'ably');
 const final=rule('virtual-final','platform_final_price','platform_final_input','self',H.parseSteps('+200'),'ably');
 const resolvedValues=new Map([[H.key('A','platform_option_input','ably'),{value:-300}],[H.key('A','platform_final_input','ably'),{value:8000}]]);
 const e=H.createEvaluator({products,rules:[option,final],assignments:[assignment('A',option),assignment('A',final)],resolvedValues});
 assert.equal(e.evaluate('A','platform_option_price','ably').value,-400);
 assert.equal(e.evaluate('A','platform_final_price','ably').value,8200);
 assert.equal(H.isPlatform('platform_option_input'),true);assert.equal(H.targets.includes('platform_option_input'),false);
 assert.throws(()=>H.validateRule({...option,target_field:'platform_option_input'}),/적용 항목/);
 assert.throws(()=>e.evaluate('A','platform_option_input','makeshop'),/미배정/);
});
test('decimal multiply and ordered currency ceiling do not add an extra 500 at exact boundaries',()=>{
 const config={steps:[{op:'multiply',value:2.2},{op:'round',unit:500,rounding:'up'}]};
 for(let input=0;input<=150000;input+=250)assert.equal(HubRuleRegistry.transform(input,config),Math.ceil(input*22/5000)*500,'input '+input);
 assert.equal(HubRuleRegistry.transform(42500,config),93500);assert.equal(HubRuleRegistry.transform(42501,config),94000);assert.equal(HubRuleRegistry.transform(26750,config),59000);
 assert.throws(()=>HubRuleRegistry.transform(37119,{steps:[{op:'divide',value:2}]}),/안전한 정수/);
});
test('actual inbound cost rounds fractional won after any assigned formula',()=>{
 const inbound=rule('half','actual_inbound_cost','purchase_price','self',[{op:'divide',value:2}]);
 const base=rule('double','calculated_base_price','actual_inbound_cost','self',[{op:'multiply',value:2.2},{op:'round',unit:500,rounding:'up'}]);
 const graph={products:{'6699-1':{sellpia_source_purchase_price:37119},'6699-2':{sellpia_source_purchase_price:37119}},rules:[inbound,base],assignments:['6699-1','6699-2'].flatMap(sku=>[assignment(sku,inbound),assignment(sku,base)])};
 const evaluator=H.createEvaluator(graph);
 for(const sku of ['6699-1','6699-2']){
  assert.equal(evaluator.evaluate(sku,'actual_inbound_cost').value,18560);
  assert.equal(evaluator.evaluate(sku,'calculated_base_price').value,41000);
 }
 assert.throws(()=>H.transform(37119,{steps:[{op:'divide',value:2}]}),/정수/,'other price stages still require an explicit rounding rule');
});
