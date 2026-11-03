import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {chromium} from 'playwright';

async function fixture(t) {
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:process.platform==='win32'?{channel:'msedge'}:{})});
  const page=await browser.newPage(),errors=[];
  page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  t.after(async()=>{await browser.close();assert.deepEqual(errors,[]);});
  await page.route('**/*',route=>route.abort());
  await page.setContent('<main id="price-rules"></main>');
  await page.addStyleTag({path:'mockups/operations-hub/rule-workspace.css'});
  await page.addScriptTag({path:path.resolve('tests/vendor/xlsx-0.18.5.full.min.js')});
  await page.evaluate(()=>{
    const tags=[{tag_id:'tag-111',tag_name:'써지컬 대량 변경'},{tag_id:'tag-222',tag_name:'메타데이터 태그'},{tag_id:'tag-slash',tag_name:'14K_1/2'},{tag_id:'tag-dash',tag_name:'14K-1-2'}];
    window.filenameSuffixQA={tags,previews:[],writes:[]};
    window.SystemV3Data={ruleRegistry:async()=>({rules:[],assignments:[],dependencies:[]}),loadTags:async()=>structuredClone(tags),bulkImportTags:async({rows,tagId,preview,partial})=>{
      if(!partial)throw Error('Expected partial import contract');
      const resolved=rows.map(row=>({row,tag:tags.find(tag=>tagId?tag.tag_id===tagId:tag.tag_name===row.tag_name)}));
      if(resolved.some(item=>!item.tag))throw Error('Unresolved tag must not reach save');
      const call={tagId,rows:structuredClone(rows),resolvedTagIds:resolved.map(item=>item.tag.tag_id)};
      filenameSuffixQA[preview?'previews':'writes'].push(call);
      return {row_count:rows.length,row_results:rows.map((row,index)=>({...row,row_no:index+1,state:'APPLY',reason:null,issues:[]})),apply_count:rows.length,applied_count:preview?0:rows.length,applied_skus:preview?[]:rows.map(row=>row.sku),sku_count:rows.length,inserted_tag_count:preview?0:rows.length,noop_count:0,blocked_count:0,invalid_count:0};
    }};
  });
  for(const file of ['rule-registry.js','rule-workspace.js'])await page.addScriptTag({path:'mockups/operations-hub/'+file});
  await page.evaluate(()=>HubPriceWorkspace.refresh());await idle(page);await open(page);
  return page;
}

const idle=page=>page.waitForFunction(()=>!HubPriceWorkspace.state.busy);
async function open(page){await page.evaluate(()=>HubPriceWorkspace.openTagImport());await idle(page);}
async function upload(page,name,{metadata=null}={}) {
  const buffer=/\.csv$/i.test(name)?Buffer.from('\ufeff셀피아 SKU,메모\n10322-5,가격 메모\n10322-6,그대로 유지\n'):Buffer.from(await page.evaluate(metadata=>{
    const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['셀피아 SKU','메모'],['10322-5','가격 메모'],['10322-6','그대로 유지']]),'SKU');
    if(metadata)HubPriceWorkspace.addTagWorkbookMetadata(book,metadata);
    return Array.from(new Uint8Array(XLSX.write(book,{bookType:'xlsx',type:'array'})));
  },metadata));
  await page.locator('#rw-tag-import-file').setInputFiles({name,mimeType:/\.csv$/i.test(name)?'text/csv':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer});
  await page.waitForFunction(()=>HubPriceWorkspace.state.tagImport!==null);await idle(page);
}

test('numbered split CSV and real XLSX filenames automatically resolve the intended tag and explicit APPLY saves only that tag',async t=>{
  const page=await fixture(t);
  for(const name of ['써지컬 대량 변경_일괄적용 2.csv','써지컬 대량 변경_일괄적용 2.xlsx']){
    if(await page.evaluate(()=>HubPriceWorkspace.state.tagImport!==null))await open(page);
    await upload(page,name);
    assert.deepEqual(await page.evaluate(()=>{const file=HubPriceWorkspace.state.tagImport.files[0];return {status:file.status,mode:file.parsed.mode,source:file.resolution.source,id:file.resolution.tag.tag_id,rows:file.rows.map(row=>row.sku)};}),{status:'ready',mode:'filename_tag',source:'filename_exact',id:'tag-111',rows:['10322-5','10322-6']});
    assert.equal(await page.locator('#rw-tag-import-apply').isEnabled(),true);assert.match(await page.locator('#rw-tag-import-mode').innerText(),/파일명 태그 자동 인식.*써지컬 대량 변경/);
    const before=await page.evaluate(()=>filenameSuffixQA.writes.length);await page.locator('#rw-tag-import-apply').click();await idle(page);
    assert.equal(await page.evaluate(()=>filenameSuffixQA.writes.length),before+1);
    assert.deepEqual(await page.evaluate(()=>filenameSuffixQA.writes.at(-1).resolvedTagIds),['tag-111','tag-111']);
    assert.match(await page.locator('#rw-drawer-status').innerText(),/태그 DB 저장 완료/);assert.equal(await page.locator('#rw-tag-import-apply').isDisabled(),true);
  }
});

test('stable template metadata takes priority over a conflicting numbered filename',async t=>{
  const page=await fixture(t);
  await upload(page,'써지컬 대량 변경_일괄적용 (2).xlsx',{metadata:{tag_id:'tag-222',tag_name:'예전 이름'}});
  assert.deepEqual(await page.evaluate(()=>{const file=HubPriceWorkspace.state.tagImport.files[0];return {status:file.status,source:file.resolution.source,id:file.resolution.tag.tag_id};}),{status:'ready',source:'metadata_id',id:'tag-222'});
  await page.locator('#rw-tag-import-apply').click();await idle(page);
  assert.deepEqual(await page.evaluate(()=>filenameSuffixQA.writes[0].resolvedTagIds),['tag-222','tag-222']);
  assert.deepEqual(await page.evaluate(()=>filenameSuffixQA.writes[0].rows.map(row=>row.tag_name)),['메타데이터 태그','메타데이터 태그']);
});

test('ambiguous normalized numbered filenames stay blocked until an explicit file tag is selected',async t=>{
  const page=await fixture(t);await upload(page,'14K_1_2_일괄적용_2.csv');
  assert.deepEqual(await page.evaluate(()=>{const file=HubPriceWorkspace.state.tagImport.files[0];return {status:file.status,resolution:file.resolution.status,writes:filenameSuffixQA.writes.length};}),{status:'needs_choice',resolution:'ambiguous',writes:0});
  assert.equal(await page.locator('#rw-tag-import-apply').isDisabled(),true);
  await page.locator('[data-import-file-tag="0"]').selectOption('tag-slash');await idle(page);
  assert.equal(await page.locator('#rw-tag-import-apply').isEnabled(),true);
  await page.locator('#rw-tag-import-apply').click();await idle(page);
  assert.deepEqual(await page.evaluate(()=>filenameSuffixQA.writes[0].resolvedTagIds),['tag-slash','tag-slash']);
});
