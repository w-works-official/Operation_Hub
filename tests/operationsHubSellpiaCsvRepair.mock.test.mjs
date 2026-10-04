import assert from 'node:assert/strict';
import fs from 'node:fs';

const dataService = fs.readFileSync(new URL('../mockups/operations-hub/data-service.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../mockups/operations-hub/app.js', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../supabase/migrations/20260820183000_fix_sellpia_csv_and_matrix_read_cache.sql', import.meta.url), 'utf8');
const dashboardMigration = fs.readFileSync(new URL('../supabase/migrations/20260820184500_cache_operations_hub_dashboard_metrics.sql', import.meta.url), 'utf8');
const searchMigration = fs.readFileSync(new URL('../supabase/migrations/20260820190000_optimize_operations_hub_listing_source_search.sql', import.meta.url), 'utf8');
const indexedSearchMigration = fs.readFileSync(new URL('../supabase/migrations/20260820191500_index_operations_hub_listing_source_search.sql', import.meta.url), 'utf8');
const staleRefreshMigration = fs.readFileSync(new URL('../supabase/migrations/20260820193000_skip_unchanged_operations_hub_cache_refresh.sql', import.meta.url), 'utf8');
const pageFirstMigration = fs.readFileSync(new URL('../supabase/migrations/20260831151000_operations_hub_matrix_page_v3.sql', import.meta.url), 'utf8');

// Upload parsing moved into sellpia-source-parser.js. Its encoding, schema,
// row-number, and preflight contract is covered by
// operationsHubSellpiaUploadParser.mock.test.mjs; this file stays focused on
// the independent snapshot-repair and matrix-cache regression boundary.
assert.doesNotMatch(dataService, /\.from\('operations_hub_matrix_live'\)/, 'interactive matrix reads must not hit the expensive live view');
assert.match(dataService, /\.from\('operations_hub_matrix_cached'\)/, 'interactive matrix reads must use the non-blocking cache');
assert.match(pageFirstMigration, /operations_hub_matrix_export_cache cache[\s\S]*?cache\.sellpia_sku_code[\s\S]*?ilike '%' \|\| v_search \|\| '%'/, 'Sellpia searches must stay on the compact page-key cache instead of the wide managed view');
assert.match(app, /MATRIX_TRANSIENT_RETRY_DELAYS_MS = \[700\]/, 'matrix reads must use one short bounded retry instead of amplifying a timeout storm');
assert.match(app, /attempt <= MATRIX_TRANSIENT_RETRY_DELAYS_MS\.length[\s\S]*DB 재시도 중/, 'matrix reads must retry transient database timeouts automatically');

assert.match(migration, /date '1899-12-30'/, 'the repair must use the Excel serial-date epoch');
assert.match(migration, /corrected_from_snapshot_id/, 'the corrected snapshot must retain its source snapshot lineage');
assert.match(migration, /without altering the uploaded source snapshot/, 'the repair must preserve the original uploaded snapshot');
assert.match(migration, /create or replace view public\.operations_hub_matrix_cached[\s\S]*operations_hub_matrix_export_cache/, 'the frontend read view must use the concurrently refreshed cache');
assert.match(migration, /operations_hub_matrix_export_cache_status_idx/, 'status pagination must have a cache index');
assert.match(migration, /create or replace view public\.operations_hub_dashboard_metrics[\s\S]*from public\.operations_hub_matrix_cached matrix/, 'dashboard metrics must avoid the expensive live matrix');
assert.match(dashboardMigration, /operations_hub_dashboard_metrics_cache[\s\S]*unique index/, 'dashboard metrics must be stored as a single cached row');
assert.match(dashboardMigration, /refresh materialized view concurrently operations_private\.operations_hub_dashboard_metrics_cache/, 'the dashboard cache must refresh atomically with the matrix cache');
assert.match(dashboardMigration, /create or replace view public\.operations_hub_dashboard_metrics[\s\S]*operations_hub_dashboard_metrics_cache/, 'frontend dashboard reads must use the cached aggregate');
assert.match(searchMigration, /find_operations_hub_listing_skus_by_sources[\s\S]*operations_hub_matrix_cached/, 'seller-code resolution must use the cached effective links');
assert.doesNotMatch(searchMigration, /operations_hub_matrix_core/, 'seller-code resolution must not rescan the core mapping three times');
assert.match(indexedSearchMigration, /smartstore_code_idx[\s\S]*makeshop_code_idx[\s\S]*ably_code_idx/, 'every seller composite code must have a cache expression index');
assert.match(indexedSearchMigration, /with allowed_sources as materialized[\s\S]*union all/, 'indexed seller-code lookup must keep source scans independently indexable');
assert.match(staleRefreshMigration, /refresh_operations_hub_matrix_export_cache_if_stale[\s\S]*cache_is_current/, 'the minute scheduler must skip unchanged matrix cache rebuilds');
assert.match(staleRefreshMigration, /cron\.alter_job[\s\S]*cron_matrix_read_cache/, 'the existing cache cron must use the stale-aware wrapper');

console.log('operations hub Sellpia CSV repair and cached read mock checks passed');
