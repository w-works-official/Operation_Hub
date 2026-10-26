import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {createRequire} from 'node:module';

const require=createRequire(process.env.CODEX_NODE_MODULES?`${process.env.CODEX_NODE_MODULES}/manual-sku-scope-ui.cjs`:import.meta.url);
const {chromium}=require('playwright');
const source=name=>fs.readFileSync(new URL(`../mockups/operations-hub/${name}`,import.meta.url),'utf8');
const prefixes=['8008','8434','9992','10057'];
const expectedSkus=prefixes.flatMap((code,index)=>Array.from({length:[12,6,5,5][index]},(_,option)=>`${code}-${option+1}`)).sort();
const scope=channel=>`[data-seller-scope-mode="${channel}"]`;
const input=channel=>`[data-seller-scope-manual="${channel}"]`;
const report=channel=>`[data-seller-manual-report="${channel}"]`;
const summary=channel=>`[data-seller-scope-summary="${channel}"]`;
const choose=(page,selector,value)=>page.locator(selector).locator('..').locator(`.seller-choice-options input[value="${value}"]`).check();
let browser;
test.before(async()=>{browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:process.platform==='win32'?{channel:'msedge'}:{})});});
test.after(async()=>{await browser?.close();});

async function fixture(t){
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.setDefaultTimeout(6000);
 page.on('pageerror',error=>errors.push(error.message));
 t.after(async()=>{assert.deepEqual(errors,[]);await page.close();});
 await page.setContent('<!doctype html><main><section id="jobs" class="page"><div class="page-head"><h2>판매처 내보내기</h2></div></section></main>');
 await page.addStyleTag({content:source('seller-file-workflow-v2.css')});
 for(const name of ['discount-price-math.js','sellpia-inventory-count.js','current-price-export.js','ably-price-projection.js','manual-sku-scope.js'])await page.addScriptTag({content:source(name)});
 await page.evaluate(()=>{
  window.calls=[];window.resolverCalls=[];window.pendingResolvers=[];window.downloads=[];window.builds=[];window.tagCalls=[];window.stockCalls=[];
  if(!crypto.randomUUID)Object.defineProperty(crypto,'randomUUID',{value:()=>`fixture-${Date.now()}`});
  const counts={'8008':12,'8434':6,'9992':5,'10057':5};
  window.fixtureSkus=Object.entries(counts).flatMap(([code,count])=>Array.from({length:count},(_,index)=>`${code}-${index+1}`));
  window.resolverRows=entries=>entries.flatMap(entry=>{
   const exact=fixtureSkus.includes(entry.code),skus=exact?[entry.code]:Array.from({length:counts[entry.code]||0},(_,index)=>`${entry.code}-${index+1}`);
   if(window.expandExtra&&entry.code==='8008'&&!exact)skus.push('8008-99');
   const base={input_row:entry.row_no,source_channel:'sellpia',input_code:entry.code,product_code:null,option_code:null};
   return skus.length?skus.map(sku=>({...base,match_scope:exact?'sku':'prefix',match_status:'matched',sellpia_sku_code:sku})):[{...base,match_scope:'none',match_status:'not_found',sellpia_sku_code:null}];
  });
  const scopeSummary=skus=>{const matched=skus===null?fixtureSkus:skus.filter(sku=>fixtureSkus.includes(sku));return {selectedSkuCount:skus===null?fixtureSkus.length:skus.length,matchedOptionCount:matched.length,changedOptionCount:matched.length,unchangedOptionCount:0,unmatchedSkuCount:skus===null?0:skus.length-matched.length,blockedCount:0,preservedCount:0,outputRowCount:matched.length};};
  const preview=name=>async args=>{calls.push({name,source:args.source,skus:args.skus===null?null:[...args.skus]});return {planFingerprint:JSON.stringify([args.source,args.skus,args.stockSource,args.priceMode]),scopeSummary:scopeSummary(args.skus),diagnostics:{sku_count:args.skus===null?fixtureSkus.length:args.skus.length,query_count:1},stockSource:args.stockSource,includeStock:args.includeStock,plans:[],count:'합성 미리보기',detail:'현재 원본 매칭 확인'};};
  const run=name=>async args=>{calls.push({name,source:args.source,skus:args.skus===null?null:[...args.skus]});downloads.push({source:args.source,skus:args.skus===null?null:[...args.skus]});return {scopeSummary:scopeSummary(args.skus),title:'합성 파일 생성'};};
  window.SystemV3SellerExportBridge={previewTargetAll:preview('preview'),previewChangedOnly:preview('preview-changed'),previewFullOriginal:preview('preview-full'),previewPriceOnly:preview('preview-price'),previewStockOnly:preview('preview-stock'),runTargetAll:run('run'),runChangedOnly:run('run-changed'),runFullOriginal:run('run-full'),runPriceOnly:run('run-price'),runStockOnly:run('run-stock')};
  window.SystemV3Data={
   loadAuxiliarySellerFiles:async()=>({rows:[]}),loadLatestSellerOriginalStatus:async()=>[],loadTagCatalog:async()=>({rows:[{id:'tag-one',tag_id:'tag-one',name:'선택 태그',tag_name:'선택 태그',count:2}]}),
   async resolveCodeEntries(entries){
    resolverCalls.push(structuredClone(entries));
    if(window.resolveError)throw Error('SKU 조회 실패: synthetic timeout');
    const rows=resolverRows(entries).filter(row=>!window.malformedRows||row.input_code!==entries.at(-1).code);
    if(window.deferResolve)return new Promise((resolve,reject)=>pendingResolvers.push({entries:structuredClone(entries),rows,resolve,reject}));
    return rows;
   },
   loadAllTagScopeSkus:async args=>{tagCalls.push(args);return {skus:['8008-1','8434-2'],count:2};},
   loadPlayautoSellpiaCatalog:async()=>[],loadCarrierSellerMappings:async()=>({rows:[]}),
   loadSellpiaStockSourcesForExport:async({skus})=>{stockCalls.push([...skus]);return {snapshotId:'stock-v1',bySku:new Map(skus.map(sku=>[sku,{sellpia_available_stock:9,sellpia_current_stock:9}]))};},
   recordStockExportAudit:async()=>({})
  };
  const items=fixtureSkus.map((sku,index)=>({fixtureSku:sku,source_row_no:index+2,option_index:0,seller_product_code:`SELLER-${sku}`,seller_option_code:sku,sellpia_product_code:sku.split('-')[0],seller_management_code:sku,primary_option_name:'size',secondary_option_value:sku,base_price:1000,option_price:0,sales_quantity:3}));
  window.AblyPlayautoExport={
   readTemplate:async()=>({type:'option_price_stock',items:structuredClone(items)}),
   resolveRows:rows=>rows.map(row=>({...row,resolution:{sku:row.fixtureSku,method:'verified_solution_code'}})),
   prepareStockOnlyRow:(item,row)=>({...item,target_stock:row.sellpia_available_stock}),
   buildOptionPriceStock:async(file,rows)=>{builds.push(structuredClone(rows));return new Blob(['synthetic workbook']);}
  };
  window.SystemV3SellerExport={downloadBlob:(blob,name)=>downloads.push({source:'ably',name}),conflictCsv:()=>''};
 });
 await page.addScriptTag({content:source('seller-file-workflow-v2.js')});await page.waitForSelector('#export-workflow-v2');return page;
}

async function manual(page,channel,value){await choose(page,scope(channel),'manual');await page.locator(input(channel)).fill(value);}
async function clickStandard(page,channel,kind='preview'){
 const selector=`[data-standard-${kind}="${channel}"]`;await page.locator(selector).click();await page.waitForFunction(selector=>!document.querySelector(selector).disabled,selector);
}
async function setupAbly(page,value='8008\n8434\n9992\n10057'){
 await choose(page,'[data-ably-field-mode]','stock_only');await manual(page,'ably',value);
 await page.locator('[data-standard-source="ably"] details.seller-advanced').evaluate(node=>node.open=true);
 await page.locator('[data-carrier-input="playauto_option"]').setInputFiles({name:'synthetic-options.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from('synthetic UI file')});
 await page.waitForFunction(()=>['done','error'].includes(document.querySelector('[data-ably-progress]').dataset.state));
}
function assertResolvedSummary(text,inputs,skus,unresolved=0){
 assert.match(text,new RegExp(`입력\\s*${inputs}\\s*개`));assert.match(text,new RegExp(`셀피아\\s*${skus}\\s*SKU`));if(unresolved)assert.match(text,new RegExp(`미발견\\s*${unresolved}\\s*개`));
}

test('all three manual pickers explain product numbers and full SKUs, count input tokens before lookup, and never query while typing',async t=>{
 const page=await fixture(t);
 for(const channel of ['smartstore','makeshop','ably']){
  await manual(page,channel,prefixes.join('\n'));
  assert.match(await page.locator(input(channel)).locator('..').innerText(),/셀피아 상품번호\s*\/\s*SKU/);
  const text=await page.locator(summary(channel)).innerText();assert.match(text,/입력\s*4\s*개/);assert.match(text,/조회\s*전/);assert.doesNotMatch(text,/직접 입력\s*4\s*SKU/);
 }
 await page.waitForTimeout(350);assert.equal(await page.evaluate(()=>resolverCalls.length),0);assert.equal(await page.evaluate(()=>calls.length),0);
});

for(const channel of ['smartstore','makeshop'])test(`${channel} expands four product prefixes to 28 full SKUs identically for preview and generation`,async t=>{
 const page=await fixture(t);await manual(page,channel,prefixes.join('\n'));await clickStandard(page,channel);
 assert.deepEqual(await page.evaluate(()=>calls[0].skus),expectedSkus);
 assert.deepEqual(await page.evaluate(()=>resolverCalls[0]),prefixes.map((code,index)=>({row_no:index+1,source:'sellpia',code})));
 assertResolvedSummary(await page.locator(summary(channel)).innerText(),4,28);
 assert.equal(await page.locator(report(channel)).count(),1);assert.match(await page.locator(report(channel)).textContent(),/8008/);
 await clickStandard(page,channel,'run');assert.deepEqual(await page.evaluate(()=>calls.at(-1).skus),expectedSkus);assert.equal(await page.evaluate(()=>resolverCalls.length),2);assert.equal(await page.evaluate(()=>downloads.length),1);
});

test('Ably uses the same resolved 28-SKU scope in its actual stock preview and revalidated workbook generation',async t=>{
 const page=await fixture(t);await setupAbly(page);
 assert.match(await page.locator('[data-ably-action-status]').innerText(),/미리보기 완료/);assertResolvedSummary(await page.locator(summary('ably')).innerText(),4,28);
 assert.equal(await page.locator('#export-preview-rows tr').count(),28);assert.deepEqual(await page.evaluate(()=>[...stockCalls[0]].sort()),expectedSkus);
 await page.locator('[data-ably-standard-run]').click();await page.waitForFunction(()=>downloads.length>0||document.querySelector('[data-ably-progress]').dataset.state==='error');
 assert.equal(await page.evaluate(()=>downloads.length),1,await page.locator('#export-workflow-status').innerText());assert.equal(await page.evaluate(()=>resolverCalls.length),2);assert.equal(await page.evaluate(()=>builds[0].length),28);
});

test('mixed product numbers and exact SKUs deduplicate after expansion while retaining meaningful input counts',async t=>{
 const page=await fixture(t);await manual(page,'smartstore','8008, 8008-1\n8434-2 8008');await clickStandard(page,'smartstore');
 assert.deepEqual(await page.evaluate(()=>resolverCalls[0].map(entry=>entry.code)),['8008','8008-1','8434-2']);
 assert.deepEqual(await page.evaluate(()=>calls[0].skus),[...expectedSkus.filter(sku=>sku.startsWith('8008-')),'8434-2'].sort());
 assertResolvedSummary(await page.locator(summary('smartstore')).innerText(),3,13);assert.match(await page.locator(report('smartstore')).textContent(),/8008-1/);
});

test('partial unknown inputs remain visible and escaped while found SKUs retain the existing partial-success export',async t=>{
 const page=await fixture(t),unknown='<svg/onload=window.injected=1>';await manual(page,'makeshop',`8008\n${unknown}`);await clickStandard(page,'makeshop');
 assertResolvedSummary(await page.locator(summary('makeshop')).innerText(),2,12,1);
 assert.match(await page.locator(report('makeshop')).textContent(),/<svg\/onload=window.injected=1>/);assert.equal(await page.locator(`${report('makeshop')} svg`).count(),0);assert.equal(await page.evaluate(()=>window.injected),undefined);
 await clickStandard(page,'makeshop','run');assert.equal(await page.evaluate(()=>downloads.length),1);assert.equal(await page.evaluate(()=>downloads[0].skus.length),12);
});

test('entirely unknown input publishes its zero-SKU report and never reaches preview or generation',async t=>{
 const page=await fixture(t);await manual(page,'smartstore','MISSING\nNOT-FOUND');await clickStandard(page,'smartstore');
 assertResolvedSummary(await page.locator(summary('smartstore')).innerText(),2,0,2);assert.match(await page.locator('[data-standard-result="smartstore"]').innerText(),/셀피아 SKU가 없습니다/);
 assert.equal(await page.evaluate(()=>calls.length),0);await clickStandard(page,'smartstore','run');assert.equal(await page.evaluate(()=>downloads.length),0);assert.equal(await page.evaluate(()=>calls.length),0);
});

test('all and authoritative tag scopes preserve their previous contracts and make no manual resolver request',async t=>{
 const page=await fixture(t);await clickStandard(page,'smartstore');assert.equal(await page.evaluate(()=>calls[0].skus),null);
 await choose(page,scope('makeshop'),'tag');await page.waitForFunction(()=>document.querySelector('[data-seller-scope-tag="makeshop"]').options.length>1);
 await page.locator('[data-seller-scope-tag="makeshop"]').selectOption('tag-one');await clickStandard(page,'makeshop');
 assert.deepEqual(await page.evaluate(()=>calls.at(-1).skus),['8008-1','8434-2']);assert.deepEqual(await page.evaluate(()=>tagCalls),[{tagId:'tag-one'}]);assert.equal(await page.evaluate(()=>resolverCalls.length),0);
});

test('resolver failures and incomplete responses fail closed, clear prior successful resolution, and never fall back to bare inputs',async t=>{
 for(const failure of ['resolveError','malformedRows']){
  const page=await fixture(t);await manual(page,'smartstore','8008');await clickStandard(page,'smartstore');assertResolvedSummary(await page.locator(summary('smartstore')).innerText(),1,12);
  await page.locator(input('smartstore')).fill('8434');await page.evaluate(failure=>window[failure]=true,failure);await clickStandard(page,'smartstore');
  assert.equal(await page.evaluate(()=>calls.length),1);assert.doesNotMatch(await page.locator(summary('smartstore')).innerText(),/셀피아\s*12\s*SKU/);
  assert.match(await page.locator('[data-standard-result="smartstore"]').innerText(),/조회|응답|누락|결과/);await clickStandard(page,'smartstore','run');assert.equal(await page.evaluate(()=>downloads.length),0);
 }
});

test('input changes invalidate pending resolution and an older response cannot replace the latest scope or report',async t=>{
 const page=await fixture(t);await manual(page,'smartstore','8008');await page.evaluate(()=>window.deferResolve=true);
 await page.locator('[data-standard-preview="smartstore"]').click();await page.waitForFunction(()=>pendingResolvers.length===1);
 assert.match(await page.locator(summary('smartstore')).innerText(),/조회\s*중/);
 await page.locator(input('smartstore')).evaluate(node=>{node.value='8434';node.dispatchEvent(new Event('input',{bubbles:true}));});
 await page.locator('[data-standard-preview="smartstore"]').click();await page.waitForFunction(()=>pendingResolvers.length===2);
 await page.evaluate(()=>pendingResolvers[1].resolve(pendingResolvers[1].rows));await page.waitForFunction(()=>calls.length===1);
 assertResolvedSummary(await page.locator(summary('smartstore')).innerText(),1,6);
 await page.evaluate(()=>pendingResolvers[0].resolve(pendingResolvers[0].rows));await page.waitForTimeout(30);
 assertResolvedSummary(await page.locator(summary('smartstore')).innerText(),1,6);assert.equal(await page.evaluate(()=>calls.length),1);assert.deepEqual(await page.evaluate(()=>calls[0].skus),expectedSkus.filter(sku=>sku.startsWith('8434-')));
 assert.doesNotMatch(await page.locator(report('smartstore')).textContent(),/8008/);
});

test('changing manual mode to all during a pending lookup prevents its late report from restoring the old selection',async t=>{
 const page=await fixture(t);await manual(page,'makeshop','8008');await page.evaluate(()=>window.deferResolve=true);await page.locator('[data-standard-preview="makeshop"]').click();await page.waitForFunction(()=>pendingResolvers.length===1);
 await page.locator(scope('makeshop')).evaluate(node=>{node.value='all';node.dispatchEvent(new Event('change',{bubbles:true}));});
 await page.evaluate(()=>pendingResolvers[0].resolve(pendingResolvers[0].rows));await page.waitForTimeout(30);
 assert.equal(await page.evaluate(()=>calls.length),0);assert.match(await page.locator(summary('makeshop')).innerText(),/전체 매칭 SKU/);assert.equal(await page.locator(report('makeshop')).isVisible(),false);
 await clickStandard(page,'makeshop');assert.equal(await page.evaluate(()=>calls[0].skus),null);
});

test('manual resolution reports belong to their own seller and input invalidation leaves the other seller intact',async t=>{
 const page=await fixture(t);await manual(page,'smartstore','8008');await clickStandard(page,'smartstore');await manual(page,'makeshop','8434');await clickStandard(page,'makeshop');
 assertResolvedSummary(await page.locator(summary('smartstore')).innerText(),1,12);assertResolvedSummary(await page.locator(summary('makeshop')).innerText(),1,6);
 await page.locator(input('smartstore')).fill('9992');assert.match(await page.locator(summary('smartstore')).innerText(),/조회\s*전/);assert.equal(await page.locator(report('smartstore')).isVisible(),false);
 assertResolvedSummary(await page.locator(summary('makeshop')).innerText(),1,6);assert.equal(await page.locator(report('makeshop')).isVisible(),true);assert.equal(await page.evaluate(()=>resolverCalls.length),2);
});

test('source reload and authentication expiry invalidate resolved reports and prior preview permission',async t=>{
 for(const event of ['hub-matrix-source-reloaded','operations-hub-auth-required']){
  const page=await fixture(t);await manual(page,'smartstore','8008');await clickStandard(page,'smartstore');
  await page.evaluate(event=>dispatchEvent(new Event(event)),event);assert.equal(await page.locator(report('smartstore')).isVisible(),false);assert.match(await page.locator(summary('smartstore')).innerText(),/조회\s*전/);
  await clickStandard(page,'smartstore','run');assert.equal(await page.evaluate(()=>downloads.length),0);assert.equal(await page.evaluate(()=>calls.filter(call=>call.name.startsWith('run')).length),0);
  assert.match(await page.locator('[data-standard-result="smartstore"]').innerText(),/미리보기/);
 }
});

test('cancelled generation ignores a late manual resolver rejection after reset, source reload or authentication expiry',async t=>{
 for(const invalidation of ['reset','hub-matrix-source-reloaded','operations-hub-auth-required']){
  const page=await fixture(t);await manual(page,'smartstore','8008');await clickStandard(page,'smartstore');await page.evaluate(()=>window.deferResolve=true);
  await page.locator('[data-standard-run="smartstore"]').click();await page.waitForFunction(()=>pendingResolvers.length===1);
  await page.evaluate(invalidation=>{
   if(invalidation==='reset')document.querySelector('[data-seller-reset="smartstore"]').dispatchEvent(new MouseEvent('click',{bubbles:true}));
   else dispatchEvent(new Event(invalidation));
  },invalidation);
  const snapshot=()=>page.evaluate(()=>({result:document.querySelector('[data-standard-result="smartstore"]').textContent,status:document.querySelector('#export-workflow-status').textContent,panel:document.querySelector('[data-seller-panel="smartstore"]').dataset.state,progress:document.querySelector('[data-standard-progress="smartstore"]').dataset.state,summary:document.querySelector('[data-seller-scope-summary="smartstore"]').textContent}));
  const before=await snapshot();assert.equal(await page.locator(report('smartstore')).isVisible(),false);
  await page.evaluate(()=>pendingResolvers[0].reject(Error('late stale resolver failure')));await page.waitForFunction(()=>!document.querySelector('[data-standard-run="smartstore"]').disabled);
  assert.deepEqual(await snapshot(),before,`${invalidation} retains the current UI instead of publishing the cancelled request failure`);
  assert.equal(await page.evaluate(()=>downloads.length),0);assert.equal(await page.evaluate(()=>calls.filter(call=>call.name.startsWith('run')).length),0);
 }
});

test('Smartstore re-resolves manual prefixes and blocks generation when the expanded SKU scope has changed',async t=>{
 const page=await fixture(t);await manual(page,'smartstore','8008');await clickStandard(page,'smartstore');await page.evaluate(()=>window.expandExtra=true);
 await clickStandard(page,'smartstore','run');assert.equal(await page.evaluate(()=>downloads.length),0);assert.equal(await page.evaluate(()=>calls.filter(call=>call.name.startsWith('run')).length),0);
 assert.match(await page.locator('[data-standard-result="smartstore"]').innerText(),/범위|미리보기/);assertResolvedSummary(await page.locator(summary('smartstore')).innerText(),1,13);
 await clickStandard(page,'smartstore');await clickStandard(page,'smartstore','run');assert.equal(await page.evaluate(()=>downloads.length),1);assert.ok((await page.evaluate(()=>downloads[0].skus)).includes('8008-99'));
});

test('Ably rejects scope drift even when the newly resolved SKU has no carrier row and leaves every output value unchanged',async t=>{
 const page=await fixture(t);await setupAbly(page,'8008');assert.equal(await page.locator('#export-preview-rows tr').count(),12);await page.evaluate(()=>window.expandExtra=true);
 await page.locator('[data-ably-standard-run]').click();await page.waitForFunction(()=>document.querySelector('[data-ably-progress]').dataset.state==='error'||downloads.length>0);
 assert.equal(await page.evaluate(()=>downloads.length),0);assert.equal(await page.evaluate(()=>builds.length),0);assert.equal(await page.evaluate(()=>resolverCalls.length),2);
 assert.match(await page.locator('#export-workflow-status').innerText(),/변경|다시 확인|미리보기/);assertResolvedSummary(await page.locator(summary('ably')).innerText(),1,13);
});
