import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url),JSZip=require('./vendor/jszip-3.10.1.min.js'),XLSX=require('./vendor/xlsx-0.18.5.full.min.js');
const app=()=>fs.readFileSync(path.join(repo,'mockups/operations-hub/app.js'),'utf8');
class TestFile extends Blob{constructor(parts,name,options={}){super(parts,options);this.name=name;}}
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
function extract(name,method=false){
 const source=app(),signature=`async ${method?'':'function '}${name}(`,start=source.indexOf(signature);assert.ok(start>=0,`Missing ${signature}`);
 const paren=source.indexOf('(',start),close=matchBracket(source,paren,'(',')'),body=source.indexOf('{',close),end=matchBracket(source,body,'{','}');
 return `async function ${name}`+source.slice(paren,end+1);
}
function file(name,rows){const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(rows),'Sheet1');return new TestFile([XLSX.write(book,{type:'buffer',bookType:'xlsx'})],name);}
function smartFile(name,product,option,stock){
 const header=Array(68).fill(null),row=Array(68).fill(null);Object.assign(header,{0:'상품번호',1:'판매자 상품코드',18:'옵션 재고수량'});Object.assign(row,{0:product,1:`sellpia_${product}`,3:`Product ${product}`,5:1000,15:option,16:`Option ${option}`,17:0,18:stock,19:'Y'});return file(name,[header,row]);
}
function makeFile(){
 const header=Array(124).fill(null),row=Array(124).fill(null);Object.assign(header,{4:'product_uid',32:'sto_stock',44:'sell_price'});Object.assign(row,{4:'2001',12:'Make product',29:'Make option',31:0,32:3,39:'sellpia_2001',41:'판매',43:'5003',44:1000});return file('make.xlsx',[header,row]);
}

function harness({mappingRows=null,mappingDrift=false,templateError=false,failMatrixOnce=false,stockDrift=false,quantityDrift=false,changed=true}={}){
 const timeline=[],downloads=[],audit=[],priceCalls=[],stocks=new Map([['S-A',{sellpia_current_stock:8,sellpia_available_stock:6}],['S-B',{sellpia_current_stock:4,sellpia_available_stock:3}],['S-C',{sellpia_current_stock:7,sellpia_available_stock:5}]]);
 const official=fs.readFileSync(path.join(repo,'mockups/operations-hub/ably-inventory-template.xlsx'));
 const files=new Map([['smartstore',[smartFile('smart1.xlsx','1001','5001',1),smartFile('smart2.xlsx','1002','5002',2)]],['makeshop',[makeFile()]]]);
 const statuses=[...files].map(([source,originals])=>({source,snapshotId:`original-${source}`,available:true,files:originals.map(file=>({name:file.name,size:file.size}))}));
 const defaultMapping=[{solution_code:'J-0001',sellpia_sku_code:'S-A',product_code:'AP-1',option_code:'AO-1',mapping_state:'verified',stock_policy:'shared',individual_stock:null,suppression_active:false,is_active:true}];
 const expected={fingerprint:'count-file-fingerprint',baseSnapshotId:'stock-before',summary:{errorRowCount:0,duplicateConflictCount:0},changedRows:changed?[{sellpia_sku_code:'S-A',stock:13,available_stock:11}]:[]};
 let currentSnapshot='stock-before',mappingReads=0,stockReads=0,uploads=0,matrixReads=0;
 const liveData={
  async checkOperationsHubSession(){timeline.push('session');return {authenticated:true};},
  async loadLatestSellerOriginalStatus(){timeline.push('original-status');return statuses;},
  async downloadLatestSellerOriginals(){timeline.push('original-download');return files;},
  async loadAblyInventoryMappings(){timeline.push('ably-mapping');mappingReads++;return {rows:mappingRows??defaultMapping,fingerprint:mappingDrift&&mappingReads>1?'mapping-new':'mapping-1'};},
  async loadAblyInventoryTemplateFile(){timeline.push('ably-template');if(templateError)throw Error('official template unavailable');return new TestFile([official],'official.xlsx');},
  async loadCarrierSellerMappings({source,identities}){timeline.push(`carrier-mapping-${source}`);return {rows:identities.map(row=>({...row,sku:source==='makeshop'?'S-C':row.product_code==='1001'?'S-A':'S-B'}))};},
  async loadSellpiaStockSourcesForExport({skus}){timeline.push('stock-read');stockReads++;return {snapshotId:stockDrift&&stockReads>1?'unexpected-snapshot':currentSnapshot,bySku:new Map(skus.filter(sku=>stocks.has(sku)).map(sku=>[sku,{...stocks.get(sku),...(quantityDrift&&stockReads>1?{sellpia_available_stock:12345}:{})}]))};},
  async previewSellpiaInventoryCount(){timeline.push('count-repreview');return expected;},
  async uploadSellpiaInventoryCount(_files,preview){timeline.push('stock-upload');uploads++;assert.equal(preview,expected);currentSnapshot='stock-after';for(const row of preview.changedRows)stocks.set(row.sellpia_sku_code,{sellpia_current_stock:row.stock,sellpia_available_stock:row.available_stock});return {...preview,snapshotId:currentSnapshot,uploadedRowCount:preview.changedRows.length,matrixAffectedSkus:preview.changedRows.map(row=>row.sellpia_sku_code)};},
  async waitForSellpiaMatrixRebuild(id){timeline.push('matrix-wait');matrixReads++;if(failMatrixOnce&&matrixReads===1)throw Error('matrix rebuild timed out');return {matrix_snapshot_id:id,rebuild_pending:false};},
  async recordStockExportAudit(value){timeline.push('audit');audit.push(value);return {id:'audit-1'};},
  async loadCarrierMatrixTargets(){priceCalls.push('targets');throw Error('price targets are forbidden in inventory path');},
  async loadCurrentPriceDecisions(){priceCalls.push('decisions');throw Error('price decisions are forbidden in inventory path');},
  async loadSellpiaSourcePricesForExport(){priceCalls.push('source');throw Error('source prices are forbidden in inventory path');}
 };
 class TransportZip extends JSZip{file(name,value,...rest){return super.file(name,value instanceof Blob?value.arrayBuffer().then(buffer=>new Uint8Array(buffer)):value,...rest);}}
 const context={console,Blob,File:TestFile,JSZip:TransportZip,XLSX,Map,Set,Number,String,JSON,RegExp,Error,Promise,Uint8Array,ArrayBuffer,TextEncoder,TextDecoder,Date,Math,Intl,crypto:globalThis.crypto,setTimeout,performance:{now:()=>Date.now()},CustomEvent:class{constructor(type,init){this.type=type;this.detail=init?.detail;}},dispatchEvent(){},liveData,sellerExportState:{running:false},formatNumber:String,CHANNEL_LABELS:{smartstore:'스마트스토어',makeshop:'메이크샵'},__systemV3InventoryBatchBusy:false,__systemV3DirectExportBusy:false};
 context.globalThis=context;context.window=context;context.refreshMatrixSkus=async skus=>{timeline.push('matrix-refresh');return skus;};
 vm.createContext(context);
 for(const name of ['sellpia-inventory-count','seller-source-parsers','seller-export-adapter','current-price-export','ably-inventory-export'])vm.runInContext(fs.readFileSync(path.join(repo,`mockups/operations-hub/${name}.js`),'utf8'),context,{filename:name+'.js'});
 context.sellerExport=context.SystemV3SellerExport;
 context.sellerExport={...context.sellerExport,downloadBlob(blob,name){timeline.push('download');downloads.push({blob,name});}};
 vm.runInContext('let inventoryBatchRecovery=null;'+extract('prepareChangedOnlyExport')+extract('preflightInventoryMappings',true)+extract('runInventoryBatch',true)+extract('runInventoryUpdateBatch',true)+extract('retryInventoryBatchExport',true)+';this.bridge={preflightInventoryMappings,runInventoryBatch,runInventoryUpdateBatch,retryInventoryBatchExport};',context);
 const previewFile=file('count.xlsx',[['상품코드','가용재고','재고'],['S-A',11,13]]);
 return {context,bridge:context.bridge,expected,previewFile,timeline,downloads,audit,priceCalls,files,stocks,get uploads(){return uploads;},get stockReads(){return stockReads;}};
}

test('integrated target_all serializes a safe selected unchanged row while changed_only has no output',async()=>{
 const h=harness();h.stocks.set('S-A',{sellpia_current_stock:1,sellpia_available_stock:1});
 const request={download:false,includePrice:false,includeStock:true,stockSource:'available_stock'};
 const all=await h.context.prepareChangedOnlyExport('smartstore',['S-A'],{...request,mode:'target_all'});
 assert.equal(all.outputs.length,1);assert.equal(all.changedItems.length,0);assert.equal(all.selectedRows.length,1);assert.equal(all.selectedRows[0].sku,'S-A');assert.equal(all.selectedRows[0].export_scope_selected,true);
 const parsed=await h.context.SystemV3SellerParsers.parseSellerFiles('smartstore',[new TestFile([all.outputs[0].blob],all.outputs[0].file.name)],{price:false,inventory:true});
 assert.equal(parsed.normalizedRows.length,1);assert.equal(parsed.normalizedRows[0].product_code,'1001');assert.equal(parsed.normalizedRows[0].stock,1);
 const changed=await h.context.prepareChangedOnlyExport('smartstore',['S-A'],{...request,mode:'changed_only'});
 assert.equal(changed.outputs.length,0);assert.equal(changed.changedItems.length,0);assert.deepEqual(h.priceCalls,[]);
});

test('integrated selected row count and applied change cell count remain independent across original files',async()=>{
 const h=harness();h.stocks.set('S-A',{sellpia_current_stock:9,sellpia_available_stock:9});h.stocks.set('S-B',{sellpia_current_stock:2,sellpia_available_stock:2});
 const request={download:false,includePrice:false,includeStock:true,stockSource:'available_stock'};
 const all=await h.context.prepareChangedOnlyExport('smartstore',['S-A','S-B'],{...request,mode:'target_all'});
 assert.equal(all.outputs.length,2);assert.equal(all.selectedRows.length,2);assert.equal(all.changedItems.length,1);
 assert.deepEqual(Array.from(all.changedItems,row=>[row.sellpia_sku_code,row.field_key,row.after_value]),[['S-A','sellpia_current_stock',9]]);
 const changed=await h.context.prepareChangedOnlyExport('smartstore',['S-A','S-B'],{...request,mode:'changed_only'});
 assert.equal(changed.outputs.length,1);assert.equal(changed.changedItems.length,1);assert.deepEqual(h.priceCalls,[]);
});

test('integrated combined price and stock export honors both stock criteria and preserves uninstructed prices in reopened XLSX',async()=>{
 const h=harness();h.context.liveData.loadCarrierMatrixTargets=async()=>({rows:[]});h.context.liveData.loadCurrentPriceDecisions=async()=>({rows:[],groups:[]});
 for(const [stockSource,expectedStock] of [['stock',8],['available_stock',6]]){
  const result=await h.context.prepareChangedOnlyExport('smartstore',['S-A'],{download:false,mode:'target_all',includePrice:true,includeStock:true,stockSource});
  assert.equal(result.outputs.length,1);assert.equal(result.stockSource,stockSource);assert.equal(result.changedItems.length,1);assert.equal(result.changedItems[0].field_key,'sellpia_current_stock');
  const parsed=await h.context.SystemV3SellerParsers.parseSellerFiles('smartstore',[new TestFile([result.outputs[0].blob],result.outputs[0].file.name)],{price:true,inventory:true});
  assert.equal(parsed.normalizedRows[0].stock,expectedStock);assert.equal(parsed.normalizedRows[0].price,1000);
 }
});

test('integrated real MakeShop target_all retains physical continuation rows and counts data separately from English metadata',async()=>{
 const h=harness(),korean=Array(124).fill(null),english=Array(124).fill(null),parent=Array(124).fill(null),continuation=Array(124).fill(null),other=Array(124).fill(null);
 Object.assign(korean,{4:'상품 고유번호',32:'옵션별 재고',44:'판매가격'});Object.assign(english,{4:'product_uid',32:'sto_stock',43:'sto_uid',44:'sell_price'});
 Object.assign(parent,{4:'2001',12:'Selected product',29:'First option',31:0,32:3,39:'sellpia_2001',41:'판매',43:'5003',44:1000});Object.assign(continuation,{29:'Physical continuation',31:100,32:2,43:'5004'});Object.assign(other,{4:'2002',12:'Other product',29:'Other option',31:0,32:5,43:'5005',44:900});
 const original=file('official-two-header-make.xlsx',[korean,english,parent,continuation,other]);
 h.context.liveData.loadCarrierSellerMappings=async({identities})=>({rows:identities.filter(row=>row.product_code==='2001'||row.product_code==='2002').map(row=>({...row,sku:row.option_code==='5003'?'S-C':row.option_code==='5004'?'S-B':'S-A'}))});
 const result=await h.context.prepareChangedOnlyExport('makeshop',['S-C'],{download:false,mode:'target_all',includePrice:false,includeStock:true,stockSource:'stock',filesBySourceOverride:new Map([['makeshop',[original]]])});
 assert.equal(result.outputs.length,1);assert.equal(result.selectedRows.length,1);assert.equal(result.changedItems.length,1);assert.equal(result.scopeSummary.outputRowCount,2,'two physical option rows exclude English metadata');
 const output=result.outputs[0],book=XLSX.read(await output.blob.arrayBuffer(),{type:'array'}),sheet=book.Sheets[book.SheetNames[0]];
 assert.equal(sheet.E2.v,'product_uid');assert.equal(sheet.E3.v,'2001');assert.equal(sheet.AR3.v,'5003');assert.equal(sheet.AG3.v,7);assert.equal(sheet.AR4.v,'5004');assert.equal(sheet.AG4.v,2);assert.equal(sheet.E4,undefined);assert.equal(sheet.E5,undefined);
 const roundtrip=await h.context.SystemV3SellerParsers.parseSellerFiles('makeshop',[new TestFile([output.blob],output.file.name)],{price:true,inventory:true});
 const options=roundtrip.normalizedRows.filter(row=>row.product_code==='2001');assert.deepEqual(Array.from(options,row=>[row.option_code,row.stock,row.price]),[['5003',7,1000],['5004',2,1100]],'unselected sibling stock and original price remain intact');
});

test('integrated inventory validates DB mapping and official template before committing any stock',async()=>{
 for(const scenario of [{templateError:true},{mappingRows:[]}]){
  const h=harness(scenario);await assert.rejects(h.bridge.runInventoryUpdateBatch({files:[h.previewFile],expectedPreview:h.expected}),/template|매핑|검증/);
  assert.equal(h.uploads,0);assert.equal(h.downloads.length,0);assert.ok(h.timeline.indexOf('ably-mapping')>=0);
 }
});

test('integrated inventory generates exactly four reopened files without any PlayAuto input or price read',async()=>{
 const h=harness(),output=await h.bridge.runInventoryUpdateBatch({files:[h.previewFile],expectedPreview:h.expected,stockSource:'available_stock'});
 assert.equal(h.uploads,1);assert.ok(output.blob instanceof Blob);assert.deepEqual(h.priceCalls,[]);
 assert.ok(h.timeline.indexOf('ably-template')<h.timeline.indexOf('stock-upload'));assert.ok(h.timeline.indexOf('matrix-wait')<h.timeline.indexOf('stock-read'));assert.ok(h.timeline.indexOf('matrix-refresh')<h.timeline.indexOf('stock-read'));
 const zip=await JSZip.loadAsync(await output.blob.arrayBuffer()),names=Object.keys(zip.files).filter(name=>!zip.files[name].dir);assert.equal(names.length,4);assert.equal(output.files.length,4);
 const ablyName=names.find(name=>name==='에이블리_재고 수량 변경.xlsx');assert.ok(ablyName);
 const ably=XLSX.read(await zip.file(ablyName).async('uint8array'),{type:'array'}).Sheets['재고 수량 수정_양식'];assert.equal(ably.A2.v,'J-0001');assert.equal(ably.B2.v,11);
 const merchantFiles=names.filter(name=>name!==ablyName);for(const name of merchantFiles){const book=XLSX.read(await zip.file(name).async('uint8array'),{type:'array'}),sheet=book.Sheets[book.SheetNames[0]];assert.ok(sheet,'every archived merchant XLSX reopens');}
});

test('integrated zero-change inventory skips stock upload and still builds four current snapshot files',async()=>{
 const h=harness({changed:false});const result=await h.bridge.runInventoryUpdateBatch({files:[h.previewFile],expectedPreview:h.expected});
 assert.equal(h.uploads,0);assert.equal(result.stockSnapshotId,'stock-before');assert.equal(result.files.length,4);assert.ok(h.timeline.includes('count-repreview'));assert.deepEqual(h.priceCalls,[]);
});

test('integrated mapping drift or stock snapshot drift prevents ZIP download after a committed update',async()=>{
 for(const scenario of [{mappingDrift:true},{stockDrift:true},{quantityDrift:true}]){
  const h=harness(scenario);await assert.rejects(h.bridge.runInventoryUpdateBatch({files:[h.previewFile],expectedPreview:h.expected}),error=>error.code==='INVENTORY_EXPORT_FAILED_AFTER_UPDATE'&&error.uploaded===true&&error.retryAvailable===true);
  assert.equal(h.uploads,1);assert.equal(h.downloads.length,0);assert.equal(h.audit.length,0);
 }
});

test('integrated explicit export retry after Matrix failure never submits the successful inventory again',async()=>{
 const h=harness({failMatrixOnce:true});await assert.rejects(h.bridge.runInventoryUpdateBatch({files:[h.previewFile],expectedPreview:h.expected}),error=>error.code==='INVENTORY_EXPORT_FAILED_AFTER_UPDATE');
 assert.equal(h.uploads,1);const result=await h.bridge.retryInventoryBatchExport({});
 assert.equal(h.uploads,1);assert.equal(result.files.length,4);assert.ok(result.blob instanceof Blob);assert.deepEqual(h.priceCalls,[]);
});
