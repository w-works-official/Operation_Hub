import assert from 'node:assert/strict';
import test from 'node:test';
import '../mockups/operations-hub/price-dependency-export.js';
import '../mockups/operations-hub/stock-dependency-export.js';
import '../mockups/operations-hub/sellpia-inventory-count.js';

const api=globalThis.HubStockDependencyExport;
const edge=(parent_sku,child_sku,edge_id=`${parent_sku}-${child_sku}`)=>({edge_id,parent_sku,child_sku});
const context=({selected=['A','B','C'],requested=['A'],references=[],edges=[edge('A','B'),edge('B','C')],version='graph-1'}={})=>({
  contract_version:1,version,snapshot_id:'graph-snapshot-1',requested_skus:requested,selected_skus:selected,reference_skus:references,edges
});
const stock=(sku,current,available)=>({sellpia_sku_code:sku,sellpia_current_stock:current,sellpia_available_stock:available,provenance:{file:`${sku}.xlsx`}});
const sources=(rows=[stock('A',3,2),stock('B',99,88),stock('C',77,66)])=>({snapshotId:'stock-snapshot-1',bySku:new Map(rows.map(row=>[row.sellpia_sku_code,row])),missingSkus:[],invalidSkus:[]});
const resolved=(result,sku)=>result.rows.find(row=>row.sku===sku);

test('stock inheritance copies root raw 3 to all descendants without quantity arithmetic or changing another stock field',()=>{
  const input=sources(),before=JSON.stringify([...input.bySku]);
  const result=api.resolve({context:context(),stockSources:input,stockSource:'stock'});
  assert.deepEqual(result.inputSkus,['A','B','C']);assert.deepEqual(result.blockedSkus,[]);
  assert.deepEqual([...result.stockSources.bySku.values()].map(row=>[row.sellpia_current_stock,row.sellpia_available_stock]),[[3,2],[3,88],[3,66]]);
  assert.equal(resolved(result,'A').applied,false);assert.equal(resolved(result,'B').applied,true);
  assert.equal(resolved(result,'B').parent_sku,'A');assert.equal(resolved(result,'C').root_sku,'A');
  assert.deepEqual(resolved(result,'C').path,['A','B','C']);
  assert.equal(resolved(result,'C').raw_value,3);assert.equal(resolved(result,'C').source_snapshot_id,'stock-snapshot-1');
  assert.equal(JSON.stringify([...input.bySku]),before);
  assert.notEqual(result.stockSources.bySku,input.bySku);
  assert.notEqual(result.stockSources.bySku.get('A'),input.bySku.get('A'));
  result.stockSources.bySku.get('B').provenance.file='changed';
  assert.equal(input.bySku.get('B').provenance.file,'B.xlsx','export rows have independent nested provenance');
  result.stockSources.missingSkus.push('export-only');assert.deepEqual(input.missingSkus,[]);
});

test('available inheritance preserves the negative raw value and delegates zero clamping to the existing file projection',()=>{
  const input=sources([stock('A',9,-3),stock('B',8,88),stock('C',7,66)]);
  const result=api.resolve({context:context(),stockSources:input,stockSource:'available_stock'});
  assert.deepEqual([...result.stockSources.bySku.values()].map(row=>[row.sellpia_current_stock,row.sellpia_available_stock]),[[9,-3],[8,-3],[7,-3]]);
  assert.equal(resolved(result,'B').raw_value,-3);
  assert.equal(globalThis.SystemV3SellpiaInventoryCount.resolveExportStock(result.stockSources.bySku.get('B'),'available_stock'),0);
  assert.equal(input.bySku.get('B').sellpia_available_stock,88);
});

test('zero and negative physical stock remain exact scalar values without a fallback to child stock',()=>{
  for(const value of [0,-4,Number.MAX_SAFE_INTEGER,Number.MIN_SAFE_INTEGER]){
    const result=api.resolve({context:context(),stockSources:sources([stock('A',value,5),stock('B',99,88),stock('C',77,66)]),stockSource:'stock'});
    assert.deepEqual(result.blockedSkus,[]);assert.equal(result.stockSources.bySku.get('B').sellpia_current_stock,value);
    assert.equal(result.stockSources.bySku.get('C').sellpia_current_stock,value);
  }
});

test('a reference-only ancestor is read but never becomes an output row; unrelated source entries remain unchanged',()=>{
  const graph=context({selected:['B','C'],requested:['B'],references:['A']});
  const input=sources([stock('A',3,2),stock('B',99,88),stock('C',77,66),stock('unrelated',42,40)]);
  const result=api.resolve({context:graph,stockSources:input,stockSource:'stock'});
  assert.deepEqual(result.rows.map(row=>row.sku),['B','C']);assert.deepEqual(result.inputSkus,['A','B','C']);
  assert.equal(result.stockSources.bySku.get('unrelated').sellpia_current_stock,42);
  assert.equal(result.stockSources.bySku.get('A').sellpia_current_stock,3);
  assert.equal(resolved(result,'B').automatically_included,false);assert.equal(resolved(result,'C').automatically_included,true);
});

test('a missing or blocked root blocks its descendants without synthesizing source rows or using child stock',()=>{
  const missing=sources([stock('B',99,88),stock('C',77,66)]);
  const result=api.resolve({context:context(),stockSources:missing,stockSource:'stock'});
  assert.deepEqual(result.blockedSkus,['B','C']);assert.equal(result.stockSources.bySku.has('A'),false);
  assert.equal(resolved(result,'B').error_code,'PARENT_SOURCE_MISSING');assert.equal(result.stockSources.bySku.get('B').sellpia_current_stock,99);
  const blocked=api.resolve({context:context(),stockSources:sources(),stockSource:'stock',blockedSkus:['A']});
  assert.deepEqual(blocked.blockedSkus,['A','B','C']);assert.equal(resolved(blocked,'A').error_code,'SKU_BLOCKED');
  assert.equal(resolved(blocked,'B').error_code,'PARENT_BLOCKED');assert.equal(blocked.stockSources.bySku.get('C').sellpia_current_stock,77);
});

test('a blocked or missing intermediate child stays blocked and cannot be bypassed by later descendants',()=>{
  const blocked=api.resolve({context:context(),stockSources:sources(),stockSource:'stock',blockedSkus:new Set(['B'])});
  assert.deepEqual(blocked.blockedSkus,['B','C']);assert.equal(resolved(blocked,'B').error_code,'SKU_BLOCKED');
  assert.equal(resolved(blocked,'C').error_code,'PARENT_BLOCKED');assert.equal(blocked.stockSources.bySku.get('B').sellpia_current_stock,99);
  const missing=api.resolve({context:context(),stockSources:sources([stock('A',3,2),stock('C',77,66)]),stockSource:'stock'});
  assert.deepEqual(missing.blockedSkus,['B','C']);assert.equal(resolved(missing,'B').error_code,'SKU_SOURCE_MISSING');
  assert.equal(resolved(missing,'C').error_code,'PARENT_SOURCE_MISSING');assert.equal(missing.stockSources.bySku.has('B'),false);
});

test('a child input block is never repaired by a valid parent and a missing leaf remains absent',()=>{
  const blocked=api.resolve({context:context(),stockSources:sources(),stockSource:'stock',blockedSkus:['C']});
  assert.equal(blocked.stockSources.bySku.get('B').sellpia_current_stock,3);
  assert.equal(blocked.stockSources.bySku.get('C').sellpia_current_stock,77);assert.equal(resolved(blocked,'C').error_code,'SKU_BLOCKED');
  const missing=api.resolve({context:context(),stockSources:sources([stock('A',3,2),stock('B',99,88)]),stockSource:'stock'});
  assert.deepEqual(missing.blockedSkus,['C']);assert.equal(missing.stockSources.bySku.has('C'),false);
});

test('null, missing, coerced, fractional, nonfinite and unsafe root values fail closed',()=>{
  for(const value of [null,undefined,'',false,'3',1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]){
    const result=api.resolve({context:context(),stockSources:sources([stock('A',value,2),stock('B',99,88),stock('C',77,66)]),stockSource:'stock'});
    assert.deepEqual(result.blockedSkus,['B','C']);assert.equal(resolved(result,'B').error_code,'INVALID_PARENT_STOCK');
    assert.equal(result.stockSources.bySku.get('B').sellpia_current_stock,99);
    assert.equal(result.stockSources.bySku.get('C').sellpia_current_stock,77);
  }
});

test('cycles, self references and multiple distinct parents block only their dependent output rows',()=>{
  for(const edges of [[edge('A','A'),edge('A','B'),edge('B','C')],[edge('A','B'),edge('B','A'),edge('B','C')]]){
    const result=api.resolve({context:context({edges}),stockSources:sources(),stockSource:'stock'});
    assert.deepEqual(result.blockedSkus,['A','B','C']);assert.equal(result.stockSources.bySku.get('C').sellpia_current_stock,77);
  }
  const graph=context({selected:['A','B','C','U'],requested:['A','U'],references:['Z'],edges:[edge('A','B'),edge('Z','B'),edge('B','C')]});
  const result=api.resolve({context:graph,stockSources:sources([stock('A',3,2),stock('B',99,88),stock('C',77,66),stock('Z',3,2),stock('U',12,10)]),stockSource:'stock'});
  assert.deepEqual(result.blockedSkus,['B','C']);assert.equal(resolved(result,'B').error_code,'MULTIPLE_PARENTS');
  assert.equal(resolved(result,'U').error,null);assert.equal(result.stockSources.bySku.get('U').sellpia_current_stock,12);
});

test('proof is stable across input ordering and changes for source, snapshot, graph, root stock, blocked scope or provenance paths',()=>{
  const graph=context(),input=sources();
  const result=api.resolve({context:graph,stockSources:input,stockSource:'stock'});
  const reordered={...graph,selected_skus:[...graph.selected_skus].reverse(),edges:[...graph.edges].reverse()};
  const reversed={...input,bySku:new Map([...input.bySku].reverse())};
  assert.equal(api.resolve({context:reordered,stockSources:reversed,stockSource:'stock'}).proof,result.proof);
  const variants=[
    {context:graph,stockSources:input,stockSource:'available_stock'},
    {context:graph,stockSources:{...input,snapshotId:'stock-snapshot-2'},stockSource:'stock'},
    {context:{...graph,version:'graph-2'},stockSources:input,stockSource:'stock'},
    {context:{...graph,snapshot_id:'graph-snapshot-2'},stockSources:input,stockSource:'stock'},
    {context:graph,stockSources:sources([stock('A',4,2),stock('B',99,88),stock('C',77,66)]),stockSource:'stock'},
    {context:graph,stockSources:input,stockSource:'stock',blockedSkus:['C']},
    {context:context({edges:[edge('A','B','new-edge'),edge('B','C')]}),stockSources:input,stockSource:'stock'}
  ];
  for(const variant of variants)assert.notEqual(api.resolve(variant).proof,result.proof);
  const proof=JSON.parse(result.proof);assert.equal(proof.snapshot_id,'stock-snapshot-1');
  assert.equal(proof.rows.find(row=>row.sku==='C').root_raw_value,3);assert.deepEqual(proof.rows.find(row=>row.sku==='C').path,['A','B','C']);
});

test('invalid contract inputs reject while an empty authoritative scope returns an independent empty export map',()=>{
  for(const change of [{stockSource:'system_stock'},{stockSource:'constructor'},{stockSource:'__proto__'},{stockSources:{snapshotId:'',bySku:new Map()}},{stockSources:{snapshotId:'snap',bySku:{}}},{blockedSkus:'A'},{blockedSkus:['']}]){
    assert.throws(()=>api.resolve({context:context(),stockSources:sources(),stockSource:'stock',...change}));
  }
  assert.throws(()=>api.resolve({context:context({selected:['A']}),stockSources:sources(),stockSource:'stock'}),/범위|후손|대상/);
  const empty={contract_version:1,version:'empty',snapshot_id:'snapshot',requested_skus:[],selected_skus:[],reference_skus:[],edges:[]};
  const input={snapshotId:'stock-empty',bySku:new Map()},result=api.resolve({context:empty,stockSources:input,stockSource:'stock'});
  assert.deepEqual(result.rows,[]);assert.deepEqual(result.blockedSkus,[]);assert.deepEqual(result.inputSkus,[]);
  assert.notEqual(result.stockSources.bySku,input.bySku);assert.equal(result.stockSources.bySku.size,0);
});
