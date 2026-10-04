import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const dataService=fs.readFileSync(new URL('../mockups/operations-hub/data-service.js',import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../mockups/operations-hub/app.js',import.meta.url),'utf8');
const sellpiaMigration=fs.readFileSync(new URL('../supabase/migrations/20260915051920_stabilize_source_upload_price_refresh.sql',import.meta.url),'utf8');
const sellerMigration=fs.readFileSync(new URL('../supabase/migrations/20260915052736_target_seller_source_price_refresh.sql',import.meta.url),'utf8');

function extract(name){
  const start=dataService.search(new RegExp('  (?:async )?function '+name+'\\('));
  assert.ok(start>=0,`missing ${name}`);
  const rest=dataService.slice(start+2),end=rest.slice(2).search(/\n  (?:async )?function /);
  return end<0?rest:rest.slice(0,end+2);
}

const calls=[];
let first=true;
const db={rpc:async()=>({data:[],error:null}),from(){let ids=[];const query={select(){return query;},in(field,values){ids=[...values];return query;},then(resolve,reject){calls.push(ids.length);if(first&&ids.length===100){first=false;return Promise.resolve({data:null,error:{message:'canceling statement due to statement timeout'}}).then(resolve,reject);}return Promise.resolve({data:ids.map(sku=>({sellpia_sku_code:sku})),error:null}).then(resolve,reject);}};return query;}};
const passthrough=async rows=>rows;
const context={db,MATRIX_VIEW:'matrix',requireOperationsHubSessionToken:()=> 'fixture',readableDatabaseError:error=>Error(error.message),attachProductProfiles:passthrough,attachInboundCostDetails:passthrough,attachSystemOperationalDetails:passthrough,attachSellerPriceComponents:passthrough,attachSellerDrafts:passthrough,setTimeout,global:{}};
vm.createContext(context);
context.attachRepresentativePrices=passthrough;
vm.runInContext(extract('loadFormulaProducts')+'\nthis.load=loadFormulaProducts;',context);
const products=await context.load(Array.from({length:101},(_,index)=>`SKU-${index}`));
assert.equal(products.length,101);
assert.deepEqual(calls.toSorted((a,b)=>b-a),[100,50,50,1],'a timed-out formula input read is split into bounded retries');

assert.doesNotMatch(app,/if \(affectsSellerPrice\) affectedSkus = \(await liveData\.loadAllFilteredSkus/,'seller uploads must not reprice the full catalog');
const importFlow=app.slice(app.indexOf('let calculationWarning = result.calculationScopeWarning'),app.indexOf('const rowLabel =',app.indexOf('let calculationWarning = result.calculationScopeWarning')));
assert.match(importFlow,/materializeHubPrices\(/,'UI-only release preserves the existing bounded import materialization path');
assert.doesNotMatch(app,/result\.sourceDeltaPreview=await liveData\.loadSourceDelta/,'source lifecycle write cutover remains held');
assert.match(dataService,/operations_hub_sellpia_patch_price_affected_skus/,'Sellpia patch upload compares price inputs before materialization');
assert.match(dataService,/operations_hub_seller_snapshot_price_affected_skus/,'seller upload asks the database for changed mapped SKUs');
assert.match(sellpiaMigration,/alter function public\.finalize_operations_hub_sellpia_patch\(uuid, jsonb\)[\s\S]*statement_timeout = '60s'/);
assert.match(sellerMigration,/current_row\.discount_terms is distinct from base_row\.discount_terms/);
assert.match(sellerMigration,/operations_hub_listing_component_projection component/);

console.log('PASS source imports preserve bounded input reads, record deltas and wait for explicit recalculation');
