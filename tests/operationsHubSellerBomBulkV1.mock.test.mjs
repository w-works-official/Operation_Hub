import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const migration = fs.readFileSync(
  new URL('../supabase/migrations/20260901064313_operations_hub_seller_bom_bulk_v1.sql', import.meta.url),
  'utf8',
);
const applyStart = migration.indexOf('create or replace function public.apply_operations_hub_seller_bundle_import_v1');
const applyEnd = migration.indexOf('create or replace function public.list_operations_hub_seller_bundle_graph_v1', applyStart);
const applySql = migration.slice(applyStart, applyEnd);

test('seller bundle bulk import reuses listing/component tables and never creates fake Sellpia identities', () => {
  assert.match(applySql, /insert into public\.operations_hub_seller_listings/i);
  assert.match(applySql, /insert into public\.operations_hub_listing_components/i);
  assert.doesNotMatch(migration, /create table public\.operations_hub_(?:seller_listings|listing_components)/i);
  assert.doesNotMatch(migration, /insert into public\.sellpia_stock|insert into catalog\.sellpia_products/i);
  assert.doesNotMatch(migration, /insert into public\.operations_hub_bundle_(?:definitions|components)/i);
});

test('preflight contract is bounded and validates exact seller option plus exact Sellpia component', () => {
  assert.match(migration, /resolve_operations_hub_seller_bundle_import_rows_v1\(\s*p_rows jsonb default '\[\]'::jsonb/i);
  assert.match(migration, /jsonb_array_length\(p_rows\) > 1000/i);
  for (const field of [
    'source_channel', 'product_code', 'option_code',
    'component_sku_code', 'component_qty', 'bundle_type',
  ]) {
    assert.match(migration, new RegExp(`v_item ->> '${field}'`, 'i'), `${field} is part of the row contract`);
  }
  assert.match(
    migration,
    /from public\.seller_inventory_latest latest[\s\S]*?latest\.source_channel = v_source[\s\S]*?latest\.product_code = v_product_code[\s\S]*?latest\.option_code = v_option_code[\s\S]*?v_count <> 1/i,
    'source/product/option must resolve to exactly one latest seller row',
  );
  assert.match(migration, /seller_option_not_found[\s\S]*?seller_option_ambiguous/i);
  assert.match(
    migration,
    /from public\.sellpia_stock_latest latest[\s\S]*?latest\.sellpia_sku_code = v_component_sku[\s\S]*?v_count <> 1/i,
    'component must be one exact real Sellpia SKU',
  );
  assert.match(migration, /component_not_found[\s\S]*?component_ambiguous/i);
});

test('type, quantity, duplicate, and one-plus-one validation are explicit', () => {
  assert.match(migration, /v_bundle_type not in \('one_plus_one', 'set'\)/i);
  assert.match(migration, /v_qty_text !~ '\^\[0-9\]\+\$'/i, 'decimal quantity text is rejected');
  assert.match(migration, /v_qty_text::numeric <= 0[\s\S]*?> 2147483647/i);
  assert.match(migration, /conflicting_bundle_type/i, 'one seller option cannot be both set and one-plus-one');
  assert.match(migration, /conflicting_duplicate/i, 'duplicate pairs with conflicting quantities are rejected');
  assert.match(migration, /one_plus_one_quantity_too_small[\s\S]*?총 구성수량은 2 이상/i);
  assert.match(migration, /v_component_role := case when v_target_seen \? v_target_key then 'additional' else 'primary' end/i);
});

test('apply validates the full request before writes and remains additive', () => {
  assert.ok(applyStart >= 0 && applyEnd > applyStart);
  assert.match(
    applySql,
    /v_preflight := public\.resolve_operations_hub_seller_bundle_import_rows_v1\(p_rows\)[\s\S]*?if not coalesce[\s\S]*?return jsonb_build_object[\s\S]*?pg_advisory_xact_lock[\s\S]*?for v_row/i,
    'all rows are preflighted before the first mutation',
  );
  assert.match(applySql, /insert into public\.operations_hub_seller_listings/i);
  assert.match(applySql, /insert into public\.operations_hub_listing_components/i);
  assert.match(applySql, /relation_kind = v_row ->> 'bundle_type'/i);
  assert.match(applySql, /mapping_origin = 'import'/i);
  assert.doesNotMatch(applySql, /delete from|is_active\s*=\s*false|DEACTIVATE/i, 'omitted rows are never removed');
});

test('unique-key upsert is naturally idempotent and audits actual changes only', () => {
  assert.match(
    applySql,
    /if not v_listing\.is_active[\s\S]*?v_listing_changed := true/i,
    'an unchanged listing skips update',
  );
  assert.match(
    applySql,
    /if not v_component\.is_active[\s\S]*?component_qty is distinct from[\s\S]*?component_role is distinct from[\s\S]*?v_component_changed := true/i,
    'an unchanged component skips update',
  );
  assert.match(
    applySql,
    /if v_component_changed then[\s\S]*?insert into public\.operations_hub_listing_component_events/i,
    'component audit is emitted only for an actual insert/update/reactivation',
  );
  assert.match(
    applySql,
    /if v_listing_changed then[\s\S]*?insert into public\.operations_hub_relation_events/i,
    'listing type changes retain before/after organization audit',
  );
  assert.match(applySql, /'changedCount'[\s\S]*?'unchangedCount'[\s\S]*?'rows'[\s\S]*?'errors'/i);
});

test('RPCs preserve current anon RLS boundaries without privileged definer code', () => {
  assert.doesNotMatch(migration, /security definer/i);
  for (const rpc of [
    'resolve_operations_hub_seller_bundle_import_rows_v1',
    'apply_operations_hub_seller_bundle_import_v1',
    'list_operations_hub_seller_bundle_graph_v1',
  ]) {
    assert.match(
      migration,
      new RegExp(`${rpc}\\([\\s\\S]*?security invoker[\\s\\S]*?set search_path = pg_catalog, public`, 'i'),
    );
  }
  assert.match(migration, /grant execute on function public\.apply_operations_hub_seller_bundle_import_v1\(jsonb\) to anon, authenticated/i);
  assert.match(migration, /revoke all on function public\.apply_operations_hub_seller_bundle_import_v1\(jsonb\) from public/i);
});

test('read contract returns seller targets, real components, and counts', () => {
  assert.match(migration, /list_operations_hub_seller_bundle_graph_v1\(\s*p_source text default '',\s*p_query text default ''/i);
  assert.match(migration, /listing\.relation_kind in \('one_plus_one', 'set'\)/i);
  assert.match(migration, /'listings'[\s\S]*?'components'[\s\S]*?'counts'/i);
  assert.match(migration, /'componentSkuCode'[\s\S]*?'componentQty'[\s\S]*?'componentRole'/i);
});

console.log('operations hub seller bundle bulk V1 database contract tests passed');
