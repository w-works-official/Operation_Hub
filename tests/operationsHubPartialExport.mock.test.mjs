import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const data = fs.readFileSync(new URL('../mockups/operations-hub/data-service.js', import.meta.url), 'utf8');
const adapter = fs.readFileSync(new URL('../mockups/operations-hub/seller-export-adapter.js', import.meta.url), 'utf8');
const helpers = data.slice(data.indexOf('  async function loadSellerDraftRows('), data.indexOf('  async function loadLatestSellerOriginalStatus('));
const row = (id, extra = {}) => ({change_id:id, source_channel:'smartstore', sellpia_sku_code:String(id), seller_product_code:'p'+id, seller_option_code:'o'+id, status:'pending', field_key:'sellpia_current_stock', target_safety_state:'ready', ...extra});
function harness(rows, {rejectIds = [], cancelId = null} = {}) {
  let reads = 0;
  const validated = [], queries = [];
  const db = {from(table) {
    const filters = [], query = {select(){return this;}, in(key, values){filters.push([key, values]); return this;}, order(){return this;}, gt(key,value){this.after=[key,value];return this;}, limit(value){this.limitValue=value;return this;}, range(a,b){this.bounds=[a,b];return this;},
      then(resolve,reject) {
        reads++;
        if (reads === 2 && cancelId) rows.find(r => r.change_id === cancelId).status = 'cancelled';
        const result = rows.filter(r => filters.every(([k,v]) => v.includes(r[k])) && (!this.after || r[this.after[0]] > this.after[1]));
        queries.push({table, filters});
        return Promise.resolve({data:(this.bounds ? result.slice(this.bounds[0],this.bounds[1]+1) : result.slice(0,this.limitValue??result.length)).map(r=>({...r})),error:null}).then(resolve,reject);
      }};
    return query;
  }};
  const context = {db, cleanText:v=>String(v??'').trim(), validateChangeQueue:async ids=>{
    validated.push([...ids]);
    for (const r of rows.filter(r=>ids.includes(r.change_id))) {
      if (rejectIds.includes(r.change_id)) {r.status='failed';r.error_message='숫자 검증 실패';}
      else r.status='validated';
    }
  }};
  vm.createContext(context);
  vm.runInContext(helpers+'\nthis.review = reviewSellerDraftsForExport;',context);
  return {...context, validated, queries};
}
{
  const h=harness([row(1),row(2,{status:'validated',target_safety_state:'incomplete'}),row(3,{status:'failed',target_safety_state:'conflict'}),row(4,{status:'failed'}),row(5,{status:'validated'})],{rejectIds:[4],cancelId:5});
  const r=await h.review({sources:['smartstore']});
  assert.deepEqual(Array.from(r.changeIds),[1]);
  assert.deepEqual(h.validated,[[1,4]],'unsafe proposals must never be sent to old validation');
  assert.equal(r.excluded.length,4);
  assert.match(r.excluded.find(x=>x.item.change_id===2).reason,/원본 재고 확인 불가/);
  assert.match(r.excluded.find(x=>x.item.change_id===3).reason,/재고 충돌/);
  assert.match(r.excluded.find(x=>x.item.change_id===4).reason,/숫자 검증 실패/);
  assert.match(r.excluded.find(x=>x.item.change_id===5).reason,/상태가 바뀌/);
}
{
  const h=harness([row(1,{source_channel:'ably'}),row(2,{source_channel:null,target_channels:['smartstore']})]);
  const r=await h.review({sources:['smartstore'],changeIds:[1,2,99]});
  assert.deepEqual(Array.from(r.changeIds),[2]);
  assert.equal(r.excluded.length,2,'missing and out-of-source IDs must not silently disappear');
}
{
  const h=harness(Array.from({length:1201},(_,i)=>row(i+1)));
  const r=await h.review({sources:['smartstore']});
  assert.equal(r.changeIds.length,1201);
  assert.deepEqual(h.validated.map(x=>x.length),[...Array(24).fill(50),1]);
}
{
  const h=harness([row(1),row(2)]);
  const r=await h.review({sources:['smartstore'],skus:['2']});
  assert.deepEqual(Array.from(r.changeIds),[2],'filtered export must not include other SKUs');
  const empty=await h.review({sources:['smartstore'],changeIds:[]});
  assert.equal(empty.changeIds.length,0);
}
// The server's real failure must be surfaced without being rewritten as "0 missing originals".
{
  const fn=data.slice(data.indexOf('  async function prepareSellerExport('),data.indexOf('  async function completeSellerExport('));
  const context={cleanText:String,requireOperationsHubSessionToken:()=> 'local-fixture', db:{
    rpc:async()=>({data:[{item_count:0,batch_status:'failed'}]}),
    from(table){return {select(){return this;},eq(){return this;},order(){return this;},
      range:async()=>({data:[]}),maybeSingle:async()=>({data:{error_message:'원래 서버 차단 사유'}})}}
  }};
  vm.createContext(context);vm.runInContext(fn+'\nthis.prepare=prepareSellerExport;',context);
  await assert.rejects(context.prepare({batchId:'fixture',mode:'change_queue',changeIds:[1],sources:['smartstore']}),/원래 서버 차단 사유/);
}
// Exercise the real ZIP orchestration with a fixture file patcher; existing
// seller-export tests separately cover the actual XML patching/highlighting.
{
  const files = new Map();
  class Zip {file(name,value){files.set(name,value);} async generateAsync(){return new Blob(['fixture zip']);}}
  const c={console,Blob,global:{JSZip:Zip},auditCsv:()=> 'verified',conflictCsv:x=>JSON.stringify(x),outputName:n=>n+'-out',
    patchCsvFile:async(file,items,conflict,applied)=>{applied(items[0]);conflict({item:items[1],reason:'원본값 불일치'});return new Blob(['changed']);}};
  vm.createContext(c);
  vm.runInContext(adapter.slice(adapter.indexOf('  async function buildExportArchive('),adapter.indexOf('  function downloadBlob('))+'\nthis.build=buildExportArchive;',c);
  const initial=[{item:row(7),reason:'사전검사 제외'}];
  const r=await c.build(new Map([['smartstore',[{name:'sample.csv'}]]]),[{export_item_id:11,source_file_name:'sample.csv',source_channel:'smartstore'},{export_item_id:12,source_file_name:'sample.csv',source_channel:'smartstore'}],null,initial);
  assert.equal(r.appliedItems.length,1);
  assert.equal(r.skippedItems.length,2);
  assert.match(files.get('SystemV3_내보내기_제외목록.csv'),/사전검사 제외/);
  assert.match(files.get('SystemV3_내보내기_제외목록.csv'),/원본값 불일치/);
}
// Exercise the app's actual export controller, including all-excluded and mixed plans.
const app=fs.readFileSync(new URL('../mockups/operations-hub/app.js',import.meta.url),'utf8');
for (const allExcluded of [false,true]) {
  const nodes=new Map(), completed=[], calls=[];
  const excluded=[{item:row(2),reason:'사전 제외'}], good={export_item_id:11,source_channel:'smartstore'}, blocked={export_item_id:12,source_channel:'smartstore',blocking_reason:'원본행 누락'};
  const state={action:'export',running:false,rows:[row(1)],selectedSkus:[],excludedItems:[]};
  const context={console:{error(){}},Blob,sellerExportState:state,
    document:{getElementById(id){if(!nodes.has(id))nodes.set(id,{style:{},disabled:false});return nodes.get(id);}},
    selectedExportSources:()=>['smartstore'],selectedSellerExportScope:()=> 'all',resolveSellerExportScopeSkus:async()=>[],sellerExportRowsForSources:rows=>rows,
    createRequestId:()=> 'fixture',formatNumber:String,showToast(){},stopCancelledSellerExport(){},
    showSellerExportProgress:(p,t,d)=>calls.push({p,t,d}),
    showSellerExportExclusions:items=>{state.excludedItems=items;},
    liveData:{reviewSellerDraftsForExport:async()=>({changeIds:allExcluded?[]:[1],excluded}),
      downloadLatestSellerOriginals:async()=>new Map(),prepareSellerExport:async()=>{calls.push('prepare');return {items:[good,blocked]};},
      completeSellerExport:async p=>completed.push(p)},
    sellerExport:{buildExportArchive:async(files,items,progress,initial)=>{
      assert.deepEqual(Array.from(items),allExcluded?[]:[good]);assert.equal(initial.length,allExcluded?1:2);
      return {manifest:[],blob:new Blob(),appliedItems:items,skippedItems:initial};
    },downloadBlob:()=>calls.push('download')},
    loadChangeQueue:async()=>{},loadLiveMatrix:async()=>{}};
  context.HubCurrentPriceExport={refreshItems:async(items,files,options)=>{calls.push('refresh-current');assert.equal(options.includeRules,false);return {items,excludedItems:[]};},buildArchive:async(...args)=>{calls.push('build-current');return context.sellerExport.buildExportArchive(...args);}};
  vm.createContext(context);
  vm.runInContext(app.slice(app.indexOf('async function runSellerExport()'),app.indexOf("document.getElementById('matrix-match-stock-btn').addEventListener"))+'\nthis.run=runSellerExport;',context);
  await context.run();
  assert.equal(state.running,false);
  assert.equal(completed.length,allExcluded?0:1);
  assert.equal(calls.includes('download'),true,'all excluded must still download unchanged originals');
  assert.equal(calls.includes('refresh-current'),true);assert.equal(calls.includes('build-current'),true);
  assert.equal(state.excludedItems.length,allExcluded?1:2);
  if(!allExcluded)assert.ok(calls.some(x=>x?.p===100 && /2건은 제외목록/.test(x.d)),'excluded count must not be double-counted');
}
// Current-data exports must calculate rules even with zero queue IDs; explicit queue rows retain scope.
for(const scenario of ['rule-only','explicit-rows','missing-module']){
 const explicit=scenario==='explicit-rows',missing=scenario==='missing-module',calls=[],toasts=[],nodes=new Map();
 const price={export_item_id:21,source_channel:'smartstore',sellpia_sku_code:'1014-1',field_key:'sellpia_sale_price',target_final_price:5400};
 const state={action:'export',running:false,rows:explicit?[row(1)]:[],selectedSkus:[],excludedItems:[]};
 const context={console:{error(){}},Blob,sellerExportState:state,document:{getElementById(id){if(!nodes.has(id))nodes.set(id,{style:{},disabled:false});return nodes.get(id);}},
  selectedExportSources:()=>['smartstore'],selectedSellerExportScope:()=> 'filtered',resolveSellerExportScopeSkus:async()=>['1014-1'],sellerExportRowsForSources:rows=>rows,
  createRequestId:()=> 'fixture',formatNumber:String,showToast:message=>toasts.push(message),stopCancelledSellerExport(){},showSellerExportProgress(){},showSellerExportExclusions:items=>{state.excludedItems=items;},
  liveData:{reviewSellerDraftsForExport:async options=>{calls.push({name:'review',options});return {changeIds:explicit?[1]:[],excluded:[]};},downloadLatestSellerOriginals:async()=>new Map(),prepareSellerExport:async()=>{calls.push({name:'prepare'});return {items:[price]};},completeSellerExport:async()=>calls.push({name:'complete'})},
  sellerExport:{buildExportArchive:async()=>{throw Error('legacy archive fallback must not run');},downloadBlob:()=>calls.push({name:'download'})},loadChangeQueue:async()=>{},loadLiveMatrix:async()=>{}};
 if(!missing)context.HubCurrentPriceExport={refreshItems:async(items,files,options)=>{calls.push({name:'refresh',options,inputCount:items.length});return {items:explicit?items:[price],excludedItems:[]};},buildArchive:async(files,items)=>{calls.push({name:'build',items});return {manifest:[],blob:new Blob(),appliedItems:items,skippedItems:[]};}};
 vm.createContext(context);vm.runInContext(app.slice(app.indexOf('async function runSellerExport()'),app.indexOf("document.getElementById('matrix-match-stock-btn').addEventListener"))+'\nthis.run=runSellerExport;',context);
 await context.run();assert.equal(state.running,false);
 if(missing){assert.equal(calls.length,0,'missing module must fail before queue validation or other export work');assert.ok(toasts.some(t=>/모듈|수식|계산/.test(t)));continue;}
 const refresh=calls.find(c=>c.name==='refresh');assert.ok(refresh,'controller must call current-price refresh');assert.equal(refresh.options.includeRules,!explicit);
 assert.equal(refresh.inputCount,explicit?1:0);assert.deepEqual(refresh.options.skus===null?null:Array.from(refresh.options.skus),explicit?null:['1014-1']);
 assert.equal(calls.some(c=>c.name==='prepare'),explicit);assert.equal(calls.some(c=>c.name==='complete'),explicit);
 if(!explicit)assert.equal(calls.some(c=>c.name==='review'),false,'default latest-price export must skip stored inventory draft validation');
 assert.deepEqual(Array.from(calls.find(c=>c.name==='build').items),[price]);assert.equal(calls.some(c=>c.name==='download'),true);
}
console.log('Partial export: mixed safety, selection, pagination, validation failure, stale IDs, original server error, ZIP report and app export controller passed');
