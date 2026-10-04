import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source=fs.readFileSync('mockups/operations-hub/app.js','utf8');
const start=source.indexOf('async function prepareChangedOnlyExport(');
const end=source.indexOf('\nwindow.SystemV3SellerExportBridge=',start);
assert.ok(start>=0&&end>start);
const functionSource=source.slice(start,end);

test('changed-only export derives its authoritative scope from carrier identities, never a full Matrix snapshot',async()=>{
 const calls=[];
 const file={name:'actual-carrier.xlsx'};
 const carrierRows=[{product_code:'P1',option_code:'O1',source_row_no:2,stock:4,base_price:1000,discounted_base_price:1000,option_price:0,final_price:1000,discount_terms:[]}];
 const ctx={
  Date,Blob,setTimeout,performance:{now:()=>Date.now()},formatNumber:value=>String(value),CHANNEL_LABELS:{smartstore:'스마트스토어'},
  sellerExport:{transformSellerFile(){throw Error('unchanged plan must not serialize');},outputName:name=>name,downloadBlob(){},conflictCsv(){return '';}},
  liveData:{
   async downloadLatestSellerOriginals(sources){calls.push(['files',sources]);return new Map([['smartstore',[file]]]);},
   async loadCarrierSellerMappings({source,identities,onQuery}){calls.push(['mapping',source,identities.length]);onQuery({query:'carrier seller identity',scope_count:1,latency_ms:1,status:'ok'});return {rows:[{sku:'S1',product_code:'P1',option_code:'O1'}]};},
   async loadCarrierMatrixTargets({source,skus,onQuery}){calls.push(['targets',source,[...skus]]);onQuery({query:'hub_carrier_targets_read_v1',scope_count:1,latency_ms:2,status:'ok'});return {rows:[{sku:'S1',seller_stock:4,active_price_rule:false}]};},
   loadMatrixExportSnapshot(){throw Error('full Matrix snapshot must never be called');}
  },
  window:{
   SystemV3SellerParsers:{async parseSellerFiles(){return {normalizedRows:carrierRows};}},
   HubCurrentPriceExport:{prepareCarrierItems(source,name,rows,snapshot){calls.push(['plan',source,name,rows.length,snapshot.length]);return {operations:[],excludedItems:[]};}}
  }
 };
 vm.createContext(ctx);vm.runInContext(functionSource+'\nthis.prepare=prepareChangedOnlyExport;',ctx);
 let reference=null;
 for(let repeat=0;repeat<5;repeat++){
  const result=await ctx.prepare('smartstore',null,{download:false});
  const compact={carrier_rows:result.diagnostics.carrier_rows,sku_count:result.diagnostics.sku_count,query_count:result.diagnostics.query_count,changed:result.changedItems.length};
  if(reference)assert.deepEqual(compact,reference);else reference=compact;
  assert.equal(result.diagnostics.full_snapshot,false);
 }
 assert.deepEqual(reference,{carrier_rows:1,sku_count:1,query_count:2,changed:0});
 assert.equal(calls.filter(call=>call[0]==='targets').length,5);
 assert.ok(calls.filter(call=>call[0]==='targets').every(call=>call[2].length===1&&call[2][0]==='S1'));
});

test('carrier RPC migration splits direct SKU and seller identity probes without a broad OR scan',()=>{
 const sql=fs.readFileSync('supabase/migrations/20260919122245_optimize_carrier_scoped_targets_v2.sql','utf8');
 assert.match(sql,/candidate_union as materialized/);
 assert.match(sql,/join public\.operations_hub_change_queue q on q\.sellpia_sku_code=r\.sku/);
 assert.match(sql,/join public\.operations_hub_change_queue q\s+on q\.source_channel=p_source/);
 assert.doesNotMatch(sql,/and \(q\.sellpia_sku_code in .* or exists/is);
 assert.doesNotMatch(sql,/statement_timeout/i);
});
