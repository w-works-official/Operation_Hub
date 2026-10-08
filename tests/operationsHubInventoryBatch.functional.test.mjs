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
 const ablyMappings=['1001-1','1002-1','2001-1'].map((sku,index)=>({solution_code:`00${index+1}`,sellpia_sku_code:sku,product_code:'4001',option_code:sku,mapping_state:'verified',stock_policy:'shared',individual_stock:null,suppression_active:false,is_active:true}));
 const officialTemplateBytes=fs.readFileSync('mockups/operations-hub/ably-inventory-template.xlsx');
 const snapshotId='snap-1';let stockRead=0,downloadCalls=0,statusCalls=0;const stockSkuSets=[];const workflow={active:false,snapshotId:'snap-1',failNextStockRead:false,failWaitCalls:0,uploadGate:null,sessionAuthenticated:true,checkSessionCalls:0,timeline:[],uploadCalls:0,waitCalls:0,refreshCalls:[]};
 const status=[{source:'smartstore',snapshotId:'ss-1',available:true,files:[{name:'ss-a.xlsx',size:1},{name:'ss-b.xlsx',size:1}]},{source:'makeshop',snapshotId:'ms-1',available:true,files:[{name:'ms-a.xlsx',size:1}]}];
 const liveData={
  loadLatestSellerOriginalStatus:async()=>{statusCalls++;return statusOverride||structuredClone(status);},
  downloadLatestSellerOriginals:async()=>{downloadCalls++;return new Map([['smartstore',originals.smartstore],['makeshop',originals.makeshop]]);},
  loadAblyInventoryMappings:async()=>{workflow.timeline.push('ably-mapping');return {rows:ablyMappings,fingerprint:'mapping-1'};},
  loadAblyInventoryTemplateFile:async()=>{workflow.timeline.push('ably-template');return asFile('official-ably-template.xlsx',officialTemplateBytes);},
  loadCarrierSellerMappings:async({source,identities})=>({rows:identities.map(row=>{const sku=skuByIdentity.get(`${row.product_code}\u0000${row.option_code||''}`)||(/^sellpia_.+-\d+$/.test(row.seller_option_code||'')?(row.seller_option_code||'').replace(/^sellpia_/,''):null);return {...row,sku};}).filter(row=>row.sku)}),
  loadPlayautoSellpiaCatalog:async productCodes=>[...stockBySku.keys()].map((sku,index)=>({sellpia_product_code:['1001','1002','2001'][index],sellpia_sku_code:sku,sellpia_option_name:`Option ${['5001','5002','5003'][index]}`})).filter(row=>productCodes.includes(row.sellpia_product_code)),
  loadSellpiaStockSourcesForExport:async({skus})=>{stockRead++;stockSkuSets.push([...skus]);workflow.timeline.push(`stock-read-${stockRead}`);if(workflow.failNextStockRead){workflow.failNextStockRead=false;throw Error('synthetic export source failed');}const selectedSnapshot=workflow.active?workflow.snapshotId:changeSecondSnapshot&&stockRead===2?'snap-2':snapshotId;return {snapshotId:selectedSnapshot,bySku:new Map(skus.filter(sku=>stockBySku.has(sku)).map(sku=>[sku,stockBySku.get(sku)]))};},
  previewSellpiaInventoryCount:async()=>workflow.expectedPreview,
  checkOperationsHubSession:async()=>{workflow.checkSessionCalls++;workflow.timeline.push('session');return {authenticated:workflow.sessionAuthenticated};},
  uploadSellpiaInventoryCount:async(_files,expected)=>{workflow.uploadCalls++;workflow.timeline.push('upload');if(workflow.uploadGate)await workflow.uploadGate;for(const row of expected.changedRows||[]){const current=stockBySku.get(row.sellpia_sku_code);if(current)Object.assign(current,{sellpia_current_stock:row.stock,sellpia_available_stock:row.available_stock});}return {...expected,snapshotId:'snap-2',uploadMode:'inventory_count',uploadedRowCount:expected.changedRows.length,matrixAffectedSkus:['1001-1']};},
  waitForSellpiaMatrixRebuild:async id=>{workflow.waitCalls++;workflow.timeline.push('wait');if(workflow.failWaitCalls>0){workflow.failWaitCalls--;throw Error('synthetic matrix rebuild timeout');}return {matrix_snapshot_id:id,rebuild_pending:false};}
 };
 const resolverCalls=[];
 const forbiddenPriceResolver=new Proxy({}, {get(_target,method){return (...args)=>{resolverCalls.push({method:String(method),args});throw Error(`stock-only batch must not invoke current-price decision ${String(method)}`);};}});
 const ctx={console,Blob:BlobClass,File:class TestFile extends BlobClass{constructor(parts,name,options={}){super(parts,options);this.name=name;}},JSZip,Uint8Array,ArrayBuffer,TextEncoder,TextDecoder,Date,Math,Map,Set,Number,String,JSON,RegExp,Error,Promise,setTimeout,performance:{now:()=>Date.now()},CustomEvent:class CustomEvent{constructor(type,init){this.type=type;this.detail=init?.detail;}},dispatchEvent(){},liveData,sellerExportState:{running:false},formatNumber:value=>String(value),CHANNEL_LABELS:{smartstore:'스마트스토어',makeshop:'메이크샵'},window:{__systemV3InventoryBatchBusy:false,__systemV3DirectExportBusy:false,HubCurrentPriceDecisionResolver:forbiddenPriceResolver},SystemV3SellerExportBridge:{},SystemV3SellerParsers:null,HubCurrentPriceExport:null,AblyPlayautoExport:null,SystemV3SellpiaInventoryCount:null,XLSX:null,systemV3OriginalFileBoundaryDiagnostics:null,inventoryBatchRecovery:null,HubCurrentPriceDecisionResolver:forbiddenPriceResolver};
 ctx.refreshMatrixSkus=async skus=>{workflow.refreshCalls.push([...skus]);workflow.timeline.push('refresh');return [...skus];};
 ctx.globalThis=ctx;ctx.window.globalThis=ctx;ctx.window.liveData=liveData;
 ctx.JSZip=class TransportZip extends JSZip{file(name,value,...rest){return super.file(name,value instanceof BlobClass?value.arrayBuffer().then(bytes=>new Uint8Array(bytes)):value,...rest);}};
 ctx.window.JSZip=ctx.JSZip;
 vm.createContext(ctx);
 for(const name of ['sellpia-inventory-count','seller-source-parsers','seller-export-adapter','current-price-export','ably-stock-export','ably-playauto-export','ably-inventory-export'])vm.runInContext(fs.readFileSync(`mockups/operations-hub/${name}.js`,'utf8'),ctx,{filename:name+'.js'});
 ctx.SystemV3SellpiaInventoryCount=ctx.window.SystemV3SellpiaInventoryCount||ctx.SystemV3SellpiaInventoryCount;
 ctx.SystemV3SellerParsers=ctx.window.SystemV3SellerParsers;ctx.HubCurrentPriceExport=ctx.window.HubCurrentPriceExport;ctx.AblyPlayautoExport=ctx.window.AblyPlayautoExport;ctx.sellerExport=ctx.window.SystemV3SellerExport;
 ctx.window.SystemV3SellpiaInventoryCount=ctx.SystemV3SellpiaInventoryCount;ctx.window.SystemV3SellerParsers=ctx.SystemV3SellerParsers;ctx.window.HubCurrentPriceExport=ctx.HubCurrentPriceExport;ctx.window.AblyPlayautoExport=ctx.AblyPlayautoExport;ctx.window.SystemV3SellerExport=ctx.sellerExport;
 // Use the same pinned SheetJS and JSZip builds loaded by the application.
 ctx.XLSX=XLSX;
 ctx.window.XLSX=ctx.XLSX;
 ctx.window.SystemV3SellpiaInventoryCount=ctx.SystemV3SellpiaInventoryCount;
 const sellerSource=inventorySource;
 const prepare=extractFunction(sellerSource,'async function prepareChangedOnlyExport(','async function prepareChangedOnlyExport');
 const preflight=extractFunction(sellerSource,'async preflightInventoryMappings(','async function preflightInventoryMappings');
 const bridge=extractFunction(sellerSource,'async runInventoryBatch(','async function runInventoryBatch');
 const updateBridge=extractFunction(sellerSource,'async runInventoryUpdateBatch(','async function runInventoryUpdateBatch');
 const retryBridge=extractFunction(sellerSource,'async retryInventoryBatchExport(','async function retryInventoryBatchExport');
 vm.runInContext(prepare+'; this.__prepareChangedOnlyExport=prepareChangedOnlyExport;',ctx,{filename:'prepareChangedOnlyExport.js'});
 vm.runInContext(preflight+'; this.__preflightInventoryMappings=preflightInventoryMappings;',ctx,{filename:'preflightInventoryMappings.js'});
 vm.runInContext(bridge+'; this.__runInventoryBatch=runInventoryBatch;',ctx,{filename:'runInventoryBatch.js'});
 vm.runInContext(updateBridge+'; this.__runInventoryUpdateBatch=runInventoryUpdateBatch;',ctx,{filename:'runInventoryUpdateBatch.js'});
 vm.runInContext(retryBridge+'; this.__retryInventoryBatchExport=retryInventoryBatchExport;',ctx,{filename:'retryInventoryBatchExport.js'});
 ctx.SystemV3SellerExportBridge.preflightInventoryMappings=options=>ctx.__preflightInventoryMappings.call(ctx.SystemV3SellerExportBridge,options);
 ctx.SystemV3SellerExportBridge.runInventoryBatch=options=>ctx.__runInventoryBatch.call(ctx.SystemV3SellerExportBridge,options);
 ctx.SystemV3SellerExportBridge.runInventoryUpdateBatch=options=>ctx.__runInventoryUpdateBatch.call(ctx.SystemV3SellerExportBridge,options);
 ctx.SystemV3SellerExportBridge.retryInventoryBatchExport=options=>ctx.__retryInventoryBatchExport.call(ctx.SystemV3SellerExportBridge,options);
 ctx.window.__prepareChangedOnlyExport=ctx.__prepareChangedOnlyExport;
 return {ctx,run:options=>ctx.SystemV3SellerExportBridge.runInventoryBatch(options),liveData,originals,stockBySku,ablyMappings,officialTemplateBytes,status,stockSkuSets,workflow,resolverCalls,get counts(){return {stockRead,downloadCalls,statusCalls};}};
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
async function officialAblyRows(file){const book=XLSX.read(await file.arrayBuffer(),{type:'array'});assert.deepEqual(book.SheetNames,['재고 수량 수정_양식']);const sheet=book.Sheets['재고 수량 수정_양식'];assert.equal(sheet.A1.v,'솔루션사 고유코드');assert.equal(sheet.B1.v,'재고 수량');return XLSX.utils.sheet_to_json(sheet,{header:1,raw:true,defval:''}).slice(1).filter(row=>String(row[0])!=='').map(row=>({solution_code:row[0],quantity:row[1]}));}
async function assertOfficialAblyPreserved(h,file){const original=await sheetCells(asFile('official.xlsx',h.officialTemplateBytes)),output=await sheetCells(file);for(const [ref,cell] of original)if(!/^[AB]\d+$/.test(ref)||/[AB]1$/.test(ref))assert.equal(output.get(ref),cell,`official Ably guidance/non-input cell ${ref} is preserved`);}
async function writeQaOutput(result,details){
 const outputDir=process.env.INVENTORY_QA_OUTPUT;if(!outputDir)return;
 fs.mkdirSync(outputDir,{recursive:true});
 fs.writeFileSync(path.join(outputDir,'QA-fixture-inventory-batch.zip'),Buffer.from(await result.blob.arrayBuffer()));
 fs.writeFileSync(path.join(outputDir,'QA-fixture-inventory-batch-summary.json'),JSON.stringify({synthetic_fixture:true,live_data_used:false,archive_file_name:result.fileName,archive_members:details.archiveMembers,source_identity:details.sourceIdentity,stock_modes:['available_stock','stock'],matched_sku_count:result.matchedSkuCount,stock_snapshot_reads:details.stockReads,stock_snapshot_read_sku_sets:details.stockSkuSets,negative_available_stock_source:-3,negative_available_stock_export:0,source_snapshot_preserved:true,parser_row_counts:details.rowCounts,ably_solution_column:'A',ably_stock_column:'B',ably_source:'verified DB option mapping plus packaged official blank template'},null,2)+'\n','utf8');
}

async function writeInventoryUpdateQaOutput(result,details){
 const outputDir=process.env.INVENTORY_UPDATE_QA_OUTPUT;if(!outputDir)return;
 fs.mkdirSync(outputDir,{recursive:true});
 fs.writeFileSync(path.join(outputDir,'QA-fixture-inventory-update.zip'),Buffer.from(await result.blob.arrayBuffer()));
 fs.writeFileSync(path.join(outputDir,'QA-fixture-inventory-update-summary.json'),JSON.stringify({synthetic_fixture:true,live_data_used:false,upload_mode:'inventory_count',base_snapshot_id:'snap-1',export_snapshot_id:result.stockSnapshotId,stock_source:result.stockSource,uploaded_changed_sku_count:result.uploadResult.uploadedRowCount,matched_sku_count:result.matchedSkuCount,changed_row_stock_after_upload:7,unchanged_matched_sku_stock_after_upload:5,archive_file_name:result.fileName,archive_members:details.archiveMembers,parser_row_counts:details.rowCounts,upload_call_count:details.uploadCalls,matrix_refresh_calls:details.refreshCalls},null,2)+'\n','utf8');
}

test('inventory batch emits three full originals plus official Ably AB stock file without PlayAuto input',async()=>{
 const h=buildHarness();await makeHarnessFiles(h);const result=await h.run({stockSource:'available_stock'});
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
 const ablyFile=outputFiles.find(item=>item.name.startsWith('에이블리_'));const ably=await officialAblyRows(ablyFile);assert.equal(ably.length,3);
 assert.deepEqual(ably.map(item=>item.solution_code),['001','002','003'],'literal DB solution codes retain leading zeros');assert.deepEqual(ably.map(item=>item.quantity),[0,5,9],'every verified Ably shared-stock option uses the authoritative stock snapshot');
 assert.equal(h.stockBySku.get('1001-1').sellpia_available_stock,-3,'clamp does not mutate the source snapshot');
 await assertOfficialAblyPreserved(h,ablyFile);
 assert.equal(h.counts.stockRead,2,'one initial and one final shared stock snapshot read');assert.equal(h.counts.downloadCalls,1);assert.equal(h.counts.statusCalls,2);
 const readSkuSets=h.stockSkuSets.map(skus=>Array.from(skus).sort());assert.deepEqual(readSkuSets[0],['1001-1','1002-1','2001-1']);assert.deepEqual(readSkuSets[1],readSkuSets[0],'both shared stock reads query the same full SKU union');
 await writeQaOutput(result,{archiveMembers:names,sourceIdentity:result.files,rowCounts:{smartstore:ssRows.length,makeshop:msParsed.normalizedRows.length,ably:ably.length},stockReads:h.counts.stockRead,stockSkuSets:h.stockSkuSets.map(skus=>skus.join(','))});
});

test('stock source accepts the current-stock mode and maps its value to all carriers',async()=>{
 const h=buildHarness(),file=await makeHarnessFiles(h),result=await h.run({file,stockSource:'stock'}),{zip,names}=await archiveXlsx(result.blob);
 assert.equal(result.stockSource,'stock');assert.equal(names.length,4);
 const ablyName=names.find(name=>name.startsWith('에이블리_')),ably=await officialAblyRows(asFile(ablyName,await zip.file(ablyName).async('uint8array')));
 assert.deepEqual(ably.map(item=>item.quantity),[11,8,3]);
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
 const ably=await officialAblyRows(asFile(names.find(name=>name.startsWith('에이블리_')),await zip.file(names.find(name=>name.startsWith('에이블리_'))).async('uint8array')));assert.deepEqual(ably.map(item=>item.quantity),[0,0,0]);
 for(const value of h.stockBySku.values())assert.equal(value.sellpia_available_stock,-3);
});

test('unchanged full originals still emit four files with unchanged worksheet XML and no warnings',async()=>{
 const h=buildHarness();h.stockBySku.set('1001-1',{sellpia_current_stock:1,sellpia_available_stock:1});h.stockBySku.set('1002-1',{sellpia_current_stock:2,sellpia_available_stock:2});h.stockBySku.set('2001-1',{sellpia_current_stock:3,sellpia_available_stock:3});
 const file=await makeHarnessFiles(h),result=await h.run({file,stockSource:'stock'}),{zip,names}=await archiveXlsx(result.blob);assert.equal(names.length,4);assert.equal(result.files.length,4);assert.equal(result.warnings.length,0);
 for(const [index,name] of names.filter(name=>name.startsWith('스마트스토어_')).entries()){const outFile=asFile(name,await zip.file(name).async('uint8array'));assert.equal(await sheetXml(h.originals.smartstore[index]),await sheetXml(outFile),'unchanged SmartStore full-original sheet is emitted intact');}
 const makeName=names.find(name=>name.startsWith('메이크샵_'));assert.equal(await sheetXml(h.originals.makeshop[0]),await sheetXml(asFile(makeName,await zip.file(makeName).async('uint8array'))));
 const ablyName=names.find(name=>name.startsWith('에이블리_')),ablyFile=asFile(ablyName,await zip.file(ablyName).async('uint8array'));assert.deepEqual((await officialAblyRows(ablyFile)).map(item=>item.quantity),[1,2,3]);await assertOfficialAblyPreserved(h,ablyFile);
});

test('missing Ably mapping or required seller originals fails before generating a ZIP',async()=>{
 const missingAbly=buildHarness();await makeHarnessFiles(missingAbly);missingAbly.ablyMappings.splice(0);await assert.rejects(()=>missingAbly.run({}),/매핑/);assert.equal(missingAbly.counts.downloadCalls,0);assert.equal(missingAbly.counts.stockRead,0);
 const missingMake=buildHarness({statusOverride:[{source:'smartstore',snapshotId:'ss',available:true,files:[{name:'a.xlsx'},{name:'b.xlsx'}]},{source:'makeshop',snapshotId:'ms',available:false,files:[]}]});const file=await makeHarnessFiles(missingMake);
 await assert.rejects(()=>missingMake.run({file}),/메이크샵.*공식 원본/);assert.equal(missingMake.counts.downloadCalls,0);
 const missingSmart=buildHarness({statusOverride:[{source:'smartstore',snapshotId:'ss',available:true,files:[{name:'only-one.xlsx'}]},{source:'makeshop',snapshotId:'ms',available:true,files:[{name:'make.xlsx'}]}]});
 await assert.rejects(()=>missingSmart.run({file}),/스마트스토어.*원본 2개가 필요/);assert.equal(missingSmart.counts.downloadCalls,0);assert.equal(missingSmart.counts.stockRead,0,'incomplete originals cannot reach a stock query or produce a ZIP');
});

test('review-only duplicate rawcodes are excluded while safe official Ably mappings still emit four files',async()=>{
 const h=buildHarness();await makeHarnessFiles(h);h.ablyMappings.push({...h.ablyMappings[0],solution_code:'review-duplicate',mapping_state:'review'},{...h.ablyMappings[1],solution_code:'review-duplicate',mapping_state:'review'});
 const result=await h.run({stockSource:'available_stock'}),{zip,names}=await archiveXlsx(result.blob);assert.equal(names.length,4);assert.equal(result.ablySummary.reviewCount,2);
 const ablyName=names.find(name=>name.startsWith('에이블리_')),parsed=await officialAblyRows(asFile(ablyName,await zip.file(ablyName).async('uint8array')));assert.deepEqual(parsed.map(item=>[item.solution_code,item.quantity]),[['001',0],['002',5],['003',9]]);
});

test('snapshot drift aborts the batch before the ZIP is returned',async()=>{
 const h=buildHarness({changeSecondSnapshot:true}),file=await makeHarnessFiles(h);await assert.rejects(()=>h.run({file,stockSource:'available_stock'}),/snapshot이 변경되었습니다/);assert.equal(h.counts.stockRead,2);
});

test('inventory update uploads once, waits for snapshot B, refreshes affected Matrix SKUs, then exports and reopens four XLSX files from B',async()=>{
 const h=buildHarness(),ablyFile=await makeHarnessFiles(h),countFile=asFile('inventory-count.xlsx',new Uint8Array([1,2,3]));
 const expectedPreview={baseSnapshotId:'snap-1',fingerprint:'proof-A',summary:{changedSkuCount:1,errorRowCount:0,duplicateConflictCount:0},changedRows:[{sellpia_sku_code:'1001-1',stock:10,available_stock:7}]};
 h.workflow.active=true;h.workflow.snapshotId='snap-2';h.workflow.expectedPreview=expectedPreview;
 const result=await h.ctx.SystemV3SellerExportBridge.runInventoryUpdateBatch({files:[countFile],expectedPreview,file:ablyFile,stockSource:'available_stock'});
 assert.equal(h.workflow.uploadCalls,1);assert.equal(h.workflow.checkSessionCalls,1);assert.equal(h.workflow.waitCalls,1);assert.equal(result.stockSnapshotId,'snap-2');assert.equal(result.uploadResult.snapshotId,'snap-2');
 assert.deepEqual(h.resolverCalls,[],'stock-only batch never invokes current-price decision normalization or proof logic');
 assert.deepEqual(h.workflow.refreshCalls,[['1001-1']]);
 assert.deepEqual(h.workflow.timeline,['session','ably-mapping','ably-template','upload','wait','refresh','stock-read-1','stock-read-2','ably-mapping']);
 const {zip,names}=await archiveXlsx(result.blob);assert.equal(names.length,4);assert.ok(names.every(name=>name.endsWith('.xlsx')));
 const parsed=[];for(const name of names){const file=asFile(name,await zip.file(name).async('uint8array'));if(name.startsWith('스마트스토어_'))parsed.push(...(await h.ctx.SystemV3SellerParsers.parseSellerFiles('smartstore',[file],{inventory:true,price:false})).normalizedRows);else if(name.startsWith('메이크샵_')){const makeRows=(await h.ctx.SystemV3SellerParsers.parseSellerFiles('makeshop',[file],{inventory:true,price:false})).normalizedRows;assert.equal(makeRows.length,1);assert.equal(makeRows[0].stock,9);}else{const ably=await officialAblyRows(file);assert.equal(ably.length,3);assert.deepEqual(ably.map(row=>[row.solution_code,row.quantity]),[['001',7],['002',5],['003',9]],'the uploaded changed row and every unchanged matched option use snapshot B');await assertOfficialAblyPreserved(h,file);}}
 assert.equal(parsed.length,2);assert.deepEqual(parsed.map(row=>row.stock).sort((a,b)=>a-b),[5,7],'the changed row comes from B and the SKU absent from the changed-row list remains in the full-original export');
 await writeInventoryUpdateQaOutput(result,{archiveMembers:names,rowCounts:{smartstore:parsed.length,makeshop:1,ably:3},uploadCalls:h.workflow.uploadCalls,refreshCalls:h.workflow.refreshCalls});
 const retriedAfterDownloadFailure=await h.ctx.SystemV3SellerExportBridge.runInventoryUpdateBatch({files:[countFile],expectedPreview,file:ablyFile,stockSource:'available_stock'});
 assert.equal(h.workflow.uploadCalls,1,'re-running the same confirmed proof after a client-side download failure reuses the completed upload');
 assert.equal(retriedAfterDownloadFailure.uploaded,true);assert.equal(retriedAfterDownloadFailure.stockSnapshotId,'snap-2');
 assert.equal((await archiveXlsx(retriedAfterDownloadFailure.blob)).names.length,4);
});

test('inventory update clamps negative available stock across every matched XLSX while preserving negative snapshot values',async()=>{
 const h=buildHarness(),ablyFile=await makeHarnessFiles(h),countFile=asFile('negative-count.xlsx',new Uint8Array([1,2,3]));
 for(const row of h.stockBySku.values())row.sellpia_available_stock=-3;
 const expectedPreview={baseSnapshotId:'snap-1',fingerprint:'proof-negative',summary:{changedSkuCount:1,errorRowCount:0,duplicateConflictCount:0},changedRows:[{sellpia_sku_code:'1001-1',stock:10,available_stock:-3}]};
 h.workflow.active=true;h.workflow.snapshotId='snap-2';h.workflow.expectedPreview=expectedPreview;
 const result=await h.ctx.SystemV3SellerExportBridge.runInventoryUpdateBatch({files:[countFile],expectedPreview,file:ablyFile,stockSource:'available_stock'});
 const {zip,names}=await archiveXlsx(result.blob);assert.equal(names.length,4);
 const smartRows=[];
 for(const name of names){
  const file=asFile(name,await zip.file(name).async('uint8array'));
  if(name.startsWith('스마트스토어_'))smartRows.push(...(await h.ctx.SystemV3SellerParsers.parseSellerFiles('smartstore',[file],{inventory:true,price:false})).normalizedRows);
  else if(name.startsWith('메이크샵_'))assert.equal((await h.ctx.SystemV3SellerParsers.parseSellerFiles('makeshop',[file],{inventory:true,price:false})).normalizedRows[0].stock,0);
  else assert.deepEqual((await officialAblyRows(file)).map(item=>item.quantity),[0,0,0]);
 }
 assert.deepEqual(smartRows.map(row=>row.stock),[0,0]);
 for(const value of h.stockBySku.values())assert.equal(value.sellpia_available_stock,-3,'export clamp never mutates snapshot source values');
});

test('inventory update rejects preview errors before upload and rejects stale base snapshot A after the upload boundary',async()=>{
 const invalid=buildHarness(),invalidFile=await makeHarnessFiles(invalid),invalidPreview={baseSnapshotId:'snap-1',fingerprint:'fatal',summary:{errorRowCount:1,duplicateConflictCount:0},changedRows:[{sellpia_sku_code:'1001-1'}]};
 await assert.rejects(()=>invalid.ctx.SystemV3SellerExportBridge.runInventoryUpdateBatch({files:[asFile('count.xlsx',new Uint8Array([1]))],expectedPreview:invalidPreview,file:invalidFile}),/숫자 오류|중복 충돌/);
 assert.equal(invalid.workflow.uploadCalls,0);assert.equal(invalid.counts.stockRead,0);

 const duplicate=buildHarness(),duplicateFile=await makeHarnessFiles(duplicate),duplicatePreview={baseSnapshotId:'snap-1',fingerprint:'duplicate',summary:{errorRowCount:0,duplicateConflictCount:1},changedRows:[{sellpia_sku_code:'1001-1'}]};
 await assert.rejects(()=>duplicate.ctx.SystemV3SellerExportBridge.runInventoryUpdateBatch({files:[asFile('count.xlsx',new Uint8Array([1]))],expectedPreview:duplicatePreview,file:duplicateFile}),/숫자 오류|중복 충돌/);
 assert.equal(duplicate.workflow.uploadCalls,0);assert.equal(duplicate.counts.stockRead,0);

 const stale=buildHarness(),staleFile=await makeHarnessFiles(stale),preview={baseSnapshotId:'snap-1',fingerprint:'proof-stale',summary:{errorRowCount:0,duplicateConflictCount:0},changedRows:[{sellpia_sku_code:'1001-1'}]};
 stale.workflow.active=true;stale.workflow.snapshotId='snap-1';stale.workflow.expectedPreview=preview;
 await assert.rejects(()=>stale.ctx.SystemV3SellerExportBridge.runInventoryUpdateBatch({files:[asFile('count.xlsx',new Uint8Array([1]))],expectedPreview:preview,file:staleFile}),/업로드\/미리보기 기준과 달라 ZIP을 만들지 않았습니다/);
 assert.equal(stale.workflow.uploadCalls,1);assert.equal(stale.workflow.waitCalls,1);assert.equal(stale.counts.stockRead,1);

 const invalidAbly=buildHarness(),fatalAbly=asFile('not-an-ably-template.xlsx',new Uint8Array([7,8,9])),validPreview={baseSnapshotId:'snap-1',fingerprint:'proof-valid',summary:{errorRowCount:0,duplicateConflictCount:0},changedRows:[{sellpia_sku_code:'1001-1'}]};
 invalidAbly.workflow.active=true;invalidAbly.workflow.snapshotId='snap-2';invalidAbly.workflow.expectedPreview=validPreview;
 await makeHarnessFiles(invalidAbly);invalidAbly.liveData.loadAblyInventoryTemplateFile=async()=>fatalAbly;
 await assert.rejects(()=>invalidAbly.ctx.SystemV3SellerExportBridge.runInventoryUpdateBatch({files:[asFile('count.xlsx',new Uint8Array([1]))],expectedPreview:validPreview}));
 assert.equal(invalidAbly.workflow.uploadCalls,0,'invalid packaged official Ably workbook is rejected before the DB write');assert.equal(invalidAbly.counts.stockRead,0);
});

test('missing required SmartStore or MakeShop originals fail before inventory upload',async()=>{
 const preview={baseSnapshotId:'snap-1',fingerprint:'proof-originals',summary:{errorRowCount:0,duplicateConflictCount:0},changedRows:[{sellpia_sku_code:'1001-1'}]};
 const cases=[
  [[{source:'smartstore',snapshotId:'ss-1',available:false,files:[]},{source:'makeshop',snapshotId:'ms-1',available:true,files:[{name:'make.xlsx',size:1}]}],/스마트스토어/],
  [[{source:'smartstore',snapshotId:'ss-1',available:true,files:[{name:'ss-a.xlsx',size:1},{name:'ss-b.xlsx',size:1}]},{source:'makeshop',snapshotId:'ms-1',available:false,files:[]}],/메이크샵/]
 ];
 for(const [status,expected] of cases){
  const h=buildHarness({statusOverride:status}),ably=asFile('ably.xlsx',new Uint8Array([1]));
  await assert.rejects(()=>h.ctx.SystemV3SellerExportBridge.runInventoryUpdateBatch({files:[asFile('count.xlsx',new Uint8Array([2]))],expectedPreview:preview,file:ably}),expected);
  assert.equal(h.workflow.uploadCalls,0);assert.equal(h.counts.stockRead,0);
 }
});

test('new inventory update rechecks authentication before upload and prevents concurrent duplicate submits',async()=>{
 const unauthenticated=buildHarness(),file=await makeHarnessFiles(unauthenticated),preview={baseSnapshotId:'snap-1',fingerprint:'auth-proof',summary:{errorRowCount:0,duplicateConflictCount:0},changedRows:[{sellpia_sku_code:'1001-1'}]};
 unauthenticated.workflow.sessionAuthenticated=false;unauthenticated.workflow.expectedPreview=preview;
 await assert.rejects(()=>unauthenticated.ctx.SystemV3SellerExportBridge.runInventoryUpdateBatch({files:[asFile('count.xlsx',new Uint8Array([1]))],expectedPreview:preview,file}),/세션이 만료|다시 로그인/);
 assert.equal(unauthenticated.workflow.checkSessionCalls,1);assert.equal(unauthenticated.workflow.uploadCalls,0);assert.equal(unauthenticated.counts.stockRead,0);

 const h=buildHarness(),ablyFile=await makeHarnessFiles(h),deferred={};deferred.promise=new Promise(resolve=>{deferred.resolve=resolve;});
 h.workflow.active=true;h.workflow.snapshotId='snap-2';h.workflow.expectedPreview=preview;h.workflow.uploadGate=deferred.promise;
 const options={files:[asFile('count.xlsx',new Uint8Array([1]))],expectedPreview:preview,file:ablyFile};
 const first=h.ctx.SystemV3SellerExportBridge.runInventoryUpdateBatch(options);
 await new Promise(resolve=>setTimeout(resolve,0));
 await assert.rejects(()=>h.ctx.SystemV3SellerExportBridge.runInventoryUpdateBatch(options),/다른 내보내기 작업/);
 deferred.resolve();await first;
 assert.equal(h.workflow.uploadCalls,1,'the busy guard allows only one concurrent inventory upload');
});

test('no-change inventory preview skips upload and exports the current complete four-file batch',async()=>{
 const h=buildHarness(),file=await makeHarnessFiles(h),countFile=asFile('same-count.xlsx',new Uint8Array([2]));
 const expectedPreview={baseSnapshotId:'snap-1',fingerprint:'proof-no-change',summary:{changedSkuCount:0,errorRowCount:0,duplicateConflictCount:0},changedRows:[]};
 h.workflow.active=true;h.workflow.snapshotId='snap-1';h.workflow.expectedPreview=expectedPreview;
 const result=await h.ctx.SystemV3SellerExportBridge.runInventoryUpdateBatch({files:[countFile],expectedPreview,file,stockSource:'stock'});
 assert.equal(h.workflow.uploadCalls,0);assert.equal(h.workflow.waitCalls,1);assert.equal(h.workflow.refreshCalls.length,0);assert.equal(result.stockSnapshotId,'snap-1');
 assert.deepEqual(h.workflow.timeline,['session','ably-mapping','ably-template','wait','stock-read-1','stock-read-2','ably-mapping'],'the unchanged path preflights mapping/template and waits for the current base snapshot without writing or refreshing affected SKUs');
 const {zip,names}=await archiveXlsx(result.blob);assert.equal(names.length,4);assert.ok(names.every(name=>name.endsWith('.xlsx')));
 for(const name of names.filter(name=>name.startsWith('스마트스토어_'))){const parsed=await h.ctx.SystemV3SellerParsers.parseSellerFiles('smartstore',[asFile(name,await zip.file(name).async('uint8array'))],{inventory:true,price:false});assert.equal(parsed.normalizedRows.length,1);}
});

test('export failure after a ready inventory upload can retry from retained snapshot B without uploading again',async()=>{
 const h=buildHarness(),file=await makeHarnessFiles(h),countFile=asFile('inventory-count.xlsx',new Uint8Array([4,5,6]));
 const expectedPreview={baseSnapshotId:'snap-1',fingerprint:'proof-retry',summary:{errorRowCount:0,duplicateConflictCount:0},changedRows:[{sellpia_sku_code:'1001-1',stock:10,available_stock:7}]};
 h.workflow.active=true;h.workflow.snapshotId='snap-2';h.workflow.expectedPreview=expectedPreview;h.workflow.failNextStockRead=true;
 await assert.rejects(()=>h.ctx.SystemV3SellerExportBridge.runInventoryUpdateBatch({files:[countFile],expectedPreview,file,stockSource:'available_stock'}),error=>error.code==='INVENTORY_EXPORT_FAILED_AFTER_UPDATE'&&error.uploaded&&error.retryAvailable);
 assert.equal(h.workflow.uploadCalls,1);assert.equal(h.counts.stockRead,1);
 const retried=await h.ctx.SystemV3SellerExportBridge.retryInventoryBatchExport({stockSource:'available_stock'});
 assert.equal(h.workflow.uploadCalls,1,'retry uses the retained successful DB upload');assert.equal(retried.uploaded,true);assert.equal(retried.stockSnapshotId,'snap-2');assert.equal(h.workflow.checkSessionCalls,2,'retry validates the current Operations Hub session again');
 const {names}=await archiveXlsx(retried.blob);assert.equal(names.length,4);
});

test('matrix rebuild timeout can be retried from the completed upload without a second upload',async()=>{
 const h=buildHarness(),file=await makeHarnessFiles(h),countFile=asFile('inventory-count.xlsx',new Uint8Array([5]));
 const expectedPreview={baseSnapshotId:'snap-1',fingerprint:'proof-wait-retry',summary:{errorRowCount:0,duplicateConflictCount:0},changedRows:[{sellpia_sku_code:'1001-1',stock:10,available_stock:7}]};
 h.workflow.active=true;h.workflow.snapshotId='snap-2';h.workflow.expectedPreview=expectedPreview;h.workflow.failWaitCalls=1;
 await assert.rejects(()=>h.ctx.SystemV3SellerExportBridge.runInventoryUpdateBatch({files:[countFile],expectedPreview,file}),error=>error.code==='INVENTORY_EXPORT_FAILED_AFTER_UPDATE'&&error.uploaded&&error.retryAvailable);
 assert.equal(h.workflow.uploadCalls,1);assert.equal(h.workflow.waitCalls,1);assert.equal(h.counts.stockRead,0);
 const result=await h.ctx.SystemV3SellerExportBridge.retryInventoryBatchExport({});
 assert.equal(h.workflow.uploadCalls,1);assert.equal(h.workflow.waitCalls,2);assert.equal(result.stockSnapshotId,'snap-2');assert.equal(h.counts.stockRead,2);
});

test('separate legacy PlayAuto option workflow retains V/W and blank X while updating only safe X stock',async()=>{
 const h=buildHarness(),file=await makeHarnessFiles(h,{duplicateCarrier:true}),carrier=await h.ctx.AblyPlayautoExport.readTemplate(file);
 const items=carrier.items.map((item,index)=>h.ctx.AblyPlayautoExport.prepareStockOnlyRow({...item,resolution:{sku:['1001-1','1002-1','2001-1','1001-1'][index]},...(index===0||index===3?{carrier_identity_error:'duplicate identity'}:{})},h.stockBySku.get(['1001-1','1002-1','2001-1','1001-1'][index]),{stockSource:'available_stock'}));
 const blob=await h.ctx.AblyPlayautoExport.buildOptionPriceStock(file,items),out=asFile('legacy-playauto.xlsx',new Uint8Array(await blob.arrayBuffer())),parsed=await h.ctx.AblyPlayautoExport.readTemplate(out);
 assert.deepEqual(parsed.items.map(item=>item.sales_quantity),[1,5,null,1],'ambiguous duplicate identities and blank source X are preserved');assert.deepEqual(parsed.items.map(item=>item.option_price),[25,25,25,25]);assert.deepEqual(parsed.items.map(item=>item.available_stock),[88,88,88,88]);
 const before=await sheetRowsFromBytes(new Uint8Array(await file.arrayBuffer())),after=await sheetRowsFromBytes(new Uint8Array(await out.arrayBuffer()));assert.equal(after.length,before.length);for(let row=0;row<before.length;row++)for(let column=0;column<before[row].length;column++)if(column!==23)assert.equal(after[row][column]??'',before[row][column]??'',`legacy non-X value ${row+1}/${column+1} preserved`);
});
