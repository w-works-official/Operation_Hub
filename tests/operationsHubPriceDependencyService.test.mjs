import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {createHash,webcrypto} from 'node:crypto';

const modules = ['discount-price-math.js','rule-registry.js','current-price-export.js','price-dependency-export.js','price-dependency-service.js']
  .map(name => [name,fs.readFileSync(`mockups/operations-hub/${name}`,'utf8')]);
const plain = value => JSON.parse(JSON.stringify(value));
const exportSnapshots={seller_snapshot_id:'00000000-0000-4000-8000-000000000001',sellpia_snapshot_id:'00000000-0000-4000-8000-000000000002',sellpia_observed_at:'2026-10-22T00:00:00Z'};
const exportEnvelope=response=>response.proof_version?response:{...response,proof_version:'sellpia-export-v2',absence_proofs:[],carrier_proofs:[],snapshots:{...exportSnapshots}};
const digest=text=>'sha256:v1:'+createHash('sha256').update(text,'utf8').digest('hex');
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

function harness({context = graph(),decisions = {rows:[],groups:[]},handlers = {},crypto = webcrypto} = {}) {
  const calls = [];
  const implementations = {
    loadExportSkuDependencies:async()=>context,
    loadCurrentPriceDecisions:async()=>decisions,
    ...handlers
  };
  implementations.loadExportCurrentPriceDecisions=handlers.loadExportCurrentPriceDecisions||(async options=>{
    assert.ok(['smartstore','makeshop','ably'].includes(options.source),'the large-group reader must receive an explicit supported source');
    assert.equal(options.allowLargeGroups,true,'dependency parent reads must explicitly opt into the bounded large-group contract');
    return exportEnvelope(await implementations.loadCurrentPriceDecisions(options));
  });
  const SystemV3Data = new Proxy({}, {get(_target,name) {
    return async(...args)=>{
      calls.push({name,args});
      if(!Object.hasOwn(implementations,name))throw Error(`Unexpected data access: ${String(name)}`);
      return implementations[name](...args);
    };
  }});
  const sandbox = vm.createContext({console,structuredClone,SystemV3Data,crypto,TextEncoder,TextDecoder,Uint8Array,
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
    assert.deepEqual(calls.map(call=>call.name),['loadExportSkuDependencies','loadExportCurrentPriceDecisions']);
    assert.equal(calls[1].args[0].source,source);assert.deepEqual(plain(calls[1].args[0].skus),['A']);
    assert.equal(calls[1].args[0].allowLargeGroups,true,'every dependency parent uses the bounded export reader rather than the editor group cap');
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
  assert.deepEqual(calls.map(call=>call.name),['loadExportSkuDependencies','loadExportCurrentPriceDecisions']);
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
  const {api,calls,sandbox}=harness({context:graph(['A','B']),decisions:{rows:[decision('A',9000)],groups:[]},handlers:{
    loadSellpiaSourcePricesForExport:async()=>new Map([['B',12345]])
  }});
  const result=await api.prepare({source:'smartstore',skus:['A','B'],priceMode:'sellpia_source',onQuery});
  assert.equal(result.resolution.bySku.get('A-child').final,9000);
  assert.equal(result.resolution.bySku.get('B-child').final,12345);
  const evidence=result.resolution.bySku.get('B-child').price_proof;
  assert.equal(evidence.origin,'sellpia_source');
  const canonical=sandbox.HubCurrentPriceDecisionResolver.proof(sandbox.HubCurrentPriceDecisionResolver.normalize(exportEnvelope({rows:[decision('A',9000)],groups:[]}),{source:'smartstore',skus:['A','B']}));
  assert.equal(JSON.parse(canonical).rows.find(row=>row.sku==='B').event_id,null);
  assert.equal(evidence.decisionProof,digest(canonical),'the complete batch, including the explicit absence, is hashed without dropping evidence');
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
  assert.deepEqual(calls.map(call=>call.name),['loadExportSkuDependencies','loadExportCurrentPriceDecisions','loadCarrierMatrixTargets','ruleRegistry','loadInternalFormulaProducts']);
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
  assert.deepEqual(plain(calls.find(call=>call.name==='loadExportCurrentPriceDecisions').args[0].skus),['A']);
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
  assert.equal(calls.filter(call=>call.name==='loadExportCurrentPriceDecisions').length,3);
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

test('all supported cache-only reference parents retain carrier and source snapshot evidence through large-group reads and final verification',async()=>{
 for(const source of ['smartstore','makeshop','ably']){
  const context={...graph(),requested_skus:['A-child'],selected_skus:['A-child'],reference_skus:['A']};
  const carrier={source_channel:source,seller_product_code:'CACHE-PRODUCT',mapping_fingerprint:'cache-map-1',
    snapshot_id:exportSnapshots.seller_snapshot_id,sellpia_snapshot_id:exportSnapshots.sellpia_snapshot_id,source_observed_at:exportSnapshots.sellpia_observed_at,
    sellpia_prices:{A:21000},targets:[{sku:'A',member_skus:['A'],seller_product_code:'CACHE-PRODUCT',seller_option_code:'A-option',
      price:{base:21000,discounted:21000,option:0,final:21000,terms:[]},source_row_no:2,source_valid:true,
      component_members:[{sku:'A',mapping_source:'carrier_cache',listing_id:null,component_id:null,component_qty:1,component_role:'primary'}]}]};
  const original={rows:[],groups:[],proof_version:'sellpia-export-v2',absence_proofs:[],carrier_proofs:[carrier],snapshots:{...exportSnapshots}};
  let response=structuredClone(original),rawPrice=21000;
  const onQuery=()=>{};
  const {api,calls,sandbox}=harness({context,handlers:{
    loadCurrentPriceDecisions:async()=>{throw Error('editor fallback is forbidden for a dependency parent');},
    loadExportCurrentPriceDecisions:async options=>{
      assert.equal(options.source,source);assert.equal(options.allowLargeGroups,true);
      assert.deepEqual(plain(options.skus),['A']);return response;
    },
    loadSellpiaSourcePricesForExport:async({skus})=>{assert.deepEqual(plain(skus),['A']);return new Map([['A',rawPrice]]);}
  }});
  const prepared=await api.prepare({source,skus:['A-child'],priceMode:'sellpia_source',onQuery});
  assert.deepEqual(plain(prepared.outputSkus),['A-child']);assert.equal(prepared.resolution.bySku.has('A'),false);
  assert.equal(prepared.resolution.bySku.get('A-child').final,21000);
  const canonical=sandbox.HubCurrentPriceDecisionResolver.proof(sandbox.HubCurrentPriceDecisionResolver.normalize(response,{source,skus:['A']}));
  assert.equal(prepared.resolution.bySku.get('A-child').price_proof.decisionProof,digest(canonical));
  const proof=JSON.parse(canonical);
  assert.deepEqual(proof.groups,[]);assert.equal(proof.carrier_proofs[0].mapping_fingerprint,'cache-map-1');assert.deepEqual(proof.snapshots,exportSnapshots);
  assert.equal(proof.carrier_proofs[0].source_channel,source);
  assert.equal(calls.find(call=>call.name==='loadExportCurrentPriceDecisions').args[0].onQuery,onQuery);
  assert.equal(await api.verify(prepared),true);
  response=structuredClone(original);response.carrier_proofs[0].mapping_fingerprint='cache-map-2';
  await assert.rejects(api.verify(prepared),/상위 가격 또는 종속관계가 변경/);
  response=structuredClone(original);response.snapshots.seller_snapshot_id='new-seller-snapshot';response.carrier_proofs[0].snapshot_id='new-seller-snapshot';
  await assert.rejects(api.verify(prepared),/상위 가격 또는 종속관계가 변경/);
  response=structuredClone(original);rawPrice=22000;
  await assert.rejects(api.verify(prepared),/상위 가격 또는 종속관계가 변경/);
  assert.ok(!calls.some(call=>call.name==='loadCurrentPriceDecisions'));
 }
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

function largeEvidence(rootCount,descendantCount=rootCount){
 const roots=Array.from({length:rootCount},(_,index)=>`ROOT-${index}`),children=Array.from({length:descendantCount},(_,index)=>`CHILD-${index}`);
 const context={contract_version:1,version:'large-graph',snapshot_id:'sellpia-1',requested_skus:roots,selected_skus:[...roots,...children],reference_skus:[],
  edges:children.map((child,index)=>({edge_id:`edge-${index}`,parent_node_id:`root-node-${index%rootCount}`,child_node_id:`child-node-${index}`,parent_sku:roots[index%rootCount],child_sku:child}))};
 const response={rows:[],groups:[],proof_version:'sellpia-export-v2',absence_proofs:[],snapshots:{...exportSnapshots},carrier_proofs:roots.map((sku,index)=>({
  source_channel:'smartstore',seller_product_code:`PRODUCT-${index}`,mapping_fingerprint:`mapping-${index}`,
  snapshot_id:exportSnapshots.seller_snapshot_id,sellpia_snapshot_id:exportSnapshots.sellpia_snapshot_id,source_observed_at:exportSnapshots.sellpia_observed_at,
  sellpia_prices:{[sku]:1000+index},targets:[{sku,member_skus:[sku],seller_product_code:`PRODUCT-${index}`,seller_option_code:`OPTION-${index}`,sourceprice:1000+index,source_row_no:index+2,source_valid:true,
   component_members:[{sku,mapping_source:'carrier_cache',listing_id:null,component_id:null,component_qty:1,component_role:'primary'}]}]}))};
 return {roots,children,context,response,raw:new Map(roots.map((sku,index)=>[sku,1000+index]))};
}

test('a fresh parent read hashes the complete canonical evidence exactly once and keeps scalar provenance',async()=>{
 const fixture=largeEvidence(40),hashCalls=[];
 const h=harness({context:fixture.context,decisions:fixture.response,crypto:{subtle:{digest:async(algorithm,bytes)=>{hashCalls.push({algorithm,bytes:bytes.length});return webcrypto.subtle.digest(algorithm,bytes);}}},handlers:{loadSellpiaSourcePricesForExport:async()=>fixture.raw}});
 const resolver=h.sandbox.HubCurrentPriceDecisionResolver;let proofCalls=0;
 h.sandbox.HubCurrentPriceDecisionResolver={...resolver,proof:value=>{proofCalls++;return resolver.proof(value);}};
 const expected=digest(resolver.proof(resolver.normalize(fixture.response,{source:'smartstore',skus:fixture.roots})));
 const prepared=await h.api.prepare({source:'smartstore',skus:fixture.roots,priceMode:'sellpia_source'});
 assert.equal(proofCalls,1);assert.equal(hashCalls.length,1);assert.equal(hashCalls[0].algorithm,'SHA-256');
 assert.ok(hashCalls[0].bytes>10000,'the full carrier and snapshot proof, rather than an identity-only subset, must enter SHA-256');
 for(const child of fixture.children){const row=prepared.resolution.bySku.get(child);assert.equal(row.price_proof.decisionProof,expected);assert.match(row.price_proof.decisionProof,/^sha256:v1:[0-9a-f]{64}$/);assert.equal(row.price_proof.origin,'sellpia_source');assert.equal(row.final,fixture.raw.get(row.root_sku));}
 assert.equal(await h.api.verify(prepared),true);assert.equal(proofCalls,2);assert.equal(hashCalls.length,2,'verification performs a new read and a new digest');
 await assert.rejects(h.api.verify({...prepared,proof:prepared.proof.replaceAll('sha256:v1:','sha256:v0:')}),/상위 가격 또는 종속관계가 변경/);
});

test('doubling independent roots grows dependency proof linearly instead of repeating each full batch proof',async()=>{
 const sizes=[];
 for(const count of [40,80]){
  const fixture=largeEvidence(count),h=harness({context:fixture.context,decisions:fixture.response,handlers:{loadSellpiaSourcePricesForExport:async()=>fixture.raw}});
  const result=await h.api.prepare({source:'smartstore',skus:fixture.roots,priceMode:'sellpia_source'});
  sizes.push(result.proof.length);assert.ok(result.proof.length<1000*count);
  assert.ok(result.resolution.proof.length<1000*count);
 }
 assert.ok(sizes[1]<sizes[0]*2.2,`40/80 roots must remain linear: ${sizes.join(' / ')}`);
});

test('600 roots and 16000 descendants retain exact finals with bounded read-only proofs',async()=>{
 const fixture=largeEvidence(600,16000),before=JSON.stringify({context:fixture.context,response:fixture.response}),h=harness({context:fixture.context,decisions:fixture.response,handlers:{loadSellpiaSourcePricesForExport:async()=>fixture.raw}});
 const result=await h.api.prepare({source:'smartstore',skus:fixture.roots,priceMode:'sellpia_source'});
 assert.equal(result.outputSkus.length,16600);assert.equal(result.summary.inheritedCount,16000);assert.equal(result.summary.autoIncludedCount,16000);
 for(const child of fixture.children){const row=result.resolution.bySku.get(child);assert.equal(row.final,fixture.raw.get(row.root_sku));assert.equal(row.price_proof.decisionProof.length,74);}
 assert.ok(result.proof.length<12_000_000,`service proof must stay bounded: ${result.proof.length}`);
 assert.ok(result.resolution.proof.length<12_000_000);
 assert.equal(JSON.stringify({context:fixture.context,response:fixture.response}),before);
 assert.deepEqual(h.calls.map(call=>call.name),['loadExportSkuDependencies','loadExportCurrentPriceDecisions','loadSellpiaSourcePricesForExport']);
});

test('digest verification detects carrier, source, absence and current-decision evidence changes while ignoring object key order',async()=>{
 const fixture=largeEvidence(1),original=fixture.response;let response=structuredClone(original);
 const absence={...structuredClone(original.carrier_proofs[0]),mapping_valid:true,revision:0};response.absence_proofs=[absence];
 const initial=structuredClone(response),h=harness({context:fixture.context,handlers:{loadExportCurrentPriceDecisions:async()=>response,loadSellpiaSourcePricesForExport:async()=>fixture.raw}});
 const prepared=await h.api.prepare({source:'smartstore',skus:fixture.roots,priceMode:'sellpia_source'});
 const reordered=value=>Array.isArray(value)?value.map(reordered):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().map(([key,item])=>[key,reordered(item)])):value;
 response=reordered(initial);assert.equal(await h.api.verify(prepared),true);
 for(const mutate of [r=>{r.carrier_proofs[0].mapping_fingerprint='changed';},r=>{r.carrier_proofs[0].targets[0].component_members[0].component_qty=2;},r=>{r.carrier_proofs[0].sellpia_prices['ROOT-0']=2000;},r=>{r.absence_proofs[0].mapping_fingerprint='changed';},r=>{r.snapshots.seller_snapshot_id='new-seller';r.carrier_proofs[0].snapshot_id='new-seller';r.absence_proofs[0].snapshot_id='new-seller';}]){
  response=structuredClone(initial);mutate(response);await assert.rejects(h.api.verify(prepared),/상위 가격 또는 종속관계가 변경/);
 }
 response=structuredClone(initial);response.rows=[decision('ROOT-0',1000,{product:'PRODUCT-0',option:'OPTION-0'})];
 await assert.rejects(h.api.verify(prepared),/상위 가격 또는 종속관계가 변경/);
});

test('unavailable or failed WebCrypto rejects without an insecure fallback or price read',async()=>{
 for(const crypto of [undefined,{}, {subtle:{digest:async()=>{throw Error('digest unavailable');}}}]){
  const h=harness({crypto:crypto??null});
  await assert.rejects(h.api.prepare({source:'smartstore',skus:['A'],priceMode:'sellpia_source'}),/안전한 검증 기능|digest unavailable/);
  assert.deepEqual(h.calls.map(call=>call.name),['loadExportSkuDependencies','loadExportCurrentPriceDecisions']);
 }
 const h=harness({context:graph([],{requested:['A']}),crypto:null});
 assert.equal((await h.api.prepare({source:'smartstore',skus:['A']})).summary.inheritedCount,0,'an unrelated output does not require hashing or a price read');
});
