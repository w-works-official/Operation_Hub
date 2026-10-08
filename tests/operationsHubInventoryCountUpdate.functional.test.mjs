import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {webcrypto} from 'node:crypto';

const require=createRequire(import.meta.url);
const XLSX=require('./vendor/xlsx-0.18.5.full.min.js');
const parserSource=fs.readFileSync(new URL('../mockups/operations-hub/sellpia-inventory-count.js',import.meta.url),'utf8');
const dataServiceSource=fs.readFileSync(new URL('../mockups/operations-hub/data-service.js',import.meta.url),'utf8');

function xlsxFile(name, headers, rows) {
  const workbook=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([headers,...rows]),'재고조사');
  const bytes=new Uint8Array(XLSX.write(workbook,{type:'array',bookType:'xlsx'}));
  return {name,size:bytes.byteLength,type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',async arrayBuffer(){return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);}};
}

const headers=['매입처','상품코드','상품명','옵션명','가용재고','재고','안전재고','매입가','자사코드','바코드'];
const standardRows=[
  ['테스트 매입처','sku-change','테스트 상품','은침',6,8,2,1200,'OWN-1','880000000001'],
  ['테스트 매입처','sku-same','테스트 상품','금침',7,9,3,1500,'OWN-2','880000000002'],
];

function serviceHarness({baseSnapshotId='base-A',baseRows=null,session=true,readResponses=[]}={}) {
  const calls={rpc:[],boundary:[],signedUploads:[],uploadedRows:[],complete:0,read:0};
  let currentBaseSnapshotId=baseSnapshotId;
  const defaults=[
    {sellpia_sku_code:'sku-change',sellpia_current_stock:3,sellpia_available_stock:4},
    {sellpia_sku_code:'sku-same',sellpia_current_stock:9,sellpia_available_stock:7},
  ];
  const stockRows=baseRows||defaults;
  const db={
    rpc:async(name,args)=>{
      calls.rpc.push({name,args});
      if(name==='hub_sellpia_stock_sources_read_v1'){
        calls.read++;
        if(readResponses[calls.read-1])return typeof readResponses[calls.read-1]==='function'?readResponses[calls.read-1](args):readResponses[calls.read-1];
        return {data:{snapshot_id:currentBaseSnapshotId,rows:stockRows.filter(row=>args.p_skus.includes(row.sellpia_sku_code))},error:null};
      }
      if(name==='hub_sellpia_upload_rows_v2'){calls.uploadedRows.push(...args.p_rows);return {data:null,error:null};}
      if(name==='hub_sellpia_upload_complete_v2'){calls.complete++;return {data:{status:'ready',row_count:args.p_rows?.length||calls.uploadedRows.length,affected_skus:calls.uploadedRows.map(row=>row.sellpia_sku_code)},error:null};}
      throw new Error(`unexpected RPC ${name}`);
    },
    storage:{from:bucket=>({uploadToSignedUrl:async(path,token,file,options)=>{calls.signedUploads.push({bucket,path,token,fileName:file.name,options});return {data:{},error:null};}})}
  };
  const context={
    console,Blob,TextDecoder,TextEncoder,Uint8Array,ArrayBuffer,Buffer,XLSX,crypto:webcrypto,performance,
    supabase:{createClient:()=>db},
    fetch:async(_url,options)=>{
      const request=JSON.parse(options.body);calls.boundary.push(request.action);
      const data=request.action==='upload-init'
        ?{intent_id:'intent-synthetic',snapshot_id:'snapshot-synthetic',manifest:request.files.map((file,index)=>({ordinal:index+1,path:`synthetic/${index+1}`,token:`token-${index+1}`}))}
        :request.action==='upload-finalize'?{status:'uploaded'}:{};
      return {ok:true,status:200,json:async()=>({ok:true,data})};
    },
  };
  context.window=context;context.globalThis=context;
  vm.createContext(context);
  vm.runInContext(parserSource,context,{filename:'sellpia-inventory-count.js'});
  vm.runInContext(dataServiceSource,context,{filename:'data-service.js'});
  if(session)context.SystemV3Data.setOperationsHubSessionToken('synthetic-session-token');
  return {api:context.SystemV3Data,calls,changeBase(id){currentBaseSnapshotId=id;}};
}

test('real SheetJS XLSX parser previews filename-agnostic multi-files, ignores auxiliary columns, and reuses the same fingerprint',async()=>{
  const h=serviceHarness();
  const files=[
    xlsxFile('vendor-export-2026-10-08.xlsx',headers,[standardRows[0]]),
    xlsxFile('second-file-with-no-special-name.xlsx',headers,[standardRows[1]]),
  ];
  const first=await h.api.previewSellpiaInventoryCount(files);
  const second=await h.api.previewSellpiaInventoryCount(files);
  assert.equal(first.summary.fileCount,2);
  assert.equal(first.summary.validSkuCount,2);
  assert.equal(first.summary.changedSkuCount,1);
  assert.equal(first.summary.unchangedSkuCount,1);
  assert.deepEqual(Array.from(first.changedRows,row=>row.sellpia_sku_code),['sku-change']);
  assert.equal(first.baseSnapshotId,'base-A');
  assert.equal(first.fingerprint,second.fingerprint,'the same files and base snapshot produce a reusable proof');
  assert.equal(h.calls.read,2,'each explicit preview reads a consistent base snapshot');
  assert.equal(h.calls.boundary.length,0);
  assert.equal(h.calls.uploadedRows.length,0,'preview never uploads rows');
});

test('existing inventory upload rechecks the proof and uploads changed SKU rows only through the signed boundary',async()=>{
  const h=serviceHarness();
  const file=xlsxFile('inventory.xlsx',headers,standardRows);
  const preview=await h.api.previewSellpiaInventoryCount([file]);
  const result=await h.api.uploadSellpiaInventoryCount([file],preview);
  assert.equal(result.uploadMode,'inventory_count');
  assert.equal(result.baseSnapshotId,'base-A');
  assert.equal(result.uploadedRowCount,1);
  assert.deepEqual(result.matrixAffectedSkus,['sku-change']);
  assert.equal(h.calls.read,2,'upload performs a proof reread before the write boundary');
  assert.deepEqual(h.calls.boundary,['upload-init','upload-finalize']);
  assert.equal(h.calls.signedUploads.length,1);
  assert.deepEqual(h.calls.uploadedRows.map(row=>row.sellpia_sku_code),['sku-change']);
  assert.equal(h.calls.complete,1);
});

test('unchanged preview completes without creating an upload intent or writing rows',async()=>{
  const rows=[
    ['테스트 매입처','sku-change','테스트 상품','은침',4,3,2,1200,'OWN-1','880000000001'],
    ['테스트 매입처','sku-same','테스트 상품','금침',7,9,3,1500,'OWN-2','880000000002'],
  ];
  const h=serviceHarness(),file=xlsxFile('no-change.xlsx',headers,rows),preview=await h.api.previewSellpiaInventoryCount([file]);
  const result=await h.api.uploadSellpiaInventoryCount([file],preview);
  assert.equal(result.unchanged,true);
  assert.equal(result.uploadedRowCount,0);
  assert.equal(h.calls.boundary.length,0);
  assert.equal(h.calls.uploadedRows.length,0);
});

test('missing headers fail closed, while invalid numeric and repeated SKU groups have explicit per-row blockers',async()=>{
  const missing=serviceHarness(),missingFile=xlsxFile('missing.xlsx',['상품코드','재고'],[['sku-change',8]]);
  await assert.rejects(()=>missing.api.previewSellpiaInventoryCount([missingFile]),/가용재고/);
  assert.equal(missing.calls.boundary.length,0);

  const invalid=serviceHarness(),invalidFile=xlsxFile('invalid.xlsx',headers,[['매입처','sku-change','상품','옵션','bad',8,0,0,'OWN','BAR']]);
  const invalidPreview=await invalid.api.previewSellpiaInventoryCount([invalidFile]);
  assert.equal(invalidPreview.summary.errorRowCount,1);
  assert.equal(invalidPreview.summary.blockedRowCount,1);
  assert.equal(invalidPreview.summary.validSkuCount,0);
  assert.equal(invalid.calls.boundary.length,0);
  assert.equal(invalid.calls.uploadedRows.length,0);

  const conflict=serviceHarness(),a=xlsxFile('arbitrary-a.xlsx',headers,[standardRows[0]]),b=xlsxFile('arbitrary-b.xlsx',headers,[['매입처','sku-change','상품','옵션',99,100,0,0,'OWN','BAR']]);
  const conflictPreview=await conflict.api.previewSellpiaInventoryCount([a,b]);
  assert.equal(conflictPreview.summary.duplicateConflictCount,1);
  assert.equal(conflictPreview.summary.blockedRowCount,2);
  assert.deepEqual(Array.from(conflictPreview.blockedSkus),['sku-change']);
  assert.equal(conflict.calls.boundary.length,0);
});

test('real multi-file input uploads only known changed nonduplicate SKU rows and reopens the complete blocked report',async()=>{
  const h=serviceHarness(),cols=['상품코드','가용재고','재고'];
  const files=[
    xlsxFile('part-one.xlsx',cols,[['sku-change',6,8],[],['sku-same',7,9],['mixed',3,4],['missing',5,6],['invalid','bad',1]]),
    xlsxFile('part-two.xlsx',cols,[['sku-same',7,9],['mixed','bad',4]]),
  ];
  const preview=await h.api.previewSellpiaInventoryCount(files);
  assert.equal(preview.summary.changedSkuCount,1);
  assert.equal(preview.summary.duplicateSameCount,1);
  assert.equal(preview.summary.duplicateConflictCount,1);
  assert.equal(preview.summary.blockedSkuCount,4);
  assert.equal(preview.summary.blockedRowCount,6);
  assert.deepEqual(Array.from(preview.blockedRows,row=>[row.file_name,row.source_row_no,row.sellpia_sku_code]),[
    ['part-one.xlsx',4,'sku-same'],['part-two.xlsx',2,'sku-same'],
    ['part-one.xlsx',5,'mixed'],['part-two.xlsx',3,'mixed'],
    ['part-one.xlsx',6,'missing'],['part-one.xlsx',7,'invalid'],
  ]);
  const result=await h.api.uploadSellpiaInventoryCount(files,preview);
  assert.equal(result.uploadedRowCount,1);
  assert.deepEqual(h.calls.uploadedRows.map(row=>[row.sellpia_sku_code,row.stock,row.available_stock]),[['sku-change',8,6]]);
  assert.equal(h.calls.signedUploads.length,2);
  const parserContext={console,Blob,XLSX};parserContext.globalThis=parserContext;vm.createContext(parserContext);vm.runInContext(parserSource,parserContext);
  const report=parserContext.SystemV3SellpiaInventoryCount.buildBlockedWorkbook(preview.blockedRows,{XLSX});
  const book=XLSX.read(await report.blob.arrayBuffer(),{type:'array'});
  assert.deepEqual(book.SheetNames,['차단목록']);
  const reportRows=XLSX.utils.sheet_to_json(book.Sheets['차단목록'],{header:1,raw:true,defval:''});
  assert.equal(report.rowCount,6);assert.equal(reportRows.length,7);
  assert.equal(reportRows[0].length,15);assert.equal(book.Sheets['차단목록']['!autofilter'].ref,'A1:O7');
  assert.deepEqual(reportRows.slice(1).map(row=>[row[5],row[6],row[7]]),Array.from(preview.blockedRows,row=>[row.sellpia_sku_code,row.file_name,row.source_row_no]));
  assert.equal(reportRows.find(row=>row[5]==='invalid')[14],'bad','report retains unusable raw input for review');
  assert.equal(reportRows[1][0],'재고조사 입력');assert.equal(reportRows[1][1],'셀피아');assert.equal(reportRows[1][2],'중복 SKU');
});

test('a blocked input edit cannot reuse an otherwise unchanged valid-row upload proof',async()=>{
  const h=serviceHarness(),cols=['상품코드','가용재고','재고'];
  const first=xlsxFile('same-name.xlsx',cols,[['sku-change',6,8],['blocked','bad',1]]);
  const proof=await h.api.previewSellpiaInventoryCount([first]);
  const changed=xlsxFile('same-name.xlsx',cols,[['sku-change',6,8],['blocked','different',1]]);
  await assert.rejects(()=>h.api.uploadSellpiaInventoryCount([changed],proof),/다시 미리보기|바뀌었|변경/);
  assert.equal(h.calls.boundary.length,0);assert.equal(h.calls.uploadedRows.length,0);
});

test('authoritative stock partial read excludes only missing or invalid sources while strict reads still fail',async()=>{
  const h=serviceHarness({baseRows:[
    {sellpia_sku_code:'normal',sellpia_current_stock:7,sellpia_available_stock:4},
    {sellpia_sku_code:'invalid',sellpia_current_stock:'bad',sellpia_available_stock:2},
  ]});
  const partial=await h.api.loadSellpiaStockSourcesForExport({skus:['normal','invalid','missing'],allowPartial:true});
  assert.deepEqual(Array.from(partial.bySku.keys()),['normal']);
  assert.deepEqual(Array.from(partial.missingSkus),['missing']);
  assert.deepEqual(Array.from(partial.invalidSkus),['invalid']);
  await assert.rejects(()=>h.api.loadSellpiaStockSourcesForExport({skus:['normal','invalid','missing']}),/재고 source|최신 재고 SKU/);
  assert.equal(h.calls.boundary.length,0);
});

test('partial stock mode does not relax duplicate/out-of-scope identity, RPC failure, session, or cross-chunk snapshot guards',async()=>{
 const row={sellpia_sku_code:'normal',sellpia_current_stock:1,sellpia_available_stock:2};
 for(const response of [
  {data:{snapshot_id:'base-A',rows:[row,{...row}]},error:null},
  {data:{snapshot_id:'base-A',rows:[{...row,sellpia_sku_code:'unexpected'}]},error:null},
  {data:null,error:{message:'synthetic RPC unavailable',code:'XX000'}},
 ]){
  const h=serviceHarness({readResponses:[response]});await assert.rejects(()=>h.api.loadSellpiaStockSourcesForExport({skus:['normal'],allowPartial:true}));
  assert.equal(h.calls.boundary.length,0);assert.equal(h.calls.uploadedRows.length,0);
 }
 const split=serviceHarness({readResponses:[{data:{snapshot_id:'base-A',rows:[]},error:null},{data:{snapshot_id:'base-B',rows:[]},error:null}]});
 await assert.rejects(()=>split.api.loadSellpiaStockSourcesForExport({skus:Array.from({length:1001},(_,index)=>`sku-${index}`),allowPartial:true}),/snapshot이 변경/);
 assert.deepEqual(split.calls.rpc.map(row=>row.args.p_skus.length),[1000,1]);assert.ok(split.calls.rpc.every(row=>row.args.p_session_token==='synthetic-session-token'));
 const unauthenticated=serviceHarness({session:false});await assert.rejects(()=>unauthenticated.api.loadSellpiaStockSourcesForExport({skus:['normal'],allowPartial:true}),/운영 로그인이 필요/);assert.equal(unauthenticated.calls.rpc.length,0);
});

test('files or base snapshot changed after preview fail the existing upload proof check before writes',async()=>{
  const stale=serviceHarness(),staleFile=xlsxFile('stale.xlsx',headers,standardRows),stalePreview=await stale.api.previewSellpiaInventoryCount([staleFile]);
  stale.changeBase('base-B');
  await assert.rejects(()=>stale.api.uploadSellpiaInventoryCount([staleFile],stalePreview),/바뀌었|변경|다시 미리보기/);
  assert.equal(stale.calls.boundary.length,0);
  assert.equal(stale.calls.uploadedRows.length,0);

  const changed=serviceHarness(),fileA=xlsxFile('original.xlsx',headers,standardRows),preview=await changed.api.previewSellpiaInventoryCount([fileA]);
  const fileB=xlsxFile('changed.xlsx',headers,[standardRows[0],['테스트 매입처','sku-same','테스트 상품','금침',77,99,3,1500,'OWN-2','880000000002']]);
  await assert.rejects(()=>changed.api.uploadSellpiaInventoryCount([fileB],preview),/바뀌었|변경|다시 미리보기/);
  assert.equal(changed.calls.boundary.length,0);
  assert.equal(changed.calls.uploadedRows.length,0);
});

test('missing authenticated session blocks even the read-only preview before any write boundary',async()=>{
  const h=serviceHarness({session:false}),file=xlsxFile('session.xlsx',headers,standardRows);
  await assert.rejects(()=>h.api.previewSellpiaInventoryCount([file]),/운영 로그인이 필요/);
  assert.equal(h.calls.rpc.length,0);
  assert.equal(h.calls.boundary.length,0);
});
