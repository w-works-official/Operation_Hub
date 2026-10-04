import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium} from 'playwright';

const xlsx=process.env.XLSX_BROWSER_SCRIPT;
const jszip=process.env.JSZIP_BROWSER_SCRIPT;

async function pageWithModules(browser){
 const page=await browser.newPage();
 await page.addScriptTag({content:fs.readFileSync(xlsx,'utf8')});
 await page.addScriptTag({content:fs.readFileSync(jszip,'utf8')});
 for(const path of ['mockups/operations-hub/sellpia-source-parser.js','mockups/operations-hub/seller-export-adapter.js','mockups/operations-hub/sellpia-carrier-export.js'])await page.addScriptTag({path});
 return page;
}

test('Sellpia XLSX carrier supports full and compact changed-only output',async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await pageWithModules(browser);
  const result=await page.evaluate(async()=>{
   const header=['#','상품코드','자사코드','상품명','옵션명','재고','가용재고','품절','단종','판매가','안전재고','매입처코드','매입처','매입처그룹','매입처주소','상가명','매입처전화','매입상품명','매입옵션명','매입가','수수료','매입처부가세','발주단위','최소발주수량','메모'];
   const row=(n,sku,stock,price)=>[n,sku,'OWN','상품','옵션',stock,stock,'','',price,0,'S','N','G','A','M','T','PP','PO',500,'0','과세',1,1,'keep'];
   const sheet=XLSX.utils.aoa_to_sheet([header,row(1,'90000-1',3,1000),row(2,'90000-2',4,2000),row(3,'90000-3',5,3000)]);
   sheet.Y2={t:'n',f:'F2+J2',v:1003};sheet['!cols']=header.map(()=>({wch:12}));
   const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,sheet,'원본상품');
   const file=new File([XLSX.write(book,{type:'array',bookType:'xlsx'})],'original.xlsx');
   const plan={keys:['base','stock'],values:[{sku:'90000-1',base:1500,stock:7},{sku:'90000-2',base:2000,stock:9},{sku:'90000-3',base:3000,stock:5}],preview:[
    {sku:'90000-1',key:'base',field:'기준가격',before:1000,after:1500,status:'변경'},{sku:'90000-1',key:'stock',field:'재고',before:3,after:7,status:'변경'},
    {sku:'90000-2',key:'base',field:'기준가격',before:2000,after:2000,status:'변경 없음'},{sku:'90000-2',key:'stock',field:'재고',before:4,after:9,status:'변경'},
    {sku:'90000-3',key:'base',field:'기준가격',before:3000,after:3000,status:'변경 없음'},{sku:'90000-3',key:'stock',field:'재고',before:5,after:5,status:'변경 없음'}],errors:[],blockedSkus:[]};
   async function inspect(mode){
    const prepared=await SystemV3SellpiaCarrierExport.prepare([file],plan,mode),built=await SystemV3SellpiaCarrierExport.build(prepared),bytes=new Uint8Array(await built.blob.arrayBuffer());
    const output=XLSX.read(bytes,{type:'array',cellFormula:true}),sheet=output.Sheets[output.SheetNames[0]],zip=await JSZip.loadAsync(bytes);
    return {counts:[prepared.priceChangeCount,prepared.stockChangeCount,prepared.changedSkuCount],grid:XLSX.utils.sheet_to_json(sheet,{header:1,raw:true,defval:''}),formula:sheet.Y2?.f||'',styles:await zip.file('xl/styles.xml').async('string'),workbook:await zip.file('xl/workbook.xml').async('string')};
   }
   return {full:await inspect('full'),changed:await inspect('changed_only')};
  });
  assert.deepEqual(result.full.counts,[1,2,2]);
  assert.equal(result.full.grid.length,4);assert.equal(result.full.grid[1][9],1500);assert.equal(result.full.grid[1][5],7);assert.equal(result.full.grid[2][5],9);assert.equal(result.full.grid[3][9],3000);
  assert.equal(result.full.formula,'F2+J2');assert.match(result.full.styles,/FFFFFF00/i);assert.match(result.full.styles,/<b\/>/);assert.match(result.full.workbook,/원본상품/);
  assert.equal(result.changed.grid.length,3);assert.deepEqual(result.changed.grid.slice(1).map(row=>row[0]),[1,2]);assert.deepEqual(result.changed.grid.slice(1).map(row=>row[1]),['90000-1','90000-2']);
 }finally{await browser.close();}
});

test('Sellpia CSV carrier preserves unrelated columns and blocks only the mismatched SKU',async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await pageWithModules(browser);
  const result=await page.evaluate(async()=>{
   const h=['#','상품코드','자사코드','상품명','옵션명','재고','가용재고','품절','단종','판매가','안전재고','매입처코드','매입처','매입처그룹','매입처주소','상가명','매입처전화','매입상품명','매입옵션명','매입가','수수료','매입처부가세','발주단위','최소발주수량','자유메모'];
   const rows=[h,[1,'90000-1','A','P','O1',3,3,'','',1000,0,'S','N','G','A','M','T','PP','PO',500,'0','과세',1,1,'keep-a'],[2,'90000-2','B','P','O2',4,4,'','',2000,0,'S','N','G','A','M','T','PP','PO',600,'0','과세',1,1,'keep-b']];
   const file=new File(['\uFEFF'+rows.map(row=>row.join(',')).join('\r\n')],'original.csv',{type:'text/csv'});
   const plan={keys:['base','stock'],values:[{sku:'90000-1',base:1500,stock:7},{sku:'90000-2',base:2100,stock:8}],preview:[
    {sku:'90000-1',key:'base',field:'기준가격',before:999,after:1500,status:'변경'},{sku:'90000-1',key:'stock',field:'재고',before:3,after:7,status:'변경'},
    {sku:'90000-2',key:'base',field:'기준가격',before:2000,after:2100,status:'변경'},{sku:'90000-2',key:'stock',field:'재고',before:4,after:8,status:'변경'}],errors:[],blockedSkus:[]};
   const prepared=await SystemV3SellpiaCarrierExport.prepare([file],plan,'changed_only'),built=await SystemV3SellpiaCarrierExport.build(prepared),bytes=new Uint8Array(await built.blob.arrayBuffer()),output=XLSX.read(bytes,{type:'array',raw:true}),grid=XLSX.utils.sheet_to_json(output.Sheets[output.SheetNames[0]],{header:1,raw:true,defval:''}),zip=await JSZip.loadAsync(bytes),sheetXml=await zip.file('xl/worksheets/sheet1.xml').async('string'),styles=await zip.file('xl/styles.xml').async('string');
   return {blocks:prepared.blocks,changed:prepared.changedSkuCount,grid,name:built.name,sheetXml,styles};
  });
  assert.equal(result.blocks.length,1);assert.equal(result.blocks[0].sku,'90000-1');assert.equal(result.changed,1);
  assert.equal(result.grid.length,2);assert.equal(Number(result.grid[1][0]),1);assert.equal(result.grid[1][1],'90000-2');assert.equal(Number(result.grid[1][5]),8);assert.equal(Number(result.grid[1][9]),2100);assert.equal(result.grid[1][24],'keep-b');
  assert.match(result.name,/\.xlsx$/i);assert.match(result.styles,/FFFFFF00/i);assert.match(result.styles,/<b\/>/);assert.match(result.sheetXml,/<c\b[^>]*\br="F2"[^>]*\bs="\d+"/);assert.match(result.sheetXml,/<c\b[^>]*\br="J2"[^>]*\bs="\d+"/);
 }finally{await browser.close();}
});

test('Sellpia carrier compares against snapshot raw before while exporting a different operational target',async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await pageWithModules(browser);
  const result=await page.evaluate(async()=>{
   const header=['#','상품코드','자사코드','상품명','옵션명','재고','가용재고','품절','단종','판매가','안전재고','매입처코드','매입처','매입처그룹','매입처주소','상가명','매입처전화','매입상품명','매입옵션명','매입가','수수료','매입처부가세','발주단위','최소발주수량'];
   const row=[1,'10437-1','OWN','상품','옵션',103,103,'','',67500,0,'S','N','G','A','M','T','PP','PO',37500,'0','과세',1,1];
   const file=new File(['\uFEFF'+[header,row].map(values=>values.join(',')).join('\r\n')],'exported-list.csv',{type:'text/csv'});
   const plan={keys:['base'],values:[{sku:'10437-1',base:59000}],preview:[{sku:'10437-1',key:'base',field:'기준가격',before:67500,after:59000,status:'변경'}],errors:[],blockedSkus:[]};
   const prepared=await SystemV3SellpiaCarrierExport.prepare([file],plan,'full'),built=await SystemV3SellpiaCarrierExport.build(prepared),bytes=new Uint8Array(await built.blob.arrayBuffer()),output=XLSX.read(bytes,{type:'array',raw:true}),grid=XLSX.utils.sheet_to_json(output.Sheets[output.SheetNames[0]],{header:1,raw:true,defval:''});
   return {blocks:prepared.blocks,priceChanges:prepared.priceChangeCount,value:grid[1][9],name:built.name};
  });
  assert.deepEqual(result.blocks,[]);assert.equal(result.priceChanges,1);assert.equal(result.value,59000);assert.match(result.name,/\.xlsx$/i);
 }finally{await browser.close();}
});

test('current three-file Sellpia CSV carrier stays bounded to one changed SKU',{skip:!process.env.SELLPIA_REAL_CARRIER_DIR},async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await pageWithModules(browser),paths=fs.readdirSync(process.env.SELLPIA_REAL_CARRIER_DIR).filter(name=>/^exported-list_2026-09-18_15\.36\.1[234]\.csv$/i.test(name)).sort().map(name=>process.env.SELLPIA_REAL_CARRIER_DIR+'/'+name);
  assert.equal(paths.length,3);
  await page.setContent('<input id="files" type="file" multiple>');await page.locator('#files').setInputFiles(paths);
  const result=await page.evaluate(async()=>{
   const files=[...document.getElementById('files').files],analyses=[];for(const file of files)analyses.push(await SystemV3SellpiaCarrierExport.matrixFromFile(file));
   const first=analyses[0],entry=first.bySku.values().next().value,sku=entry.sku,base=Number(entry.row[first.columns.salePrice]),stock=Number(entry.row[first.columns.stock]),plan={keys:['base','stock'],values:[{sku,base:base+500,stock:stock+1}],preview:[{sku,key:'base',field:'기준가격',before:base,after:base+500,status:'변경'},{sku,key:'stock',field:'재고',before:stock,after:stock+1,status:'변경'}],errors:[],blockedSkus:[]};
   const prepared=await SystemV3SellpiaCarrierExport.prepare(files,plan,'changed_only'),built=await SystemV3SellpiaCarrierExport.build(prepared),bytes=new Uint8Array(await built.blob.arrayBuffer()),output=XLSX.read(bytes,{type:'array',raw:true}),grid=XLSX.utils.sheet_to_json(output.Sheets[output.SheetNames[0]],{header:1,raw:true,defval:''});
   return {sku,skuColumn:first.columns.sku,columnCount:first.rows[0].length,sourceCount:analyses.reduce((sum,item)=>sum+item.bySku.size,0),counts:[prepared.priceChangeCount,prepared.stockChangeCount,prepared.changedSkuCount],grid};
  });
  assert.ok(result.sourceCount>23000);assert.deepEqual(result.counts,[1,1,1]);assert.equal(result.grid.length,2);assert.equal(result.grid[0].length,result.columnCount);assert.equal(result.grid[1][result.skuColumn],result.sku);
 }finally{await browser.close();}
});
