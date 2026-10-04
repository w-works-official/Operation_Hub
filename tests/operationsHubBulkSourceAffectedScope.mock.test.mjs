import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(new URL('../supabase/migrations/20260921025302_read_bulk_source_refresh_affected_skus.sql', import.meta.url), 'utf8');
const recoveryMigration = fs.readFileSync(new URL('../supabase/migrations/20260921032052_recover_bulk_source_price_calculation_scope.sql', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../mockups/operations-hub/app.js', import.meta.url), 'utf8');
const dataService = fs.readFileSync(new URL('../mockups/operations-hub/data-service.js', import.meta.url), 'utf8');
const materializer = fs.readFileSync(new URL('../mockups/operations-hub/price-result-materializer.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../mockups/operations-hub/index.html', import.meta.url), 'utf8');

assert.match(migration, /require_operations_hub_operator_session\(p_session_token\)/, 'affected scope read must validate the operator session');
assert.match(migration, /metadata ->> 'request_id'[\s\S]*p_request_id::text/, 'affected scope must use the exact source-refresh request');
assert.match(migration, /metadata ->> 'operation' = 'bulk_source_refresh'/, 'unrelated operational events must not enter the calculation scope');
assert.match(migration, /select distinct operational_event\.sellpia_sku_code/, 'affected scope must contain unique SKUs');
assert.match(migration, /revoke all on function public\.read_operations_hub_bulk_source_refresh_affected_skus_v1[\s\S]*grant execute[\s\S]*to anon, authenticated/, 'the RPC must be callable only through its session-gated body');
assert.match(recoveryMigration, /require_operations_hub_operator_session\(p_session_token\)/, 'recovery scope must validate the operator session');
assert.match(recoveryMigration, /calculated\.calculated_at < source_event\.created_at/, 'recovery scope must find calculations older than their source refresh');
assert.match(recoveryMigration, /calculated\.status <> 'calculated'/, 'recovery scope must include failed calculations');
assert.match(recoveryMigration, /calculated\.sku is null/, 'recovery scope must include missing calculations');

assert.match(dataService, /if \(dryRun !== false\) return result;/, 'dry-runs must not issue an affected or recovery scope read');
assert.match(dataService, /affected_skus_error/, 'a lost scope response must be explicit and must not trigger a full-catalog fallback');
assert.match(dataService, /changedCount < 1[\s\S]*read_operations_hub_bulk_source_refresh_recovery_skus_v1/, 'a no-op source refresh must recover the latest unfinished price calculation scope');
assert.doesNotMatch(app.slice(app.indexOf('async function applyBulkSourceRefresh()'), app.indexOf("document.getElementById('matrix-bulk-source-refresh-btn')")), /loadAllFilteredSkus/, 'apply must never widen a source refresh to the full catalog');
assert.match(app, /row\.affectedSkus\.length > 0[\s\S]*materializeHubPrices\(priceSkus/, 'recovery SKUs must run even when the source write count is zero');
assert.match(app, /incompleteScope[\s\S]*affectedSkus\.length !== \(row\.calculationRecovery \? row\.calculationRecoveryCount : row\.changedCount\)/, 'the client must prove that every changed or recovered SKU entered the bounded calculation scope');
assert.match(materializer, /summary\.affectedSkus=\[\.\.\.affected\]/, 'the materializer must return expanded dependency SKUs for row patching');
assert.match(html, /data-service\.js\?v=[^"']+[\s\S]*app\.js\?v=[^"']+[\s\S]*price-result-materializer\.js\?v=[^"']+/, 'the deployed page must cache-bust every changed source-refresh asset');

console.log('Operations Hub bulk source refresh exact affected scope contract: passed');
