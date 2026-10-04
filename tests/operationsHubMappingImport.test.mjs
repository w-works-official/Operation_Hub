import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {pathToFileURL} from 'node:url';
const source=fs.readFileSync(new URL('../mockups/operations-hub/mapping-import.js',import.meta.url),'utf8');
const c={};vm.createContext(c);vm.runInContext(source,c);
const {parse,headers,templateHeaders,sellerTemplateHeaders,buildThumbnailTemplate,buildSellerUnmatchedTemplate}=c.SystemV3MappingImport;
let result=parse([headers,['sku1','001','0002','','','',''],['sku2','','','3','','4','5']]);
assert.equal(result.entries.length,3);
assert.equal(result.entries[0].productCode,'001');
assert.equal(result.entries[0].optionCode,'0002');
assert.equal(result.entries[1].optionCode,'','empty option is exact no-option, not a guessed option');
assert.equal(parse([headers,['sku','','','','','','']]).entries.length,0);
assert.equal(parse([headers,['sku','','opt','','','','']]).errors.length,1);
result=parse([headers,['sku','p','o','','','',''],['sku','p','o','','','','']]);
assert.equal(result.entries.length,1,'same duplicate collapses');
result=parse([headers,['sku','p','o','','','',''],['sku','p','other','','','','']]);
assert.equal(result.entries.length,0,'conflicting duplicate must not pick a winner');
assert.equal(result.errors.length,2);
assert.equal(parse([headers,['sku',9007199254740992,'','','','','']]).errors.length,1);
assert.equal(parse([headers,['sku','1.2e+9','','','','','']]).errors.length,1);
assert.throws(()=>parse([['wrong']]),/필수 헤더/);
// Thumbnail column is presentation-only: B onward stays an ordinary mapping upload.
assert.equal(parse([templateHeaders,['=IMAGE(...)','sku-thumb','001','0002','','','','']]).entries[0].sku,'sku-thumb');
// Seller-side unmatched templates prefill a seller code and become a normal
// mapping upload once the user writes the target Sellpia SKU in column B.
assert.equal(parse([sellerTemplateHeaders,['셀피아 미연결','sku-seller','001','0002','','','','','스마트스토어','상품명','옵션명']]).entries[0].sku,'sku-seller');
class MockCell { constructor(col){this.col=col;this.value='';} }
class MockRow {
  constructor(number){this.number=number;this.cells=Array.from({length:11},(_,index)=>new MockCell(index+1));}
  getCell(index){return this.cells[index-1];}
  eachCell({includeEmpty},callback){if(includeEmpty)this.cells.forEach(callback);}
}
class MockSheet {
  constructor(){this.rows=[];this.images=[];}
  getRow(index){while(this.rows.length<index)this.rows.push(new MockRow(this.rows.length+1));return this.rows[index-1];}
  addRow(values){const row=this.getRow(this.rows.length+1);this.columns.forEach((column,index)=>{row.getCell(index+1).value=values[column.key]||'';});return row;}
  addImage(id,range){this.images.push({id,range});}
}
let mockBook;
c.ExcelJS={Workbook:class {
  constructor(){mockBook=this;this.images=[];this.xlsx={writeBuffer:async()=>this};}
  addWorksheet(){this.sheet=new MockSheet();return this.sheet;}
  addImage(image){this.images.push(image);return this.images.length;}
}};
c.fetch=async()=>({ok:true,arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer});
c.Blob=class { constructor(parts,options){this.parts=parts;this.options=options;} };
c.createImageBitmap=async()=>({width:300,height:100,close(){}});
const thumbnailBook=await buildThumbnailTemplate([
  {sellpia_sku_code:'sku-thumb',image_url:'https://images.example/item.jpg'},
  {sellpia_sku_code:'sku-empty'}
]);
assert.equal(thumbnailBook,mockBook);
assert.equal(mockBook.sheet.columns[0].header,'썸네일');
assert.equal(mockBook.sheet.getRow(2).getCell(2).value,'sku-thumb');
assert.equal(mockBook.images[0].extension,'jpeg');
assert.equal(mockBook.sheet.images.length,1);
assert.equal(mockBook.sheet.images[0].range.ext.width,96);
assert.equal(mockBook.sheet.images[0].range.ext.height,32);
assert.equal(mockBook.sheet.getRow(2).height,76);
assert.equal(mockBook.sheet.getRow(3).getCell(1).value,'이미지 없음');
assert.equal(mockBook.sheet.autoFilter.to,'H3');
const sellerBook=await buildSellerUnmatchedTemplate([{source_channel:'smartstore',product_code:'001',option_code:'0002',product_name:'판매처 상품',option_name:'판매처 옵션'}]);
assert.equal(sellerBook,mockBook);
assert.equal(mockBook.sheet.columns[8].header,'판매처');
assert.equal(mockBook.sheet.getRow(2).getCell(2).value,'');
assert.equal(mockBook.sheet.getRow(2).getCell(3).value,'001');
assert.equal(mockBook.sheet.getRow(2).getCell(4).value,'0002');
assert.equal(mockBook.sheet.getRow(2).getCell(9).value,'스마트스토어');
assert.equal(mockBook.sheet.autoFilter.to,'K2');
const {chromium}=await import(pathToFileURL('C:/Users/hihi0/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
// Exercise the actual preview adapter with bounded fixture queries.
const dataSource=fs.readFileSync(new URL('../mockups/operations-hub/data-service.js',import.meta.url),'utf8');
const start=dataSource.indexOf('  async function previewMappingImport(');
const end=dataSource.indexOf('  async function saveSellerListing(',start);
const dc={MATRIX_VIEW:'matrix',cleanText:v=>String(v??'').trim(),db:{from(table){
  let source='';
  return {select(){return this;},eq(k,v){source=v;return this;},order(){return this;},range(){return this;},
    in(){return this;},then(resolve,reject){
      const data=table==='matrix'?[{sellpia_sku_code:'known',smartstore_product_code:'old',smartstore_option_code:'oldopt'}]:
        source==='smartstore'?[{product_code:'new',option_code:'newopt',product_name:'상품',option_name:'옵션'}]:[];
      return Promise.resolve({data,error:null}).then(resolve,reject);
    }};
}}};
vm.createContext(dc);vm.runInContext(dataSource.slice(start,end)+'\nthis.preview=previewMappingImport;',dc);
const preview=await dc.preview([{sku:'known',source:'smartstore',productCode:'new',optionCode:'newopt'},{sku:'known',source:'smartstore',productCode:'new',optionCode:''},{sku:'missing',source:'smartstore',productCode:'new',optionCode:'newopt'}]);
assert.deepEqual(Array.from(preview,r=>r.status),['replace','error','error']);
assert.equal(preview[0].before.productCode,'old');
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
  const page=await browser.newPage({viewport:{width:1200,height:900}});
  const html=fs.readFileSync(new URL('../mockups/operations-hub/index.html',import.meta.url),'utf8');
  const modal=html.slice(html.indexOf('    <div id="mapping-import-modal"'),html.indexOf('    <script src="https://cdn.jsdelivr.net/npm/xlsx'));
  const css=['style.css','ui-scale-base.css','ui-scale-workspaces.css'].map(f=>fs.readFileSync(new URL('../mockups/operations-hub/'+f,import.meta.url),'utf8')).join('\n');
  await page.setContent('<html><head><style>'+css+'</style></head><body><button id="mapping-import-open">매칭값 일괄 업로드</button><button id="matrix-refresh-btn">새로고침</button>'+modal+'</body></html>');
  await page.evaluate(()=>{
    window.fixtureSaved=[];
    window.XLSX={read:input=>({SheetNames:['first'],Sheets:{first:input}}),utils:{sheet_to_json:sheet=>sheet.split(/\r?\n/).map(line=>line.split(','))}};
    window.SystemV3Data={
      previewMappingImport:async rows=>rows.map(row=>({...row,before:{productCode:row.sku==='replace'?'old':'',optionCode:''},status:row.sku==='bad'?'error':row.sku==='replace'?'replace':'ready',reason:row.sku==='bad'?'원본 옵션코드 없음':'',productName:'테스트 상품'})),
      linkSellerItem:async row=>{window.fixtureSaved.push(row);await new Promise(resolve=>setTimeout(resolve,100));return {product_code:row.productCode,option_code:row.optionCode};}
    };
  });
  await page.addScriptTag({content:source});
  await page.getByRole('button',{name:'매칭값 일괄 업로드',exact:true}).click();
  const csv=[Array.from(headers).join(','),'good,p,o,,,,','replace,p2,o2,,,,','bad,p3,o3,,,,'].join('\n');
  await page.locator('#mapping-import-file').setInputFiles({name:'mapping.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});
  await page.waitForFunction(()=>!document.getElementById('mapping-import-apply').disabled);
  assert.match(await page.locator('#mapping-import-status').innerText(),/신규 등록 1건.*기존 연결 변경 1건.*오류 1건|오류 1건.*신규 등록 1건.*기존 연결 변경 1건/);
  await page.locator('#mapping-import-apply').click();
  await page.waitForFunction(()=>document.getElementById('mapping-import-status').textContent.includes('저장 완료 2건'));
  assert.equal(await page.evaluate(()=>window.fixtureSaved.length),2);
  await fs.promises.mkdir(new URL('../outputs/ui-qa/',import.meta.url),{recursive:true});
  await page.screenshot({path:new URL('../outputs/ui-qa/20260908-mapping-import.png',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
  // A new run can be stopped while a save is in flight; already saved work remains.
  await page.locator('#mapping-import-file').setInputFiles({name:'mapping.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});
  await page.waitForFunction(()=>!document.getElementById('mapping-import-apply').disabled);
  await page.locator('#mapping-import-apply').click();
  await page.waitForFunction(()=>window.fixtureSaved.length===3);
  await page.locator('#mapping-import-cancel').click();
  await page.waitForFunction(()=>document.getElementById('mapping-import-status').textContent.includes('중단되었습니다'));
  assert.equal(await page.evaluate(()=>window.fixtureSaved.length),3,'cancel prevents next save');
  console.log('Mapping import: parsing safety, blank preservation, exact codes, duplicate conflicts, browser preview/apply/error/stop passed');
}finally{await browser.close();}
