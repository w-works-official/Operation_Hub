import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code=fs.readFileSync('mockups/operations-hub/data-service.js','utf8');
test('full Matrix read preserves current fingerprints and skips freshness reads for unused seller history',async()=>{
 const requests=[];
 const products=[{sellpia_sku_code:'current',__hubInternalPrices:{actual_inbound_cost:{value:5}},__hubRulePrices:{smartstore:{platformFinal:10}}},{sellpia_sku_code:'legacy'}];
 const context={fullMatrixReadContext:{},console,throwIfAborted:()=>{},global:{HubMatrixShadow:{request:(p,s)=>({sku:p.sellpia_sku_code}),annotate:(p,payload)=>({...p,[payload.source]:payload.rows.find(r=>r.sku===p.sellpia_sku_code)})}},
  loadMatrixShadowMetadata:async({source})=>({source,rows:products.map(p=>({sku:p.sellpia_sku_code,calculated:[{scope:'',field:'actual_inbound_cost',result_details:{input_fingerprint:'stored'}},{scope:source,field:'platform_final_price',result_details:{input_fingerprint:'stored'}}]}))}),
  loadInputFingerprints:async(codes,scope)=>{requests.push({codes:Array.from(codes),scope});return Object.fromEntries(codes.map(s=>[s,'current-proof']));}};
 vm.createContext(context);vm.runInContext(code.slice(code.indexOf('  async function attachMatrixShadow('),code.indexOf('  async function loadBaselineShadow(')),context);
 const rows=await context.attachMatrixShadow(products);
 assert.deepEqual(requests,[{codes:['current'],scope:''},{codes:['current'],scope:'smartstore'}]);
 assert.equal(rows[0].smartstore.current_input_fingerprint,'current-proof');
 assert.equal(rows[0].ably.current_internal_input_fingerprint,'current-proof');
 assert.equal(rows[1].ably.calculated.length,2,'stored history remains available');
 requests.length=0;context.fullMatrixReadContext=null;
 await context.attachMatrixShadow(products);
 assert.equal(requests.length,4,'ordinary production/detail reads retain existing fingerprint behavior');
 assert.ok(requests.every(r=>r.codes.includes('legacy')));
});

test('failed full read keeps its read context until all concurrent workers have settled',async()=>{
 let released;
 const pending=new Promise(resolve=>released=resolve),context={performance,global:{},throwIfAborted:()=>{},matrixReadMetrics:{requests:0,bytes:0,networkMs:0},
 loadAllFilteredSkus:async()=>({skus:Array.from({length:400},(_,i)=>String(i))}),
 loadProductsBySkus:async(batch)=>{if(batch[0]==='0')throw Error('permission denied');await pending;assert.ok(context.readContext(),'pending worker must still use full-read RPCs');return batch.map(sku=>({sellpia_sku_code:sku,__hubActivePriceRules:{}}));}};
 vm.createContext(context);vm.runInContext(code.slice(code.indexOf('  let fullMatrixReadContext='),code.indexOf('  async function loadProductsBySkus('))+'\nthis.readContext=()=>fullMatrixReadContext;',context);
 let settled=false;const read=context.loadFullMatrixDataset().finally(()=>settled=true);const rejection=assert.rejects(read,/permission denied/);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);
 released();await rejection;assert.equal(context.readContext(),null);
});
