import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration=fs.readFileSync(new URL('../supabase/migrations/20260920083000_hub_sellpia_carrier_snapshot_read_v2.sql',import.meta.url),'utf8');
const service=fs.readFileSync(new URL('../mockups/operations-hub/data-service.js',import.meta.url),'utf8');

test('Sellpia carrier proof reads raw price from the exact ready snapshot',()=>{
 assert.match(migration,/raw\.snapshot_id=p_snapshot_id/);
 assert.match(migration,/sellpia_source_sale_price',nullif\(raw\.raw_payload->>'base_price'/);
 assert.match(migration,/s\.snapshot_id=p_snapshot_id and s\.upload_status='ready'/);
 assert.match(migration,/'snapshot_id',p_snapshot_id/);
 assert.doesNotMatch(migration,/'sellpia_source_sale_price',c\.sellpia_sale_price/);
});

test('Sellpia patch caller binds every page to carrier and current state snapshots',()=>{
 assert.match(service,/hub_sellpia_patch_read_v3/);
 assert.match(service,/args\.p_snapshot_id=expectedSnapshotId/);
 assert.match(service,/args\.p_state_snapshot_id=expectedStateId/);
 assert.match(service,/data\?\.snapshot_id\)!==expectedSnapshotId/);
 assert.match(service,/data\?\.state_snapshot_id\)!==expectedStateId/);
});
