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

function inventoryFile(count=76,offset=0,name='count.xlsx') {
  const book=XLSX.utils.book_new();
  const rows=[['상품코드','가용재고','재고'],...Array.from({length:count},(_,index)=>[`sku-${index+offset}`,index+offset-3,index+offset+8])];
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(rows),'재고조사');
  const bytes=new Uint8Array(XLSX.write(book,{type:'array',bookType:'xlsx'}));
  return {name,size:bytes.byteLength,type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',async arrayBuffer(){return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);}};
}

// This harness verifies the shipped browser adapter against a scripted server.
// SQL rollback and ready-snapshot protection are verified by the DB test suite.
function harness({count=76,changedCount=count,completionFailure=null,rowFailureCall=0,abortFailure=false,readSnapshotDriftCall=0,matrixStatuses=null}={}) {
  const calls={rpc:[],boundary:[],signedUploads:[],rows:0,complete:0,stockReads:0,matrixReads:0};
  const intents=new Map();
  let latestId='base-A',rowCalls=0;
  const current=new Map(Array.from({length:count},(_,index)=>[`sku-${index}`,{sellpia_sku_code:`sku-${index}`,sellpia_current_stock:index<changedCount?-100:index+8,sellpia_available_stock:index<changedCount?-100:index-3}]));
  const failure={message:'canceling statement due to statement timeout',code:'57014'};
  const db={
    rpc:async(name,args)=>{
      calls.rpc.push({name,args});
      if(name==='hub_sellpia_stock_sources_read_v1'){
        calls.stockReads++;
        return {data:{snapshot_id:calls.stockReads===readSnapshotDriftCall?'base-B':latestId,rows:args.p_skus.map(sku=>current.get(sku)).filter(Boolean)},error:null};
      }
      const intent=intents.get(args.p_intent_id);
      if(name==='hub_sellpia_upload_rows_v2'){
        rowCalls++;
        if(rowCalls===rowFailureCall)return {data:null,error:failure};
        intent.status='parsing';
        for(const row of args.p_rows)intent.rows.set(row.sellpia_sku_code,{...row});
        calls.rows+=args.p_rows.length;
        return {data:null,error:null};
      }
      if(name==='hub_sellpia_upload_complete_v2'){
        calls.complete++;
        if(completionFailure==='timeout')return {data:null,error:failure};
        if(completionFailure==='disconnect')throw new TypeError('Failed to fetch');
        if(completionFailure==='incomplete')return {data:{status:'parsing'},error:null};
        intent.status='ready';latestId=intent.snapshotId;
        for(const row of intent.rows.values())current.set(row.sellpia_sku_code,{sellpia_sku_code:row.sellpia_sku_code,sellpia_current_stock:row.stock,sellpia_available_stock:row.available_stock});
        if(completionFailure==='committed-response-loss')return {data:null,error:{message:'Network response lost after commit',code:'FETCH_ERROR'}};
        return {data:{status:'ready',row_count:count,affected_skus:[...intent.rows.keys()]},error:null};
      }
      throw Error(`unexpected RPC ${name}`);
    },
    storage:{from:bucket=>({uploadToSignedUrl:async(path,token,file)=>{calls.signedUploads.push({bucket,path,token,fileName:file.name});return {error:null};}})},
    from:table=>({select:()=>({maybeSingle:async()=>{
      assert.equal(table,'operations_hub_sellpia_matrix_sync_status');
      const status=matrixStatuses[Math.min(calls.matrixReads++,matrixStatuses.length-1)];
      return {data:status,error:null};
    }})})
  };
  const context={console,Blob,TextDecoder,TextEncoder,Uint8Array,ArrayBuffer,Buffer,XLSX,crypto:webcrypto,performance,supabase:{createClient:()=>db},fetch:async(_url,options)=>{
    const request=JSON.parse(options.body);calls.boundary.push(request);
    let data={};
    if(request.action==='upload-init'){
      const ordinal=intents.size+1,intentId=`intent-${ordinal}`,snapshotId=`snapshot-${ordinal}`;
      intents.set(intentId,{snapshotId,status:'created',rows:new Map()});
      data={intent_id:intentId,snapshot_id:snapshotId,manifest:request.files.map((_file,index)=>({ordinal:index+1,path:`synthetic/${ordinal}/${index+1}`,token:`token-${ordinal}-${index+1}`}))};
    }
    if(request.action==='upload-finalize'){intents.get(request.intent_id).status='uploaded';data={status:'uploaded'};}
    if(request.action==='upload-abort'){
      if(abortFailure)throw new TypeError('cleanup connection unavailable');
      const intent=intents.get(request.intent_id);
      if(intent.status==='ready')return {ok:false,status:409,json:async()=>({ok:false,error:'ready snapshot cannot be failed',code:'55000'})};
      intent.status='failed';
    }
    return {ok:true,status:200,json:async()=>({ok:true,data})};
  }};
  if(matrixStatuses){
    let time=0;
    context.Date=class extends Date{static now(){return time;}};
    context.setTimeout=callback=>{time+=1000;callback();};
  }
  context.window=context;context.globalThis=context;vm.createContext(context);
  vm.runInContext(parserSource,context,{filename:'sellpia-inventory-count.js'});
  vm.runInContext(dataServiceSource,context,{filename:'data-service.js'});
  context.SystemV3Data.setOperationsHubSessionToken('synthetic-session');
  return {api:context.SystemV3Data,calls,intents,get latestId(){return latestId;},setFailure(value){completionFailure=value;}};
}

test('adapter completion timeout aborts the staged intent after the 76 changed rows and retains the original RPC error',async()=>{
  const h=harness({completionFailure:'timeout'}),file=inventoryFile(),preview=await h.api.previewSellpiaInventoryCount([file]);
  await assert.rejects(h.api.uploadSellpiaInventoryCount([file],preview),error=>error.code==='57014'&&/statement timeout/.test(error.message));
  assert.equal(h.calls.rows,76);assert.equal(h.calls.complete,1);
  assert.deepEqual(h.calls.boundary.map(request=>request.action),['upload-init','upload-finalize','upload-abort']);
  assert.equal(h.calls.boundary.at(-1).intent_id,'intent-1');
  assert.match(h.calls.boundary.at(-1).reason,/statement timeout/);
  assert.equal(h.latestId,'base-A');assert.equal(h.intents.get('intent-1').status,'failed');
});

test('adapter partial chunk failure never calls completion and a later retry creates a fresh immutable intent',async()=>{
  const h=harness({count:501,rowFailureCall:2}),file=inventoryFile(501),preview=await h.api.previewSellpiaInventoryCount([file]);
  await assert.rejects(h.api.uploadSellpiaInventoryCount([file],preview),error=>error.code==='57014');
  assert.equal(h.calls.rows,500);assert.equal(h.calls.complete,0);assert.equal(h.intents.get('intent-1').rows.size,500);
  assert.equal(h.intents.get('intent-1').status,'failed');assert.equal(h.latestId,'base-A');
  const output=await h.api.uploadSellpiaInventoryCount([file],preview);
  assert.equal(output.intentId,'intent-2');assert.equal(output.snapshotId,'snapshot-2');assert.equal(output.uploadedRowCount,501);
  assert.equal(h.intents.get('intent-1').status,'failed');assert.equal(h.intents.get('intent-2').rows.size,501);
  const requests=h.calls.boundary.filter(request=>request.action==='upload-init');
  assert.notEqual(requests[0].request_id,requests[1].request_id);
  assert.deepEqual(h.calls.rpc.filter(call=>call.name==='hub_sellpia_upload_rows_v2').map(call=>call.args.p_rows.length),[500,1,500,1]);
});

test('adapter abort connection failure records cleanup diagnostics while surfacing the original completion timeout',async()=>{
  const h=harness({completionFailure:'timeout',abortFailure:true}),file=inventoryFile(),preview=await h.api.previewSellpiaInventoryCount([file]);
  await assert.rejects(h.api.uploadSellpiaInventoryCount([file],preview),error=>error.code==='57014');
  const diagnostics=h.api.getOriginalBoundaryDiagnostics();
  assert.equal(diagnostics.length,1);assert.equal(diagnostics[0].kind,'inventory-count-cleanup-failed');
  assert.equal(diagnostics[0].intentId,'intent-1');assert.match(diagnostics[0].message,/cleanup connection unavailable/);
  assert.equal(h.latestId,'base-A');
});

test('adapter disconnect or non-ready completion response never returns a successful upload result',async()=>{
  for(const completionFailure of ['disconnect','incomplete']){
    const h=harness({completionFailure}),file=inventoryFile(),preview=await h.api.previewSellpiaInventoryCount([file]);
    await assert.rejects(h.api.uploadSellpiaInventoryCount([file],preview),/Failed to fetch|ready 상태로 완료되지/);
    assert.equal(h.calls.complete,1);assert.equal(h.calls.boundary.at(-1).action,'upload-abort');
    assert.equal(h.latestId,'base-A');assert.equal(h.intents.get('intent-1').status,'failed');
  }
});

test('adapter committed response loss requires a fresh preview and then skips any duplicate inventory upload',async()=>{
  const h=harness({completionFailure:'committed-response-loss'}),file=inventoryFile(),preview=await h.api.previewSellpiaInventoryCount([file]);
  await assert.rejects(h.api.uploadSellpiaInventoryCount([file],preview),error=>error.code==='FETCH_ERROR');
  assert.equal(h.latestId,'snapshot-1');assert.equal(h.intents.get('intent-1').status,'ready');
  assert.equal(h.calls.boundary.at(-1).action,'upload-abort');
  assert.equal(h.api.getOriginalBoundaryDiagnostics()[0].kind,'inventory-count-cleanup-failed');
  const boundaryCount=h.calls.boundary.length;
  await assert.rejects(h.api.uploadSellpiaInventoryCount([file],preview),/다시 미리보기/);
  assert.equal(h.calls.boundary.length,boundaryCount,'stale proof never creates a new intent');
  const refreshed=await h.api.previewSellpiaInventoryCount([file]);
  assert.equal(refreshed.baseSnapshotId,'snapshot-1');assert.equal(refreshed.summary.changedSkuCount,0);
  const output=await h.api.uploadSellpiaInventoryCount([file],refreshed);
  assert.equal(output.unchanged,true);assert.equal(output.uploadedRowCount,0);
  assert.equal(h.calls.complete,1);assert.equal(h.calls.rows,76);assert.equal(h.intents.size,1);
});

test('adapter confirmed ready completion performs no abort and returns the established caller contract',async()=>{
  const h=harness(),file=inventoryFile(),preview=await h.api.previewSellpiaInventoryCount([file]);
  const output=await h.api.uploadSellpiaInventoryCount([file],preview);
  assert.equal(output.snapshotId,'snapshot-1');assert.equal(output.intentId,'intent-1');assert.equal(output.boundary,'signed-upload-v2');
  assert.equal(output.rowCount,76);assert.equal(output.uploadedRowCount,76);assert.equal(output.uploadMode,'inventory_count');
  assert.equal(output.baseSnapshotId,preview.baseSnapshotId);assert.equal(output.fingerprint,preview.fingerprint);
  assert.equal(output.matrixAffectedSkus.length,76);assert.equal(output.affectedSkus.length,76);
  assert.deepEqual(h.calls.boundary.map(request=>request.action),['upload-init','upload-finalize']);
});

test('adapter operation-sized two-file input reads 20,612 rows but submits only 76 changed known SKUs',async()=>{
  const h=harness({count:20475,changedCount:76}),files=[inventoryFile(10306,0,'part-1.xlsx'),inventoryFile(10306,10306,'part-2.xlsx')],preview=await h.api.previewSellpiaInventoryCount(files);
  assert.equal(preview.summary.fileCount,2);
  assert.equal(preview.summary.readRowCount,20612);assert.equal(preview.summary.validSkuCount,20475);
  assert.equal(preview.summary.changedSkuCount,76);assert.equal(preview.summary.unchangedSkuCount,20399);
  assert.equal(preview.summary.unknownSkuCount,137);assert.equal(preview.summary.duplicateConflictCount,0);assert.equal(preview.summary.errorRowCount,0);
  const output=await h.api.uploadSellpiaInventoryCount(files,preview);
  assert.equal(h.calls.rows,76);assert.equal(h.calls.complete,1);assert.equal(output.rowCount,20475);
  assert.equal(h.calls.stockReads,42,'preview and upload proof each read 21 chunks of at most 1,000 SKUs');
  const init=h.calls.boundary.find(request=>request.action==='upload-init');
  assert.equal(init.source_row_count,76);assert.equal(init.selected_fields.source_read_row_count,20612);
  assert.equal(init.files.length,2);assert.equal(h.calls.signedUploads.length,2);
  assert.equal(h.calls.rpc.filter(call=>call.name==='hub_sellpia_upload_rows_v2').length,1);
});

test('adapter inventory preview rejects base snapshot drift across its read chunks before creating any intent',async()=>{
  const h=harness({count:1001,readSnapshotDriftCall:2}),file=inventoryFile(1001);
  await assert.rejects(h.api.previewSellpiaInventoryCount([file]),/비교 도중 최신 Sellpia snapshot이 변경/);
  assert.equal(h.calls.stockReads,2);assert.equal(h.calls.boundary.length,0);assert.equal(h.calls.rows,0);
});

test('adapter Matrix poll ignores another ready snapshot and its own pending state until the requested snapshot is ready',async()=>{
  const h=harness({matrixStatuses:[
    {matrix_snapshot_id:'another-snapshot',rebuild_pending:false},
    {matrix_snapshot_id:'requested-snapshot',rebuild_pending:true},
    {matrix_snapshot_id:'requested-snapshot',rebuild_pending:false,matrix_row_count:20475},
  ]});
  const output=await h.api.waitForSellpiaMatrixRebuild('requested-snapshot',null,{pollMs:1000,timeoutMs:30000});
  assert.equal(output.matrix_snapshot_id,'requested-snapshot');assert.equal(output.rebuild_pending,false);
  assert.equal(h.calls.matrixReads,3);assert.equal(h.calls.boundary.length,0);
});

test('adapter Matrix pending timeout reports completed-upload recovery without issuing a new write',async()=>{
  const h=harness({matrixStatuses:[{matrix_snapshot_id:'requested-snapshot',rebuild_pending:true}]});
  await assert.rejects(h.api.waitForSellpiaMatrixRebuild('requested-snapshot',null,{pollMs:1000,timeoutMs:30000}),/업로드는 완료됐지만 매트릭스 재구성/);
  assert.equal(h.calls.matrixReads,30);assert.equal(h.calls.boundary.length,0);assert.equal(h.calls.rpc.length,0);
});
