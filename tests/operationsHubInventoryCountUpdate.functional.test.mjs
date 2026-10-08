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

function serviceHarness({baseSnapshotId='base-A',baseRows=null,session=true}={}) {
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
        return {data:{snapshot_id:currentBaseSnapshotId,rows:stockRows.filter(row=>args.p_skus.includes(row.sellpia_sku_code))},error:null};
      }
      if(name==='hub_sellpia_upload_rows_v2'){calls.uploadedRows.push(...args.p_rows);return {data:null,error:null};}
      if(name==='hub_sellpia_upload_complete_v2'){calls.complete++;return {data:{status:'ready',row_count:args.p_rows?.length||calls.uploadedRows.length,affected_skus:calls.uploadedRows.map(row=>row.sellpia_sku_code)},error:null};}
      throw new Error(`unexpected RPC ${name}`);
    },
    storage:{from:bucket=>({uploadToSignedUrl:async(path,token,file,options)=>{calls.signedUploads.push({bucket,path,token,fileName:file.name,options});return {data:{},error:null};}})}
  };
  const context={
    console,TextDecoder,TextEncoder,Uint8Array,ArrayBuffer,Buffer,XLSX,crypto:webcrypto,
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

test('missing headers fail closed, while invalid numeric and conflicting duplicate rows remain explicitly fatal in preview',async()=>{
  const missing=serviceHarness(),missingFile=xlsxFile('missing.xlsx',['상품코드','재고'],[['sku-change',8]]);
  await assert.rejects(()=>missing.api.previewSellpiaInventoryCount([missingFile]),/가용재고/);
  assert.equal(missing.calls.boundary.length,0);

  const invalid=serviceHarness(),invalidFile=xlsxFile('invalid.xlsx',headers,[['매입처','sku-change','상품','옵션','bad',8,0,0,'OWN','BAR']]);
  const invalidPreview=await invalid.api.previewSellpiaInventoryCount([invalidFile]);
  assert.equal(invalidPreview.summary.errorRowCount,1);
  assert.equal(invalid.calls.boundary.length,0);
  assert.equal(invalid.calls.uploadedRows.length,0);

  const conflict=serviceHarness(),a=xlsxFile('arbitrary-a.xlsx',headers,[standardRows[0]]),b=xlsxFile('arbitrary-b.xlsx',headers,[['매입처','sku-change','상품','옵션',99,100,0,0,'OWN','BAR']]);
  const conflictPreview=await conflict.api.previewSellpiaInventoryCount([a,b]);
  assert.equal(conflictPreview.summary.duplicateConflictCount,1);
  assert.equal(conflict.calls.boundary.length,0);
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
