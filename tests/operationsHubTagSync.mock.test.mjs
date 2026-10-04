import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const migration=fs.readFileSync('supabase/migrations/20260912211000_hub_tag_bulk_sync.sql','utf8');
const data=fs.readFileSync('mockups/operations-hub/data-service.js','utf8');
const rule=fs.readFileSync('mockups/operations-hub/rule-workspace.js','utf8');

test('filename tag sync supports explicit authoritative-list removal including empty list',()=>{
  assert.match(migration,/hub_tag_bulk_sync_v1/);
  assert.match(migration,/is_active=false/);
  assert.match(migration,/hub_sync_tag_rules/);
  assert.match(migration,/target_count/);
  assert.match(data,/async function syncTagAssignments/);
  assert.match(data,/hub_tag_bulk_sync_v1/);
  assert.match(rule,/metadata_tag':'filename_tag'/);
  assert.match(rule,/files\.length>1\?'multi_file'/);
  assert.match(rule,/openTagImport:options=>run\(\(\)=>openTagImport\(options\)\)/);
  const cleanup=fs.readFileSync('mockups/operations-hub/ui-cleanup-v1.js','utf8');
  assert.match(cleanup,/function tagSyncContext\(data\)/);
  assert.match(cleanup,/\['metadata_tag','filename_tag'\]\.includes\(file\.parsed\?\.mode\)/);
});
