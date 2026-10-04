import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {chromium} from 'playwright';
test('partial tag import exposes late blocked row, saves APPLY only, and exports a re-importable rejection workbook',async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>r.abort());
 await page.setContent('<main id="price-rules"></main>');await page.addStyleTag({path:'mockups/operations-hub/rule-workspace.css'});
 await page.addScriptTag({path:process.env.XLSX_BROWSER_SCRIPT});
 await page.evaluate(()=>{
  window.qa={writes:[],materialized:[],saved:new Set(),fail:false};
  window.SystemV3Data={ruleRegistry:async()=>({rules:[],assignments:[],dependencies:[]}),loadTags:async()=>[{tag_id:'no-ball',tag_name:'14K_노볼'}],async bulkImportTags({rows,preview,partial}){
   if(!partial)throw Error('partial contract required');if(!preview&&qa.fail)throw Error('forced APPLY rollback');
   const row_results=rows.map((row,i)=>({...row,row_no:i+1,state:row.sku==='5566-1'?'BLOCK':row.sku==='missing'?'INVALID':qa.saved.has(row.sku)?'NOOP':'APPLY',reason:row.sku==='missing'?'셀피아 원본에 없는 SKU':row.sku==='5566-1'?'ownership 충돌':null,issues:row.sku==='5566-1'?[{existing_tag:'14K_1_2',stage:'inbound_cost',output_field:'actual_inbound_cost',exclusive_group:'common:actual_inbound_cost',reason:'기존 owner 충돌'}]:[]}));
   const applies=row_results.filter(r=>r.state==='APPLY');if(!preview){qa.writes.push(structuredClone(rows));applies.forEach(r=>qa.saved.add(r.sku));}
   return {row_count:rows.length,row_results,apply_count:applies.length,applied_count:preview?0:applies.length,applied_skus:preview?[]:applies.map(r=>r.sku),noop_count:row_results.filter(r=>r.state==='NOOP').length,blocked_count:row_results.filter(r=>r.state==='BLOCK').length,invalid_count:row_results.filter(r=>r.state==='INVALID').length,sku_count:applies.length,inserted_tag_count:applies.length};
  }};window.HubPriceMaterializer={materialize:async p=>{qa.materialized.push(p.skus);return {totalSkus:p.skus.length,persistedRows:p.skus.length,errorRows:0,status:'complete'};}};
 });
 for(const file of ['rule-registry.js','rule-workspace.js'])await page.addScriptTag({path:'mockups/operations-hub/'+file});
 const idle=()=>page.waitForFunction(()=>!HubPriceWorkspace.state.busy);
 await page.evaluate(()=>HubPriceWorkspace.refresh());await idle();await page.evaluate(()=>HubPriceWorkspace.openTagImport());await idle();
 const csv='셀피아 SKU,메모\n'+Array.from({length:1354},(_,i)=>`${9832+i}-4,=memo`).join('\n')+'\n5566-1,메모\n';
 await page.locator('#rw-tag-import-file').setInputFiles({name:'14K_노볼_일괄적용.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});await page.waitForFunction(()=>HubPriceWorkspace.state.tagImport?.server?.row_count>0);await idle();
 assert.equal(await page.evaluate(()=>HubPriceWorkspace.state.tagImport.server.row_count),1355,await page.locator('#rw-drawer-status').innerText());
 assert.match(await page.locator('#rw-tag-import-summary').innerText(),/전체 1,355.*적용 가능 1,354.*차단 1/);
 assert.equal(await page.locator('#rw-tag-import-rows [data-import-state="APPLY"]').count(),200);
 assert.doesNotMatch(await page.locator('#rw-tag-import-rows').innerText(),/파일의 오류 행/);
 await page.locator('#rw-tag-import-filter').click();assert.equal(await page.locator('#rw-tag-import-rows tr').count(),1);assert.match(await page.locator('#rw-tag-import-rows').innerText(),/1356.*5566-1.*14K_노볼.*BLOCK.*14K_1_2.*actual_inbound_cost/s);
 await page.locator('#rw-tag-import-apply').click();await idle();assert.match(await page.locator('#rw-tag-import-summary').innerText(),/전체 1,355.*적용 1,354.*차단 1/);
 assert.deepEqual(await page.evaluate(()=>({calls:qa.writes.length,count:qa.writes[0].length,blocked:qa.writes[0].some(r=>r.sku==='5566-1')})),{calls:1,count:1354,blocked:false});
 const download=await Promise.all([page.waitForEvent('download'),page.locator('#rw-tag-import-download').click()]);
 const downloadPath=await download[0].path();const X=await import('node:vm');const ctx={};X.default.createContext(ctx);X.default.runInContext(fs.readFileSync(process.env.XLSX_BROWSER_SCRIPT,'utf8'),ctx);
 const book=ctx.XLSX.read(new Uint8Array(fs.readFileSync(downloadPath)),{type:'array'});
 const retry=ctx.XLSX.utils.sheet_to_json(book.Sheets['재등록'],{header:1,defval:''});assert.equal(retry[1][0],'5566-1');assert.equal(retry[1][1],'14K_노볼');
 const details=ctx.XLSX.utils.sheet_to_json(book.Sheets['차단 상세'],{header:1,defval:''});assert.equal(details[1][0],1356);assert.equal(details[1][3],'14K_1_2');assert.equal(details[1][5],'actual_inbound_cost');assert.equal(details[1][7],'BLOCK');
 if(process.env.TAG_PARTIAL_OUTPUT){fs.mkdirSync(process.env.TAG_PARTIAL_OUTPUT,{recursive:true});fs.copyFileSync(downloadPath,path.join(process.env.TAG_PARTIAL_OUTPUT,'bounded-blocked.xlsx'));}
 // New import is NOOP for saved rows; invalid rows have their own status.
 await page.locator('#rw-close').click();await page.evaluate(()=>HubPriceWorkspace.openTagImport());await idle();
 await page.locator('#rw-tag-import-file').setInputFiles({name:'14K_노볼_일괄적용.csv',mimeType:'text/csv',buffer:Buffer.from('셀피아 SKU\n9832-4\nmissing\n5566-1\n')});await page.waitForFunction(()=>HubPriceWorkspace.state.tagImport?.server?.row_count===3);await idle();assert.match(await page.locator('#rw-tag-import-summary').innerText(),/변경 없음 1.*차단 1.*오류 1/);assert.equal(await page.locator('#rw-tag-import-apply').isDisabled(),true);
 // Parser failure hard-blocks the file, without any additional write.
 await page.evaluate(()=>{XLSX.read=()=>{throw Error('XLSX parser failure');};});
 await page.locator('#rw-tag-import-file').setInputFiles({name:'broken.xlsx',mimeType:'application/octet-stream',buffer:Buffer.from('broken')});await idle();await page.waitForFunction(()=>HubPriceWorkspace.state.tagImport?.files?.[0]?.status==='error');assert.equal(await page.locator('#rw-tag-import-apply').isDisabled(),true);assert.match(await page.locator('#rw-tag-import-files').innerText(),/XLSX parser failure/);assert.equal(await page.evaluate(()=>qa.writes.length),1);
 assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
