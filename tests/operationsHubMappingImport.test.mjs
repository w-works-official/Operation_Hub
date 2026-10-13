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
    window.fixturePreviewCalls=[];
    window.fixtureTemplateQueries=[];
    const unexpectedTemplateQuery=name=>async()=>{window.fixtureTemplateQueries.push(name);throw new Error('Blank templates must not query existing data');};
    window.SystemV3Data={
      loadAllFilteredSkus:unexpectedTemplateQuery('loadAllFilteredSkus'),
      loadProductThumbnailsBySkus:unexpectedTemplateQuery('loadProductThumbnailsBySkus'),
      loadAllSellerUnmatchedSkus:unexpectedTemplateQuery('loadAllSellerUnmatchedSkus'),
      previewMappingImport:async rows=>{window.fixturePreviewCalls.push(rows);return rows.map(row=>({...row,before:{productCode:row.sku==='replace'?'old':'',optionCode:''},status:row.sku==='bad'?'error':row.sku==='replace'?'replace':'ready',reason:row.sku==='bad'?'원본 옵션코드 없음':'',productName:'테스트 상품'}));},
      linkSellerItem:async row=>{window.fixtureSaved.push(row);await new Promise(resolve=>setTimeout(resolve,100));return {product_code:row.productCode,option_code:row.optionCode};}
    };
  });
  await page.addScriptTag({content:fs.readFileSync(new URL('../mockups/operations-hub/vendor/exceljs.min.js',import.meta.url),'utf8')});
  await page.addScriptTag({content:fs.readFileSync(new URL('./vendor/xlsx-0.18.5.full.min.js',import.meta.url),'utf8')});
  await page.addScriptTag({content:source});
  await page.getByRole('button',{name:'매칭값 일괄 업로드',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'셀피아 SKU 미매칭 양식',exact:true}).count(),1);
  assert.equal(await page.getByRole('button',{name:'판매처 SKU 미매칭 양식',exact:true}).count(),1);
  const helpText=await page.locator('#mapping-import-help').innerText();
  assert.match(helpText,/A열에 셀피아 SKU/);
  assert.match(helpText,/텍스트 형식/);
  assert.match(helpText,/기존 상품코드를 그대로 쓰고 새 옵션코드/);
  assert.match(helpText,/상품·옵션 두 칸을 모두 비우세요/);
  assert.match(helpText,/상품코드만 입력하고 옵션코드를 비우면 옵션 없는 상품/);
  assert.match(helpText,/최신 판매처 원본에 존재하는 상품·옵션 조합/);
  assert.match(helpText,/적용 버튼을 눌러 저장/);
  await fs.promises.mkdir(new URL('../outputs/ui-qa/',import.meta.url),{recursive:true});
  await page.screenshot({path:new URL('../outputs/ui-qa/20261013-mapping-import-blank-template.png',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
  await page.setViewportSize({width:375,height:900});
  for(const name of ['빈 양식 다운로드','셀피아 SKU 미매칭 양식','판매처 SKU 미매칭 양식']){
    const bounds=await page.getByRole('button',{name,exact:true}).boundingBox();
    assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=375,'template buttons remain within a narrow viewport');
  }
  await page.screenshot({path:new URL('../outputs/ui-qa/20261013-mapping-import-blank-template-mobile.png',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
  await page.setViewportSize({width:1200,height:900});
  const downloadEvent=page.waitForEvent('download');
  await page.getByRole('button',{name:'빈 양식 다운로드',exact:true}).click();
  const downloaded=await downloadEvent;
  assert.equal(downloaded.suggestedFilename(),'매칭값_일괄등록_빈양식.xlsx');
  const chunks=[];
  for await(const chunk of await downloaded.createReadStream())chunks.push(chunk);
  const blankBytes=Buffer.concat(chunks);
  await fs.promises.writeFile(new URL('../outputs/ui-qa/매칭값_일괄등록_빈양식.xlsx',import.meta.url),blankBytes);
  const blankBook=await page.evaluate(async bytes=>{
    const input=new Uint8Array(bytes);
    const book=new ExcelJS.Workbook();await book.xlsx.load(input);
    const sheet=book.worksheets[0];
    const parsedBook=XLSX.read(input,{type:'array',raw:true});
    const rows=XLSX.utils.sheet_to_json(parsedBook.Sheets[parsedBook.SheetNames[0]],{header:1,defval:'',raw:true});
    return {sheetCount:book.worksheets.length,rowCount:sheet.rowCount,columnCount:sheet.columnCount,
      headers:sheet.getRow(1).values.slice(1),formats:Array.from({length:7},(_,i)=>sheet.getColumn(i+1).numFmt),
      parsed:SystemV3MappingImport.parse(rows),queries:window.fixtureTemplateQueries};
  },Array.from(blankBytes));
  assert.equal(blankBook.sheetCount,1);
  assert.equal(blankBook.rowCount,1,'blank XLSX contains headers only, without examples or unmatched rows');
  assert.equal(blankBook.columnCount,7);
  assert.deepEqual(blankBook.headers,Array.from(headers),'blank template starts with Sellpia SKU in column A');
  assert.deepEqual(blankBook.formats,Array(7).fill('@'),'all code columns retain text format after reopening');
  assert.deepEqual(blankBook.parsed,{entries:[],errors:[]});
  assert.deepEqual(blankBook.queries,[],'blank download is independent of unmatched data and thumbnail queries');
  await page.locator('#mapping-import-file').setInputFiles({name:'blank.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:blankBytes});
  await page.waitForFunction(()=>!document.getElementById('mapping-import-file').disabled);
  assert.equal(await page.locator('#mapping-import-apply').isDisabled(),true);
  assert.equal(await page.evaluate(()=>window.fixturePreviewCalls.length),0,'header-only upload performs no preview data query');
  const modifiedBytes=await page.evaluate(async bytes=>{
    const book=new ExcelJS.Workbook();await book.xlsx.load(new Uint8Array(bytes));
    book.worksheets[0].addRow(['replace','0010807677752','0060372395148','','','','']);
    return Array.from(new Uint8Array(await book.xlsx.writeBuffer()));
  },Array.from(blankBytes));
  await page.locator('#mapping-import-file').setInputFiles({name:'updated-mapping.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(modifiedBytes)});
  await page.waitForFunction(()=>!document.getElementById('mapping-import-apply').disabled);
  assert.match(await page.locator('#mapping-import-status').innerText(),/기존 연결 변경 1건/);
  assert.equal(await page.evaluate(()=>window.fixtureSaved.length),0,'upload only previews changes until apply');
  assert.deepEqual(await page.evaluate(()=>window.fixturePreviewCalls[0].map(({sku,source,productCode,optionCode})=>({sku,source,productCode,optionCode}))),[
    {sku:'replace',source:'smartstore',productCode:'0010807677752',optionCode:'0060372395148'}
  ],'edited template keeps leading zeros and skips the two blank sellers');
  await page.locator('#mapping-import-apply').click();
  await page.waitForFunction(()=>document.getElementById('mapping-import-status').textContent.includes('저장 완료 1건'));
  assert.deepEqual(await page.evaluate(()=>window.fixtureSaved.map(({sku,source,productCode,optionCode})=>({sku,source,productCode,optionCode}))),[
    {sku:'replace',source:'smartstore',productCode:'0010807677752',optionCode:'0060372395148'}
  ]);
  assert.equal(await page.evaluate(()=>window.fixturePreviewCalls.length),2,'apply rechecks the current mapping before saving');
  await page.evaluate(()=>{window.fixtureSaved=[];window.fixturePreviewCalls=[];});
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
  console.log('Mapping import: header-only XLSX download/reopen/reimport without data queries, parsing safety, blank preservation, exact codes, duplicate conflicts, browser preview/apply/error/stop passed');
}finally{await browser.close();}
