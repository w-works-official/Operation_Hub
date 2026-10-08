import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {createRequire} from 'node:module';

const repo=process.cwd();
const require=createRequire(import.meta.url);
const JSZip=require('./vendor/jszip-3.10.1.min.js');
const XLSX=require('./vendor/xlsx-0.18.5.full.min.js');
const BlobClass=globalThis.Blob;
const inventorySource=fs.readFileSync('mockups/operations-hub/app.js','utf8');

function extractFunction(source,signature,replacement){
 const start=source.indexOf(signature);assert.notEqual(start,-1,`missing source function ${signature}`);
 const openParen=source.indexOf('(',start),closeParen=matching(source,openParen,'(',')');
 const bodyOpen=source.indexOf('{',closeParen);assert.notEqual(bodyOpen,-1,`missing body for ${signature}`);
 const bodyClose=matching(source,bodyOpen,'{','}');
 return replacement+source.slice(openParen,bodyOpen+1)+source.slice(bodyOpen+1,bodyClose)+'}';
}
function matching(source,start,open,close){
 let depth=0,quote='',escape=false,lineComment=false,blockComment=false;
 for(let i=start;i<source.length;i++){
  const c=source[i],n=source[i+1];
  if(lineComment){if(c==='\n')lineComment=false;continue;}
  if(blockComment){if(c==='*'&&n==='/'){blockComment=false;i++;}continue;}
  if(quote){if(escape){escape=false;continue;}if(c==='\\'){escape=true;continue;}if(c===quote)quote='';continue;}
  if(c==='/'&&n==='/'){lineComment=true;i++;continue;}if(c==='/'&&n==='*'){blockComment=true;i++;continue;}
  if(c==='\''||c==='"'||c==='`'){quote=c;continue;}
  if(c===open)depth++;else if(c===close&&--depth===0)return i;
 }
 throw Error(`unclosed ${open} in ${source.slice(start,start+80)}`);
}

const xmlEscape=value=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
function colName(index){let value=index+1,result='';while(value){const remainder=(value-1)%26;result=String.fromCharCode(65+remainder)+result;value=Math.floor((value-1)/26);}return result;}
async function makeXlsx(sheetName,rows){
 const zip=new JSZip();
 zip.file('[Content_Types].xml','<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>');
 zip.file('_rels/.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
 zip.file('xl/workbook.xml',`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`);
 zip.file('xl/_rels/workbook.xml.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
 zip.file('xl/styles.xml','<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>');
 const sheetRows=rows.map((row,r)=>`<row r="${r+1}">${row.map((value,c)=>{if(value===null||value===undefined||value==='')return '';const ref=`${colName(c)}${r+1}`;return typeof value==='number'?`<c r="${ref}"><v>${value}</v></c>`:`<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;}).join('')}</row>`).join('');
 zip.file('xl/worksheets/sheet1.xml',`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`);
 return zip.generateAsync({type:'uint8array',compression:'DEFLATE'});
}
const xmlDecode=value=>String(value??'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
async function sheetRowsFromBytes(bytes){
 const zip=await JSZip.loadAsync(bytes),book=await zip.file('xl/workbook.xml').async('string'),rels=await zip.file('xl/_rels/workbook.xml.rels').async('string');
 const sheet=book.match(/<sheet\b([^>]*)\/?\s*>/i)?.[1]||'',rid=sheet.match(/r:id="([^"]+)"/)?.[1];let target='';
 for(const match of rels.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)){const attrs=match[1];if(attrs.match(/Id="([^"]+)"/)?.[1]===rid)target=attrs.match(/Target="([^"]+)"/)?.[1]||'';}
 const pathName=target.startsWith('/')?target.slice(1):`xl/${target.replace(/^\.\//,'')}`;
 const xml=await zip.file(pathName).async('string'),sharedXml=await zip.file('xl/sharedStrings.xml')?.async('string'),shared=[];
 for(const match of String(sharedXml||'').matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g))shared.push([...match[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(x=>xmlDecode(x[1])).join(''));
 const rows=[];
 for(const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)){
  const rowNo=Number(rowMatch[1].match(/\br="(\d+)"/)?.[1]),row=[];
  for(const cell of rowMatch[2].matchAll(/<c\b([^>]*?\br="([A-Z]+)\d+"[^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)){
   const ref=cell[2];let col=0;for(const letter of ref)col=col*26+letter.charCodeAt(0)-64;col--;
   const attrs=cell[1],body=cell[3]||'',type=attrs.match(/\bt="([^"]+)"/)?.[1],raw=body.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/)?.[1];
   let value='';if(type==='s')value=shared[Number(raw)]??'';else if(type==='inlineStr')value=[...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(x=>xmlDecode(x[1])).join('');else if(raw!==undefined){const decoded=xmlDecode(raw);value=/^-?\d+(?:\.\d+)?$/.test(decoded)?Number(decoded):decoded;}
   row[col]=value;
  }
  rows[rowNo-1]=row;
 }
 return rows;
}
async function sheetJsGrid(file){const book=XLSX.read(await file.arrayBuffer(),{type:'array',raw:true});return XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]],{header:1,defval:'',raw:true,blankrows:true});}
function asFile(name,bytes){return {name,size:bytes.byteLength,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};}
function smartRows(product,option,sku,stock){const rows=Array.from({length:2},()=>Array(68).fill(null));rows[0][0]='상품번호';rows[0][1]='판매자 상품코드';rows[0][18]='옵션 재고수량';const row=rows[1];row[0]=Number(product);row[1]=`sellpia_${product}`;row[3]=`Smart ${product}`;row[5]=1000;row[15]=String(option);row[16]=`Option ${option}`;row[17]='25';row[18]=String(stock);row[19]='Y';return rows;}
function makeRows(product,option,sku,stock){const rows=Array.from({length:2},()=>Array(124).fill(null));const h=rows[0];h[4]='product_uid';h[32]='sto_stock';h[44]='sell_price';const row=rows[1];row[4]=product;row[12]=`Make ${product}`;row[29]=`Option ${option}`;row[31]='25';row[32]=String(stock);row[39]=`sellpia_${product}`;row[41]='판매';row[43]=option;row[44]=1000;return rows;}
function ablyRows({duplicateCarrier=false}={}){const header=Array(29).fill(null);Object.assign(header,{0:'*쇼핑몰',1:'*계정',2:'*판매자관리코드',3:'온라인 상품명',4:'쇼핑몰상품코드',5:'옵션1 명칭',6:'옵션1 값',10:'옵션관리코드',11:'옵션 SKU 코드',21:'추가 금액',22:'판매가능재고',23:'*판매수량'});const rows=[header];for(const [product,sku] of [['1001','1001-1'],['1002','1002-1'],['2001','2001-1']]){const row=Array(29).fill(null);row[0]='shop';row[1]='account';row[2]=`sellpia_${product}`;row[3]=`Ably ${product}`;row[4]=product;row[5]='Color';row[6]='Black';row[10]=`sellpia_${sku}`;row[11]=`sellpia_${sku}`;row[21]=25;row[22]=88;row[23]=product==='2001'?null:product==='1001'?1:2;rows.push(row);}if(duplicateCarrier)rows.push([...rows[1]]);return rows;}

function buildHarness({statusOverride=null,changeSecondSnapshot=false}={}){
 const skuByIdentity=new Map([['1001\u00005001','1001-1'],['1002\u00005002','1002-1'],['2001\u00005003','2001-1'],['4001\u00001001-1','1001-1'],['4001\u00001002-1','1002-1'],['4001\u00002001-1','2001-1']]);
 const stockBySku=new Map([['1001-1',{sellpia_current_stock:11,sellpia_available_stock:-3}],['1002-1',{sellpia_current_stock:8,sellpia_available_stock:5}],['2001-1',{sellpia_current_stock:3,sellpia_available_stock:9}]]);
 const originals={smartstore:[],makeshop:[]};
 const snapshotId='snap-1';let stockRead=0,downloadCalls=0,statusCalls=0;const stockSkuSets=[];
 const status=[{source:'smartstore',snapshotId:'ss-1',available:true,files:[{name:'ss-a.xlsx',size:1},{name:'ss-b.xlsx',size:1}]},{source:'makeshop',snapshotId:'ms-1',available:true,files:[{name:'ms-a.xlsx',size:1}]}];
 const liveData={
  loadLatestSellerOriginalStatus:async()=>{statusCalls++;return statusOverride||structuredClone(status);},
  downloadLatestSellerOriginals:async()=>{downloadCalls++;return new Map([['smartstore',originals.smartstore],['makeshop',originals.makeshop]]);},
  loadCarrierSellerMappings:async({source,identities})=>({rows:identities.map(row=>{const sku=skuByIdentity.get(`${row.product_code}\u0000${row.option_code||''}`)||(/^sellpia_.+-\d+$/.test(row.seller_option_code||'')?(row.seller_option_code||'').replace(/^sellpia_/,''):null);return {...row,sku};}).filter(row=>row.sku)}),
  loadPlayautoSellpiaCatalog:async productCodes=>[...stockBySku.keys()].map((sku,index)=>({sellpia_product_code:['1001','1002','2001'][index],sellpia_sku_code:sku,sellpia_option_name:`Option ${['5001','5002','5003'][index]}`})).filter(row=>productCodes.includes(row.sellpia_product_code)),
  loadSellpiaStockSourcesForExport:async({skus})=>{stockRead++;stockSkuSets.push([...skus]);return {snapshotId:changeSecondSnapshot&&stockRead===2?'snap-2':snapshotId,bySku:new Map(skus.filter(sku=>stockBySku.has(sku)).map(sku=>[sku,stockBySku.get(sku)]))};}
 };
 const ctx={console,Blob:BlobClass,File:class TestFile extends BlobClass{constructor(parts,name,options={}){super(parts,options);this.name=name;}},JSZip,Uint8Array,ArrayBuffer,TextEncoder,TextDecoder,Date,Math,Map,Set,Number,String,JSON,RegExp,Error,Promise,setTimeout,performance:{now:()=>Date.now()},CustomEvent:class CustomEvent{constructor(type,init){this.type=type;this.detail=init?.detail;}},dispatchEvent(){},liveData,sellerExportState:{running:false},formatNumber:value=>String(value),CHANNEL_LABELS:{smartstore:'스마트스토어',makeshop:'메이크샵'},window:{__systemV3InventoryBatchBusy:false,__systemV3DirectExportBusy:false},SystemV3SellerExportBridge:{},SystemV3SellerParsers:null,HubCurrentPriceExport:null,AblyPlayautoExport:null,SystemV3SellpiaInventoryCount:null,XLSX:null,systemV3OriginalFileBoundaryDiagnostics:null};
 ctx.globalThis=ctx;ctx.window.globalThis=ctx;ctx.window.liveData=liveData;
 ctx.JSZip=class TransportZip extends JSZip{file(name,value,...rest){return super.file(name,value instanceof BlobClass?value.arrayBuffer().then(bytes=>new Uint8Array(bytes)):value,...rest);}};
 ctx.window.JSZip=ctx.JSZip;
 vm.createContext(ctx);
 for(const name of ['sellpia-inventory-count','seller-source-parsers','seller-export-adapter','current-price-export','ably-stock-export','ably-playauto-export'])vm.runInContext(fs.readFileSync(`mockups/operations-hub/${name}.js`,'utf8'),ctx,{filename:name+'.js'});
 ctx.SystemV3SellpiaInventoryCount=ctx.window.SystemV3SellpiaInventoryCount||ctx.SystemV3SellpiaInventoryCount;
 ctx.SystemV3SellerParsers=ctx.window.SystemV3SellerParsers;ctx.HubCurrentPriceExport=ctx.window.HubCurrentPriceExport;ctx.AblyPlayautoExport=ctx.window.AblyPlayautoExport;ctx.sellerExport=ctx.window.SystemV3SellerExport;
 ctx.window.SystemV3SellpiaInventoryCount=ctx.SystemV3SellpiaInventoryCount;ctx.window.SystemV3SellerParsers=ctx.SystemV3SellerParsers;ctx.window.HubCurrentPriceExport=ctx.HubCurrentPriceExport;ctx.window.AblyPlayautoExport=ctx.AblyPlayautoExport;ctx.window.SystemV3SellerExport=ctx.sellerExport;
 // Use the same pinned SheetJS and JSZip builds loaded by the application.
 ctx.XLSX=XLSX;
 ctx.window.XLSX=ctx.XLSX;
 ctx.window.SystemV3SellpiaInventoryCount=ctx.SystemV3SellpiaInventoryCount;
 const sellerSource=inventorySource;
 const prepare=extractFunction(sellerSource,'async function prepareChangedOnlyExport(','async function prepareChangedOnlyExport');
 const bridge=extractFunction(sellerSource,'async runInventoryBatch(','async function runInventoryBatch');
 vm.runInContext(prepare+'; this.__prepareChangedOnlyExport=prepareChangedOnlyExport;',ctx,{filename:'prepareChangedOnlyExport.js'});
 vm.runInContext(bridge+'; this.__runInventoryBatch=runInventoryBatch;',ctx,{filename:'runInventoryBatch.js'});
 ctx.window.__prepareChangedOnlyExport=ctx.__prepareChangedOnlyExport;
 return {ctx,run:ctx.__runInventoryBatch,liveData,originals,stockBySku,status,stockSkuSets,get counts(){return {stockRead,downloadCalls,statusCalls};}};
}

async function makeHarnessFiles(harness,{duplicateCarrier=false}={}){
 const smartA=asFile('ss-a.xlsx',await makeXlsx('Sheet1',smartRows('1001','5001','SKU-A',1)));
 const smartB=asFile('ss-b.xlsx',await makeXlsx('Sheet1',smartRows('1002','5002','SKU-B',2)));
 const make=asFile('ms-a.xlsx',await makeXlsx('Sheet1',makeRows('2001','5003','SKU-C',3)));
 harness.originals.smartstore.push(smartA,smartB);harness.originals.makeshop.push(make);
 harness.status.find(row=>row.source==='smartstore').files.forEach((item,index)=>item.size=[smartA,smartB][index].size);
 harness.status.find(row=>row.source==='makeshop').files[0].size=make.size;
 return asFile('ably-original.xlsx',await makeXlsx('옵션기본',ablyRows({duplicateCarrier})));
}

async function archiveXlsx(blob){const zip=await JSZip.loadAsync(await blob.arrayBuffer());const names=Object.keys(zip.files).filter(name=>!zip.files[name].dir);return {zip,names};}
async function sheetCells(file){const zip=await JSZip.loadAsync(await file.arrayBuffer()),xml=await zip.file('xl/worksheets/sheet1.xml').async('string');return new Map([...xml.matchAll(/<c\b([^>]*?\br="([A-Z]+\d+)"[^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map(match=>[match[2],match[0]]));}
async function sheetXml(file){const zip=await JSZip.loadAsync(await file.arrayBuffer());return zip.file('xl/worksheets/sheet1.xml').async('string');}
async function writeQaOutput(result,details){
 const outputDir=process.env.INVENTORY_QA_OUTPUT;if(!outputDir)return;
 fs.mkdirSync(outputDir,{recursive:true});
 fs.writeFileSync(path.join(outputDir,'QA-fixture-inventory-batch.zip'),Buffer.from(await result.blob.arrayBuffer()));
 fs.writeFileSync(path.join(outputDir,'QA-fixture-inventory-batch-summary.json'),JSON.stringify({synthetic_fixture:true,live_data_used:false,archive_file_name:result.fileName,archive_members:details.archiveMembers,source_identity:details.sourceIdentity,stock_modes:['available_stock','stock'],matched_sku_count:result.matchedSkuCount,stock_snapshot_reads:details.stockReads,stock_snapshot_read_sku_sets:details.stockSkuSets,negative_available_stock_source:-3,negative_available_stock_export:0,source_snapshot_preserved:true,parser_row_counts:details.rowCounts,ably_columns_preserved:['V','W'],ably_stock_column:'X'},null,2)+'\n','utf8');
}

test('inventory batch emits four full originals, parser round-trips stock-only values and preserves PlayAuto V/W',async()=>{
 const h=buildHarness(),file=await makeHarnessFiles(h),result=await h.run({file,stockSource:'available_stock'});
 assert.equal(result.stockSource,'available_stock');assert.equal(result.matchedSkuCount,3);assert.equal(result.files.length,4);
 assert.equal(result.files.filter(entry=>entry.source==='smartstore').length,2);assert.equal(result.files.filter(entry=>entry.source==='makeshop').length,1);assert.equal(result.files.filter(entry=>entry.source==='ably').length,1);
 assert.match(result.fileName,/^재고파일_\d{8}_\d{4}\.zip$/,'archive uses the KST inventory batch name');
 const {zip,names}=await archiveXlsx(result.blob);assert.equal(names.length,4);assert.ok(names.every(name=>name.toLowerCase().endsWith('.xlsx')));assert.ok(names.every(name=>!name.includes('/')),'all four labeled XLSX files are flat ZIP members');
 assert.equal(names.filter(name=>name.startsWith('스마트스토어_원본')).length,2);assert.equal(names.filter(name=>name.startsWith('메이크샵_')).length,1);assert.equal(names.filter(name=>name.startsWith('에이블리_')).length,1);
 const outputFiles=[];for(const name of names)outputFiles.push(asFile(name,await zip.file(name).async('uint8array')));
 const sourceParsers=h.ctx.SystemV3SellerParsers;
 const ssOut=outputFiles.filter(file=>file.name.startsWith('스마트스토어_'));assert.equal(ssOut.length,2);
 const ssParsed=[];for(const out of ssOut)ssParsed.push(await sourceParsers.parseSellerFiles('smartstore',[out],{price:true,discount:true,inventory:true}));
 const ssRows=ssParsed.flatMap(result=>result.normalizedRows);assert.equal(ssRows.length,2);assert.deepEqual(ssRows.map(row=>row.product_code).sort(),['1001','1002']);
 assert.deepEqual(ssRows.map(row=>row.stock).sort((a,b)=>a-b),[0,5]);assert.deepEqual(ssRows.map(row=>row.price).sort((a,b)=>a-b),[1025,1025]);assert.deepEqual(ssRows.map(row=>row.option_code).sort(),['5001','5002']);
 for(let index=0;index<2;index++){const before=await sheetCells(h.originals.smartstore[index]),after=await sheetCells(ssOut.find(file=>file.name.includes(`원본${index+1}_`)));assert.deepEqual([...after.keys()].sort(),[...before.keys()].sort());for(const [ref,cell] of before)if(!/^S\d+$/.test(ref))assert.equal(after.get(ref),cell,`SmartStore ${index+1} cell ${ref} must be preserved byte-for-byte`);}
 const msFile=outputFiles.find(file=>file.name.startsWith('메이크샵_'));const msParsed=await sourceParsers.parseSellerFiles('makeshop',[msFile],{price:true,discount:true,inventory:true});
 assert.equal(msParsed.normalizedRows.length,1);assert.equal(msParsed.normalizedRows[0].product_code,'2001');assert.equal(msParsed.normalizedRows[0].option_code,'5003');assert.equal(msParsed.normalizedRows[0].stock,9);assert.equal(msParsed.normalizedRows[0].price,1025);
 const makeBefore=await sheetCells(h.originals.makeshop[0]),makeAfter=await sheetCells(msFile);assert.deepEqual([...makeAfter.keys()].sort(),[...makeBefore.keys()].sort());for(const [ref,cell] of makeBefore)if(!/^AG\d+$/.test(ref))assert.equal(makeAfter.get(ref),cell,`MakeShop cell ${ref} must be preserved byte-for-byte`);
 const ablyFile=outputFiles.find(item=>item.name.startsWith('에이블리_'));const ably=await h.ctx.AblyPlayautoExport.readTemplate(ablyFile);assert.equal(ably.type,'option_price_stock');assert.equal(ably.items.length,3);
 const bySku=new Map(ably.items.map(item=>[item.option_sku_code.replace(/^sellpia_/,'').split('-')[0],item]));
 assert.equal(ably.items[0].sales_quantity,0,'available_stock -3 is clamped to zero in export only');assert.equal(ably.items[0].available_stock,88);assert.equal(ably.items[0].option_price,25);
 assert.deepEqual(ably.items.map(item=>item.sales_quantity),[0,5,null],'blank X stock remains blank');assert.deepEqual(ably.items.map(item=>item.available_stock),[88,88,88]);assert.deepEqual(ably.items.map(item=>item.option_price),[25,25,25]);
 assert.equal(h.stockBySku.get('1001-1').sellpia_available_stock,-3,'clamp does not mutate the source snapshot');
 const originalRows=await sheetRowsFromBytes(new Uint8Array(await file.arrayBuffer())),roundtripRows=await sheetRowsFromBytes(new Uint8Array(await ablyFile.arrayBuffer()));
 assert.equal(roundtripRows.length,originalRows.length);for(let row=0;row<originalRows.length;row++)for(let column=0;column<originalRows[row].length;column++)if(column!==23)assert.equal(roundtripRows[row][column]??'',originalRows[row][column]??'',`Ably row ${row+1} col ${column+1} must be preserved`);
 assert.equal(h.counts.stockRead,2,'one initial and one final shared stock snapshot read');assert.equal(h.counts.downloadCalls,1);assert.equal(h.counts.statusCalls,2);
 const readSkuSets=h.stockSkuSets.map(skus=>Array.from(skus).sort());assert.deepEqual(readSkuSets[0],['1001-1','1002-1','2001-1']);assert.deepEqual(readSkuSets[1],readSkuSets[0],'both shared stock reads query the same full SKU union');
 await writeQaOutput(result,{archiveMembers:names,sourceIdentity:result.files,rowCounts:{smartstore:ssRows.length,makeshop:msParsed.normalizedRows.length,ably:ably.items.length},stockReads:h.counts.stockRead,stockSkuSets:h.stockSkuSets.map(skus=>skus.join(','))});
});

test('stock source accepts the current-stock mode and maps its value to all carriers',async()=>{
 const h=buildHarness(),file=await makeHarnessFiles(h),result=await h.run({file,stockSource:'stock'}),{zip,names}=await archiveXlsx(result.blob);
 assert.equal(result.stockSource,'stock');assert.equal(names.length,4);
 const ablyName=names.find(name=>name.startsWith('에이블리_')),ably=await h.ctx.AblyPlayautoExport.readTemplate(asFile(ablyName,await zip.file(ablyName).async('uint8array')));
 assert.deepEqual(ably.items.map(item=>item.sales_quantity),[11,8,null]);
 const ssFiles=names.filter(name=>name.startsWith('스마트스토어_')).map(async name=>h.ctx.SystemV3SellerParsers.parseSellerFiles('smartstore',[asFile(name,await zip.file(name).async('uint8array'))],{inventory:true,price:false}));
 assert.deepEqual((await Promise.all(ssFiles)).flatMap(result=>result.normalizedRows.map(row=>row.stock)).sort((a,b)=>a-b),[8,11]);
 const msName=names.find(name=>name.startsWith('메이크샵_')),msResult=await h.ctx.SystemV3SellerParsers.parseSellerFiles('makeshop',[asFile(msName,await zip.file(msName).async('uint8array'))],{inventory:true,price:false});assert.equal(msResult.normalizedRows[0].stock,3,'MakeShop physical stock uses sellpia_current_stock');
});

test('available stock -3 clamps to zero on all matched seller exports while the source snapshot stays negative',async()=>{
 const h=buildHarness();for(const value of h.stockBySku.values())value.sellpia_available_stock=-3;
 const file=await makeHarnessFiles(h),result=await h.run({file,stockSource:'available_stock'}),{zip,names}=await archiveXlsx(result.blob);
 const ssFiles=names.filter(name=>name.startsWith('스마트스토어_')).map(async name=>h.ctx.SystemV3SellerParsers.parseSellerFiles('smartstore',[asFile(name,await zip.file(name).async('uint8array'))],{inventory:true,price:false}));
 assert.deepEqual((await Promise.all(ssFiles)).flatMap(part=>part.normalizedRows.map(row=>row.stock)),[0,0]);
 const ms=await h.ctx.SystemV3SellerParsers.parseSellerFiles('makeshop',[asFile(names.find(name=>name.startsWith('메이크샵_')),await zip.file(names.find(name=>name.startsWith('메이크샵_'))).async('uint8array'))],{inventory:true,price:false});assert.equal(ms.normalizedRows[0].stock,0);
 const ably=await h.ctx.AblyPlayautoExport.readTemplate(asFile(names.find(name=>name.startsWith('에이블리_')),await zip.file(names.find(name=>name.startsWith('에이블리_'))).async('uint8array')));assert.deepEqual(ably.items.map(item=>item.sales_quantity),[0,0,null]);
 for(const value of h.stockBySku.values())assert.equal(value.sellpia_available_stock,-3);
});

test('unchanged full originals still emit four files with unchanged worksheet XML and no warnings',async()=>{
 const h=buildHarness();h.stockBySku.set('1001-1',{sellpia_current_stock:1,sellpia_available_stock:1});h.stockBySku.set('1002-1',{sellpia_current_stock:2,sellpia_available_stock:2});h.stockBySku.set('2001-1',{sellpia_current_stock:3,sellpia_available_stock:3});
 const file=await makeHarnessFiles(h),result=await h.run({file,stockSource:'stock'}),{zip,names}=await archiveXlsx(result.blob);assert.equal(names.length,4);assert.equal(result.files.length,4);assert.equal(result.warnings.length,0);
 for(const [index,name] of names.filter(name=>name.startsWith('스마트스토어_')).entries()){const outFile=asFile(name,await zip.file(name).async('uint8array'));assert.equal(await sheetXml(h.originals.smartstore[index]),await sheetXml(outFile),'unchanged SmartStore full-original sheet is emitted intact');}
 const makeName=names.find(name=>name.startsWith('메이크샵_'));assert.equal(await sheetXml(h.originals.makeshop[0]),await sheetXml(asFile(makeName,await zip.file(makeName).async('uint8array'))));
 const ablyName=names.find(name=>name.startsWith('에이블리_')),ablyOriginal=await sheetCells(file),ablyOut=await sheetCells(asFile(ablyName,await zip.file(ablyName).async('uint8array')));assert.deepEqual([...ablyOut.keys()].sort(),[...ablyOriginal.keys()].sort());for(const [ref,cell] of ablyOriginal)assert.equal(ablyOut.get(ref),cell,`unchanged Ably cell ${ref} is preserved`);
});

test('missing Ably or required seller originals fails before generating a ZIP',async()=>{
 const missingAbly=buildHarness();await makeHarnessFiles(missingAbly);await assert.rejects(()=>missingAbly.run({file:null}),/PlayAuto.*XLSX/);assert.equal(missingAbly.counts.statusCalls,0);
 const missingMake=buildHarness({statusOverride:[{source:'smartstore',snapshotId:'ss',available:true,files:[{name:'a.xlsx'},{name:'b.xlsx'}]},{source:'makeshop',snapshotId:'ms',available:false,files:[]}]});const file=await makeHarnessFiles(missingMake);
 await assert.rejects(()=>missingMake.run({file}),/메이크샵.*공식 원본/);assert.equal(missingMake.counts.downloadCalls,0);
 const missingSmart=buildHarness({statusOverride:[{source:'smartstore',snapshotId:'ss',available:true,files:[{name:'only-one.xlsx'}]},{source:'makeshop',snapshotId:'ms',available:true,files:[{name:'make.xlsx'}]}]});
 await assert.rejects(()=>missingSmart.run({file}),/스마트스토어.*원본 2개가 필요/);assert.equal(missingSmart.counts.downloadCalls,0);assert.equal(missingSmart.counts.stockRead,0,'incomplete originals cannot reach a stock query or produce a ZIP');
});

test('ambiguous PlayAuto carrier rows warn and keep original stock while the batch still emits all four files',async()=>{
 const h=buildHarness(),file=await makeHarnessFiles(h,{duplicateCarrier:true}),result=await h.run({file,stockSource:'available_stock'}),{zip,names}=await archiveXlsx(result.blob);
 assert.equal(names.length,4);assert.ok(result.warnings.some(item=>/중복|identity|식별/i.test(item.reason||'')),'ambiguous carrier identity is reported as a warning');
 const ablyName=names.find(name=>name.startsWith('에이블리_')),parsed=await h.ctx.AblyPlayautoExport.readTemplate(asFile(ablyName,await zip.file(ablyName).async('uint8array')));
 assert.equal(parsed.items.length,4);assert.equal(parsed.items[0].sales_quantity,1);assert.equal(parsed.items[3].sales_quantity,1,'both rows with ambiguous shared carrier identity preserve original X stock');assert.equal(parsed.items[1].sales_quantity,5);assert.equal(parsed.items[2].sales_quantity,null,'blank source X remains blank');
 const inputCells=await sheetCells(file),outputCells=await sheetCells(asFile(ablyName,await zip.file(ablyName).async('uint8array')));for(const [ref,cell] of inputCells)if(!/^X\d+$/.test(ref))assert.equal(outputCells.get(ref),cell,`ambiguous carrier leaves non-X cell ${ref} unchanged`);
});

test('snapshot drift aborts the batch before the ZIP is returned',async()=>{
 const h=buildHarness({changeSecondSnapshot:true}),file=await makeHarnessFiles(h);await assert.rejects(()=>h.run({file,stockSource:'available_stock'}),/snapshot이 변경되었습니다/);assert.equal(h.counts.stockRead,2);
});
