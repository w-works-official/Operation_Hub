import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const c={};vm.createContext(c);vm.runInContext(fs.readFileSync('mockups/operations-hub/matrix-dataset.js','utf8'),c);const {Dataset}=c.HubMatrixDataset;
test('canonical full dataset keeps identity through local filtering/sort and bounded patch',()=>{
 const rows=Array.from({length:23775},(_,i)=>({sellpia_sku_code:'P-'+i,system_stock:i%7,system_base_price:i,own_code:'CODE'+i,__profile:{sku_tags:i%2?[{tag_id:'T',tag_name:'14K'}]:[]},smartstore_product_code:i%3?'S'+i:null}));
 rows.splice(0,4,...[1,2,3,4].map(i=>({...rows[i-1],sellpia_sku_code:'5566-'+i})));const d=new Dataset(rows);const before=JSON.stringify(d.rows);assert.equal(d.rows.length,23775);assert.equal(d.select({search:'5566',searchType:'sku'}).length,4);assert.equal(d.select({search:''}).length,23775);assert.ok(d.select({tagId:'T'}).every(r=>r.__profile.sku_tags.length));assert.ok(d.select({seller:'smartstore'}).every(r=>r.smartstore_product_code));assert.equal(JSON.stringify(d.rows),before);
 const sorted=d.select({sort:'stock_desc'});assert.ok(sorted.every((r,i)=>!i||sorted[i-1].system_stock>=r.system_stock));assert.equal(JSON.stringify(d.rows),before);
 const untouched=d.bySku.get('P-7'),changed={...d.bySku.get('5566-1'),system_stock:999};assert.deepEqual(Array.from(d.patch([changed])),['5566-1']);assert.equal(d.bySku.get('P-7'),untouched);assert.equal(d.rows.find(r=>r.sellpia_sku_code==='5566-1'),changed);assert.equal(d.rows.length,23775);assert.throws(()=>new Dataset([changed,changed]),/중복/);assert.throws(()=>new Dataset([changed],2),/count/);assert.throws(()=>d.patch([{sellpia_sku_code:'MISSING'}]),/reload/);
});
test('local exact/prefix searches and null numeric/stale/ownership guards',()=>{
 const d=new Dataset([{sellpia_sku_code:'1-1',own_code:'ABC',system_stock:null,__hubInternalPrices:{calculated_base_price:{stale:true}}},{sellpia_sku_code:'1-10',own_code:'ABCD',system_stock:3}]);assert.equal(d.select({search:'1-1',searchType:'sku'}).length,1);assert.equal(d.select({search:'ABC',searchType:'own_code'}).length,1);assert.equal(d.select({state:'stale'}).length,1);assert.equal(d.select({advancedFilter:{conditions:[{field:'system_stock',operator:'lt',value:1}]}}).length,0);
});
test('compact Grid flags and tag ids preserve local filter semantics without shadow traversal',()=>{
 const rows=[
  {sellpia_sku_code:'G-1',__grid_tag_ids:['T1'],__profile:{sku_tags:[{tag_id:'T1',tag_name:'14K'}]},__grid_stale:true,__grid_conflict:false,__grid_pending:false,__grid_stock_mismatch:true,__grid_price_mismatch:false},
  {sellpia_sku_code:'G-2',__grid_tag_ids:['T2'],__profile:{sku_tags:[{tag_id:'T2',tag_name:'기타'}]},__grid_stale:false,__grid_conflict:true,__grid_pending:true,__grid_stock_mismatch:false,__grid_price_mismatch:true}
 ];
 const d=new Dataset(rows);
 const selected=options=>JSON.stringify(d.select(options).map(r=>r.sellpia_sku_code));
 assert.equal(selected({tagId:'T1'}),JSON.stringify(['G-1']));
 assert.equal(selected({state:'stale'}),JSON.stringify(['G-1']));
 assert.equal(selected({state:'conflict'}),JSON.stringify(['G-2']));
 assert.equal(selected({state:'pending'}),JSON.stringify(['G-2']));
 assert.equal(selected({state:'stock_mismatch'}),JSON.stringify(['G-1']));
 assert.equal(selected({state:'price_mismatch'}),JSON.stringify(['G-2']));
});
