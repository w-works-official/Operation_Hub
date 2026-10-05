import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const retention=fs.readFileSync(new URL('../supabase/migrations/20261001031902_operations_hub_retention_lifecycle_v2.sql',import.meta.url),'utf8');
const cron=fs.readFileSync(new URL('../supabase/migrations/20261001031840_remove_legacy_matrix_refresh_crons_v1.sql',import.meta.url),'utf8');
const activation=fs.readFileSync(new URL('../supabase/migrations/20261001032134_activate_operations_hub_safe_retention_v2.sql',import.meta.url),'utf8');

test('retention V2 preserves provenance parents and Storage while pruning only eligible child rows',()=>{
  assert.match(retention,/operations_hub_retention_policy_v2[\s\S]*?'sellpia_ready_days', 90[\s\S]*?'seller_ready_days', 180[\s\S]*?'failed_snapshot_days', 30[\s\S]*?'cron_log_days', 14/);
  assert.match(retention,/with recursive[\s\S]*?sellpia_protected\(snapshot_id\)[\s\S]*?base_snapshot_id[\s\S]*?seller_protected\(snapshot_id\)[\s\S]*?base\.snapshot_id=child\.base_snapshot_id/);
  assert.match(retention,/hub_baseline_versions[\s\S]*?operations_hub_active_seller_drafts[\s\S]*?operations_hub_change_queue[\s\S]*?operations_hub_export_items/);
  assert.match(retention,/update public\.sellpia_stock_snapshots[\s\S]*?upload_status='archived'/);
  assert.match(retention,/update public\.seller_inventory_snapshots[\s\S]*?upload_status='archived'/);
  assert.match(retention,/delete from public\.sellpia_stock_snapshot_rows/);
  assert.match(retention,/delete from public\.seller_inventory_snapshot_rows/);
  assert.doesNotMatch(retention,/delete from (?:public\.)?sellpia_stock_snapshots\b/i);
  assert.doesNotMatch(retention,/delete from (?:public\.)?seller_inventory_snapshots\b/i);
  assert.doesNotMatch(retention,/delete from operations_private\.operations_hub_original_upload_intents\b/i);
  assert.doesNotMatch(retention,/delete from storage\.objects\b/i);
});

test('retention categories run as separate cron transactions',()=>{
  for(const job of [
    'operations-hub-snapshot-retention-v2',
    'operations-hub-cancelled-history-retention-v1',
    'operations-hub-cron-log-retention-v2',
  ]) assert.match(retention,new RegExp(`cron\\.schedule\\([\\s\\S]*?'${job}'`));
  assert.match(retention,/cron\.alter_job\(v_job_id,active:=false\)/,'new retention jobs must remain inactive until a separately approved production activation');
  assert.match(retention,/exception when others[\s\S]*?partial_failure/i);
  assert.doesNotMatch(retention,/perform\s+operations_private\.prune_operations_hub_history\(\)/i);
});

test('legacy cron removal requires live background replacements and keeps compatibility functions',()=>{
  assert.match(cron,/expected two active background replacements/);
  assert.match(cron,/system-v3-core-cache-refresh-v1[\s\S]*?refresh_operations_hub_matrix_core_if_stale_background/);
  assert.match(cron,/system-v3-export-cache-refresh-v1[\s\S]*?refresh_operations_hub_matrix_export_cache_if_stale_background/);
  assert.match(cron,/background_managed/);
  assert.match(cron,/cron\.unschedule/);
  assert.match(cron,/operations-hub-legacy-mapping-refresh/);
  assert.match(cron,/operations-hub-csv-export-cache-refresh/);
  assert.doesNotMatch(cron,/update\s+operations_private\.operations_hub_matrix_refresh_state/i);
  assert.doesNotMatch(cron,/drop function/i);
});

test('first production activation enables only snapshot and cron-log retention',()=>{
  assert.match(activation,/operations-hub-snapshot-retention-v2[\s\S]*?cron\.alter_job\(v_snapshot_job_id,active:=true\)/);
  assert.match(activation,/operations-hub-cron-log-retention-v2[\s\S]*?cron\.alter_job\(v_cron_log_job_id,active:=true\)/);
  assert.match(activation,/operations-hub-cancelled-history-retention-v1[\s\S]*?cron\.alter_job\(v_cancelled_job_id,active:=false\)/);
  assert.doesNotMatch(activation,/^\s*(?:select|perform)\s+operations_private\.(?:archive_operations_hub_snapshot_history_v2|prune_operations_hub_cron_history_v2)\s*\(\s*\)\s*;/im);
});

