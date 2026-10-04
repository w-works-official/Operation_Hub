import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const feed = fs.readFileSync('supabase/migrations/20260921103800_optimize_hub_matrix_grid_feed_v5_snapshot_lookup.sql', 'utf8');
const targeted = fs.readFileSync('supabase/migrations/20260921142718_hub_matrix_grid_rows_v5.sql', 'utf8');

function between(sql, start, end) {
  const from = sql.indexOf(start);
  assert.ok(from >= 0, `missing ${start}`);
  const to = sql.indexOf(end, from + start.length);
  assert.ok(to >= 0, `missing ${end}`);
  return sql.slice(from, to);
}

test('targeted Grid reader validates the operator, caps input, and reads only exact SKUs', () => {
  assert.match(targeted, /create or replace function public\.hub_matrix_grid_rows_v5\(\s*p_session_token text,\s*p_skus text\[\]/);
  assert.match(targeted, /security definer[\s\S]*?set search_path to 'pg_catalog'/);
  assert.match(targeted, /perform operations_private\.require_operations_hub_operator_session\(p_session_token\);/);
  assert.match(targeted, /cardinality\(p_skus\) not between 1 and 200/);
  assert.match(targeted, /cache\.sellpia_sku_code = any\(v_skus\)/);
  assert.match(targeted, /join page_keys using \(sellpia_sku_code\)/);
  assert.doesNotMatch(targeted, /p_after_sku|\boffset\b|\b(insert|update|delete|merge|truncate)\b/i);
  assert.match(targeted, /revoke all on function public\.hub_matrix_grid_rows_v5\(text,text\[\]\) from public/);
});

test('targeted Grid reader shares the exact v5 positional projection and bounded enrichments', () => {
  const cacheColumns = (sql, cte) => between(sql.replaceAll('\r', ''), `  ${cte} as materialized (\n    select`,
    '    from operations_private.operations_hub_matrix_export_cache cache')
    .replace(/^  page(?:_plus)? as materialized \(\n    select/, '');
  assert.equal(cacheColumns(targeted, 'page'), cacheColumns(feed, 'page_plus'),
    'targeted rows must read the same Grid cache columns');
  const projection = sql => between(sql, '  page_keys as materialized (', '\n  select coalesce(jsonb_agg(assembled.row_json');
  assert.equal(projection(targeted).replaceAll('\r', ''), projection(feed).replaceAll('\r', ''),
    'targeted rows must preserve the live v5 Grid row shape and joins');
  assert.match(targeted, /get_operations_hub_sku_link_badges_v2\(v_skus\)/);
  assert.doesNotMatch(targeted, /get_operations_hub_sku_link_badges_v2\(\s*\(select array_agg\(cache\.sellpia_sku_code/);
  assert.match(targeted, /'tag_catalog', v_tag_catalog/);
  assert.match(targeted, /'link_badges', v_link_badges/);
  assert.match(targeted, /'contract_version', 5/);
});

test('targeted Grid reader exposes missing identities and a current cache version without full reload', () => {
  assert.match(targeted, /not exists \(\s*select 1 from operations_private\.operations_hub_matrix_export_cache cache\s*where cache\.sellpia_sku_code = requested\.sku/);
  assert.match(targeted, /'requested', cardinality\(v_skus\)/);
  assert.match(targeted, /'loaded', v_loaded/);
  assert.match(targeted, /'missing_skus', v_missing_skus/);
  assert.match(targeted, /'dataset_version', v_current_version/);
  assert.match(targeted, /'rows', v_rows/);
  assert.doesNotMatch(targeted, /page_cursors|latest.*manifest|loadFullMatrixDataset/);
});
