import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {chromium} from 'playwright';

const workflow=fs.readFileSync(path.resolve('mockups/operations-hub/seller-file-workflow-v2.js'),'utf8');
const renderSource=workflow.slice(workflow.indexOf(' function renderSourcePricePreview('),workflow.indexOf('\n async function previewStandard('));

test('MakeShop source-price preview renders mutually exclusive changed, no-change, and blocked row counts',async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.setContent('<main><div data-standard-result="makeshop"></div></main>');
  const result=await page.evaluate(renderSource=>{
   const n=value=>Number(value||0).toLocaleString('ko-KR'),esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
   window.HubCurrentPriceExport={summarizeSourcePricePreview(plans){const rows=plans.flatMap(plan=>plan.preview||[]),changed=rows.filter(row=>row.status==='ready'&&row.changed).length,noChange=rows.filter(row=>row.status==='ready'&&!row.changed).length,blocked=rows.filter(row=>row.status==='blocked').length;return {total:rows.length,changed,noChange,blocked,unclassified:0,complete:true};}};
   const render=Function('global','document','setSellerPanel','n','esc',`${renderSource};return renderSourcePricePreview;`)(window,document,()=>{},n,esc);
   const price=(final=10000)=>({base:final,discounted:final,option:0,final,discount_terms:[]});
   const row=(status,changed,index,product)=>({status,changed,sku:`SKU-${index}`,product_code:product,option_code:`OPT-${index}`,source_row_no:index+2,reason:status==='blocked'?'synthetic safety block':'',diff:{price:{before:price(),after:price(changed?11000:10000)}}});
   const rows=[...Array.from({length:3},(_,index)=>row('ready',true,index,`CHANGED-${index}`)),...Array.from({length:2},(_,index)=>row('ready',false,index+3,`NO-CHANGE-${index}`)),...Array.from({length:44},(_,index)=>row('blocked',false,index+5,index<36?'2084923':index<42?'2080413':'2085509'))];
   const previewResult={plans:[{preview:rows}],skippedItems:rows.filter(row=>row.status==='blocked').map(row=>({item:{seller_product_code:row.product_code},reason:row.reason})),diagnostics:{unmatched_selected_skus:[]}};
   render('makeshop',previewResult);
   const host=document.querySelector('[data-standard-result="makeshop"]');
   return {text:host.textContent,changed:host.querySelectorAll('.export-row-change').length,noChange:host.querySelectorAll('.export-row-unchanged').length,blocked:host.querySelectorAll('.export-row-blocker').length,statusCells:[...host.querySelectorAll('tbody td:last-child b')].map(node=>node.textContent)};
  },renderSource);
  assert.match(result.text,/전체 대상 49행/);assert.match(result.text,/변경 3행/);assert.match(result.text,/변경 불필요 2행/);assert.match(result.text,/차단 44행/);
  assert.match(result.text,/경고 CSV 44행에는 차단만 포함/);assert.match(result.text,/변경 불필요 = 계산된 값이 현재 원본과 동일/);
  assert.deepEqual({changed:result.changed,noChange:result.noChange,blocked:result.blocked},{changed:3,noChange:2,blocked:44});
  assert.equal(result.statusCells.filter(value=>value==='변경').length,3);assert.equal(result.statusCells.filter(value=>value==='변경없음').length,2);assert.equal(result.statusCells.filter(value=>value==='차단').length,44);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
