import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {createRequire} from 'node:module';

const require=createRequire(process.env.CODEX_NODE_MODULES?`${process.env.CODEX_NODE_MODULES}/product-price-adjustment-ui.cjs`:import.meta.url);
const {chromium}=require('playwright');
const source=name=>fs.readFileSync(new URL(`../mockups/operations-hub/${name}`,import.meta.url),'utf8');
let browser;
test.before(async()=>{browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:process.platform==='win32'?{channel:'msedge'}:{})});});
test.after(async()=>{await browser?.close();});
const choose=(page,selector,value)=>page.locator(selector).locator('..').locator(`.seller-choice-options input[value="${value}"]`).check();
const dialog='.product-price-adjustment-dialog';
const primary=kind=>`[data-standard-${kind}="smartstore"]`;
const adjustment={source:'smartstore',productCode:'COLLECTION',basePrice:9000,basicDiscount:2000};

async function fixture(t){
 const page=await browser.newPage({viewport:{width:1700,height:1000}}),errors=[];page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
 t.after(async()=>{assert.deepEqual(errors,[]);await page.close();});
 await page.setContent('<!doctype html><style>body{margin:0;font:14px system-ui}.btn{padding:8px}</style><main><section id="jobs" class="page"><div class="page-head"><h2>판매처 내보내기</h2></div></section></main>');
 await page.addStyleTag({content:source('seller-file-workflow-v2.css')});
 for(const name of ['discount-price-math.js','product-price-adjustment.js'])await page.addScriptTag({content:source(name)});
 await page.evaluate(()=>{
  window.calls=[];window.downloads=[];window.pending=[];window.upstreamVersion='upstream-v1';
  const summary={selectedSkuCount:218,matchedOptionCount:218,changedOptionCount:218,unchangedOptionCount:0,unmatchedSkuCount:0,blockedCount:0,preservedCount:0,outputRowCount:218};
  const makeGroup=(productCode,count,locked=false)=>{
   const helperRows=Array.from({length:count},(_,index)=>({row:{source_channel:'smartstore',product_code:productCode,option_code:`O${index}`,base_price:5000,discounted_base_price:5000,option_price:0,final_price:5000,discount_terms:[],source_row_no:index+2,raw_payload:{source_file_name:'original.xlsx',smartstore_basic_discount_value:'',smartstore_basic_discount_unit:'',smartstore_mobile_discount_value:'',smartstore_mobile_discount_unit:'',smartstore_reservation_discount_value:'',smartstore_reservation_discount_unit:'',smartstore_multi_buy_discount_value:'',smartstore_multi_buy_discount_unit:''}},final:productCode==='NORMAL'?5000:[3000,3100,10500,7000][index%4],proof:{source:'snapshot',version:1}}));
   const inspected=HubProductPriceAdjustment.inspect({source:'smartstore',productCode,rows:helperRows});
   return {...inspected,source:'smartstore',productCode,productName:productCode==='COLLECTION'?'베이직 피어싱 모음전':productCode==='NORMAL'?'정상 상품':'확정 가격 상품',fileNames:['original.xlsx'],helperRows,rows:helperRows.map((entry,index)=>({sku:productCode==='COLLECTION'?`10322-${index+5}`:`${productCode}-${index}`,optionCode:entry.row.option_code,optionName:`옵션 ${index+1}`,targetFinal:entry.final,parentSku:productCode==='COLLECTION'?'2242-1':null,rootSku:productCode==='COLLECTION'?'2242-1':null,selected:true,preserved:false,sourceRowNo:entry.row.source_row_no})),editable:!locked,blockedReason:locked?'확정 가격 결정이 있는 상품은 기존 가격 결정 화면에서 변경해주세요.':null,needsAdjustment:productCode!=='NORMAL',appliedDraft:null};
  };
  window.makeResult=args=>{
   const groups=[makeGroup('COLLECTION',218),makeGroup('NORMAL',1),makeGroup('LOCKED',1,true)];
   for(const draft of args.productPriceAdjustments||[]){const group=groups.find(group=>group.productCode===draft.productCode);if(!group||!group.editable)throw Error('조정 대상 상품을 확인해주세요.');const result=HubProductPriceAdjustment.validate({source:'smartstore',productCode:group.productCode,rows:group.helperRows},draft);if(!result.valid)throw Error(result.errors.join(' · '));group.appliedDraft=window.omitApplied?null:result.draft;group.needsAdjustment=false;}
   return {planFingerprint:`fingerprint:${JSON.stringify(args.productPriceAdjustments||[])}`,scopeSummary:summary,diagnostics:{sku_count:218,query_count:2},includeStock:args.includeStock,stockSource:args.stockSource,plans:[],priceAdjustmentContext:{source:'smartstore',versionKey:upstreamVersion,groups}};
  };
  const preview=name=>async args=>{calls.push({name,args});if(window.deferPreview)await new Promise(resolve=>pending.push(resolve));if(window.failPreview)throw Error('최신 가격 검증 실패');return makeResult(args);};
  const run=name=>async args=>{calls.push({name,args});if(window.finalDrift)throw Error('최종 검증에서 가격 근거가 변경되었습니다.');if(args.expectedPlanFingerprint!==`fingerprint:${JSON.stringify(args.productPriceAdjustments||[])}`)throw Error('미리보기 수정안과 다릅니다.');downloads.push(structuredClone(args.productPriceAdjustments||[]));return {scopeSummary:summary,title:'synthetic XLSX'};};
  window.SystemV3SellerExportBridge={previewTargetAll:preview('target'),previewChangedOnly:preview('changed'),previewFullOriginal:preview('full'),previewPriceOnly:preview('price'),previewStockOnly:preview('stock'),runTargetAll:run('target-run'),runChangedOnly:run('changed-run'),runFullOriginal:run('full-run'),runPriceOnly:run('price-run'),runStockOnly:run('stock-run')};
  window.SystemV3Data={loadAuxiliarySellerFiles:async()=>({rows:[]}),loadLatestSellerOriginalStatus:async()=>[],loadTagCatalog:async()=>({rows:[]})};
 });
 await page.addScriptTag({content:source('seller-file-workflow-v2.js')});await page.waitForSelector('#export-workflow-v2');return page;
}
async function preview(page,kind='preview'){
 if(kind==='full-preview')await page.locator('[data-standard-source="smartstore"] .seller-advanced').evaluate(node=>node.open=true);
 await page.locator(primary(kind)).click();await page.waitForFunction(()=>!document.querySelector('[data-standard-preview="smartstore"]').disabled);
 await page.locator('[data-product-price-adjustment-open="smartstore"]').waitFor();
}
async function open(page){await page.locator('[data-product-price-adjustment-open="smartstore"]').click();await page.locator(dialog).waitFor();}
async function fill(page,base=9000,discount=2000){await page.locator('[data-adjustment-base]').fill(String(base));await page.locator('[data-adjustment-discount]').fill(String(discount));}
async function apply(page){await page.locator('[data-adjustment-apply]').click();await page.locator(dialog).waitFor({state:'detached'});}

test('product price dialog shows all 218 fixed targets and computes negative options without publishing typed values',async t=>{
 const page=await fixture(t);await preview(page);await open(page);await fill(page);
 assert.equal(await page.locator('[data-adjustment-options] tr').count(),218);
 assert.equal(await page.locator('[data-adjustment-discounted]').inputValue(),'7,000');assert.equal(await page.locator('[data-adjustment-discounted]').getAttribute('readonly'),'');
 assert.deepEqual(await page.locator('[data-adjustment-options] tr').evaluateAll(rows=>rows.slice(0,3).map(row=>row.cells[2].textContent)),['-4,000원','-3,900원','3,500원']);
 assert.equal(await page.locator('[data-adjustment-options] input').count(),0);assert.match(await page.locator('[data-adjustment-validation]').innerText(),/검증 통과.*아직 미반영/);
 assert.match(await page.locator('[data-adjustment-options] tr').first().innerText(),/2242-1 최종가 그대로/);
 assert.equal(await page.locator(primary('run')).isDisabled(),true);assert.equal(await page.locator(primary('full-run')).isDisabled(),true);
 await page.evaluate(()=>document.querySelector('[data-standard-run="smartstore"]').dispatchEvent(new MouseEvent('click',{bubbles:true})));assert.equal(await page.evaluate(()=>calls.length),1,'forced generation remains blocked while the dialog is open');
 const last=page.locator('[data-adjustment-options] tr').last();await last.scrollIntoViewIfNeeded();assert.equal(await last.isVisible(),true);assert.equal(await page.evaluate(()=>calls.length),1,'typing never submits prices');
 await page.locator('[data-adjustment-cancel]').last().click();await page.locator(primary('run')).click();await page.waitForFunction(()=>downloads.length===1);
 assert.deepEqual(await page.evaluate(()=>downloads),[[]],'cancelled input is absent from the export request');
});

test('applied drafts are committed only by a successful fresh preview and the identical draft and fingerprint reach generation',async t=>{
 const page=await fixture(t);await preview(page);await open(page);await fill(page);await apply(page);
 assert.deepEqual(await page.evaluate(()=>calls[1].args.productPriceAdjustments),[adjustment]);assert.match(await page.locator('[data-product-price-adjustment-entry]').innerText(),/수정안 1상품/);
 await open(page);assert.match(await page.locator('[data-adjustment-product="COLLECTION"]').innerText(),/수정안 적용됨/);await fill(page,10000,3000);assert.match(await page.locator('[data-adjustment-product="COLLECTION"]').innerText(),/수정안 작성/);await page.locator('[data-adjustment-cancel]').last().click();
 await page.locator(primary('run')).click();await page.waitForFunction(()=>downloads.length===1);
 assert.deepEqual(await page.evaluate(()=>calls.at(-1).args.productPriceAdjustments),[adjustment]);
 assert.equal(await page.evaluate(()=>calls.at(-1).args.expectedPlanFingerprint),`fingerprint:${JSON.stringify([adjustment])}`);
});

test('failed revalidation or a response that does not apply the draft preserves the previously applied draft',async t=>{
 for(const failure of ['failPreview','omitApplied']){
  const page=await fixture(t);await preview(page);await open(page);await fill(page);await apply(page);await open(page);await fill(page,10000,3000);await page.evaluate(flag=>window[flag]=true,failure);
  await page.locator('[data-adjustment-apply]').click();await page.waitForFunction(()=>document.querySelector('[data-adjustment-validation]').textContent.startsWith('적용할 수 없습니다:'));
  assert.equal(await page.locator(dialog).count(),1);assert.equal(await page.locator(primary('run')).isDisabled(),true);
  await page.locator('[data-adjustment-cancel]').last().click();await page.locator(primary('run')).click();await page.waitForFunction(()=>downloads.length===1);
  assert.deepEqual(await page.evaluate(()=>downloads[0]),[adjustment]);
 }
});

test('cancel during a pending apply invalidates its late result and restores generation with the previous preview',async t=>{
 const page=await fixture(t);await preview(page);await open(page);await fill(page);await page.evaluate(()=>window.deferPreview=true);
 await page.locator('[data-adjustment-apply]').click();await page.waitForFunction(()=>pending.length===1);await page.locator('[data-adjustment-cancel]').last().click();
 assert.equal(await page.evaluate(()=>calls[1].args.isCurrent()),false);await page.locator(primary('run')).click();await page.waitForFunction(()=>downloads.length===1);assert.deepEqual(await page.evaluate(()=>downloads[0]),[]);
 await page.evaluate(()=>pending.shift()());await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,30)));assert.equal(await page.locator(dialog).count(),0);assert.equal(await page.evaluate(()=>downloads.length),1);
});

test('filters and search preserve selection, locked current decisions stay read-only, and text is escaped',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{const original=makeResult;window.makeResult=args=>{const result=original(args);result.priceAdjustmentContext.groups[0].productName='<img src=x onerror="window.injected=1">';return result;};});await preview(page);await open(page);
 assert.equal(await page.locator('[data-adjustment-product]').count(),3);assert.equal(await page.locator(`${dialog} img`).count(),0);assert.equal(await page.evaluate(()=>window.injected),undefined);
 await page.locator('[data-adjustment-filter="normal"]').click();assert.equal(await page.locator('[data-adjustment-product]').count(),1);await page.locator('[data-adjustment-product="NORMAL"]').click();assert.equal(await page.locator('[data-adjustment-options] tr').count(),1);
 await page.locator('[data-adjustment-filter="all"]').click();await page.locator('[data-adjustment-search]').fill('LOCKED');await page.locator('[data-adjustment-product="LOCKED"]').click();
 assert.equal(await page.locator('[data-adjustment-base]').isDisabled(),true);assert.equal(await page.locator('[data-adjustment-discount]').isDisabled(),true);assert.equal(await page.locator('[data-adjustment-recommend]').isDisabled(),true);assert.match(await page.locator('.product-price-adjustment-locked').innerText(),/확정 가격 결정/);assert.equal(await page.locator('[data-adjustment-apply]').isDisabled(),true);
 await page.locator('[data-adjustment-search]').fill('10322-5');await page.locator('[data-adjustment-product="COLLECTION"]').click();await page.locator('[data-adjustment-base]').fill('');assert.equal(await page.locator('[data-adjustment-apply]').isDisabled(),true);
 await page.locator('[data-adjustment-recommend]').click();assert.equal(await page.locator('[data-adjustment-apply]').isDisabled(),false);assert.match(await page.locator('[data-adjustment-validation]').innerText(),/아직 미반영/);assert.equal(await page.evaluate(()=>calls.length),1,'recommendation only fills the local editing draft');
});

test('validation exposes recalculated options but rejects a missing zero-price option until recommendation is chosen',async t=>{
 const page=await fixture(t);await preview(page);await open(page);await fill(page,9000,2100);
 assert.equal(await page.locator('[data-adjustment-discounted]').inputValue(),'6,900');
 assert.equal(await page.locator('[data-adjustment-options] tr').first().locator('td').nth(2).innerText(),'-3,900원');
 assert.match(await page.locator('[data-adjustment-validation]').innerText(),/0원인 옵션/);assert.equal(await page.locator('[data-adjustment-apply]').isDisabled(),true);
 await page.locator('[data-adjustment-recommend]').click();assert.equal(await page.locator('[data-adjustment-apply]').isDisabled(),false);
 assert.ok((await page.locator('[data-adjustment-options] tr td:nth-child(3)').allTextContents()).some(value=>value==='0원'));assert.equal(await page.evaluate(()=>calls.length),1);
});

test('scope, mode, source reload and authentication changes discard applied drafts and require a fresh preview',async t=>{
 for(const change of ['scope','mode','source','auth']){
  const page=await fixture(t);await preview(page);await open(page);await fill(page);await apply(page);
  if(change==='scope'){await choose(page,'[data-seller-scope-mode="smartstore"]','manual');await page.locator('[data-seller-scope-manual="smartstore"]').fill('10322-5');}
  if(change==='mode')await choose(page,'[data-standard-price-mode="smartstore"]','sellpia_source');
  if(change==='source')await page.evaluate(()=>dispatchEvent(new Event('hub-matrix-source-reloaded')));
  if(change==='auth')await page.evaluate(()=>dispatchEvent(new Event('operations-hub-auth-required')));
  await page.locator(primary('run')).click();await page.waitForFunction(()=>!document.querySelector('[data-standard-run="smartstore"]').disabled);assert.equal(await page.evaluate(()=>downloads.length),0);
  await preview(page);assert.deepEqual(await page.evaluate(()=>calls.at(-1).args.productPriceAdjustments),[]);
 }
});

test('new upstream evidence during apply invalidates the old drafts instead of publishing a stale adjustment',async t=>{
 const page=await fixture(t);await preview(page);await open(page);await fill(page);await apply(page);await open(page);await fill(page,10000,3000);await page.evaluate(()=>window.upstreamVersion='upstream-v2');
 await page.locator('[data-adjustment-apply]').click();await page.locator(dialog).waitFor({state:'detached'});assert.match(await page.locator('[data-standard-result="smartstore"]').innerText(),/수정안을 해제/);
 await preview(page);assert.deepEqual(await page.evaluate(()=>calls.at(-1).args.productPriceAdjustments),[]);
});

test('both price modes and price-only, changed-only and full-original flows transmit the same applied draft',async t=>{
 for(const variant of ['source','price-only','changed','full']){
  const page=await fixture(t);
  if(variant==='source')await choose(page,'[data-standard-price-mode="smartstore"]','sellpia_source');
  if(variant==='price-only')await choose(page,'[data-standard-field-mode="smartstore"]','price_only');
  if(variant==='changed')await choose(page,'[data-standard-output-mode="smartstore"]','changed_only');
  await preview(page,variant==='full'?'full-preview':'preview');await open(page);await fill(page);await apply(page);
  await page.locator(primary(variant==='full'?'full-run':'run')).click();await page.waitForFunction(()=>downloads.length===1);
  assert.deepEqual(await page.evaluate(()=>downloads[0]),[adjustment]);assert.equal(await page.evaluate(()=>calls.at(-1).name),variant==='price-only'?'price-run':variant==='changed'?'changed-run':variant==='full'?'full-run':'target-run');
 }
});

test('the desktop and narrow dialog keep its actions and every option reachable without page overflow',async t=>{
 const page=await fixture(t);await preview(page);await open(page);await fill(page);
 for(const viewport of [{width:1700,height:1000},{width:390,height:844}]){
  await page.setViewportSize(viewport);const bounds=await page.locator('[data-adjustment-apply]').boundingBox();assert.ok(bounds&&bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=viewport.width&&bounds.y+bounds.height<=viewport.height);
  const last=page.locator('[data-adjustment-options] tr').last();await last.scrollIntoViewIfNeeded();assert.equal(await last.isVisible(),true);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
 }
 await page.setViewportSize({width:1700,height:1000});await page.locator('[data-adjustment-options] tr').first().scrollIntoViewIfNeeded();
 fs.mkdirSync(new URL('../outputs/ui-qa/',import.meta.url),{recursive:true});await page.screenshot({path:new URL('../outputs/ui-qa/product-price-adjustment-ready.png',import.meta.url).pathname.replace(/^\/([A-Za-z]:\/)/,'$1')});
});
