import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
const JSZip=require('./vendor/jszip-3.10.1.min.js');
const XLSX=require('./vendor/xlsx-0.18.5.full.min.js');
const sheetPath='xl/worksheets/sheet1.xml';
class TestFile extends Blob {constructor(parts,name,options={}){super(parts,options);this.name=name;}}
function context(){
  const value={console,Blob,File:TestFile,JSZip,XLSX,Map,Set,Number,String,JSON,RegExp,Error,Promise,Uint8Array,ArrayBuffer,Date,Math,Intl,setTimeout,performance:{now:()=>Date.now()},formatNumber:String,CHANNEL_LABELS:{smartstore:'스마트스토어'}};
  value.window=value;value.globalThis=value;vm.createContext(value);
  for(const name of ['sellpia-inventory-count','seller-source-parsers','seller-export-adapter','current-price-export'])vm.runInContext(fs.readFileSync(path.join(repo,`mockups/operations-hub/${name}.js`),'utf8'),value,{filename:name+'.js'});
  return value;
}
function withoutDimension(xml){return xml.replace(/<dimension\b[^>]*\/?>(?:<\/dimension>)?/i,'');}
async function fixture(ref='A1:CP5',dimensionSuffix='/>'){
  const rows=Array.from({length:753},()=>[]);
  rows[0]=['Template metadata'];
  Object.assign(rows[1],{0:'상품번호',1:'판매자 상품코드',5:'판매가',12:'재고수량',15:'옵션번호',17:'옵션가',18:'옵션 재고수량',93:'보존 열'});
  rows[2]=['필수'];rows[3]=['업로드 안내'];rows[4]=['가격과 재고 단위'];
  Object.assign(rows[5],{0:'1001',1:'sellpia_S1',5:1000,12:3,15:'O1',17:'0',18:'3',93:'kept CP6'});
  Object.assign(rows[752],{0:'1753',1:'sellpia_S2',5:2500,12:9,15:'O2',17:'100',18:'9',93:'끝행 & <보존>'});
  const book=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet(rows);
  sheet['!merges']=[{s:{r:0,c:0},e:{r:0,c:2}}];
  sheet['!cols']=[{wch:24},{wch:32}];
  sheet.F6.z='#,##0';
  XLSX.utils.book_append_sheet(book,sheet,'일괄수정');
  const zip=await JSZip.loadAsync(XLSX.write(book,{type:'buffer',bookType:'xlsx',bookSST:true}));
  let xml=await zip.file(sheetPath).async('string');
  xml=xml.replace(/<dimension\b[^>]*\/>/,`<dimension ref="${ref}"${dimensionSuffix}`);
  xml=xml.replace('<row r="6">','<row r="6" ht="24" customHeight="1">');
  zip.file(sheetPath,xml);zip.file('custom/retained.txt','Package part preserved byte for byte.');
  return {file:new TestFile([await zip.generateAsync({type:'uint8array',compression:'DEFLATE'})],'stale-smart.xlsx',{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),xml};
}
async function reopen(blob){const buffer=await blob.arrayBuffer();return XLSX.read(buffer,{type:'array',cellStyles:true,cellNF:true});}
function productRows(sheet){return XLSX.utils.sheet_to_json(sheet,{header:1,raw:true,defval:null,blankrows:false}).filter(row=>/^\d+$/.test(String(row[0]??'')));}
function matchBracket(source,start,open,close){
  let depth=0,quote='',escape=false,line=false,block=false;
  for(let index=start;index<source.length;index++){
    const c=source[index],next=source[index+1];
    if(line){if(c==='\n')line=false;continue;}if(block){if(c==='*'&&next==='/'){block=false;index++;}continue;}
    if(quote){if(escape){escape=false;continue;}if(c==='\\'){escape=true;continue;}if(c===quote)quote='';continue;}
    if(c==='/'&&next==='/'){line=true;index++;continue;}if(c==='/'&&next==='*'){block=true;index++;continue;}
    if(c==='"'||c==="'"||c==='`'){quote=c;continue;}if(c===open)depth++;else if(c===close&&--depth===0)return index;
  }
  throw Error(`Unclosed ${open}`);
}
function extract(name){
  const source=fs.readFileSync(path.join(repo,'mockups/operations-hub/app.js'),'utf8'),start=source.indexOf(`async function ${name}(`);
  assert.ok(start>=0,`Missing app entry point ${name}`);
  const paren=source.indexOf('(',start),close=matchBracket(source,paren,'(',')'),body=source.indexOf('{',close),end=matchBracket(source,body,'{','}');
  return `async function ${name}`+source.slice(paren,end+1);
}

test('worksheet dimension expands both axes and earlier bounds without changing cell XML, merge, styles or row attributes',()=>{
  const api=context().SystemV3SellerExport;
  const xml='<worksheet><dimension ref="B3:CP5" custom="keep"/><sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="2" width="24" customWidth="1"/></cols><sheetData><row r="1"><c r="A1" s="2" t="inlineStr"><is><t>metadata</t></is></c></row><row r="753" ht="24" customHeight="1"><c r="DA753" s="3"><v>9</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells></worksheet>';
  const output=api.expandWorksheetDimension(xml);
  assert.match(output,/<dimension ref="A1:DA753" custom="keep"\/>/);
  assert.equal(withoutDimension(output),withoutDimension(xml));
  assert.equal(api.expandWorksheetDimension(output),output,'repair is idempotent');
});

test('valid declared range retains reserved rows and columns byte for byte',()=>{
  const api=context().SystemV3SellerExport;
  const xml='<worksheet><dimension ref="A1:ZZ1000"/><sheetData><row r="753"><c r="CP753"><v>9</v></c></row></sheetData></worksheet>';
  assert.equal(api.expandWorksheetDimension(xml),xml,'a larger valid dimension must not shrink');
});

test('missing dimension is inserted after sheet properties and a single-cell range is supported',()=>{
  const api=context().SystemV3SellerExport;
  const xml='<worksheet><sheetPr><outlinePr summaryRight="0"/></sheetPr><sheetData><row r="7"><c r="C7"><v>2</v></c></row></sheetData></worksheet>';
  const output=api.expandWorksheetDimension(xml);
  assert.match(output,/<\/sheetPr><dimension ref="C7"\/>/);
  assert.equal(withoutDimension(output),xml);
});

test('default no-edit transform preserves every original ZIP byte even when dimension is stale',async()=>{
  const {file}=await fixture();
  const output=await context().SystemV3SellerExport.transformSellerFile(file,[]);
  assert.deepEqual(Buffer.from(await output.blob.arrayBuffer()),Buffer.from(await file.arrayBuffer()));
  assert.equal(productRows((await reopen(output.blob)).Sheets['일괄수정']).length,0,'fixture really reproduces generic-reader truncation');
});

test('explicit no-edit range repair reopens both Smartstore data rows with generic SheetJS and preserves all other package parts',async()=>{
  const {file,xml}=await fixture(),api=context().SystemV3SellerExport;
  const output=await api.transformSellerFile(file,[],{repairRange:true});
  assert.equal(output.appliedItems.length,0);assert.equal(output.skippedItems.length,0);
  const before=await JSZip.loadAsync(new Uint8Array(await file.arrayBuffer()),{checkCRC32:true});
  const after=await JSZip.loadAsync(new Uint8Array(await output.blob.arrayBuffer()),{checkCRC32:true});
  assert.deepEqual(Object.keys(after.files).sort(),Object.keys(before.files).sort());
  for(const name of Object.keys(before.files))if(!before.files[name].dir&&name!==sheetPath)assert.deepEqual(await after.file(name).async('uint8array'),await before.file(name).async('uint8array'),`${name} changed`);
  const repaired=await after.file(sheetPath).async('string');
  assert.equal(withoutDimension(repaired),withoutDimension(xml));assert.match(repaired,/<dimension ref="A1:CP753"\/>/);
  const book=await reopen(output.blob),sheet=book.Sheets['일괄수정'];
  assert.equal(sheet['!ref'],'A1:CP753');
  assert.deepEqual(productRows(sheet).map(row=>[row[0],row[5],row[18],row[93]]),[['1001',1000,'3','kept CP6'],['1753',2500,'9','끝행 & <보존>']]);
  assert.equal(sheet.F6.z,'#,##0');assert.deepEqual(sheet['!merges'],[{s:{r:0,c:0},e:{r:0,c:2}}]);
  const again=await api.transformSellerFile(new TestFile([output.blob],'repaired.xlsx'),[],{repairRange:true});
  assert.deepEqual(Buffer.from(await again.blob.arrayBuffer()),Buffer.from(await output.blob.arrayBuffer()));
});

test('explicit repair on a valid original does not regenerate its ZIP',async()=>{
  const {file}=await fixture('A1:CP1000');
  const output=await context().SystemV3SellerExport.transformSellerFile(file,[],{repairRange:true});
  assert.deepEqual(Buffer.from(await output.blob.arrayBuffer()),Buffer.from(await file.arrayBuffer()));
});

test('repair rejects malformed double-slash dimensions whether or not range expansion is needed',async()=>{
  for(const ref of ['A1:CP5','A1:CP1000']){
    const {file}=await fixture(ref,'//>');
    await assert.rejects(context().SystemV3SellerExport.transformSellerFile(file,[],{repairRange:true}),/dimension XML|worksheet XML|범위/);
  }
});

test('actual app full_original zero-change generation passes repairRange and exposes row 753 to generic readers',async()=>{
  const value=context(),{file}=await fixture(),calls=[];
  value.liveData={
    async loadCarrierSellerMappings({identities}){return {rows:identities.map(row=>({...row,sku:row.product_code==='1001'?'S1':'S2'}))};},
    async loadSellpiaStockSourcesForExport(){return {snapshotId:'same-stock',bySku:new Map([['S1',{sellpia_current_stock:3,sellpia_available_stock:3}],['S2',{sellpia_current_stock:9,sellpia_available_stock:9}]])};}
  };
  const api=value.SystemV3SellerExport;
  value.sellerExport={...api,async transformSellerFile(file,items,options){calls.push({items,options});return api.transformSellerFile(file,items,options);}};
  vm.runInContext(extract('prepareChangedOnlyExport')+extract('prepareFullOriginalExport')+';this.runFull=prepareFullOriginalExport;',value);
  const result=await value.runFull('smartstore',null,{download:false,includePrice:false,includeStock:true,stockSource:'available_stock',filesBySourceOverride:new Map([['smartstore',[file]]]),includeEmptyFullOriginal:true,markCarrierWarnings:false});
  assert.equal(calls.length,1);assert.equal(calls[0].items.length,0);assert.equal(calls[0].options.repairRange,true);
  assert.equal(result.outputs.length,1);assert.equal(result.changedItems.length,0);
  assert.equal(productRows((await reopen(result.outputs[0].blob)).Sheets['일괄수정']).length,2);
});
