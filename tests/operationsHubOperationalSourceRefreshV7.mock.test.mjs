import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(
  new URL('../supabase/migrations/20260903021316_operations_hub_operational_master_source_refresh_v7.sql', import.meta.url),
  'utf8'
);
const dataService = fs.readFileSync(
  new URL('../mockups/operations-hub/data-service.js', import.meta.url),
  'utf8'
);

for (const field of [
  'system_base_price',
  'system_stock',
  'sellpia_purchase_price',
  'sellpia_order_unit',
  'sellpia_minimum_order_unit'
]) {
  assert.match(migration, new RegExp(`'${field}'`), `${field} must be explicitly whitelisted in SQL`);
  assert.match(dataService, new RegExp(`'${field}'`), `${field} must be explicitly whitelisted in the data service`);
}

assert.doesNotMatch(
  migration.match(/create or replace function public\.refresh_operations_hub_master_column_from_source_v1[\s\S]*?comment on function/)[0],
  /'actual_inbound_cost'/,
  'computed/manual actual inbound cost has no immutable source column and must not be bulk-refreshed'
);
assert.match(
  migration,
  /refresh_operations_hub_master_column_from_source_v1\([\s\S]*?p_dry_run boolean default true[\s\S]*?if v_dry_run then[\s\S]*?else[\s\S]*?insert into public\.operations_hub_sku_operational_master/i,
  'the all-SKU source refresh must default to a write-free preview'
);
assert.match(
  migration,
  /'total_sku_count'[\s\S]*?'source_value_count'[\s\S]*?'affected_count'[\s\S]*?'skipped_count'[\s\S]*?'source_missing_count'/,
  'the preview/apply response must expose complete reconciliation counts'
);
assert.match(
  migration,
  /from public\.sellpia_stock_latest source_stock[\s\S]*?insert into public\.operations_hub_sku_operational_master[\s\S]*?from changed[\s\S]*?on conflict \(sellpia_sku_code\) do update/i,
  'the apply path must use one set-based upsert from the latest immutable source'
);
assert.match(
  migration,
  /'operation', 'bulk_source_refresh'[\s\S]*?'request_id', v_request_id[\s\S]*?'field_key', v_field/,
  'every changed-row audit event must identify the bulk operation and request'
);
assert.match(
  migration,
  /security definer[\s\S]*?set search_path = pg_catalog[\s\S]*?require_operations_hub_operator_session\(p_session_token\)[\s\S]*?revoke all on function public\.refresh_operations_hub_master_column_from_source_v1\(text,text,text,uuid,boolean\)[\s\S]*?grant execute[^;]+to anon, authenticated/i,
  'the constrained write RPC must authenticate first, use a fixed search path, and have explicit execution grants'
);
assert.match(
  migration,
  /refresh_operations_hub_master_column_from_source_v1\([\s\S]*?set statement_timeout = '45s'/i,
  'the set-based all-SKU operation must have a bounded timeout long enough for the expected batch'
);

assert.match(migration, /stock\.purchase_price as sellpia_source_purchase_price/);
assert.match(migration, /stock\.order_unit as sellpia_source_order_unit/);
assert.match(migration, /stock\.minimum_order_unit as sellpia_source_minimum_order_unit/);
assert.match(migration, /coalesce\(master\.purchase_price, stock\.purchase_price\) as sellpia_purchase_price/);
assert.match(migration, /calculate_operations_hub_inbound_cost\(\s*coalesce\(master\.purchase_price, stock\.purchase_price\)/i,
  'formula inbound cost must use the effective purchase-price overlay');
assert.match(migration, /settings\.manual_cost is not null then settings\.manual_cost[\s\S]*?settings\.formula_tag_id is not null/i,
  'existing manual-over-formula actual inbound semantics must remain intact');

assert.match(dataService, /async function refreshMasterColumnFromSource\(\{fieldKey, actor = 'operations-hub', requestId = null, dryRun = true\}/);
assert.match(dataService, /p_dry_run:dryRun !== false/);
assert.match(dataService, /db\.rpc\('refresh_operations_hub_master_column_from_source_v1', params\)/);
assert.match(dataService, /saveSellpiaChanges[\s\S]*?systemFieldKeys = new Set\([\s\S]*?sellpia_minimum_order_unit[\s\S]*?save_operations_hub_sku_operational_value/);
assert.match(dataService, /sellpia_source_purchase_price,sellpia_source_order_unit,sellpia_source_minimum_order_unit/);

console.log('Operations hub operational source-refresh V7 contract: passed');
