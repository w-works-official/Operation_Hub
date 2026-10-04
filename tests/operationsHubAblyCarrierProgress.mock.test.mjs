import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const js=fs.readFileSync('mockups/operations-hub/seller-file-workflow-v2.js','utf8');
const helpers=js.slice(js.indexOf(' const ablyPhases='),js.indexOf('\n async function loadStatuses('));
const previewSource=js.slice(js.indexOf(' async function preview(role)'),js.indexOf('\n function previewRowsForFilter('));

function harness({items=[],targets=[],readError=null,targetReader=null}={}){
 const nodes=new Map(),fields=new Map(['title','detail','bar','cancel'].map(key=>[key,{textContent:'',style:{},disabled:false}]));
 const progress={hidden:true,dataset:{},querySelector(selector){return fields.get(selector.match(/progress-(\w+)/)?.[1]);}};
 nodes.set('export-preview-v2',{hidden:false});
 const document={querySelector(selector){if(selector==='[data-ably-progress]')return progress;if(selector==='[data-ably-progress-detail]')return fields.get('detail');return null;},getElementById(id){return nodes.get(id)||null;}};
 let now=0,nextTimer=0,rendered=0;
 const timers=new Map(),messages=[],state={carrierFiles:new Map(),ablyJob:null,ablyJobSequence:0};
 const global={performance:{now:()=>now},setInterval(fn){const id=++nextTimer;timers.set(id,fn);return id;},clearInterval:id=>timers.delete(id),setTimeout:fn=>setImmediate(fn),HubCurrentPriceExport:{carrierPriceState:()=>({safe:true,code:'original_fallback'}),matrixPriceTarget:row=>({base:row.source_base_price,option:row.source_option_price}),matrixStockTarget:row=>row?.stock_draft?.after_value??row?.seller_stock??null}};
 const setStatus=(text,kind)=>messages.push({text,kind}),renderExportStatuses=()=>{},n=value=>Number(value||0).toLocaleString('ko-KR');
 const createAblyJob=Function('global','state','document','n','renderExportStatuses','setStatus',`${helpers};return createAblyJob;`)(global,state,document,n,renderExportStatuses,setStatus);
 const file={name:'carrier.xlsx',async arrayBuffer(){return new ArrayBuffer(1);}};
 const roles={playauto_option:{label:'옵션가 + 재고',type:'option_price_stock'},playauto_product:{label:'판매가 + 옵션가',type:'product_price_option'}};
 const A=()=>({async readTemplate(parsedFile){await parsedFile.arrayBuffer();if(readError)throw readError;return {type:'option_price_stock',items};},resolveRows:rows=>rows.map(item=>({...item,resolution:{sku:item.sku,method:'direct_sku'}}))});
 const D=()=>({loadCarrierSellerMappings:async()=>({rows:[]}),loadCarrierMatrixTargets:targetReader|| (async()=>({rows:targets}))});
 const preview=Function('state','roles','setStatus','createAblyJob','document','global','blobFile','A','D','catalog','scopeSkus','renderPreview','n',`${previewSource};return preview;`)(state,roles,setStatus,createAblyJob,document,global,async()=>file,A,D,async()=>[],async()=>null,()=>{rendered++;nodes.get('export-preview-v2').hidden=false;},n);
 return {state,file,preview,createAblyJob,fields,progress,timers,messages,rendered:()=>rendered,advance(ms){now+=ms;for(const fn of [...timers.values()])fn();}};
}
const row=(sku,stock=3)=>({sku,sellpia_product_code:'10000',source_row_no:Number(sku.split('-')[1])+1,base_price:2800,option_price:0,sales_quantity:stock});

test('Ably preview phases terminate with real row counts and matrix stock, preserving blank X and W',async()=>{
 const input=[row('10000-1'),row('10000-2'),row('10000-3',null)];
 input[0].available_stock=888;
 const h=harness({items:input,targets:[{sku:'10000-1',seller_stock:0,system_stock:999},{sku:'10000-2',seller_stock:7},{sku:'10000-3',seller_stock:11}]});
 h.state.carrierFiles.set('playauto_option',h.file);
 const result=await h.preview('playauto_option');
 assert.equal(result.output[0].target_stock,0);
 assert.equal(result.output[1].target_stock,7);
 assert.equal(result.output[0].available_stock,888);
 assert.equal(result.output[2].target_stock,undefined);
 assert.equal(result.output[2]._blankStockPreserved,true);
 assert.equal(result.counts.changed,2);
 assert.equal(result.counts.preserved,1);
 assert.equal(h.rendered(),1);
 assert.equal(h.state.ablyJob.phase,'done');
 assert.equal(h.state.ablyJob.running,false);
 assert.equal(h.timers.size,0);
 assert.deepEqual(h.state.ablyJob.timings.map(t=>t.phase),['read','parse','normalize','match','targets','guards','preview']);
 assert.equal(h.state.ablyJob.timings.find(t=>t.phase==='guards').processed,3);
 assert.match(h.fields.get('detail').textContent,/총 \d+ms/);
});

test('parser errors and statement timeout end the job visibly, never leave a spinner',async()=>{
 for(const setup of [{readError:Error('양식 파싱 실패')},{items:[row('10000-1')],targetReader:async()=>{throw Error('canceling statement due to statement timeout');}}]){
  const h=harness(setup);h.state.carrierFiles.set('playauto_option',h.file);
  assert.equal(await h.preview('playauto_option'),undefined);
  assert.equal(h.progress.dataset.state,'error');
  assert.equal(h.state.ablyJob.running,false);
  assert.equal(h.timers.size,0);
  assert.match(h.fields.get('title').textContent,/실패/);
  assert.ok(h.messages.some(m=>m.kind==='error'));
 }
});

test('no-progress delay is observable but an increasing processed count is not marked failed',async()=>{
 const h=harness(),job=h.createAblyJob('playauto_option',h.file);
 job.phaseTo('targets',0,500);h.advance(31000);
 assert.match(h.fields.get('detail').textContent,/처리 지연 감지/);
 assert.equal(job.running,true);
 job.phaseTo('targets',250,500);h.advance(1000);
 assert.doesNotMatch(h.fields.get('detail').textContent,/처리 지연 감지/);
 assert.match(h.fields.get('title').textContent,/250 \/ 500/);
 job.finish();assert.equal(h.timers.size,0);
});

test('cancel/reset ignores late RPC output and another file can finish normally',async()=>{
 let release,called=false;
 const pending=new Promise(resolve=>{release=resolve;});
 const h=harness({items:[row('10000-1')],targetReader:async()=>{called=true;return pending;}});
 h.state.carrierFiles.set('playauto_option',h.file);
 const old=h.preview('playauto_option');
 for(let i=0;i<30&&!called;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(called,true);
 h.state.ablyJob.cancel(true);
 assert.equal(h.state.carrierFiles.has('playauto_option'),false);
 assert.equal(h.timers.size,0);
 assert.equal(h.progress.dataset.state,'cancelled');
 const replacement={...h.file,name:'replacement.xlsx'};
 h.state.carrierFiles.set('playauto_option',replacement);
 const next=h.preview('playauto_option');
 release({rows:[{sku:'10000-1',seller_stock:7}]});
 assert.equal(await old,undefined);
 const result=await next;
 assert.equal(result.file.name,'replacement.xlsx');
 assert.equal(h.state.preview.file.name,'replacement.xlsx');
 assert.equal(h.rendered(),1);
 assert.equal(h.timers.size,0);
});

test('250-row yields publish actual matching counts rather than freezing a large preview',async()=>{
 const h=harness(),job=h.createAblyJob('playauto_option',h.file),seen=[];
 job.phaseTo('match');
 const original=job.phaseTo;job.phaseTo=(...args)=>{original(...args);seen.push(args);};
 const result=await job.mapRows(Array.from({length:701},(_,i)=>i),i=>i+1);
 assert.equal(result.length,701);
 assert.deepEqual(seen.map(args=>args[1]),[0,250,500,701]);
 job.finish();assert.equal(h.timers.size,0);
});
