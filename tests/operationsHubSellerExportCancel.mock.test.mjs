import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app=fs.readFileSync(new URL('../mockups/operations-hub/app.js',import.meta.url),'utf8');
const controller=app.slice(app.indexOf('function closeSellerExport()'),app.indexOf("document.getElementById('matrix-match-stock-btn').addEventListener"));

test('running saved-change export stops after the active 50-row validation batch',async()=>{
 const nodes=new Map(),calls=[],toasts=[];
 const node=id=>{if(!nodes.has(id))nodes.set(id,{disabled:false,textContent:'',style:{}});return nodes.get(id);};
 const state={action:'export',running:false,cancelRequested:false,draftCancellable:false,rows:[{change_id:1,source_channel:'smartstore'}],selectedSkus:[],excludedItems:[]};
 const context={console:{error(){}},Blob,sellerExportState:state,sellerExportModal:{hidden:false},
  document:{getElementById:node},selectedExportSources:()=>['smartstore'],selectedSellerExportScope:()=> 'all',resolveSellerExportScopeSkus:async()=>null,sellerExportRowsForSources:rows=>rows,
  createRequestId:()=> 'cancel-fixture',formatNumber:String,showToast:m=>toasts.push(m),showSellerExportProgress:(p,t,d)=>calls.push({p,t,d}),showSellerExportExclusions(){},
  liveData:{prepareSellerExport:async()=>({items:[]}),reviewSellerDraftsForExport:async options=>{context.cancel();assert.equal(state.cancelRequested,true);assert.equal(node('seller-export-cancel').textContent,'중단 요청됨');options.onProgress(50,100);throw Error('cancellation callback must stop this flow');},downloadLatestSellerOriginals:async()=>{calls.push('download-original');}},
  sellerExport:{downloadBlob:()=>calls.push('download-zip')},HubCurrentPriceExport:{refreshItems:async()=>{calls.push('calculate');},buildArchive:async()=>{calls.push('archive');}},
  loadChangeQueue:async()=>{},loadLiveMatrix:async()=>{}};
 vm.createContext(context);vm.runInContext(controller+'\nthis.run=runSellerExport;this.cancel=closeSellerExport;',context);
 await context.run();
 assert.equal(state.running,false);assert.equal(state.cancelRequested,false);
 assert.equal(calls.includes('download-original'),false);assert.equal(calls.includes('calculate'),false);assert.equal(calls.includes('archive'),false);assert.equal(calls.includes('download-zip'),false);
 assert.ok(calls.some(c=>c.t==='내보내기 중단 완료'));
 assert.ok(toasts.some(message=>/중단.*ZIP/.test(message)));
 assert.equal(node('seller-export-cancel').textContent,'닫기');assert.equal(node('seller-export-close').disabled,false);
});

test('database errors are labeled as export failures, not user cancellations',async()=>{
 const nodes=new Map(),progress=[],toasts=[];const node=id=>{if(!nodes.has(id))nodes.set(id,{disabled:false,textContent:'',style:{}});return nodes.get(id);};
 const state={action:'export',running:false,cancelRequested:false,draftCancellable:false,rows:[{change_id:1,source_channel:'smartstore'}],selectedSkus:[],excludedItems:[]};
 const context={console:{error(){}},Blob,sellerExportState:state,sellerExportModal:{hidden:false},document:{getElementById:node},
  selectedExportSources:()=>['smartstore'],selectedSellerExportScope:()=> 'all',resolveSellerExportScopeSkus:async()=>null,sellerExportRowsForSources:rows=>rows,createRequestId:()=> 'failure-fixture',formatNumber:String,
  showToast:m=>toasts.push(m),showSellerExportProgress:(p,t,d)=>progress.push({p,t,d}),showSellerExportExclusions(){},
  liveData:{prepareSellerExport:async()=>({items:[]}),reviewSellerDraftsForExport:async()=>{throw Error('DB 준비 오류');}},
  sellerExport:{downloadBlob(){},buildExportArchive(){}},HubCurrentPriceExport:{refreshItems(){},buildArchive(){}},loadChangeQueue:async()=>{},loadLiveMatrix:async()=>{}};
 vm.createContext(context);vm.runInContext(controller+'\nthis.run=runSellerExport;',context);await context.run();
 assert.ok(progress.some(item=>item.t==='내보내기 실패'&&/DB 준비 오류/.test(item.d)));
 assert.ok(toasts.some(message=>/원본 내보내기 실패/.test(message)));assert.ok(toasts.every(message=>!/중단했습니다/.test(message)));
});
