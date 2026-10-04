import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app=fs.readFileSync('mockups/operations-hub/app.js','utf8');
const service=fs.readFileSync('mockups/operations-hub/data-service.js','utf8');

function editFlow({materializationFails=false}={}){
  const events=[],dirty=new Set(),versions=new Map();
  const context={
    pendingChanges:[{sku:'5566-1',fieldKey:'sellpia_purchase_price',before:'30000',after:'35000'}],
    sellpiaSaveInFlight:false,sellpiaSavingCount:0,sellpiaSaveError:'',sellpiaAutosaveTimer:null,
    pendingChangeBatchId:'request-1',matrixDataset:{bySku:new Map([['5566-1',{}]])},
    matrixDirtyVersions:versions,matrixDirtySkus:dirty,changeModal:{hidden:false},
    clearTimeout(){},setTimeout(){},updatePendingChangeUi(){},createRequestId:()=> 'request-1',
    liveData:{saveSellpiaChanges:async()=>{events.push('save');return {savedCount:1,queuedCount:0};}},
    applySavedSellpiaChanges(){events.push('local-input');},
    materializeHubPrices:async(skus,opts)=>{events.push(`calculate:${opts.sources.length}:${skus.join(',')}`);if(materializationFails)throw Error('calculation failed');return {status:'complete'};},
    materializationWarning:()=>'',markMatrixAffected:skus=>{events.push('dirty');for(const sku of skus){dirty.add(sku);versions.set(sku,1);}},
    refreshMatrixSkus:async skus=>{events.push(`read:${skus.join(',')}`);return [];},
    removeSavedCellState(){},showToast(){},loadLiveDashboardMetrics(){},refreshChangeQueueInBackground(){},
    restoreFailedChanges(){},scheduleSellpiaAutosave(){},console
  };
  const start=app.indexOf('async function flushPendingSellpiaChanges('),end=app.indexOf('\nfunction editableMatrixGrid(',start);
  assert.ok(start>0&&end>start);
  vm.createContext(context);
  vm.runInContext(app.slice(start,end)+'\nthis.flush=flushPendingSellpiaChanges;',context);
  return {context,events,dirty};
}

test('purchase price edit saves, recalculates internal fields, then patches only the affected SKU',async()=>{
  const {context,events,dirty}=editFlow();
  await context.flush();
  assert.deepEqual(events,['save','local-input','calculate:0:5566-1','dirty','read:5566-1']);
  assert.equal(dirty.size,0,'successful targeted refresh clears this version of the dirty marker');
});

test('calculation error still re-reads the saved SKU instead of leaving optimistic old output',async()=>{
  const {context,events}=editFlow({materializationFails:true});
  await context.flush();
  assert.deepEqual(events,['save','local-input','calculate:0:5566-1','dirty','read:5566-1']);
  assert.equal(context.pendingChanges.length,0,'already saved input must not be resubmitted');
});

function targetedRead(responses){
  const calls=[];
  const context={
    cleanText:v=>String(v??'').trim(),requireOperationsHubSessionToken:()=> 'operator',
    normalizeMatrixGridRow:row=>row,
    readMatrixGridRpc:async(name,args)=>{calls.push({name,args});return {data:responses.shift()};}
  };
  const start=service.indexOf('  async function loadMatrixGridRowsBySkus('),end=service.indexOf('  async function loadFullMatrixDataset(',start);
  assert.ok(start>0&&end>start);
  vm.createContext(context);
  vm.runInContext(service.slice(start,end)+'\nthis.readRows=loadMatrixGridRowsBySkus;',context);
  return {context,calls};
}

function response(skus,version='v1',missing=[]){return {
  contract_version:5,requested:skus.length,loaded:skus.length-missing.length,
  rows:skus.filter(sku=>!missing.includes(sku)).map(sellpia_sku_code=>({sellpia_sku_code})),
  missing_skus:missing,dataset_version:version,tag_catalog:{},link_badges:[]
};}

test('targeted reader sends at most 200 exact SKUs per RPC and preserves 201 complete rows',async()=>{
  const skus=Array.from({length:201},(_,i)=>`SKU-${i+1}`);
  const {context,calls}=targetedRead([response(skus.slice(0,200)),response(skus.slice(200))]);
  const rows=await context.readRows(skus);
  assert.equal(rows.length,201);assert.equal(calls.length,2);
  assert.equal(calls[0].name,'hub_matrix_grid_rows_v5');
  assert.equal(calls[0].args.p_skus.length,200);assert.equal(calls[1].args.p_skus.length,1);
});

test('targeted reader refuses missing SKU or a mixed cache version before Dataset.patch',async()=>{
  const missing=targetedRead([response(['5566-1'],'v1',['5566-1'])]);
  await assert.rejects(missing.context.readRows(['5566-1']),/membership 변경/);
  const skus=Array.from({length:201},(_,i)=>`SKU-${i+1}`);
  const changed=targetedRead([response(skus.slice(0,200),'v1'),response(skus.slice(200),'v2')]);
  await assert.rejects(changed.context.readRows(skus),/cache 버전이 변경/);
});
