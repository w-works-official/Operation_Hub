import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dataSource=fs.readFileSync(path.join(repo,'mockups/operations-hub/data-service.js'),'utf8');
const clean=value=>String(value??'').trim(),plain=value=>JSON.parse(JSON.stringify(value));
function extract(name){
 const start=dataSource.search(new RegExp(`  (?:async )?function ${name}\\(`));assert.ok(start>=0,`missing ${name}`);
 const next=dataSource.slice(start+2).search(/\n  (?:async )?function /);
 return next<0?dataSource.slice(start):dataSource.slice(start,start+2+next);
}
function canonical(product,option,sku='SKU-NEW',policy='shared'){
 return {product_code:product,option_code:option,sku,solution_code:`LITERAL-${product}-${option}`,mapping_state:'verified',stock_policy:policy,is_active:policy==='shared',individual_stock:policy==='individual'?4:null};
}
function adapter({canonicalRows=[],blocked=[],legacy=[],projection=[],inventory=[]}={}){
 const calls=[];
 class Query{
  constructor(table){this.table=table;this.filters=[];this.bounds=[0,999];}
  select(){return this;}order(){return this;}eq(key,value){this.filters.push([key,[value]]);return this;}in(key,values){this.filters.push([key,Array.from(values)]);return this;}range(from,to){this.bounds=[from,to];return this;}
  then(resolve,reject){
   calls.push({kind:'table',table:this.table,filters:this.filters,bounds:this.bounds});
   const data={operations_hub_seller_listings:[],operations_hub_listing_components:[],operations_hub_link_suppressions:[],operations_hub_listing_component_projection:projection,seller_inventory_latest:inventory}[this.table];
   assert.ok(data,`unexpected/global table query ${this.table}`);
   const selected=data.filter(row=>this.filters.every(([key,values])=>values.includes(row[key]))).slice(this.bounds[0],this.bounds[1]+1);
   return Promise.resolve({data:selected,error:null}).then(resolve,reject);
  }
 }
 const context={console,Map,Set,Number,String,JSON,RegExp,Error,Promise,Date,Math,cleanText:clean,requireOperationsHubSessionToken:()=> 'independent-mapping-session',readableDatabaseError:error=>new Error(error.message||String(error)),throwIfAborted(){},withAbortSignal(query){return query;},db:{
  from(table){return new Query(table);},
  async rpc(name,args){
   calls.push({kind:'rpc',name,args:plain(args)});
   assert.equal(args.p_session_token,'independent-mapping-session');
   if(name==='hub_carrier_seller_identity_read_v1')return {data:legacy.filter(row=>args.p_product_codes.includes(row.product_code)).slice(args.p_offset,args.p_offset+args.p_limit),error:null};
   assert.equal(name,'load_ably_verified_export_mappings_v1');
   assert.ok((args.p_product_codes?.length||0)+(args.p_skus?.length||0)>0,'canonical reads must have a seller-product or SKU filter');
   if((args.p_product_codes?.length||0)>1000||(args.p_skus?.length||0)>1000)return {data:null,error:{message:'canonical RPC scope exceeds 1000'}};
   const inScope=row=>args.p_product_codes?.includes(row.product_code)||args.p_skus?.includes(row.sku);
   return {data:{rows:canonicalRows.filter(inScope),blocked_identities:blocked.filter(inScope),fingerprint:'canonical-fixture-fingerprint'},error:null};
  }
 }};
 context.global=context;context.globalThis=context;context.window=context;vm.createContext(context);
 vm.runInContext(fs.readFileSync(path.join(repo,'mockups/operations-hub/matrix-multilisting.js'),'utf8'),context);
 vm.runInContext(fs.readFileSync(path.join(repo,'mockups/operations-hub/ably-playauto-export.js'),'utf8'),context);
 context.carrierRead=async(_name,_count,query)=>{const result=await query;if(result.error)throw result.error;return result;};
 vm.runInContext(['loadAblyVerifiedExportMappings','mergeVerifiedAblyMappings','loadCarrierSellerMappings','loadMatrixSellerListingsBySkus'].map(extract).join('\n')+'\nthis.api={loadCarrierSellerMappings,loadMatrixSellerListingsBySkus,mergeVerifiedAblyMappings};',context);
 return {context,api:context.api,resolver:context.AblyPlayautoExport,calls};
}
const carrier=(product,option,type='option_price_stock')=>({template_type:type,seller_product_code:product,seller_option_code:option,sellpia_product_code:'SELLPIA-P',direct_sellpia_sku_code:'SKU-OLD',option_sku_code:'sellpia_SKU-OLD',option_candidates:['old displayed option']});
const catalog=[{sellpia_product_code:'SELLPIA-P',sellpia_sku_code:'SKU-OLD',sellpia_option_name:'old displayed option'}];

test('verified exact Ably identity overrides direct text candidate and stale legacy ownership in both carrier types',async()=>{
 const h=adapter({canonicalRows:[canonical('ABLY-P','ABLY-O')],legacy:[{product_code:'ABLY-P',option_code:'ABLY-O',sellpia_sku_code:'SKU-OLD'}]});
 const mappings=await h.api.loadCarrierSellerMappings({source:'ably',identities:[{product_code:'ABLY-P',option_code:'ABLY-O'}]});
 assert.equal(mappings.rows.length,1);assert.equal(mappings.rows[0].mapping_origin,'verified_solution_code');
 for(const type of ['option_price_stock','product_price_option'])for(const preferDirectProductSku of [false,true]){
  const result=h.resolver.resolveSellpiaSku(carrier('ABLY-P','ABLY-O',type),catalog,mappings.rows,{preferDirectProductSku});
  assert.equal(result.sku,'SKU-NEW');assert.equal(result.method,'verified_solution_code');assert.equal(result.row.solution_code,'LITERAL-ABLY-P-ABLY-O');
 }
});

test('verified fanout retains distinct option identities and individual/excluded stock policies remain eligible for price mapping',async()=>{
 const h=adapter({canonicalRows:[canonical('P','RED','SKU-NEW','shared'),canonical('P','BLUE','SKU-NEW','individual'),canonical('P','GREEN','SKU-NEW','excluded')]});
 const result=await h.api.loadCarrierSellerMappings({source:'ably',identities:['RED','BLUE','GREEN'].map(option=>({product_code:'P',option_code:option}))});
 assert.equal(result.rows.length,3);assert.deepEqual(plain(result.rows.map(row=>row.option_code)).sort(),['BLUE','GREEN','RED']);
 for(const row of result.rows){const resolved=h.resolver.resolveSellpiaSku(carrier('P',row.option_code),catalog,result.rows);assert.equal(resolved.sku,'SKU-NEW');assert.equal(resolved.method,'verified_solution_code');}
});

test('suppressed or conflicting exact Ably identities never fall back to direct text, legacy ownership or catalog matching',async()=>{
 for(const reason of ['legacy_suppression_active','mapping_conflict']){
  const h=adapter({canonicalRows:[canonical('P','O')],blocked:[{product_code:'P',option_code:'O',reason}],legacy:[{product_code:'P',option_code:'O',sellpia_sku_code:'SKU-OLD'}]});
  const mappings=await h.api.loadCarrierSellerMappings({source:'ably',identities:[{product_code:'P',option_code:'O'}]});assert.equal(mappings.rows.length,1);assert.equal(mappings.rows[0].mapping_blocked,true);assert.equal(mappings.rows[0].sku,'');
  for(const type of ['option_price_stock','product_price_option']){const resolution=h.resolver.resolveSellpiaSku(carrier('P','O',type),catalog,mappings.rows,{preferDirectProductSku:true});assert.equal(resolution.sku,undefined);assert.equal(resolution.method,'seller_mapping_suppressed');}
 }
});

test('Matrix canonical enrichment removes stale owner details and adds every verified identity for the requested owner with independent seller values',async()=>{
 const rows=[canonical('P','RED'),canonical('P','BLUE','SKU-NEW','individual')];
 const h=adapter({canonicalRows:rows,projection:[{source_channel:'ably',product_code:'P',option_code:'RED',sellpia_sku_code:'SKU-OLD',component_qty:1}],inventory:[{source_channel:'ably',product_code:'P',option_code:'RED',stock:3,price:1000},{source_channel:'ably',product_code:'P',option_code:'BLUE',stock:4,price:1200}]});
 const old=await h.api.loadMatrixSellerListingsBySkus(['SKU-OLD']);assert.equal(old.get('SKU-OLD')?.ably?.length||0,0,'legacy old identity must not remain attached to the prior SKU');
 const current=await h.api.loadMatrixSellerListingsBySkus(['SKU-NEW']);assert.equal(current.get('SKU-NEW').ably.length,2);assert.deepEqual(plain(current.get('SKU-NEW').ably.map(row=>[row.option_code,row.stock,row.price])).sort(),[['BLUE',4,1200],['RED',3,1000]]);
 const rpc=h.calls.filter(call=>call.name==='load_ably_verified_export_mappings_v1');assert.ok(rpc.some(call=>call.args.p_skus?.includes('SKU-NEW')));assert.ok(rpc.some(call=>call.args.p_product_codes?.includes('P')),'stale projected identities are reconciled within their product scope');
 assert.ok(h.calls.filter(call=>call.kind==='table'&&call.table==='seller_inventory_latest').every(call=>call.filters.some(([key,values])=>key==='product_code'&&values.length>0&&values.length<=100)));
});

test('carrier canonical reads chunk 1010 product identities and Matrix limits its visible SKU scope to 100',async()=>{
 const h=adapter();await h.api.loadCarrierSellerMappings({source:'ably',identities:Array.from({length:1010},(_,index)=>({product_code:`P-${index}`,option_code:'O'}))});
 assert.deepEqual(h.calls.filter(call=>call.name==='load_ably_verified_export_mappings_v1').map(call=>call.args.p_product_codes.length),[1000,10]);
 assert.ok(h.calls.filter(call=>call.name==='hub_carrier_seller_identity_read_v1').every(call=>call.args.p_product_codes.length<=100&&call.args.p_limit===1000));
 h.calls.splice(0);await h.api.loadMatrixSellerListingsBySkus(Array.from({length:101},(_,index)=>`SKU-${index}`));
 const calls=h.calls.filter(call=>call.name==='load_ably_verified_export_mappings_v1');assert.equal(calls.length,1);assert.equal(calls[0].args.p_skus.length,100);
 assert.deepEqual(h.calls.filter(call=>call.table==='operations_hub_listing_component_projection').map(call=>call.filters.find(([key])=>key==='sellpia_sku_code')[1].length),[50,50]);
});

test('Matrix product reconciliation chunks 1001 fanout products to respect the canonical RPC 1000-filter bound',async()=>{
 const projection=Array.from({length:1001},(_,index)=>({source_channel:'ably',product_code:`P-${index}`,option_code:'O',sellpia_sku_code:'SKU-ONE',component_qty:1}));
 const h=adapter({projection});await h.api.loadMatrixSellerListingsBySkus(['SKU-ONE']);
 const productReads=h.calls.filter(call=>call.name==='load_ably_verified_export_mappings_v1'&&call.args.p_product_codes?.length);
 assert.deepEqual(productReads.map(call=>call.args.p_product_codes.length),[1000,1]);
 assert.ok(h.calls.filter(call=>call.name==='load_ably_verified_export_mappings_v1').every(call=>(call.args.p_product_codes?.length||0)<=1000&&(call.args.p_skus?.length||0)<=1000));
});

test('inventory readiness classifies inactive review rows as review before confirmed exclusions and suppressions',()=>{
 const context={console,Map,Set,Number,String,JSON,RegExp,Error,Promise,Date,Math};context.globalThis=context;context.window=context;vm.createContext(context);
 for(const name of ['sellpia-inventory-count','ably-inventory-export'])vm.runInContext(fs.readFileSync(path.join(repo,`mockups/operations-hub/${name}.js`),'utf8'),context);
 const shared=(code,patch={})=>({solution_code:code,sellpia_sku_code:'SKU-ONE',product_code:'P',option_code:code,mapping_state:'verified',stock_policy:'shared',is_active:true,suppression_active:false,...patch});
 const mappingRows=[
  shared('SAFE'),
  shared('UNRESOLVED',{mapping_state:'review',is_active:false}),
  shared('STOCK-REVIEW',{stock_policy:'review',is_active:false}),
  shared('REVIEW-WITH-EXCLUSION',{mapping_state:'review',stock_policy:'excluded',is_active:false,suppression_active:true}),
  shared('CONFIRMED-EXCLUDED',{stock_policy:'excluded',is_active:false}),
  shared('SUPPRESSED-VERIFIED',{suppression_active:true}),
  shared('DISABLED-VERIFIED',{is_active:false})
 ];
 const readiness=context.HubAblyInventoryExport.readiness({mappingRows});
 assert.equal(readiness.ready,true);assert.equal(readiness.eligibleCount,1);assert.equal(readiness.reviewCount,3);assert.equal(readiness.excludedCount,3);
 const plan=context.HubAblyInventoryExport.prepare({mappingRows,stockSources:{snapshotId:'local-review-fixture',bySku:new Map([['SKU-ONE',{sellpia_current_stock:12,sellpia_available_stock:9}]])}});
 assert.deepEqual(plain(plan.rows.map(row=>[row.solution_code,row.quantity])),[['SAFE',9]]);
 assert.deepEqual(plain(plan.summary),{mappingCount:7,eligibleCount:1,reviewCount:3,excludedCount:3,excludedRowCount:6});
 assert.deepEqual(plain(plan.excludedRows.map(row=>row.solution_code)),['UNRESOLVED','STOCK-REVIEW','REVIEW-WITH-EXCLUSION','CONFIRMED-EXCLUDED','SUPPRESSED-VERIFIED','DISABLED-VERIFIED']);
 const reviewOnly=context.HubAblyInventoryExport.readiness({mappingRows:[mappingRows[1]]});
 assert.equal(reviewOnly.ready,false);assert.equal(reviewOnly.reviewCount,1);assert.equal(reviewOnly.excludedCount,0);assert.match(reviewOnly.reason,/검토 1건 · 제외 0건/);
});
