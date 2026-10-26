import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {createRequire} from 'node:module';

const require=createRequire(process.env.CODEX_NODE_MODULES?`${process.env.CODEX_NODE_MODULES}/export-dependencies.cjs`:import.meta.url);
const {chromium}=require('playwright');
const source=name=>fs.readFileSync(new URL(`../mockups/operations-hub/${name}`,import.meta.url),'utf8');
const workflow=source('seller-file-workflow-v2.js');
const choose=async(page,selector,value)=>page.locator(selector).locator('..').locator(`.seller-choice-options input[value="${value}"]`).check();
const dependency=source=>`[data-standard-include-dependencies="${source}"]`;
const file=name=>({name,mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from('synthetic UI input')});
let browser;
test.before(async()=>{browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:process.platform==='win32'?{channel:'msedge'}:{})});});
test.after(async()=>{await browser?.close();});

async function fixture(t){
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 t.after(async()=>{assert.deepEqual(errors,[]);await page.close();});
 await page.setContent('<!doctype html><main><section id="jobs" class="page"><div class="page-head"><h2>내보내기</h2></div></section></main>');
 await page.addStyleTag({content:source('seller-file-workflow-v2.css')});
 for(const name of ['manual-sku-scope.js','discount-price-math.js','sellpia-inventory-count.js','current-price-export.js','ably-price-projection.js'])await page.addScriptTag({content:source(name)});
 await page.evaluate(()=>{
  window.calls=[];window.builds=[];window.downloads=[];window.dependencyCalls=[];window.verifyCalls=0;window.parentFinal=6000;
  if(!crypto.randomUUID)Object.defineProperty(crypto,'randomUUID',{value:()=>`fixture-${Date.now()}`});
  const summary={selectedSkuCount:1,matchedOptionCount:3,changedOptionCount:3,unchangedOptionCount:0,unmatchedSkuCount:0,blockedCount:0,preservedCount:0,outputRowCount:3};
  const inherited=sku=>({sku,parent_sku:'P',root_sku:'P',final:window.parentFinal,path:['P',sku],inherited:true,automatically_included:true,error:window.dependencyError&&sku==='C1'?'상위 가격 확인 실패':''});
  window.dependencySummary=()=>({enabled:true,requestedCount:1,autoIncludedCount:2,inheritedCount:2,rows:[inherited('C1'),inherited('C2')]});
  const preview=name=>async args=>{calls.push({name,args});return {planFingerprint:`${name}:${args.priceMode}:${args.includeDependencies}`,scopeSummary:summary,diagnostics:{sku_count:3,query_count:1},stockSource:args.stockSource,includeStock:args.includeStock,plans:[],dependencies:args.includeDependencies?dependencySummary():undefined};};
  const run=name=>async args=>{calls.push({name,args});return {title:'합성 파일 완료',scopeSummary:summary,dependencies:args.includeDependencies?dependencySummary():undefined};};
  window.SystemV3SellerExportBridge={previewTargetAll:preview('target'),runTargetAll:run('target-run'),previewChangedOnly:preview('changed'),runChangedOnly:run('changed-run'),previewFullOriginal:preview('full'),runFullOriginal:run('full-run'),previewPriceOnly:preview('price'),runPriceOnly:run('price-run'),previewStockOnly:preview('stock'),runStockOnly:run('stock-run'),previewCarrier:preview('carrier'),runCarrier:run('carrier-run')};
  window.HubPriceDependencyService={
   async prepare(args){
    dependencyCalls.push(args);const requested=args.skus||['P','C1','C2'],outputSkus=requested.includes('P')?[...new Set([...requested,'C1','C2'])]:requested;
    const rows=outputSkus.filter(sku=>sku!=='P').map(sku=>({...inherited(sku),automatically_included:!requested.includes(sku)}));
    const summary={enabled:true,requestedCount:requested.length,autoIncludedCount:rows.filter(row=>row.automatically_included).length,inheritedCount:rows.length,rows:[...rows]};
    if(window.rootInternalOnly&&outputSkus.includes('P'))rows.push({sku:'P',parent_sku:null,root_sku:'P',final:parentFinal,path:['P'],inherited:false,dependency_root:true,automatically_included:false});
    return {outputSkus,resolution:{bySku:new Map(rows.map(row=>[row.sku,row]))},summary,proof:`parent:${parentFinal}`};
   },
   async verify(){verifyCalls++;if(window.failVerify)throw Error('가격 종속관계가 변경되었습니다. 다시 미리보기 해주세요.');}
  };
  const currentDecisions=({skus})=>({groups:[],rows:skus.includes('C1')?[{sku:'C1',source_channel:'ably',seller_product_code:'CHILD',seller_option_code:'C1',price:{base:50000,discounted:50000,option:0,final:50000,terms:[]},event_id:'child-current',revision:1,decision_source:'matrix_manual',effective_at:'2026-10-22T00:00:00Z',mapping_valid:true}]:[]});
  window.SystemV3Data={
   resolveCodeEntries:async entries=>entries.map(entry=>({input_row:entry.row_no,source_channel:entry.source,input_code:entry.code,match_scope:'sku',match_status:'matched',sellpia_sku_code:entry.code,product_code:null,option_code:null})),
   loadAuxiliarySellerFiles:async()=>({rows:[]}),loadLatestSellerOriginalStatus:async()=>[],loadTagCatalog:async()=>({rows:[]}),
   loadPlayautoSellpiaCatalog:async()=>[],loadCarrierSellerMappings:async()=>({rows:[]}),
   loadCarrierMatrixTargets:async args=>{calls.push({name:'ably-targets',args});return {rows:args.skus.map(sku=>window.rootInternalOnly&&sku==='P'?{sku,active_price_rule:false,current_effective_price:null}:{sku,active_price_rule:true,current_effective_price:{platformBase:sku==='P'?6000:99000,platformDiscount:0,platformOption:0,platformFinal:sku==='P'?6000:99000,platformTerms:[]}})};},
   loadCurrentPriceDecisions:async args=>{calls.push({name:'ably-editor-decisions',args});return currentDecisions(args);},
   loadExportCurrentPriceDecisions:async args=>{calls.push({name:'ably-large-decisions',args});return currentDecisions(args);},
   loadSellpiaSourcePricesForExport:async({skus})=>new Map(skus.map(sku=>[sku,sku==='P'?6000:88000])),
   loadAblyCarrierPoliciesForSkus:async()=>({rows:[],fingerprint:'[]'}),
   loadSellpiaStockSourcesForExport:async()=>({snapshotId:'stock',bySku:new Map(['P','C1','C2'].map(sku=>[sku,{sellpia_available_stock:9,sellpia_current_stock:9}]))}),
   recordStockExportAudit:async()=>({})
  };
  const items=[['C1',2,0,10000,1000],['C2',2,1,10000,2000],['P',3,0,5000,0]].map(([sku,row,index,base,option])=>({fixtureSku:sku,source_row_no:row,option_index:index,seller_product_code:sku==='P'?'PARENT':'CHILD',seller_option_code:sku,sellpia_product_code:sku,seller_management_code:sku,primary_option_name:'size',secondary_option_value:sku,base_price:base,option_price:option,sales_quantity:3}));
  window.AblyPlayautoExport={
   readTemplate:async input=>({type:input.name.includes('product')?'product_price_option':'option_price_stock',items:structuredClone(items)}),
   resolveRows:rows=>rows.map(row=>({...row,resolution:{sku:row.fixtureSku,method:'verified_solution_code'}})),
   prepareStockOnlyRow:(item,row)=>({...item,target_stock:row.sellpia_available_stock}),
   buildProductPriceOption:async(file,rows)=>{builds.push(structuredClone(rows));return new Blob(['synthetic product']);},
   buildOptionPriceStock:async(file,rows)=>{builds.push(structuredClone(rows));return new Blob(['synthetic option']);}
  };
  window.SystemV3SellerExport={downloadBlob:(blob,name)=>downloads.push(name),conflictCsv:()=>''};
 });
 await page.addScriptTag({content:workflow});await page.waitForSelector('#export-workflow-v2');return page;
}

async function clickReady(page,selector){await page.locator(selector).click();await page.waitForFunction(selector=>!document.querySelector(selector).disabled,selector);}
async function ablyPreview(page,{scope='P',mode='rules',role='product',fields='price_only'}={}){
 await choose(page,'[data-ably-field-mode]',fields);
 await choose(page,'[data-seller-scope-mode="ably"]','manual');await page.locator('[data-seller-scope-manual="ably"]').fill(scope);
 await choose(page,'[data-standard-price-mode="ably"]',mode);
 await page.locator('[data-standard-source="ably"] details.seller-advanced').evaluate(node=>node.open=true);
 await page.locator(`[data-carrier-input="playauto_${role}"]`).setInputFiles(file(`${role}.xlsx`));
 await page.waitForFunction(()=>document.querySelector('[data-ably-progress]').dataset.state==='done'||document.querySelector('[data-ably-progress]').dataset.state==='error');
}

test('dependency flag defaults off, stays independent of price mode, propagates to preview/run/full originals, and invalidates old preview',async t=>{
 const page=await fixture(t),check=page.locator(dependency('smartstore'));
 assert.equal(await check.isChecked(),false);assert.equal(await page.locator('input[data-standard-include-dependencies]').count(),3);
 await clickReady(page,'[data-standard-preview="smartstore"]');assert.equal(await page.evaluate(()=>calls.at(-1).args.includeDependencies),false);
 await check.check();await clickReady(page,'[data-standard-run="smartstore"]');assert.equal(await page.evaluate(()=>calls.some(call=>call.name.endsWith('-run'))),false);
 await choose(page,'[data-standard-price-mode="smartstore"]','sellpia_source');
 await clickReady(page,'[data-standard-preview="smartstore"]');await clickReady(page,'[data-standard-run="smartstore"]');
 assert.deepEqual(await page.evaluate(()=>calls.filter(call=>['target','target-run'].includes(call.name)).slice(-2).map(call=>[call.args.priceMode,call.args.includeDependencies])),[['sellpia_source',true],['sellpia_source',true]]);
 await page.locator('[data-standard-source="smartstore"] details.seller-advanced').evaluate(node=>node.open=true);
 await clickReady(page,'[data-standard-full-preview="smartstore"]');await clickReady(page,'[data-standard-full-run="smartstore"]');
 assert.deepEqual(await page.evaluate(()=>calls.filter(call=>['full','full-run'].includes(call.name)).map(call=>call.args.includeDependencies)),[true,true]);
 assert.match(await page.locator('[data-standard-result="smartstore"]').innerText(),/모음전 자동 포함 2 SKU/);
});

test('stock-only clears and disables inheritance; price-only transmits it and advanced carrier cannot silently ignore it',async t=>{
 const page=await fixture(t),check=page.locator(dependency('makeshop'));await check.check();
 await choose(page,'[data-standard-field-mode="makeshop"]','stock_only');assert.equal(await check.isDisabled(),true);assert.equal(await check.isChecked(),false);
 await clickReady(page,'[data-standard-preview="makeshop"]');assert.equal(await page.evaluate(()=>calls.at(-1).args.includeDependencies),false);
 await choose(page,'[data-standard-field-mode="makeshop"]','price_only');await check.check();
 await clickReady(page,'[data-standard-preview="makeshop"]');await clickReady(page,'[data-standard-run="makeshop"]');
 assert.deepEqual(await page.evaluate(()=>calls.filter(call=>['price','price-run'].includes(call.name)).map(call=>call.args.includeDependencies)),[true,true]);
 await page.locator('[data-standard-source="makeshop"] details.seller-advanced').evaluate(node=>node.open=true);
 await page.locator('[data-standard-carrier-input="makeshop"]').setInputFiles(file('carrier.xlsx'));
 assert.equal(await page.evaluate(()=>calls.some(call=>call.name==='carrier')),false);assert.match(await page.locator('[data-standard-result="makeshop"]').innerText(),/일반 미리보기와 XLSX 생성/);
});

test('dependency provenance is escaped, readable on mobile, and includes parent and auto-expanded counts',async t=>{
 const page=await fixture(t);await page.setViewportSize({width:390,height:900});
 await page.evaluate(()=>{const original=window.dependencySummary;window.dependencySummary=()=>({...original(),rows:[{sku:'C1',parent_sku:'<img src=x onerror="window.injected=1">',root_sku:'P',final:6000,path:['P','C1'],inherited:true,automatically_included:true}]});});
 await page.locator(dependency('smartstore')).check();await clickReady(page,'[data-standard-preview="smartstore"]');
 const summary=page.locator('[data-standard-result="smartstore"] [data-dependency-summary]');await summary.locator('summary').click();
 assert.match(await summary.innerText(),/상위 가격 참조 2 SKU/);assert.match(await summary.innerText(),/<img src=x/);assert.equal(await summary.locator('img').count(),0);assert.equal(await page.evaluate(()=>window.injected),undefined);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
});

for(const mode of ['rules','sellpia_source'])test(`Ably ${mode} copies parent final, expands parent selection, ignores inherited child formula/current decision, and verifies before download`,async t=>{
 const page=await fixture(t);await page.locator(dependency('ably')).check();await ablyPreview(page,{mode});
 assert.match(await page.locator('[data-ably-action-status]').innerText(),/미리보기 완료/);
 assert.match(await page.locator('#export-dependency-provenance').innerText(),/모음전 자동 포함 2 SKU/);
 assert.equal(await page.locator('#export-preview-rows tr').count(),3);
 const childRows=page.locator('#export-preview-rows tr').filter({hasText:'C'});assert.match(await childRows.first().innerText(),/목표 최종 6,000/);
 if(mode==='rules')assert.deepEqual(await page.evaluate(()=>calls.filter(call=>call.name==='ably-targets').flatMap(call=>call.args.skus)),['P']);
 await clickReady(page,'[data-ably-standard-run]');await page.waitForFunction(()=>downloads.length>0||document.querySelector('[data-ably-progress]').dataset.state==='error');
 assert.equal(await page.evaluate(()=>downloads.length),1,await page.locator('#export-workflow-status').innerText());
 assert.equal(await page.evaluate(()=>verifyCalls),1);
 assert.equal(await page.evaluate(()=>calls.filter(call=>call.name==='ably-editor-decisions').length),0,'enabled preview and final verification never fall back to the editor group cap');
 assert.deepEqual(await page.evaluate(()=>calls.filter(call=>call.name==='ably-large-decisions').map(call=>[call.args.source,call.args.allowLargeGroups])),[['ably',true],['ably',true],['ably',true]]);
 assert.deepEqual(await page.evaluate(()=>builds[0].filter(row=>row.fixtureSku!=='P').map(row=>row.target_base_price+row.target_option_price)),[6000,6000]);
});

test('Ably unchecked retains its current manual price decision and makes no dependency request',async t=>{
 const page=await fixture(t);await ablyPreview(page,{scope:'C1'});
 assert.equal(await page.evaluate(()=>dependencyCalls.length),0);
 assert.equal(await page.evaluate(()=>calls.filter(call=>call.name==='ably-large-decisions').length),0);
 assert.equal(await page.evaluate(()=>calls.filter(call=>call.name==='ably-editor-decisions').length),1,'unchecked retains its original editor read');
 assert.match(await page.locator('#export-preview-rows tr').filter({hasText:'C1'}).innerText(),/목표 최종 50,000/);
 assert.equal(await page.locator('#export-dependency-provenance [data-dependency-summary]').count(),0);
});

test('Ably dependency export retains a whole group above 200 options through preview and final revalidation',async t=>{
 const page=await fixture(t);
 await page.evaluate(()=>{
  const skus=Array.from({length:205},(_,index)=>`C${index}`),rows=skus.map(sku=>({sku,parent_sku:'P',root_sku:'P',final:6000,path:['P',sku],inherited:true,automatically_included:true}));
  HubPriceDependencyService.prepare=async()=>({outputSkus:['P',...skus],resolution:{bySku:new Map(rows.map(row=>[row.sku,row]))},proof:'large-group-proof',summary:{enabled:true,requestedCount:1,autoIncludedCount:205,inheritedCount:205,rows}});
  SystemV3Data.loadCurrentPriceDecisions=async()=>{throw Error('editor group limit must not be used');};
  AblyPlayautoExport.readTemplate=async()=>({type:'product_price_option',items:[...skus.map((sku,index)=>({fixtureSku:sku,source_row_no:2,option_index:index,seller_product_code:'CHILD',seller_option_code:sku,sellpia_product_code:sku,seller_management_code:sku,primary_option_name:'size',secondary_option_value:sku,base_price:10000,option_price:index,sales_quantity:3})),{fixtureSku:'P',source_row_no:3,option_index:0,seller_product_code:'PARENT',seller_option_code:'P',sellpia_product_code:'P',seller_management_code:'P',primary_option_name:'size',secondary_option_value:'P',base_price:5000,option_price:0,sales_quantity:3}]});
 });
 await page.locator(dependency('ably')).check();await ablyPreview(page);
 assert.match(await page.locator('#export-dependency-provenance').innerText(),/모음전 자동 포함 205 SKU/);
 await clickReady(page,'[data-ably-standard-run]');await page.waitForFunction(()=>downloads.length>0||document.querySelector('[data-ably-progress]').dataset.state==='error');
 assert.equal(await page.evaluate(()=>downloads.length),1);
 assert.equal(await page.evaluate(()=>builds[0].length),206,'the preview display page does not truncate generated targets');
 assert.equal(await page.evaluate(()=>builds[0].every(row=>row.target_base_price+row.target_option_price===6000)),true);
 assert.deepEqual(await page.evaluate(()=>calls.filter(call=>call.name==='ably-large-decisions').map(call=>[call.args.allowLargeGroups,call.args.skus.length])),[[true,206],[true,206],[true,206]]);
});

test('Ably enabled dependency export fails closed when the large-group reader is unavailable',async t=>{
 const page=await fixture(t);await page.evaluate(()=>delete SystemV3Data.loadExportCurrentPriceDecisions);
 await page.locator(dependency('ably')).check();await ablyPreview(page);
 assert.match(await page.locator('#export-workflow-status').innerText(),/현재 가격 결정 조회 모듈/);
 assert.equal(await page.evaluate(()=>calls.filter(call=>call.name==='ably-editor-decisions').length),0);
 assert.equal(await page.evaluate(()=>downloads.length),0);
});

test('Ably exports a selected parents edited internal price together with inherited children without a platform Rule',async t=>{
 const page=await fixture(t);await page.evaluate(()=>window.rootInternalOnly=true);await page.locator(dependency('ably')).check();await ablyPreview(page);
 const parent=page.locator('#export-preview-rows tr').filter({has:page.locator('td:first-child',{hasText:/^P$/})});
 assert.match(await parent.innerText(),/목표 최종 6,000/);assert.match(await parent.innerText(),/상위 상품 기준가격 적용/);assert.doesNotMatch(await parent.innerText(),/null|undefined/);
 assert.equal(await page.evaluate(()=>calls.filter(call=>call.name==='ably-targets').length),0);
 assert.match(await page.locator('#export-dependency-provenance').innerText(),/모음전 자동 포함 2 SKU/);
 await clickReady(page,'[data-ably-standard-run]');await page.waitForFunction(()=>downloads.length>0||document.querySelector('[data-ably-progress]').dataset.state==='error');
 assert.equal(await page.evaluate(()=>downloads.length),1);
 assert.deepEqual(await page.evaluate(()=>builds[0].map(row=>[row.fixtureSku,row.target_base_price+row.target_option_price])),[['C1',6000],['C2',6000],['P',6000]]);
});

test('Ably explicit representative policy keeps its existing download block with inherited prices',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{SystemV3Data.loadAblyCarrierPoliciesForSkus=async()=>({fingerprint:'explicit-policy',rows:['C1','C2'].map(sku=>({sku,tags:[{tag_id:1,tag_name:'명시 정책',document:{body:{carriers:{ably:{representativeStrategy:'lower_middle'}}}}}]}))});});
 await page.locator(dependency('ably')).check();await ablyPreview(page);
 assert.equal(await page.locator('#export-preview-generate').isDisabled(),true);
 assert.match(await page.locator('#export-preview-copy').innerText(),/lower_middle.*차단/);
 assert.equal(await page.evaluate(()=>downloads.length),0);
});

test('Ably child-only selection reads its outside parent and dependency drift prevents download',async t=>{
 const page=await fixture(t);await page.locator(dependency('ably')).check();await ablyPreview(page,{scope:'C1'});
 assert.deepEqual(await page.evaluate(()=>dependencyCalls[0].skus),['C1']);assert.match(await page.locator('#export-dependency-provenance').innerText(),/모음전 자동 포함 0 SKU/);
 await page.evaluate(()=>window.failVerify=true);await clickReady(page,'[data-ably-standard-run]');await page.waitForFunction(()=>document.querySelector('[data-ably-progress]').dataset.state==='error');
 assert.equal(await page.evaluate(()=>downloads.length),0);assert.match(await page.locator('#export-workflow-status').innerText(),/종속관계가 변경/);
});

test('Ably auto-included child receives only the inherited price while originally selected stock changes remain eligible',async t=>{
 const page=await fixture(t);await page.evaluate(()=>window.rootInternalOnly=true);await page.locator(dependency('ably')).check();await ablyPreview(page,{role:'option',fields:'option_stock'});
 await clickReady(page,'[data-ably-standard-run]');await page.waitForFunction(()=>downloads.length>0||document.querySelector('[data-ably-progress]').dataset.state==='error');
 assert.equal(await page.evaluate(()=>downloads.length),1,JSON.stringify(await page.evaluate(()=>({downloads,rows:builds[0]}))));
 assert.deepEqual(await page.evaluate(()=>builds[0].map(row=>[row.fixtureSku,row.target_stock])),[['C1',null],['C2',null],['P',9]]);
 assert.deepEqual(await page.evaluate(()=>builds[0].filter(row=>row.fixtureSku!=='P').map(row=>row.base_price+row.target_option_price)),[6000,6000]);
 assert.equal(await page.evaluate(()=>{const parent=builds[0].find(row=>row.fixtureSku==='P');return parent.base_price+parent.target_option_price;}),6000);
});

test('Ably inherited-price failure preserves the whole child product and never falls back to its own formula',async t=>{
 const page=await fixture(t);await page.evaluate(()=>window.dependencyError=true);await page.locator(dependency('ably')).check();await ablyPreview(page);
 assert.match(await page.locator('#export-preview-rows').innerText(),/같은 상품|공유 판매가 보호/);
 assert.equal(await page.evaluate(()=>calls.filter(call=>call.name==='ably-targets').some(call=>call.args.skus.some(sku=>sku!=='P'))),false);
 await page.locator('#export-dependency-provenance summary').click();
 assert.match(await page.locator('#export-dependency-provenance').innerText(),/상위 가격 확인 실패/);
});
