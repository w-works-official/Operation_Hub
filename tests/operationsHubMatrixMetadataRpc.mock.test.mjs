import assert from 'node:assert/strict';
import fs from 'node:fs';

const sql = fs.readFileSync(
  new URL('../supabase/migrations/20260831162000_operations_hub_matrix_metadata_v1.sql', import.meta.url),
  'utf8',
);
const optimization = fs.readFileSync(
  new URL('../supabase/migrations/20260831164000_optimize_matrix_metadata_bundle.sql', import.meta.url),
  'utf8',
);

assert.match(sql, /create or replace function public\.load_operations_hub_matrix_metadata_v1\(\s*p_skus text\[\]/i, 'matrix metadata must have one SKU-bounded RPC');
assert.match(sql, /stable\s+security invoker/i, 'metadata reads must retain caller permissions');
assert.match(sql, /cardinality\(v_skus\)[\s\S]*?> 200[\s\S]*?raise exception/i, 'metadata requests must reject more than one visible page');
for (const key of [
  'inbound_costs',
  'operational_details',
  'product_link_drafts',
  'manual_links',
  'profiles',
  'link_badges',
  'seller_price_components',
  'seller_drafts',
  'price_rule_assignments',
  'price_rule_sets',
  'link_suppressions',
]) {
  assert.match(sql, new RegExp(`'${key}'`), `${key} must be included in the one-request bundle`);
}
assert.match(sql, /seller_drafts'[\s\S]*?updated_at desc, draft\.change_id desc/i, 'latest seller drafts must preserve their deterministic priority');
assert.match(sql, /revoke all on function[\s\S]*?from public;[\s\S]*?grant execute on function[\s\S]*?to anon, authenticated;/i, 'only application roles may execute metadata reads');
assert.match(optimization, /operations_hub_change_queue_active_matrix_metadata_idx[\s\S]*?sellpia_sku_code[\s\S]*?updated_at desc[\s\S]*?status in \('pending', 'validated', 'failed'\)/i, 'active seller drafts must have one page-key-first partial index');
assert.match(optimization, /get_operations_hub_sku_link_badges_v2[\s\S]*?selected as materialized[\s\S]*?sellpia_sku_code = any[\s\S]*?selected_listings as materialized/i, 'link badges must select requested SKU relationships before counting listing sizes');
assert.match(optimization, /load_operations_hub_matrix_metadata_v1[\s\S]*?get_operations_hub_sku_link_badges_v2[\s\S]*?from \(\s*select distinct on \(queue\.sellpia_sku_code/i, 'the metadata bundle must use both page-first optimizations');

console.log('operations hub matrix metadata RPC contract tests passed');
