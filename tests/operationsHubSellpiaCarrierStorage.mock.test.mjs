import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync('mockups/operations-hub/data-service.js','utf8');
const functionSource=source.slice(source.indexOf('  async function loadLatestSellpiaOriginalStatusDirect()'),source.indexOf('  async function loadLatestSellpiaOriginalStatus()'))
  .replace('loadLatestSellpiaOriginalStatusDirect','loadLatestSellpiaOriginalStatus');

async function statusFor(rows){
 const chain={id:null,select(){return this;},eq(key,value){if(key==='snapshot_id')this.id=value;return this;},order(){return this;},limit(){return Promise.resolve({data:rows.slice(0,1),error:null});},maybeSingle(){return Promise.resolve({data:rows.find(row=>row.snapshot_id===this.id)||null,error:null});}};
 const context={cleanText:value=>String(value??'').trim(),db:{from:()=>chain}};
 vm.createContext(context);vm.runInContext(functionSource,context);return context.loadLatestSellpiaOriginalStatus();
}

test('Sellpia carrier status follows the exact full ancestor of a ready patch',async()=>{
 const stored=[1,2,3].map(i=>({name:`source-${i}.csv`,path:`sellpia/FULL/0${i}.csv`}));
 const current=await statusFor([{snapshot_id:'FULL',metadata:{upload_mode:'full',source_storage_files:stored},completed_at:'2026-09-20'}]);
 assert.equal(current.available,true);assert.equal(current.snapshotId,'FULL');
 const legacy=await statusFor([{snapshot_id:'FULL',metadata:{upload_mode:'full'},completed_at:'2026-09-20'}]);
 assert.equal(legacy.available,false);assert.match(legacy.reason,/carrier 3개/);
 const patched=await statusFor([{snapshot_id:'PATCH',metadata:{upload_mode:'patch',base_snapshot_id:'FULL'},completed_at:'2026-09-20'},{snapshot_id:'FULL',metadata:{upload_mode:'full',source_storage_files:stored},completed_at:'2026-09-19'}]);
 assert.equal(patched.available,true);assert.equal(patched.snapshotId,'FULL');assert.equal(patched.stateSnapshotId,'PATCH');
 await assert.rejects(statusFor([{snapshot_id:'PATCH',metadata:{upload_mode:'patch',base_snapshot_id:'MISSING'}}]),/기준 원본/);
});

test('future Sellpia uploads use session-gated exact signed paths before row ingestion',()=>{
 assert.match(source,/originalBoundaryRequest\('upload-init'/);
 assert.match(source,/uploadToSignedUrl\(signed\.path,signed\.token,file,[\s\S]*?upsert:false/);
 assert.match(source,/originalBoundaryRequest\('upload-finalize'/);
 assert.match(source,/rpc\('hub_sellpia_upload_rows_v1',[\s\S]*?p_session_token:requireOperationsHubSessionToken\(\)/);
 assert.match(source,/rpc\('hub_sellpia_upload_complete_v1',[\s\S]*?p_intent_id:intentId/);
 assert.doesNotMatch(source.slice(source.indexOf('  async function uploadSellpiaSnapshot('),source.indexOf('  async function uploadSellerSnapshot(')),/\.from\('sellpia_stock_snapshots'\)\s*\.insert|seller-originals'\)\.upload\(/);
 const migration=fs.readFileSync('supabase/migrations/20260920025225_operations_hub_original_upload_boundary_v1.sql','utf8');
 assert.match(migration,/require_operations_hub_operator_session\(p_session_token\)/);
 assert.match(migration,/format\('sellpia\/%s\/%s\.%s',v_snapshot_id/);
 assert.match(migration,/expected_file_count integer[^]*?between 1 and 3/);
 assert.match(migration,/expected_total_bytes bigint[^]*?62914560/);
 assert.match(migration,/v_size>26214400/);
 assert.match(migration,/status in \('uploading','uploaded','parsing','ready','failed','aborted','expired'\)/);
 assert.match(migration,/grant execute on function public\.hub_original_upload_intent_uploaded_v1[^]*?to service_role/);
 assert.doesNotMatch(migration,/create policy[^]*?sellpia[^]*?for insert[^]*?to anon/i,'secure migration must not grant anon SELLPIA Storage INSERT');
});

test('signed download broker resolves DB identities and direct read is diagnostic fallback only',()=>{
 const edge=fs.readFileSync('supabase/functions/operations-hub-original-files/index.ts','utf8');
 assert.match(edge,/x-operations-hub-session/);
 assert.match(edge,/operations_hub_check_session_v1/);
 assert.match(edge,/createSignedUploadUrl\(path, \{ upsert: false \}\)/);
 assert.match(edge,/createSignedUrl\(path, DOWNLOAD_TTL_SECONDS/);
 assert.match(edge,/seller_inventory_snapshots/);
 assert.match(edge,/sellpia_stock_snapshots/);
 assert.match(edge,/operations_hub_channel_files/);
 assert.doesNotMatch(edge,/body\.(?:path|storage_path)/,'client paths must not be accepted for signing');
 assert.match(source,/secure-download-fallback/);
 assert.match(source,/getOriginalBoundaryDiagnostics/);
});
