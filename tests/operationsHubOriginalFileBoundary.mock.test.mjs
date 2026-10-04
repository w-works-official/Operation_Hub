import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const data=fs.readFileSync('mockups/operations-hub/data-service.js','utf8');
const workflow=fs.readFileSync('mockups/operations-hub/seller-file-workflow-v2.js','utf8');
const edge=fs.readFileSync('supabase/functions/operations-hub-original-files/index.ts','utf8');
const migration=fs.readFileSync('supabase/migrations/20260920025225_operations_hub_original_upload_boundary_v1.sql','utf8');
const aclMigration=fs.readFileSync('supabase/migrations/20260920025356_operations_hub_original_upload_boundary_acl_v1.sql','utf8');

test('upload authorization is session gated and never accepts client snapshot/path/source authority',()=>{
  const beginUploadSource=edge.match(/async function beginUpload[\s\S]*?(?=async function inspectUploadedObjects)/)?.[0]||'';
  assert.match(edge,/requireSession\(req\)/);
  assert.match(edge,/operations_hub_check_session_v1/);
  assert.match(migration,/require_operations_hub_operator_session\(p_session_token\)/);
  assert.match(migration,/session_id is distinct from \(v_actor->>'session_id'\)::uuid/);
  assert.match(migration,/v_snapshot_id uuid := extensions\.gen_random_uuid\(\)/);
  assert.match(migration,/source_channel text not null check \(source_channel = 'sellpia'\)/);
  assert.ok(beginUploadSource,'upload-init implementation must remain discoverable');
  assert.doesNotMatch(beginUploadSource,/body\.(?:snapshot_id|path|storage_path|source_channel)/);
  assert.doesNotMatch(migration,/create policy[\s\S]*?for insert[\s\S]*?to anon/i);
  assert.match(aclMigration,/revoke all on function public\.hub_original_upload_intent_uploaded_v1\(text,uuid,jsonb\) from public, anon, authenticated/);
  assert.match(aclMigration,/grant execute on function public\.hub_original_upload_intent_uploaded_v1\(text,uuid,jsonb\) to service_role/);
});

test('upload manifest is exact, immutable, bounded and replay guarded',()=>{
  assert.match(migration,/format\('sellpia\/%s\/%s\.%s',v_snapshot_id/);
  assert.match(migration,/expected_file_count integer not null check \(expected_file_count between 1 and 3\)/);
  assert.match(migration,/expected_total_bytes bigint not null check \(expected_total_bytes between 1 and 62914560\)/);
  assert.match(migration,/v_size<1 or v_size>26214400/);
  assert.match(migration,/v_mode='full' and v_count<>3/);
  assert.match(edge,/createSignedUploadUrl\(path, \{ upsert: false \}\)/);
  assert.match(data,/uploadToSignedUrl\(signed\.path,signed\.token,file,\{contentType:[^}]+upsert:false\}\)/);
  assert.match(migration,/if v_intent\.status='ready' then[\s\S]*?status','ready'/);
  assert.match(edge,/if \(\["uploaded", "parsing", "ready"\]\.includes/);
});

test('partial uploads cannot become ready and cleanup is restricted to the manifest snapshot prefix',()=>{
  assert.match(edge,/objects\.length !== manifest\.length/);
  assert.match(migration,/if v_rows<>v_intent\.expected_row_count then/);
  assert.match(migration,/status not in \('uploaded','parsing'\)/);
  assert.match(edge,/path\.startsWith\(`sellpia\/\$\{status\?\.snapshot_id\}\//);
  assert.match(edge,/ready snapshot은 cleanup할 수 없습니다/);
  assert.doesNotMatch(edge,/remove\(\[?directory|remove\(prefix/);
});

test('signed read resolves database references and arbitrary paths are never signed',()=>{
  for(const table of ['seller_inventory_snapshots','sellpia_stock_snapshots','operations_hub_channel_files'])assert.match(edge,new RegExp(table));
  assert.match(edge,/validateStoredPath\(source, data\.snapshot_id/);
  assert.match(edge,/createSignedUrl\(path, DOWNLOAD_TTL_SECONDS/);
  assert.match(edge,/DOWNLOAD_TTL_SECONDS = 300/);
  assert.doesNotMatch(edge,/body\.(?:path|storage_path)/);
  assert.match(workflow,/downloadAuxiliarySellerFile\(record\)/);
  assert.match(data,/kind:'auxiliary',file_id:record\.file_id/);
});

test('service secret remains server-only and frontend exposes explicit fallback diagnostics',()=>{
  assert.match(edge,/Deno\.env\.get\("SUPABASE_SERVICE_ROLE_KEY"\)/);
  assert.doesNotMatch(data,/SUPABASE_SERVICE_ROLE_KEY|sb_secret_/);
  assert.doesNotMatch(edge,/response\([^\n]+SERVICE_KEY|JSON\.stringify\(SERVICE_KEY/);
  assert.match(data,/secure-read-fallback/);
  assert.match(data,/secure-download-fallback/);
  assert.match(data,/console\.warn\('\[Operations Hub original boundary\]'/);
  assert.match(data,/getOriginalBoundaryDiagnostics/);
});

test('SELLPIA carrier references round trip through verified intent before rows and ready',()=>{
  assert.match(migration,/source_storage_files/);
  assert.match(migration,/hub_sellpia_upload_rows_v1/);
  assert.match(migration,/hub_sellpia_upload_complete_v1/);
  assert.match(data,/upload-finalize[\s\S]*?hub_sellpia_upload_rows_v1[\s\S]*?hub_sellpia_upload_complete_v1/);
  assert.match(data,/loadLatestSellpiaOriginalStatus[\s\S]*?kind:'sellpia'/);
  assert.match(data,/downloadLatestSellpiaOriginals[\s\S]*?kind:'sellpia'/);
});
