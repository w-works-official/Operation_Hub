import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const data=fs.readFileSync('mockups/operations-hub/data-service.js','utf8');
const app=fs.readFileSync('mockups/operations-hub/app.js','utf8');
const flow=fs.readFileSync('mockups/operations-hub/seller-file-workflow-v2.js','utf8');
const migration=fs.readFileSync('supabase/migrations/20260913190000_operations_hub_reliability_v1.sql','utf8');

test('Reliability V1 has durable job checkpoints and transient retries',()=>{
  assert.ok(data.includes('beginReliableExportJob'));
  assert.ok(data.includes('checkpointReliableExportJob'));
  assert.ok(data.includes('getReliableExportJob'));
  assert.ok(data.includes('withTransientDbRetry'));
  assert.ok(data.includes('stage_operations_hub_seller_inventory_match_batch_v2'));
  assert.ok(app.includes('after_cursor'));
  assert.ok(app.includes('onCheckpoint'));
  assert.ok(data.includes('checkpointReliableExportJob'));
  assert.ok(!flow.includes('prepareReliableInventory'));
  assert.ok(!flow.includes('beginReliableExportJob'));
  assert.ok(!flow.includes('stageSellerInventoryDraftBatch'));
  assert.ok(migration.includes('operations_hub_export_jobs'));
  assert.ok(migration.includes('background_managed'));
  assert.ok(migration.includes('cron.schedule'));
});

test('Jobs silent polling is cheap and export blocks background polling',()=>{
  assert.ok(app.includes('silent && window.__systemV3DirectExportBusy'));
  assert.match(app,/if\s*\(silent\)\s*\{/);
  assert.ok(app.includes('120000'));
});
