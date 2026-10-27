import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app=fs.readFileSync(new URL('../mockups/operations-hub/app.js',import.meta.url),'utf8');
const policySource=fs.readFileSync(new URL('../mockups/operations-hub/matrix-price-edit-policy.js',import.meta.url),'utf8');
const copy=value=>JSON.parse(JSON.stringify(value));
const segment=(start,end)=>{
 const from=app.indexOf(start),to=app.indexOf(end,from+start.length);
 assert.ok(from>=0&&to>from,`actual app section exists: ${start}`);
 return app.slice(from,to);
};

// Execute the actual app workflows and ownership module. The server transport is
// an isolated in-memory fixture; this suite neither contacts nor writes a DB.
function harness({fields=['system_base_price'],targets=[],registryError=false}={}){
 const registry={rules:[
  {id:'inbound',name:'half',is_active:true,target_field:'actual_inbound_cost',scope:''},
  {id:'seller',name:'seller formula',is_active:true,target_field:'platform_registration_price',scope:'smartstore'}
 ],assignments:[
  {sku:'FORMULA-1',rule_id:'inbound',target_field:'actual_inbound_cost',scope:''},
  {sku:'FORMULA-1',rule_id:'seller',target_field:'platform_registration_price',scope:'smartstore'}
 ],dependencies:[]};
 const products=[
  {sellpia_sku_code:'FORMULA-1',system_base_price:8000,system_stock:1,sellpia_source_sale_price:12000,sellpia_source_stock:4,__hubInternalPrices:{calculated_base_price:{value:5900,activeOutputRules:[{id:'inbound'}]}}},
  {sellpia_sku_code:'NEW-1',system_base_price:null,system_stock:null,sellpia_source_sale_price:9000,sellpia_source_stock:3},
  {sellpia_sku_code:'UNCHANGED-1',system_base_price:7000,system_stock:2,sellpia_source_sale_price:7000,sellpia_source_stock:2}
 ];
 const calls=[],calculations=[],rereads=[],batches=new Map(),errors={hidden:true,textContent:''};let request=0;
 const sourceField={system_base_price:'sellpia_source_sale_price',system_stock:'sellpia_source_stock'};
 const changed=field=>products.filter(p=>p[sourceField[field]]!=null&&p[field]!==p[sourceField[field]]);
 const liveData={
  ruleRegistry:async()=>{if(registryError)throw Error('ownership unavailable');return copy(registry);},
  refreshMasterColumnFromSource:async args=>{
   calls.push(copy(args));const rows=changed(args.fieldKey),affected=rows.map(p=>p.sellpia_sku_code);
   if(!args.dryRun)for(const product of rows)product[args.fieldKey]=product[sourceField[args.fieldKey]];
   return {field_key:args.fieldKey,request_id:args.requestId,dry_run:args.dryRun,total_sku_count:products.length,source_value_count:products.length,affected_count:rows.length,skipped_count:products.length-rows.length,source_missing_count:0,affected_skus:affected};
  },
  runSelectedSourceRefreshBatch:async args=>{
   calls.push(copy(args));
   if(args.dryRun){
    const items=copy(args.targets).map(target=>({...target,previewStatus:'ready',resultStatus:'ready',sourceValue:products.find(p=>p.sellpia_sku_code===target.sku)?.[sourceField[target.fieldKey]]}));
    const batch={batchId:args.requestId,requestedCount:items.length,readyCount:items.length,skippedCount:0,failedCount:0,items};batches.set(args.requestId,batch);return copy(batch);
   }
   const batch=batches.get(args.batchId);assert.ok(batch,'apply reuses its server preview batch');
   const items=batch.items.map(item=>{
    const product=products.find(p=>p.sellpia_sku_code===item.sku);assert.ok(product);
    product[item.fieldKey]=item.sourceValue;return {...item,resultStatus:'success',applyStatus:'success',verified:true};
   });
   return {...copy(batch),successCount:items.length,verifiedCount:items.length,items};
  }
 };
 const context={window:{SystemV3Data:liveData},liveData,console:{warn(){},error(){}},Map,Set,Date,
  matrixDataset:{rows:products,bySku:new Map(products.map(p=>[p.sellpia_sku_code,p])),version:1},matrixRowsBySku:new Map(products.map(p=>[p.sellpia_sku_code,p])),
  selectedBulkSourceRefreshFields:()=>fields,createRequestId:()=>`request-${++request}`,requireMatrixChangesSaved:()=>true,
  bulkSourceRefreshConfirmationPhrase:()=> 'confirm',bulkSourceRefreshConfirm:{value:'confirm'},
  bulkSourceRefreshState:{fields:[],results:[],previewed:false,fieldStatuses:{},priceProgress:{},matrixStatus:'pending'},
  bulkSourceRefreshModal:{hidden:false},bulkSourceRefreshPreviewButton:{},bulkSourceRefreshApplyButton:{},
  BULK_SOURCE_REFRESH_FIELDS:{system_base_price:{label:'기준가격'},system_stock:{label:'재고'}},
  document:{getElementById:()=>errors},showToast(){},formatNumber:String,
  setBulkSourceRefreshBusy(){},renderBulkSourceRefreshProgress(){},beginBulkSourceRefreshProgress(){},renderBulkSourceRefreshPreview(){},
  materializeHubPrices:async skus=>{calculations.push([...skus]);return {status:'complete',affectedSkus:[...skus],totalSkus:skus.length,completedSkus:skus.length};},
  materializationWarning:()=>'',markMatrixAffected:skus=>rereads.push([...skus]),refreshHubPriceProjection:async()=>{},loadLiveDashboardMetrics:async()=>{},
  SELECTED_SOURCE_REFRESH_CHUNK_SIZE:40,matrixSourceRefreshInFlight:false,
  selectedSourceRefreshState:{targets:copy(targets),scope:{kind:'selected_cells'},previewChunks:[],appliedChunks:[],previewRequestIds:[],applyRequestIds:[]},
  selectedSourceRefreshApply:{},selectedSourceRefreshRetry:{},selectedSourceRefreshError:{hidden:true,textContent:''},
  renderSelectedSourceRefreshBatch:batch=>{if(batch)context.selectedSourceRefreshState.batch=batch;},updateSourceRefreshAction(){},
  reloadSelectedSourceRefreshRows:async batch=>{rereads.push(batch.items.map(item=>item.sku));return {failures:[]};}
 };
 vm.createContext(context);vm.runInContext(policySource,context);
 context.matrixPriceEditPolicy=(product,options)=>context.window.HubMatrixPriceEditPolicy.policy(product,options);
 vm.runInContext(segment('async function assertMatrixPriceEditable(','function resolvedInboundCost('),context);
 vm.runInContext(segment('function normalizeBulkSourceRefreshResult(','function setBulkSourceRefreshBusy('),context);
 vm.runInContext(segment('async function previewBulkSourceRefresh()','document.getElementById(\'matrix-bulk-source-refresh-btn\')'),context);
 vm.runInContext(segment('function combineSelectedSourceRefreshChunks(','function selectedSourceRefreshTransportFailure('),context);
 vm.runInContext(segment('async function previewSelectedSourceRefreshBatch()','async function retryFailedSelectedSourceRefreshChunks('),context);
 return {context,products,registry,calls,calculations,rereads};
}

test('selection collector retains disabled formula-owned raw inputs but excludes effective seller outputs',async()=>{
 const f=harness();await f.context.window.HubMatrixPriceEditPolicy.ensure();
 const cell=(sku,selector,dataset)=>({closest:()=>({dataset:{sku}}),querySelector:query=>query===selector?{disabled:true,dataset}:null});
 f.context.matrixCellSelection={selected:new Set([
  cell('FORMULA-1','.system-master-cell[data-field-key]',{fieldKey:'system_base_price'}),
  cell('NEW-1','.system-master-cell[data-field-key]',{fieldKey:'system_base_price'}),
  cell('FORMULA-1','.seller-edit[data-source][data-field-key]',{source:'smartstore',fieldKey:'sellpia_sale_price',priceComponent:'base',baseline:'12000'}),
  cell('FORMULA-1','[data-discount-edit][data-source]',{source:'smartstore'}),
  cell('FORMULA-1','.system-master-cell[data-field-key]',{fieldKey:'actual_inbound_cost'})
 ])};
 vm.runInContext(segment('function selectedSourceRefreshTargets()','function selectedSourceRefreshBatchTargets('),f.context);
 const actual=copy(f.context.selectedSourceRefreshTargets());
 assert.deepEqual(actual.map(({kind,sku,fieldKey,after,hasSource})=>({kind,sku,fieldKey,after,hasSource})),[
  {kind:'system',sku:'FORMULA-1',fieldKey:'system_base_price',after:'12000',hasSource:true},
  {kind:'system',sku:'NEW-1',fieldKey:'system_base_price',after:'9000',hasSource:true}
 ]);
 assert.equal(f.calls.length,0,'selection and eligibility do not save or invoke a refresh');
});

test('whole-column raw base and stock accept is allowed with active formulas and initializes blank SKU inputs',async()=>{
 const f=harness({fields:['system_stock','system_base_price']}),beforeFormula=copy(f.products[0].__hubInternalPrices),beforeRegistry=copy(f.registry);
 await f.context.previewBulkSourceRefresh();
 assert.equal(f.context.bulkSourceRefreshState.previewed,true);
 assert.deepEqual(copy(f.context.bulkSourceRefreshState.results.map(row=>[row.fieldKey,row.changedCount])),[['system_stock',2],['system_base_price',2]]);
 assert.equal(f.calls.filter(row=>row.dryRun===false).length,0,'dry run never saves raw inputs');
 await f.context.applyBulkSourceRefresh();
 assert.equal(f.context.bulkSourceRefreshState.finalStatus,'completed');
 assert.deepEqual(f.calls.map(row=>[row.fieldKey,row.dryRun]),[['system_stock',true],['system_base_price',true],['system_stock',false],['system_base_price',false]]);
 assert.equal(f.products[0].system_base_price,12000);assert.equal(f.products[1].system_base_price,9000);
 assert.equal(f.products[1].system_stock,3);assert.equal(f.products[2].system_base_price,7000);
 assert.deepEqual(f.products[0].__hubInternalPrices,beforeFormula);assert.deepEqual(f.registry,beforeRegistry);
 assert.deepEqual(copy(f.calculations),[['FORMULA-1','NEW-1']],'only changed raw price inputs feed the bounded calculation stage');
});

test('selected raw base preview and apply accept both the formula SKU and a blank unassigned SKU',async()=>{
 const f=harness({targets:[{kind:'system',sku:'FORMULA-1',fieldKey:'system_base_price'},{kind:'system',sku:'NEW-1',fieldKey:'system_base_price'}]}),before=copy(f.products[0].__hubInternalPrices);
 await f.context.previewSelectedSourceRefreshBatch();assert.equal(f.context.selectedSourceRefreshState.batch.readyCount,2);
 await f.context.applySelectedSourceRefreshBatch();
 assert.equal(f.context.selectedSourceRefreshState.phase,'completed');assert.equal(f.context.selectedSourceRefreshState.batch.verifiedCount,2);
 assert.deepEqual(f.calls.map(row=>row.dryRun),[true,false]);assert.deepEqual(f.calls[1].targets,[],'apply uses the captured server preview');
 assert.equal(f.products[0].system_base_price,12000);assert.equal(f.products[1].system_base_price,9000);
 assert.deepEqual(f.products[0].__hubInternalPrices,before);assert.deepEqual(copy(f.calculations),[['FORMULA-1','NEW-1']]);
 assert.deepEqual(copy(f.rereads),[['FORMULA-1','NEW-1']]);
});

test('raw source accepts do not require formula ownership availability',async()=>{
 const f=harness({registryError:true});
 await assert.doesNotReject(f.context.assertMatrixSourceTargetsEditable([{kind:'system',sku:'FORMULA-1',fieldKey:'system_base_price'}]));
 await f.context.previewBulkSourceRefresh();await f.context.applyBulkSourceRefresh();
 assert.equal(f.context.bulkSourceRefreshState.finalStatus,'completed');assert.equal(f.calls.filter(row=>row.dryRun===false).length,1);
});

test('seller effective price and discount source accepts retain formula-output ownership protection',async()=>{
 for(const target of [
  {kind:'seller_price',sku:'FORMULA-1',source:'smartstore',fieldKey:'sellpia_sale_price',priceComponent:'base'},
  {kind:'seller_discount',sku:'FORMULA-1',source:'smartstore',fieldKey:'sellpia_sale_price'}
 ]){
  const f=harness({targets:[target]});await f.context.previewSelectedSourceRefreshBatch();await f.context.applySelectedSourceRefreshBatch();
  assert.equal(f.context.selectedSourceRefreshState.phase,'failed');assert.match(f.context.selectedSourceRefreshError.textContent,/수식/);
  assert.equal(f.calls.filter(row=>row.dryRun===false).length,0);
 }
});

test('direct manual formula-output edits stay locked while purchase starting input edits remain permitted',async()=>{
 const f=harness(),product=f.products[0];
 await assert.rejects(f.context.assertMatrixPriceEditable(product,{field:'system_base_price'},{fresh:true}),/수식/);
 await assert.rejects(f.context.assertMatrixPriceChangesEditable([{sku:'FORMULA-1',fieldKey:'system_base_price',after:12000}]),/수식/);
 await assert.rejects(f.context.assertMatrixPriceEditable(product,{source:'smartstore',component:'final'},{fresh:true}),/수식/);
 await assert.doesNotReject(f.context.assertMatrixPriceEditable(product,{field:'sellpia_purchase_price'},{fresh:true}));
 assert.equal(f.calls.length,0);
});
