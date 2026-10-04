import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const sql = fs.readFileSync('supabase/migrations/20260922053841_split_hub_matrix_grid_manifest_badges.sql', 'utf8');
const manifest = sql.split('create or replace function public.hub_matrix_grid_link_badges_v1(')[0];
const badges = sql.split('create or replace function public.hub_matrix_grid_link_badges_v1(')[1];

test('v6 manifest preserves page identity without scanning all link badges', () => {
  assert.match(manifest, /hub_matrix_grid_manifest_v6\(\s*p_session_token text,\s*p_chunk_size integer default 2000/);
  assert.match(manifest, /require_operations_hub_operator_session\(p_session_token\)/);
  assert.match(manifest, /'contract_version', 6/);
  for (const key of ['total', 'dataset_version', 'recommended_chunk_size', 'max_chunk_size', 'page_cursors', 'tag_catalog']) {
    assert.match(manifest, new RegExp(`'${key}',`));
  }
  assert.doesNotMatch(manifest, /get_operations_hub_sku_link_badges_v2|link_badges/);
  assert.match(manifest, /grant execute on function public\.hub_matrix_grid_manifest_v6\(text,integer\) to anon, authenticated, service_role/);
});

test('bounded badge reader keeps the canonical relation projection and snapshot guard', () => {
  assert.match(badges, /p_dataset_version timestamptz,\s*p_skus text\[\]/);
  assert.match(badges, /require_operations_hub_operator_session\(p_session_token\)/);
  assert.match(badges, /cardinality\(p_skus\) not between 1 and 4000/);
  assert.match(badges, /set statement_timeout to '8s'/);
  assert.match(badges, /v_current_version is distinct from p_dataset_version/);
  assert.match(badges, /get_operations_hub_sku_link_badges_v2\(v_skus\)/);
  assert.match(badges, /badge\.sellpia_sku_code,\s*badge\.source_channel,\s*badge\.max_component_count,\s*badge\.relation_type/);
  for (const key of ['contract_version', 'dataset_version', 'requested', 'link_badges']) {
    assert.match(badges, new RegExp(`'${key}',`));
  }
  assert.match(badges, /revoke all on function public\.hub_matrix_grid_link_badges_v1\(text,timestamptz,text\[\]\) from public/);
  assert.match(badges, /grant execute on function public\.hub_matrix_grid_link_badges_v1\(text,timestamptz,text\[\]\) to anon, authenticated, service_role/);
});
