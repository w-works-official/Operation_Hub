import assert from 'node:assert/strict';
import fs from 'node:fs';

const data = fs.readFileSync(new URL('../mockups/operations-hub/data-service.js', import.meta.url), 'utf8');
const migration = fs.readFileSync(
  new URL('../supabase/migrations/20260831173500_operations_hub_matrix_filtered_v4.sql', import.meta.url),
  'utf8',
);
const restore = fs.readFileSync(
  new URL('../supabase/migrations/20260831172000_restore_matrix_condition_matcher.sql', import.meta.url),
  'utf8',
);

assert.match(
  data,
  /filterPayload\.conditions\.length[\s\S]*?db\.rpc\('load_operations_hub_matrix_filtered_v4'[\s\S]*?p_page:safePage[\s\S]*?p_page_size:safePageSize/,
  'advanced filters must request the full visible page through one V4 RPC',
);
assert.doesNotMatch(
  data.slice(data.indexOf('if (filterPayload.conditions.length)'), data.indexOf("db.rpc('load_operations_hub_matrix_page_v3'")),
  /loadPagedRpc/,
  'advanced filters must not split a 200-row page into two sequential database calls',
);
assert.match(migration, /jsonb_array_length\(v_conditions\) > 12/, 'V4 must bound the number of dynamic conditions');
assert.match(migration, /v_field is null|v_type is null/, 'V4 must reject fields outside the explicit allowlist');
assert.match(migration, /format\('cache\.%I', v_field\)/, 'validated ordinary fields must map to quoted cache identifiers');
assert.match(migration, /format\('\(cache\.profile_json ->> %L\)', v_field\)/, 'profile fields must stay inside the compact cache snapshot');
assert.match(migration, /format\('%L::numeric'|%L::numeric/, 'numeric values must be SQL-quoted after numeric validation');
assert.match(migration, /with filtered_keys as materialized[\s\S]*?operations_hub_matrix_export_cache cache[\s\S]*?offset \(\$9 - 1\) \* \$10 limit \$10/, 'filtering and paging must finish on compact cache rows');
assert.match(migration, /unnest\(v_page_skus\) with ordinality[\s\S]*?operations_hub_matrix_managed_live live[\s\S]*?offset 0/, 'only page keys may expand into managed matrix details');
assert.match(migration, /security invoker[\s\S]*?revoke all[\s\S]*?grant execute/i, 'V4 must preserve invoker security and explicit execution grants');
assert.match(restore, /language plpgsql[\s\S]*?operations_hub_matrix_condition_matches/, 'the rejected SQL-inline matcher must be explicitly rolled back');

console.log('Operations hub page-first advanced filter V4 contract: passed');
