import assert from 'node:assert/strict';
import fs from 'node:fs';

const sql = fs.readFileSync(
  new URL('../supabase/migrations/20260831151000_operations_hub_matrix_page_v3.sql', import.meta.url),
  'utf8',
);

assert.match(sql, /create or replace function public\.load_operations_hub_matrix_page_v3\(/i, 'V3 must be introduced as a separate rollback-safe function');
assert.match(sql, /stable\s+security invoker/i, 'the read function must retain caller permissions');
assert.match(sql, /least\(coalesce\(p_page_size, 50\), 200\)/i, 'the server must cap one request at 200 rows');
assert.match(sql, /from operations_private\.operations_hub_matrix_export_cache cache/i, 'candidate keys must come from the compact export cache');
assert.match(sql, /ordered_page as materialized[\s\S]*?offset \(v_page - 1\) \* v_page_size[\s\S]*?limit v_page_size/i, 'filtering and paging must finish before detailed rows are expanded');
assert.match(sql, /cross join lateral \([\s\S]*?operations_hub_matrix_managed_live[\s\S]*?where live\.sellpia_sku_code = page_keys\.sellpia_sku_code[\s\S]*?offset 0/i, 'detail lookup must preserve the page-first lateral execution boundary');
assert.match(sql, /revoke all on function[\s\S]*?from public;[\s\S]*?grant execute on function[\s\S]*?to anon, authenticated;/i, 'only application roles may execute the RPC');

console.log('operations hub matrix page V3 migration contract tests passed');
