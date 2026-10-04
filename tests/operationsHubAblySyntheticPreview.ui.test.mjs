import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {createRequire} from 'node:module';
import {chromium} from 'playwright';

const require=createRequire(import.meta.url);
const root=path.resolve('mockups/operations-hub');
const fixture=fs.readFileSync(path.resolve('tests/fixtures/ably/ably-price-projection-synthetic.xlsx'));
const workflow=fs.readFileSync(path.join(root,'seller-file-workflow-v2.js'),'utf8');
const xlsxScript=process.env.XLSX_BROWSER_SCRIPT&&fs.existsSync(process.env.XLSX_BROWSER_SCRIPT)
 ?fs.readFileSync(process.env.XLSX_BROWSER_SCRIPT,'utf8')
 :await (await fetch('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js')).text();

const helpers=workflow.slice(workflow.indexOf(' const ablyPhases='),workflow.indexOf('\n async function loadStatuses('));
const previewSource=workflow.slice(workflow.indexOf(' async function preview(role)'),workflow.indexOf('\n function previewRowsForFilter('));
const renderSource=workflow.slice(workflow.indexOf(' function previewRowsForFilter('),workflow.indexOf('\n async function generate('));
const generateSource=workflow.slice(workflow.indexOf(' async function generate('),workflow.indexOf('\n function renameLegacyExportUi('));

test('synthetic workbook exercises the actual Ably operator preview, guard, conflict, and generate flow',async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.setContent(`<!doctype html><body>
   <select data-standard-price-mode="ably"><option value="sellpia_source" selected>source</option></select>
   <select data-seller-scope-mode="ably"><option value="manual" selected>manual</option></select>
   <section id="export-preview-v2" hidden><h2 id="export-preview-title"></h2><p id="export-preview-copy"></p>
    <div id="export-preview-counts"></div><table><tbody id="export-preview-rows"></tbody></table>
    <div id="export-preview-pagination"></div><button id="export-preview-generate">generate</button></section>
   <div data-ably-progress hidden><b data-ably-progress-title></b><span data-ably-progress-detail></span><i data-ably-progress-bar></i><button data-ably-progress-cancel></button></div>
   <p id="seller-file-status"></p><p id="export-workflow-status"></p></body>`);
  await page.addScriptTag({content:xlsxScript});
  await page.addScriptTag({content:fs.readFileSync(require.resolve('jszip/dist/jszip.min.js'),'utf8')});
  for(const script of ['discount-price-math.js','current-price-export.js','ably-stock-export.js','seller-export-adapter.js','ably-price-projection.js','ably-playauto-export.js'])await page.addScriptTag({path:path.join(root,script)});
  await page.evaluate(({bytes,helpers,previewSource,renderSource,generateSource})=>{
   const file=new File([new Uint8Array(bytes)],'ably-price-projection-synthetic.xlsx');
   const state={carrierFiles:new Map([['playauto_product',file]]),ablyJob:null,ablyJobSequence:0,preview:null,previewFilter:'all',previewPage:1};
   const roles={playauto_product:{label:'판매가 + 옵션가',type:'product_price_option'}};
   const messages=[],downloads=[];
   const n=value=>Number(value||0).toLocaleString('ko-KR');
   const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
   const setStatus=(text,kind='')=>messages.push({text,kind});
   const setSellerPanel=()=>{};
   const createAblyJob=Function('global','state','document','n','renderExportStatuses','setStatus',`${helpers};return createAblyJob;`)(window,state,document,n,()=>{},setStatus);
   const renderPreview=Function('state','roles','document','global','setSellerPanel','esc','n',`${renderSource};return renderPreview;`)(state,roles,document,window,setSellerPanel,esc,n);
   const policyDoc=(strategy,id,name,version=1)=>({tag_id:id,tag_name:name,is_active:true,document:{id:'doc-'+id,title:'carrier-policy:tag:'+id,version,body:{version:1,carriers:{ably:{representativeStrategy:strategy}}}}});
   const scenario={selected:['CASE-C-1'],prices:{'CASE-C-1':32000},policies:[policyDoc('lowest','low','최저가',2)],fingerprint:'case-c-low-v2'};
   let catalogRows=[];
   const D=()=>({
    loadCarrierSellerMappings:async()=>({rows:[]}),
    loadSellpiaSourcePricesForExport:async({skus})=>new Map(skus.map(sku=>[sku,scenario.prices[sku]])),
    loadAblyCarrierPoliciesForSkus:async({skus})=>({rows:skus.map(sku=>({sku,tags:scenario.selected.includes(sku)?structuredClone(scenario.policies):[]})),fingerprint:scenario.fingerprint})
   });
   const A=()=>window.AblyPlayautoExport,P=()=>window.AblyPriceProjection;
   const catalog=async()=>catalogRows;
   const scopeSkus=async()=>new Set(scenario.selected);
   const preview=Function('state','roles','setStatus','createAblyJob','document','global','blobFile','A','D','P','catalog','scopeSkus','renderPreview','n',`${previewSource};return preview;`)(state,roles,setStatus,createAblyJob,document,window,async()=>file,A,D,P,catalog,scopeSkus,renderPreview,n);
   window.SystemV3SellerExport={...window.SystemV3SellerExport,downloadBlob:(blob,name)=>downloads.push({blob,name}),conflictCsv:()=>''};
   const generate=Function('state','setStatus','preview','setSellerPanel','document','A','safeName','global','n','roles',`${generateSource};return generate;`)(state,setStatus,preview,setSellerPanel,document,A,value=>String(value).replace(/[^\p{L}\p{N}._-]+/gu,'_'),window,n,roles);
   window.syntheticQa={state,scenario,messages,downloads,policyDoc,preview,generate,setCatalog:rows=>{catalogRows=rows;}};
  },{bytes:Array.from(fixture),helpers,previewSource,renderSource,generateSource});

  await page.evaluate(async()=>{
   const parsed=await AblyPlayautoExport.readTemplate(syntheticQa.state.carrierFiles.get('playauto_product'));
   syntheticQa.setCatalog([...new Map(parsed.items.filter(item=>item.direct_sellpia_sku_code).map(item=>[item.direct_sellpia_sku_code,{sellpia_product_code:item.sellpia_product_code,sellpia_sku_code:item.direct_sellpia_sku_code}])).values()]);
  });

  const lowest=await page.evaluate(async()=>{const preview=await syntheticQa.preview('playauto_product');return {copy:document.getElementById('export-preview-copy').textContent,rows:document.getElementById('export-preview-rows').textContent,disabled:document.getElementById('export-preview-generate').disabled,token:preview.versionToken,counts:preview.counts,output:preview.output.filter(row=>row.source_row_no===4).map(row=>({base:row.target_base_price,option:row.target_option_price,final:row._projectionTargetFinal,preserve:row._preserveUnselected}))};});
  assert.match(lowest.copy,/Price source: sellpia_source/);assert.match(lowest.copy,/Resolved Ably policy: lowest · tag 최저가 \(v2\)/);
  assert.match(lowest.copy,/같은 PlayAuto 상품 행 전체 T를 다시 계산/);assert.match(lowest.rows,/I 30,000 \/ T 3,500 \/ 최종 33,500/);
  assert.equal(lowest.disabled,false);assert.equal(lowest.counts.pricePreserved,2);
  assert.deepEqual(lowest.output.map(row=>row.final),[32000,33500,39000]);assert.deepEqual(lowest.output.map(row=>row.preserve),[false,true,true]);

  const stable=await page.evaluate(async()=>{const token=syntheticQa.state.preview.versionToken;await syntheticQa.generate();const downloaded=syntheticQa.downloads[0];if(!downloaded)return {before:token,after:syntheticQa.state.preview?.versionToken,downloads:0,caseC:[],messages:syntheticQa.messages};const parsed=await AblyPlayautoExport.readTemplate(new File([downloaded.blob],downloaded.name));return {before:token,after:syntheticQa.state.preview.versionToken,downloads:syntheticQa.downloads.length,caseC:parsed.items.filter(row=>row.direct_sellpia_sku_code?.startsWith('CASE-C-')).map(row=>[row.base_price,row.option_price]),messages:syntheticQa.messages};});
  assert.equal(stable.after,stable.before,'unchanged preview and generate revalidation must share a fingerprint');assert.equal(stable.downloads,1,JSON.stringify(stable.messages));assert.deepEqual(stable.caseC,[[32000,0],[32000,1500],[32000,7000]]);

  const changed=await page.evaluate(async()=>{const before=syntheticQa.state.preview.versionToken;syntheticQa.scenario.prices['CASE-C-1']=32100;const next=await syntheticQa.preview('playauto_product');return {before,after:next.versionToken};});
  assert.notEqual(changed.after,changed.before,'target input changes must invalidate the preview fingerprint');

  const lower=await page.evaluate(async()=>{Object.assign(syntheticQa.scenario,{selected:['CASE-A-1'],prices:{'CASE-A-1':40000},policies:[syntheticQa.policyDoc('lower_middle','middle','중간값',7)],fingerprint:'case-a-middle-v7'});const preview=await syntheticQa.preview('playauto_product');return {copy:document.getElementById('export-preview-copy').textContent,rows:document.getElementById('export-preview-rows').textContent,disabled:document.getElementById('export-preview-generate').disabled,blocked:preview.counts.blocked,minDelta:preview.output.find(row=>row.source_row_no===2)?._projection?.minDelta};});
  assert.match(lower.copy,/lower_middle · tag 중간값 \(v7\)/);assert.match(lower.copy,/실제 다운로드는 현재 차단/);assert.equal(lower.disabled,true);assert.ok(lower.blocked>0);assert.ok(lower.minDelta<0);

  const conflict=await page.evaluate(async()=>{Object.assign(syntheticQa.scenario,{selected:['CASE-O-1'],prices:{'CASE-O-1':41000},policies:[syntheticQa.policyDoc('lowest','low','낮은값',3),syntheticQa.policyDoc('lower_middle','middle','중간값',4)],fingerprint:'case-o-conflict'});const preview=await syntheticQa.preview('playauto_product');return {rows:document.getElementById('export-preview-rows').textContent,blocked:preview.counts.blocked,disabled:document.getElementById('export-preview-generate').disabled};});
  assert.match(conflict.rows,/에이블리 대표가 정책 충돌/);assert.equal(conflict.blocked,2);assert.equal(conflict.disabled,false,'ordinary blocked rows remain isolated under the current export contract');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
