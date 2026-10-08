import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source=fs.readFileSync('mockups/operations-hub/data-service.js','utf8');
const datasetSource=fs.readFileSync('mockups/operations-hub/matrix-dataset.js','utf8');

test('tag scope includes inherited product tags and SKU tags across the complete dataset independently of changed values',async()=>{
 const rows=Array.from({length:2005},(_,i)=>({sellpia_sku_code:`SKU-${i}`,system_stock:4,system_base_price:1000,
  __grid_tag_ids:i<2000?['14k','14k']:[],__profile:{product_tags:i%2===0?[{tag_id:'14k'}]:[],sku_tags:i%2?[{tag_id:'14k'}]:[]}}));
 const context={console,Map,Set,Intl,loadMatrixGridDataset:async()=>({rows,count:2005,metrics:{datasetVersion:'complete-1'}}),cleanText:v=>String(v??'').trim()};
 context.global=context;
 vm.createContext(context);vm.runInContext(datasetSource,context);
 const start=source.indexOf('  async function loadAllTagScopeSkus('),end=source.indexOf('  async function loadAblyInventoryMappings(',start);
 vm.runInContext(source.slice(start,end)+';this.resolve=loadAllTagScopeSkus;',context);
 const result=await context.resolve({tagId:'14k'});
 assert.equal(result.count,2000);assert.equal(new Set(result.skus).size,2000);assert.equal(result.datasetVersion,'complete-1');
 rows.pop();await assert.rejects(context.resolve({tagId:'14k'}),/count 불일치/,'an incomplete authoritative dataset is never accepted');
});

function service(handler){
 const calls=[],events=[];
 const win={supabase:{createClient:()=>({rpc:async(name,args)=>{calls.push({name,args});return handler(name,args);},from(){throw Error('unexpected raw table access');}})},
  SystemV3SellerParsers:{},crypto:{randomUUID:()=> 'fixture'},CustomEvent:class {constructor(type){this.type=type;}},dispatchEvent:event=>events.push(event.type),fetch:async()=>{throw Error('unexpected network');}};
 const context={window:win,URL,TextEncoder,TextDecoder,performance,console,setTimeout,clearTimeout,AbortController,AbortSignal,Blob,File,structuredClone};
 vm.createContext(context);vm.runInContext(source,context);
 return {api:win.SystemV3Data,calls,events};
}
test('mapping adapters require the existing operator session and validate complete mapping responses',async()=>{
 const {api,calls}=service(()=>({data:{rows:[],fingerprint:'revision-1',count:0}}));
 await assert.rejects(api.loadAblyInventoryMappings(),/로그인/);assert.equal(calls.length,0);
 api.setOperationsHubSessionToken('fixture-session');
 const result=await api.loadAblyInventoryMappings();assert.equal(result.fingerprint,'revision-1');
 assert.equal(calls[0].name,'load_ably_inventory_mappings_v1');assert.equal(calls[0].args.p_session_token,'fixture-session');
 const invalid=service(()=>({data:{rows:[]}}));invalid.api.setOperationsHubSessionToken('fixture');
 await assert.rejects(invalid.api.loadAblyInventoryMappings(),/응답을 검증/);
});
test('mapping import/update use guarded RPCs and announce readiness invalidation',async()=>{
 const {api,calls,events}=service(()=>({data:{ok:true}}));api.setOperationsHubSessionToken('fixture');
 await api.importAblyInventoryMappings({batchKey:'hash',fileName:'source.xlsx',sha256:'sha256',rows:[]});
 await api.updateAblyInventoryMapping({product_code:'P',option_code:'O',sellpia_sku_code:'S',mapping_state:'verified',stock_policy:'individual',individual_stock:0,reason:'confirmed exception'});
 assert.equal(calls[0].args.p_file_sha256,'sha256');assert.equal(calls[1].args.p_individual_stock,0);
 assert.equal(calls[1].args.p_reason,'confirmed exception');assert.deepEqual(events,['ably-inventory-mappings-changed','ably-inventory-mappings-changed']);
});
test('canonical Ably mapping preserves SKU fan-out, replaces exact legacy ownership, and carries identity suppression',()=>{
 const start=source.indexOf('  function mergeVerifiedAblyMappings('),end=source.indexOf('  async function importAblyInventoryMappings(',start);
 const context={cleanText:v=>String(v??'').trim(),Map};vm.createContext(context);
 vm.runInContext(source.slice(start,end)+';this.merge=mergeVerifiedAblyMappings;',context);
 const rows=context.merge([{sku:'OLD',product_code:'P',option_code:'O1'},{sku:'S',product_code:'P',option_code:'O3'}],{
  rows:[{sku:'S',product_code:'P',option_code:'O1',solution_code:'sellpia_S[기본]'},{sku:'S',product_code:'P',option_code:'O2',solution_code:'sellpia_S[헤비]'}],
  blocked_identities:[{product_code:'P',option_code:'O3',reason:'legacy_suppression_active'}]
 });
 assert.equal(rows.filter(row=>row.sku==='S').length,2);assert.ok(!rows.some(row=>row.sku==='OLD'));
 assert.equal(rows.find(row=>row.option_code==='O3').mapping_blocked,true);
 assert.ok(rows.filter(row=>row.sku==='S').every(row=>row.mapping_origin==='verified_solution_code'));
});
