import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../mockups/operations-hub/data-service.js',import.meta.url),'utf8');
const names=['loadFormulaProducts','attachProductProfiles','attachInboundCostDetails','attachSystemOperationalDetails','attachSellerPriceComponents','attachSellerDrafts'];
function extract(name){const start=source.search(new RegExp('  (?:async )?function '+name+'\\('));assert.ok(start>=0,name);const rest=source.slice(start+2),end=rest.slice(2).search(/\n  (?:async )?function /);return end<0?rest:rest.slice(0,end+2);}
const skus=Array.from({length:23760},(_,i)=>'catalog-'+String(i).padStart(5,'0'));
const calls=[];
const db={from(table){let ids=[],selection='';return {select(value){selection=value;return this;},in(field,values){ids=Array.from(values);return this;},order(){return this;},then(resolve,reject){
 calls.push({kind:'from',table,count:ids.length,selection});
 if(ids.length>500)return Promise.reject(Error(`unbounded ${table} request: ${ids.length} SKUs`)).then(resolve,reject);
 const data=ids.map(sku=>table==='matrix'?{sellpia_sku_code:sku,system_base_price:1}:table==='operations_hub_product_profiles'?{sellpia_sku_code:sku,sku_tags:[{tag_id:'catalog-test'}]}:table==='operations_hub_sku_operational_live'?{sellpia_sku_code:sku,system_base_price:10000,system_stock:7}:table==='operations_hub_inbound_cost_live'?{sellpia_sku_code:sku,actual_inbound_cost:5000}:null).filter(Boolean);
 return Promise.resolve({data,error:null}).then(resolve,reject);
}};},async rpc(name,args){const ids=Array.from(args.p_skus);calls.push({kind:'rpc',name,count:ids.length});assert.ok(ids.length<=200,'component requests stay within existing200-SKU batch');return {data:[],error:null};}};
const c={fullMatrixReadContext:null,db,MATRIX_VIEW:'matrix',cleanText:v=>String(v??'').trim(),requireOperationsHubSessionToken:()=> 'fixture',withAbortSignal:q=>q,global:{}};
c.attachRepresentativePrices=async rows=>rows;
vm.createContext(c);vm.runInContext(names.map(extract).join('\n')+'\nthis.load=loadFormulaProducts;',c);
const rows=await c.load(skus);
assert.equal(rows.length,23760);
assert.equal(new Set(rows.map(p=>p.sellpia_sku_code)).size,23760);
assert.ok(rows.every(p=>p.__profile.sku_tags[0].tag_id==='catalog-test'),'no catalog profile/tag truncation');
assert.ok(rows.every(p=>p.system_base_price===10000&&p.actual_inbound_cost===5000),'all original+operational basis values attached');
assert.ok(calls.filter(c=>c.table==='matrix').every(c=>c.count<=200));
assert.ok(calls.filter(c=>c.table==='operations_hub_product_profiles').every(c=>c.count<=500));

{
 const retrySkus=['10000-1','10000-2','10000-3'],retryCalls=[];let componentAttempts=0;
 const retryDb={from(table){let ids=[];return {select(){return this;},in(field,values){ids=Array.from(values);return this;},order(){return this;},then(resolve,reject){
  retryCalls.push({kind:'from',table,ids:[...ids]});
  const data=ids.map(sku=>table==='matrix'?{sellpia_sku_code:sku,system_base_price:1}:table==='operations_hub_product_profiles'?{sellpia_sku_code:sku}:table==='operations_hub_sku_operational_live'?{sellpia_sku_code:sku,system_base_price:10000}:table==='operations_hub_inbound_cost_live'?{sellpia_sku_code:sku,actual_inbound_cost:5000}:null).filter(Boolean);
  return Promise.resolve({data,error:null}).then(resolve,reject);
 }};},async rpc(name,args){const ids=Array.from(args.p_skus);retryCalls.push({kind:'rpc',name,ids});componentAttempts+=1;if(componentAttempts===1)return {data:null,error:{message:'canceling statement due to statement timeout'}};return {data:ids.map(sku=>({sellpia_sku_code:sku,source_channel:'smartstore',seller_product_code:'P10000',seller_option_code:sku})),error:null};}};
 const retryContext={db:retryDb,MATRIX_VIEW:'matrix',cleanText:v=>String(v??'').trim(),requireOperationsHubSessionToken:()=> 'fixture',withAbortSignal:q=>q,readableDatabaseError:e=>e,setTimeout:fn=>fn(),global:{}};
 retryContext.attachRepresentativePrices=async rows=>rows;
 vm.createContext(retryContext);vm.runInContext(names.map(extract).join('\n')+'\nthis.load=loadFormulaProducts;',retryContext);
 const retryRows=await retryContext.load(retrySkus);
 assert.equal(retryRows.length,3);
 assert.equal(retryCalls.filter(c=>c.table==='matrix').length,1,'component timeout must not repeat the matrix read');
 assert.equal(retryCalls.filter(c=>c.table==='operations_hub_product_profiles').length,1,'component timeout must not repeat profile enrichment');
 assert.equal(retryCalls.filter(c=>c.table==='operations_hub_inbound_cost_live').length,1,'component timeout must not repeat inbound enrichment');
 assert.equal(retryCalls.filter(c=>c.table==='operations_hub_sku_operational_live').length,1,'component timeout must not repeat operational enrichment');
 assert.equal(retryCalls.filter(c=>c.name==='load_operations_hub_seller_price_components').length,2,'only the timed-out component stage retries');
 assert.equal(retryCalls.filter(c=>c.table==='operations_hub_active_seller_drafts').length,1,'draft enrichment runs once after component recovery');
 assert.ok(retryCalls.every(c=>c.ids.length===3&&c.ids.every((sku,index)=>sku===retrySkus[index])),'every stage receives the same deduplicated three-SKU set');
}

const pipeline=[];
const stageNames=['attachInboundCostDetails','attachSystemOperationalDetails','attachPriceBasis','attachProductLinkDrafts','attachManualLinks','attachProductProfiles','attachLinkBadges','attachSellerPriceComponents','attachSellerDrafts','attachPriceRuleAssignments','attachLinkSuppressions'];
const metadataContext={fullMatrixReadContext:null,cleanText:v=>String(v??'').trim(),throwIfAborted:signal=>{if(signal?.aborted)throw Error('abort fixture');},withAbortSignal:q=>q,db:{async rpc(name,args){assert.equal(name,'load_operations_hub_matrix_metadata_v1');assert.deepEqual(Array.from(args.p_skus),['one']);return {data:{},error:null};}},global:{},attachStoredCalculatedPrices:async rows=>{pipeline.push('stored-price-projection');assert.ok(rows[0].enriched.includes('attachSellerDrafts'),'manual drafts attach before stored prices');assert.ok(rows[0].enriched.includes('attachSystemOperationalDetails'),'latest operational base attaches before stored prices');return rows.map(r=>({...r,__hubRulePrices:{ably:{platformFinal:10300,platformOption:300}}}));}};
for(const name of stageNames)metadataContext[name]=async rows=>{pipeline.push(name);return rows.map(r=>({...r,enriched:[...(r.enriched||[]),name]}));};
metadataContext.attachRepresentativePrices=async rows=>rows;
vm.createContext(metadataContext);vm.runInContext(extract('attachProductMetadata')+'\nthis.attach=attachProductMetadata;',metadataContext);
const matrixRows=await metadataContext.attach([{sellpia_sku_code:'one'}]);
assert.equal(matrixRows[0].__hubRulePrices.ably.platformFinal,10300);
assert.equal(pipeline.at(-1),'stored-price-projection','matrix attaches persisted calculation results after source/draft metadata');
const aborted={aborted:true};await assert.rejects(()=>metadataContext.attach([{sellpia_sku_code:'one'}],aborted),/abort fixture/);
console.log('PASS23760-SKU actual data-service enrichment: full row/profile preservation and bounded matrix/profile/component reads');
