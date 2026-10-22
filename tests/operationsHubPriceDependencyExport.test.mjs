import assert from 'node:assert/strict';
import test from 'node:test';
import '../mockups/operations-hub/price-dependency-export.js';

const api = globalThis.HubPriceDependencyExport;
const edge = (parent_sku, child_sku, edge_id = `${parent_sku}-${child_sku}`) => ({parent_sku, child_sku, edge_id});
function context(selected_skus, edges, {requested = ['A'], references = []} = {}) {
  return {contract_version:1, version:'relations-v1', snapshot_id:'sellpia-v1', requested_skus:requested,
    selected_skus, reference_skus:references, edges};
}

test('a selected parent includes descendants and copies its final exactly without child arithmetic or child manual prices', () => {
  const graph = context(['C','A','B'], [edge('A','B'),edge('B','C')]);
  const prices = new Map([['A',{final:12345,proof:{source:'smartstore',mode:'rules',event_id:'parent-event',revision:7}}],['B',{final:60000}],['C',{final:99999}]]);
  const result = api.resolve({context:graph,parentPrices:prices});
  assert.deepEqual(result.outputSkus,['A','B','C']);assert.deepEqual(result.rootSkus,['A']);
  assert.deepEqual(result.bySku.get('B'), {sku:'B',parent_sku:'A',root_sku:'A',path:['A','B'],error:null,error_code:null,
    inherited:true,automatically_included:true,final:12345,price_proof:{event_id:'parent-event',mode:'rules',revision:7,source:'smartstore'}});
  assert.equal(result.bySku.get('C').final,12345);assert.deepEqual(result.bySku.get('C').path,['A','B','C']);
  assert.equal(result.bySku.get('A').final,null,'the selected root keeps the existing ordinary export resolver');
  assert.equal(result.bySku.get('A').error,null);
  assert.equal(Object.hasOwn(result.bySku.get('B'),'current_price_decision'),false,'a parent event cannot become a child identity decision');
});

test('a parent outside output scope is read as a reference without exporting it or its unrelated branches', () => {
  const graph = context(['B','C'],[edge('A','B'),edge('B','C')],{requested:['B'],references:['A']});
  const plan = api.plan({context:graph});assert.deepEqual(plan.rootSkus,['A']);assert.deepEqual(plan.outputSkus,['B','C']);
  const result = api.resolve({context:graph,parentPrices:new Map([['A',4800]])});
  assert.equal(result.bySku.has('A'),false);assert.equal(result.bySku.get('B').automatically_included,false);
  assert.equal(result.bySku.get('C').automatically_included,true);assert.ok(result.rows.every(row=>row.final===4800));
});

test('unrelated roots remain ordinary and only roots required by inherited rows need a price read', () => {
  const graph = context(['A','B','U'],[edge('A','B')],{requested:['A','U']});
  assert.deepEqual(api.plan({context:graph}).rootSkus,['A']);
  const result = api.resolve({context:graph,parentPrices:new Map([['A',100]])});
  assert.equal(result.bySku.get('U').error,null);assert.equal(result.bySku.get('U').final,null);assert.equal(result.bySku.get('U').inherited,false);
});

test('duplicate semantic edges are harmless but distinct parents fail even when their prices are equal', () => {
  const duplicate = context(['A','B'],[edge('A','B',1),edge('A','B',2)]);
  assert.equal(api.resolve({context:duplicate,parentPrices:new Map([['A',5000]])}).bySku.get('B').final,5000);
  const graph = context(['A','C','D'],[edge('A','C'),edge('B','C'),edge('C','D')],{references:['B']});
  const result = api.resolve({context:graph,parentPrices:new Map([['A',5000],['B',5000]])});
  assert.equal(result.bySku.get('C').error_code,'MULTIPLE_PARENTS');assert.equal(result.bySku.get('D').error_code,'PARENT_INVALID');
  assert.ok(result.rows.filter(row=>row.inherited).every(row=>row.final===null));
});

test('self links and cycles stop their dependent chains while an independent selected root stays valid', () => {
  const self = api.resolve({context:context(['A','B'],[edge('A','A'),edge('A','B')]),parentPrices:new Map([['A',100]])});
  assert.equal(self.bySku.get('A').error_code,'SELF_REFERENCE');assert.equal(self.bySku.get('B').error_code,'PARENT_INVALID');
  const cycle = api.resolve({context:context(['A','B','C','U'],[edge('A','B'),edge('B','A'),edge('B','C')],{requested:['A','U']}),parentPrices:new Map([['A',100]])});
  assert.equal(cycle.bySku.get('A').error_code,'CYCLE');assert.equal(cycle.bySku.get('B').error_code,'CYCLE');assert.equal(cycle.bySku.get('C').error_code,'PARENT_INVALID');
  assert.equal(cycle.bySku.get('U').error,null);assert.deepEqual(cycle.rootSkus,[]);
});

test('a cycle among reference-only ancestors cannot supply a selected child price', () => {
  const graph=context(['C'],[edge('A','B'),edge('B','A'),edge('B','C')],{requested:['C'],references:['A','B']});
  const result=api.resolve({context:graph,parentPrices:new Map([['A',100]])});
  assert.equal(result.bySku.get('C').error_code,'PARENT_INVALID');assert.equal(result.bySku.get('C').final,null);
});

test('zero is a real scalar, while missing, negative, fractional, coerced and unsafe values fail closed', () => {
  const graph=context(['A','B'],[edge('A','B')]);
  for(const amount of [0,1,Number.MAX_SAFE_INTEGER])assert.equal(api.resolve({context:graph,parentPrices:new Map([['A',{final:amount}]])}).bySku.get('B').final,amount);
  for(const amount of [-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'100',null,undefined,{}]){
    const result=api.resolve({context:graph,parentPrices:new Map([['A',{final:amount}]])}).bySku.get('B');
    assert.equal(result.final,null);assert.equal(result.error_code,'INVALID_PARENT_PRICE');
  }
  assert.equal(api.resolve({context:graph}).bySku.get('B').error_code,'MISSING_PARENT_PRICE');
  assert.equal(api.resolve({context:graph,parentPrices:new Map([['A',null]])}).bySku.get('B').error_code,'MISSING_PARENT_PRICE');
  assert.match(api.resolve({context:graph,parentPrices:new Map([['A',{error:Error('parent read timeout')} ]])}).bySku.get('B').error,/parent read timeout/);
});

test('source-mode and Rule-mode finals are supplied by the caller and never transformed by this module', () => {
  const graph=context(['A','B'],[edge('A','B')]);
  const source=api.resolve({context:graph,parentPrices:new Map([['A',{final:9000,proof:{mode:'sellpia_source'}}]])});
  const rules=api.resolve({context:graph,parentPrices:new Map([['A',{final:13500,proof:{mode:'rules'}}]])});
  assert.equal(source.bySku.get('B').final,9000);assert.equal(rules.bySku.get('B').final,13500);assert.notEqual(source.proof,rules.proof);
});

test('proofs are deterministic and retain relation versions, snapshots, roots, original selection and parent price provenance', () => {
  const graph=context(['A','B','C'],[edge('A','B'),edge('B','C')]);
  const prices=new Map([['A',{final:5000,proof:{revision:1,event_id:'parent',nested:{z:2,a:1}}}]]);
  const first=api.resolve({context:graph,parentPrices:prices});
  const reordered=structuredClone(graph);reordered.selected_skus.reverse();reordered.edges.reverse();
  assert.equal(api.resolve({context:reordered,parentPrices:new Map([['A',{proof:{nested:{a:1,z:2},event_id:'parent',revision:1},final:5000}]])}).proof,first.proof);
  for(const mutate of [value=>value.version='relations-v2',value=>value.snapshot_id='sellpia-v2',value=>value.edges[0].edge_id='replacement-edge']){
    const changed=structuredClone(graph);mutate(changed);assert.notEqual(api.resolve({context:changed,parentPrices:prices}).proof,first.proof);
  }
  assert.notEqual(api.resolve({context:graph,parentPrices:new Map([['A',{final:5000,proof:{revision:2,event_id:'parent'}}]])}).proof,first.proof);
  assert.notEqual(api.resolve({context:graph,parentPrices:prices,selection:['A','C']}).proof,first.proof);
});

test('invalid graph shape or incomplete automatic scope cannot silently drop or add output SKUs', () => {
  const graph=context(['A','B'],[edge('A','B')]);
  for(const mutate of [value=>value.selected_skus=['A'],value=>value.selected_skus.push('U'),value=>value.selected_skus.push('A'),
    value=>value.reference_skus=['A'],value=>value.edges.push(edge('UNKNOWN','A')),value=>value.edges[0].child_sku='',value=>value.edges[0].is_active=false,
    value=>value.contract_version=2,value=>value.requested_skus=['UNKNOWN'],value=>value.edges=null]){
    const invalid=structuredClone(graph);mutate(invalid);assert.throws(()=>api.plan({context:invalid}));
  }
  assert.throws(()=>api.resolve({context:graph,parentPrices:{A:100}}),/Map/);
});

test('the helper supports an empty dataset and never mutates graph, price proofs or selection', () => {
  const empty=api.resolve({context:context([],[],{requested:[]})});assert.deepEqual(empty.rows,[]);assert.deepEqual(empty.rootSkus,[]);
  const graph=context(['A','B'],[edge('A','B')]),selection=new Set(['A']),price={final:123,proof:{event_id:'parent',values:[1,2]}};
  const before=JSON.stringify(graph),priceBefore=JSON.stringify(price),prices=new Map([['A',price]]);
  const result=api.resolve({context:graph,parentPrices:prices,selection});
  result.bySku.get('B').price_proof.values.push(3);result.bySku.get('B').path.push('unrelated');
  assert.equal(JSON.stringify(graph),before);assert.equal(JSON.stringify(price),priceBefore);assert.deepEqual([...selection],['A']);assert.equal(prices.size,1);
});
