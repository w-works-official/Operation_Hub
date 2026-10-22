import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const modules = ['discount-price-math.js','rule-registry.js','current-price-export.js','price-dependency-export.js','price-dependency-service.js']
  .map(name => [name,fs.readFileSync(`mockups/operations-hub/${name}`,'utf8')]);
const plain = value => JSON.parse(JSON.stringify(value));
const graph = (parents = ['A'], {version = 'graph-1', requested = parents, references = []} = {}) => ({
  contract_version:1,version,snapshot_id:'sellpia-1',requested_skus:requested,
  selected_skus:[...new Set([...requested,...parents.map(sku=>`${sku}-child`)])].sort(),reference_skus:references,
  edges:parents.map(sku=>({edge_id:`edge-${sku}`,parent_node_id:`node-${sku}`,child_node_id:`node-${sku}-child`,parent_sku:sku,child_sku:`${sku}-child`}))
});
const decision = (sku,final,{source = 'smartstore', product = 'product-1', option = 'option-1', event = 'event-1', revision = 1} = {}) => ({
  sku,source_channel:source,seller_product_code:product,seller_option_code:option,
  price:{base:final,discounted:final,option:0,final,terms:[]},event_id:event,revision,
  decision_source:'matrix_manual',effective_at:'2026-10-22T00:00:00Z',mapping_valid:true
});

function harness({context = graph(),decisions = {rows:[],groups:[]},handlers = {}} = {}) {
  const calls = [];
  const implementations = {
    loadExportSkuDependencies:async()=>context,
    loadCurrentPriceDecisions:async()=>decisions,
    ...handlers
  };
  const SystemV3Data = new Proxy({}, {get(_target,name) {
    return async(...args)=>{
      calls.push({name,args});
      if(!Object.hasOwn(implementations,name))throw Error(`Unexpected data access: ${String(name)}`);
      return implementations[name](...args);
    };
  }});
  const sandbox = vm.createContext({console,structuredClone,SystemV3Data,
    fetch(){throw Error('Network is forbidden in dependency export tests');}});
  for(const [name,source] of modules)vm.runInContext(source,sandbox,{filename:name});
  return {api:sandbox.HubPriceDependencyService,calls,sandbox};
}

test('current exact-SKU final decisions take precedence in both modes without reading or copying child prices',async()=>{
  for(const source of ['smartstore','makeshop','ably'])for(const priceMode of ['rules','sellpia_source']){
    const context=graph();context.requested_skus.push('unrelated');context.selected_skus.push('unrelated');
    context.selected_skus.push('grandchild');context.edges.push({edge_id:'edge-grandchild',parent_sku:'A-child',child_sku:'grandchild'});
    const row=decision('A',5200,{source});
    const {api,calls}=harness({context,decisions:{rows:[row],groups:[]}});
    const before=JSON.stringify({context,row});
    const result=await api.prepare({source,skus:['A','unrelated'],priceMode});
    assert.deepEqual(plain(result.outputSkus),['A','A-child','grandchild','unrelated']);
    assert.equal(result.resolution.bySku.get('A-child').final,5200);
    assert.equal(result.resolution.bySku.get('grandchild').final,5200);
    assert.equal(result.resolution.bySku.get('A').final,null);
    assert.equal(result.resolution.bySku.get('unrelated').final,null);
    assert.equal(result.summary.autoIncludedCount,2);assert.equal(result.summary.inheritedCount,2);
    assert.equal(result.resolution.bySku.get('A-child').price_proof.origin,'current_decision');
    assert.equal(Object.hasOwn(result.resolution.bySku.get('A-child'),'current_price_decision'),false);
    assert.deepEqual(calls.map(call=>call.name),['loadExportSkuDependencies','loadCurrentPriceDecisions']);
    assert.deepEqual(plain(calls[1].args[0]),{source,skus:['A']});
    assert.equal(JSON.stringify({context,row}),before,'read-only preparation must not modify graph or decision input');
  }
});

test('multiple seller identities may agree on a parent final but conflicting values block the inherited child',async()=>{
  const same=[decision('A',7000),decision('A',7000,{product:'product-2',event:'event-2'})];
  const accepted=await harness({decisions:{rows:same,groups:[]}}).api.prepare({source:'smartstore',skus:['A']});
  assert.equal(accepted.resolution.bySku.get('A-child').final,7000);
  assert.equal(accepted.resolution.bySku.get('A-child').price_proof.decisions.length,2);
  const {api,calls}=harness({decisions:{rows:[same[0],decision('A',7100,{product:'product-2',event:'event-2'})],groups:[]}});
  const blocked=await api.prepare({source:'smartstore',skus:['A']});
  assert.equal(blocked.resolution.bySku.get('A-child').final,null);
  assert.match(blocked.resolution.bySku.get('A-child').error,/연결 가격이 서로 다릅니다/);
  assert.equal(blocked.summary.inheritedCount,0);
  assert.deepEqual(calls.map(call=>call.name),['loadExportSkuDependencies','loadCurrentPriceDecisions']);
});

test('a foreign SKU decision or invalid mapping is rejected rather than becoming a parent override',async()=>{
  await assert.rejects(harness({decisions:{rows:[decision('not-requested',5000)],groups:[]}}).api.prepare({source:'smartstore',skus:['A']}),/identity 오류/);
  await assert.rejects(harness({decisions:{rows:[{...decision('A',5000),mapping_valid:false}],groups:[]}}).api.prepare({source:'smartstore',skus:['A']}),/identity 오류/);
  await assert.rejects(harness({decisions:{rows:[],groups:[{source_channel:'smartstore',seller_product_code:'product-1',mapping_valid:false}]}}).api.prepare({source:'smartstore',skus:['A']}),/연결이 변경/);
});

test('a parent with a current decision on only one identity cannot silently supply a different undecided identity price',async()=>{
 const row=decision('A',7000),otherPrice={base:9000,discounted:9000,option:0,final:9000,terms:[]};
 const groups=[{source_channel:'smartstore',seller_product_code:'product-1',targets:[{sku:'A',seller_product_code:'product-1',seller_option_code:'option-1',price:row.price,current_state:row}]},
  {source_channel:'smartstore',seller_product_code:'product-2',targets:[{sku:'A',member_skus:['A'],seller_product_code:'product-2',seller_option_code:'option-2',price:otherPrice}]}];
 const result=await harness({decisions:{rows:[row],groups}}).api.prepare({source:'smartstore',skus:['A']});
 assert.match(result.resolution.bySku.get('A-child').error,/연결 가격이 서로 다릅니다/);
 assert.equal(result.resolution.bySku.get('A-child').final,null);
});

test('source mode reads only unresolved parent SKUs and preserves raw final and explicit absence evidence',async()=>{
  const onQuery=()=>{};
  const {api,calls}=harness({context:graph(['A','B']),decisions:{rows:[decision('A',9000)],groups:[]},handlers:{
    loadSellpiaSourcePricesForExport:async()=>new Map([['B',12345]])
  }});
  const result=await api.prepare({source:'smartstore',skus:['A','B'],priceMode:'sellpia_source',onQuery});
  assert.equal(result.resolution.bySku.get('A-child').final,9000);
  assert.equal(result.resolution.bySku.get('B-child').final,12345);
  const evidence=result.resolution.bySku.get('B-child').price_proof;
  assert.equal(evidence.origin,'sellpia_source');assert.match(evidence.decisionProof,/"sku":"B","event_id":null/);
  assert.deepEqual(plain(calls.at(-1).args[0].skus),['B']);assert.equal(calls.at(-1).args[0].onQuery,onQuery);
  assert.ok(!calls.some(call=>/save|materialize|calculate|apply|write|insert|update/i.test(String(call.name))));
});

test('rules mode uses current platform or manual draft finals and evaluates an unlinked root through the real Registry',async()=>{
  const rule={id:'root-rule',name:'root-rule',version:3,is_active:true,target_field:'calculated_base_price',source_field:'purchase_price',input_origin:'parent',scope:'',config:{steps:[{op:'multiply',value:2},{op:'add',value:100}]}};
  const registry={rules:[rule],assignments:[{sku:'R',target_field:'calculated_base_price',scope:'',rule_id:rule.id,version:2}],dependencies:[{child_sku:'R',parent_sku:'Z',source_field:'purchase_price',target_field:'calculated_base_price',scope:'',rule_id:rule.id,relation_valid:true}]};
  const {api,calls}=harness({context:graph(['P','Q','R']),handlers:{
    loadCarrierMatrixTargets:async()=>({rows:[
      {sku:'P',active_price_rule:true,current_effective_price:{platformBase:6000,platformDiscount:0,platformOption:200,platformFinal:6200,platformTerms:[],versions:[{id:'platform-rule',version:4}]}},
      {sku:'Q',active_price_rule:false,price_draft:{price_base_after:7000,price_discounted_base_after:7000,price_option_after:-300,price_final_after:6700,price_discount_terms_after:[]}},
      {sku:'R',active_price_rule:false,source_final_price:99999,registration_value:88888,registration_status:'calculated'}
    ]}),
    ruleRegistry:async mode=>{assert.equal(mode,'list');return registry;},
    loadInternalFormulaProducts:async skus=>{
      assert.deepEqual([...skus].sort(),['R','Z']);
      return [{sellpia_sku_code:'R',system_base_price:88888},{sellpia_sku_code:'Z',sellpia_purchase_price:1000,sellpia_source_purchase_price:9999}];
    }
  }});
  const result=await api.prepare({source:'smartstore',skus:['P','Q','R'],priceMode:'rules'});
  assert.equal(result.resolution.bySku.get('P-child').final,6200);
  assert.equal(result.resolution.bySku.get('P-child').price_proof.origin,'calculated');
  assert.equal(result.resolution.bySku.get('P').dependency_root,undefined,'an active platform rule already owns the ordinary parent export target');
  assert.equal(result.resolution.bySku.get('Q-child').final,6700);
  assert.equal(result.resolution.bySku.get('Q-child').price_proof.origin,'draft');
  assert.equal(result.resolution.bySku.get('Q').dependency_root,undefined,'a complete price draft retains its ordinary parent export precedence');
  assert.equal(result.resolution.bySku.get('R-child').final,2100,'unlinked SKU must use current internal inputs and its current Registry dependency');
  assert.equal(result.resolution.bySku.get('R').dependency_root,true,'an included parent without a platform rule needs explicit internal-price export intent');
  assert.equal(result.resolution.bySku.get('R').final,2100,'the selected individual and its automatically included collection must use the same final');
  assert.equal(result.resolution.bySku.get('R').inherited,false,'internal export intent must not fabricate a parent relationship');
  assert.equal(result.resolution.bySku.get('R').price_proof.origin,'matrix_base_price');
  assert.equal(result.resolution.bySku.get('R-child').price_proof.origin,'matrix_base_price');
  assert.equal(result.resolution.bySku.get('R-child').price_proof.value.versions[0].version,3);
  assert.deepEqual(calls.map(call=>call.name),['loadExportSkuDependencies','loadCurrentPriceDecisions','loadCarrierMatrixTargets','ruleRegistry','loadInternalFormulaProducts']);
});

test('invalid platform targets and absent internal prices stay blocked with no source-price fallback',async()=>{
  const {api,calls}=harness({context:graph(['A','B','C']),handlers:{
    loadCarrierMatrixTargets:async()=>({rows:[{sku:'A',active_price_rule:true,current_effective_error:'current rule input missing'},{sku:'B',active_price_rule:false}]}),
    ruleRegistry:async()=>({rules:[],assignments:[],dependencies:[]}),
    loadInternalFormulaProducts:async()=>[{sellpia_sku_code:'B',system_base_price:null}]
  }});
  const result=await api.prepare({source:'smartstore',skus:['A','B','C'],priceMode:'rules'});
  assert.match(result.resolution.bySku.get('A-child').error,/current rule input missing/);
  assert.match(result.resolution.bySku.get('B-child').error,/시스템 기준가격 없음/);
  assert.match(result.resolution.bySku.get('C-child').error,/상위 가격을 확인할 수 없습니다/);
  assert.ok(!calls.some(call=>call.name==='loadSellpiaSourcePricesForExport'));
});

test('a reference-only internal parent supplies the selected child without entering the output or receiving root export intent',async()=>{
  const context={...graph(),requested_skus:['A-child'],selected_skus:['A-child'],reference_skus:['A']};
  const {api,calls}=harness({context,handlers:{
    loadCarrierMatrixTargets:async()=>({rows:[{sku:'A',active_price_rule:false}]}),
    ruleRegistry:async()=>({rules:[],assignments:[],dependencies:[]}),
    loadInternalFormulaProducts:async()=>[{sellpia_sku_code:'A',system_base_price:12345}]
  }});
  const result=await api.prepare({source:'smartstore',skus:['A-child'],priceMode:'rules'});
  assert.deepEqual(plain(result.outputSkus),['A-child']);
  assert.equal(result.resolution.bySku.has('A'),false);
  assert.equal(result.resolution.bySku.get('A-child').final,12345);
  assert.equal(result.resolution.bySku.get('A-child').dependency_root,undefined);
  assert.equal(result.resolution.bySku.get('A-child').automatically_included,false);
  assert.deepEqual(plain(calls.find(call=>call.name==='loadCurrentPriceDecisions').args[0].skus),['A']);
});

test('final verification repeats read-only inputs and rejects a newly added decision even when its final equals the original',async()=>{
  let rows=[];
  const {api,calls}=harness({handlers:{
    loadCurrentPriceDecisions:async()=>({rows,groups:[]}),
    loadSellpiaSourcePricesForExport:async()=>new Map([['A',5000]])
  }});
  const prepared=await api.prepare({source:'smartstore',skus:['A'],priceMode:'sellpia_source'});
  assert.equal(await api.verify(prepared),true);
  rows=[decision('A',5000)];
  await assert.rejects(api.verify(prepared),/상위 가격 또는 종속관계가 변경/);
  assert.equal(calls.filter(call=>call.name==='loadCurrentPriceDecisions').length,3);
  assert.ok(!calls.some(call=>/save|materialize|apply|write|insert|update/i.test(String(call.name))));
});

test('parent final, current-decision revision, and graph version changes invalidate generation',async()=>{
  let final=5000,event='event-1',revision=1,currentGraph=graph();
  const {api}=harness({handlers:{
    loadExportSkuDependencies:async({expectedVersion})=>{
      if(expectedVersion!==null&&expectedVersion!==currentGraph.version)throw Error('dependency graph version changed');
      return currentGraph;
    },
    loadCurrentPriceDecisions:async()=>({rows:[decision('A',final,{event,revision})],groups:[]})
  }});
  const prepared=await api.prepare({source:'smartstore',skus:['A']});
  final=5100;await assert.rejects(api.verify(prepared),/상위 가격 또는 종속관계가 변경/);
  final=5000;event='event-2';revision=2;await assert.rejects(api.verify(prepared),/상위 가격 또는 종속관계가 변경/);
  event='event-1';revision=1;currentGraph=graph(['A'],{version:'graph-2'});
  await assert.rejects(api.verify(prepared),/dependency graph version changed/);
});

test('no inherited outputs means no price reads and invalid modes fail before any data access',async()=>{
  const context={...graph([],{requested:['A']}),selected_skus:['A']};
  const {api,calls}=harness({context});
  const result=await api.prepare({source:'smartstore',skus:['A']});
  assert.equal(result.summary.inheritedCount,0);assert.deepEqual(plain(result.outputSkus),['A']);
  assert.deepEqual(calls.map(call=>call.name),['loadExportSkuDependencies']);
  await assert.rejects(api.prepare({source:'other',skus:['A']}),/가격 계산 방식을 확인/);
  await assert.rejects(api.prepare({source:'smartstore',skus:['A'],priceMode:'unknown'}),/가격 계산 방식을 확인/);
  assert.equal(calls.length,1);
});
