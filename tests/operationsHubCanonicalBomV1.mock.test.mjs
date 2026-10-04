import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const migrationPath = new URL(
  '../supabase/migrations/20260901061940_operations_hub_canonical_bom_v1.sql',
  import.meta.url,
);
const migration = fs.readFileSync(migrationPath, 'utf8');
const applyStart = migration.indexOf('create or replace function public.apply_operations_hub_bundle_import_v1');
const applyEnd = migration.indexOf('\nrevoke all on function', applyStart);
const applySql = migration.slice(applyStart, applyEnd);

test('canonical BOM is isolated from relation, listing, price, inventory, and export state', () => {
  assert.match(migration, /create table public\.operations_hub_bundle_definitions/i);
  assert.match(migration, /create table public\.operations_hub_bundle_components/i);
  assert.match(migration, /create table public\.operations_hub_bundle_events/i);

  for (const legacyTable of [
    'operations_hub_relation_nodes',
    'operations_hub_relation_edges',
    'operations_hub_listing_components',
    'operations_hub_price_rule_assignments',
    'operations_hub_change_queue',
  ]) {
    assert.doesNotMatch(
      migration,
      new RegExp(`(?:insert\\s+into|update|delete\\s+from|alter\\s+table)\\s+public\\.${legacyTable}\\b`, 'i'),
      `${legacyTable} must not be mutated by the canonical BOM migration`,
    );
  }
  assert.doesNotMatch(
    migration,
    /(?:sellpia_current_stock|system_stock|system_base_price|sellpia_sale_price)\s*=/i,
    'canonical BOM persistence must not calculate or mutate price or inventory',
  );
});

test('bundle and component identities are durable, positive, role-bounded, and soft-deactivated', () => {
  assert.match(
    migration,
    /operations_hub_bundle_definitions[\s\S]*?bundle_sku_code text not null[\s\S]*?unique\s*\(bundle_sku_code\)/i,
    'one exact Sellpia SKU must own one durable bundle definition',
  );
  assert.match(
    migration,
    /operations_hub_bundle_components[\s\S]*?component_qty integer not null[\s\S]*?component_qty > 0/i,
    'component quantities must be positive integers like the existing listing-component contract',
  );
  assert.match(
    migration,
    /component_role text not null default 'component'[\s\S]*?component_role in \('component', 'packaging'\)/i,
    'V1 roles are component and packaging only',
  );
  assert.match(
    migration,
    /unique\s*\(bundle_id, component_sku_code\)/i,
    'one durable row per bundle/component pair enables deterministic upsert and reactivation',
  );
  assert.match(
    migration,
    /deactivate_operations_hub_bundle_component_v1\(\s*p_component_id bigint[\s\S]*?is_active\s*=\s*false/i,
    'component removal is a code-visible soft deactivation by stable component ID',
  );
  assert.doesNotMatch(migration, /delete\s+from\s+public\.operations_hub_bundle_/i, 'BOM rows are never hard-deleted');
});

test('exact Sellpia validation, self-link rejection, and graph cycle rejection are database-enforced', () => {
  assert.match(
    migration,
    /sellpia_stock_latest[\s\S]*?sellpia_sku_code\s*=\s*new\.bundle_sku_code/i,
    'bundle definitions must resolve against the exact latest Sellpia SKU',
  );
  assert.match(
    migration,
    /sellpia_stock_latest[\s\S]*?sellpia_sku_code\s*=\s*new\.component_sku_code/i,
    'components must resolve against the exact latest Sellpia SKU',
  );
  assert.match(migration, /v_bundle_sku_code\s*=\s*new\.component_sku_code/i, 'a bundle cannot contain itself');
  assert.match(
    migration,
    /with recursive descendants[\s\S]*?join public\.operations_hub_bundle_definitions nested_bundle[\s\S]*?순환 참조/i,
    'nested bundles are traversed and an indirect cycle is rejected',
  );
  assert.match(
    migration,
    /pg_advisory_xact_lock\(hashtextextended\('operations_hub_bundle_graph_v1'/i,
    'graph-shape writes are serialized to close concurrent cycle races',
  );
  assert.doesNotMatch(
    migration,
    /check\s*\([^)]*component_sku_code[^)]]*(?:not like|!~)[^)]*\)/i,
    'a component may itself be another bundle, enabling arbitrary acyclic depth',
  );
});

test('RPC signatures and response contracts match the UI and Excel importer', () => {
  assert.match(migration, /list_operations_hub_bundle_graph_v1\(\s*p_query text default ''/i);
  assert.match(migration, /resolve_operations_hub_bundle_import_codes_v1\(\s*p_codes jsonb default '\[\]'::jsonb/i);
  assert.match(migration, /apply_operations_hub_bundle_import_v1\(\s*p_rows jsonb default '\[\]'::jsonb/i);
  assert.match(
    migration,
    /save_operations_hub_bundle_component_v1\(\s*p_bundle_sku_code text,\s*p_component_sku_code text,\s*p_component_qty integer default 1,\s*p_component_role text default 'component',\s*p_sort_order integer default 100/i,
  );
  assert.match(migration, /deactivate_operations_hub_bundle_component_v1\(\s*p_component_id bigint/i);

  assert.match(migration, /'definitions'[\s\S]*?'components'[\s\S]*?'counts'/i, 'list returns graph arrays and counts');
  assert.match(migration, /'items'[\s\S]*?'candidateCount'[\s\S]*?'candidates'/i, 'resolve returns per-code status and candidates');
  assert.match(applySql, /'applied'[\s\S]*?'count'[\s\S]*?'rows'[\s\S]*?'errors'/i, 'apply returns the required summary');
  assert.match(migration, /'bundleComponentId'[\s\S]*?'componentQty'[\s\S]*?'componentRole'[\s\S]*?'changed'/i, 'save returns the persisted component shape');
});

test('bulk import is bounded, atomic, additive, and explicit about duplicate behavior', () => {
  assert.ok(applyStart >= 0 && applyEnd > applyStart, 'apply RPC SQL must be extractable');
  assert.match(applySql, /jsonb_array_length\(p_rows\) > 1000/i, 'bulk requests are bounded');
  assert.match(applySql, /conflicting_duplicate/i, 'conflicting duplicate pairs are rejected');
  assert.match(
    applySql,
    /v_qty_text !~ '\^\[0-9\]\+\$'/i,
    'bulk import rejects decimals and accepts integer quantity text only',
  );
  assert.match(
    applySql,
    /v_existing is not null[\s\S]*?continue[\s\S]*?v_seen :=/i,
    'identical duplicate pairs collapse before persistence',
  );
  assert.match(
    applySql,
    /if jsonb_array_length\(v_errors\) > 0[\s\S]*?return jsonb_build_object\('applied', false[\s\S]*?for v_item in select value from jsonb_array_elements\(v_normalized_rows\)/i,
    'all row errors are returned before the first write',
  );
  assert.match(
    applySql,
    /with recursive staged_edges[\s\S]*?reachable[\s\S]*?cycle_detected[\s\S]*?save_operations_hub_bundle_component_v1/i,
    'the complete proposed graph is cycle-checked before the first upsert',
  );
  assert.doesNotMatch(applySql, /is_active\s*=\s*false|deactivate_operations_hub_bundle_component_v1/i, 'omitted rows are never removed');
  assert.match(
    migration,
    /comment on function public\.apply_operations_hub_bundle_import_v1[\s\S]*?Identical duplicate rows collapse; conflicting duplicates and cycles reject the whole request\. Omitted rows are never deactivated\./i,
    'the database contract documents additive and duplicate semantics',
  );
});

test('anon GitHub Pages writes use SECURITY INVOKER, explicit grants, RLS, and enforced triggers', () => {
  for (const table of ['definitions', 'components', 'events']) {
    assert.match(migration, new RegExp(`operations_hub_bundle_${table} enable row level security`, 'i'));
  }
  assert.match(
    migration,
    /grant insert, update on table public\.operations_hub_bundle_definitions to anon, authenticated/i,
    'definitions expose only the insert/update operations required by the invoker RPC',
  );
  assert.match(
    migration,
    /grant insert, update on table public\.operations_hub_bundle_components to anon, authenticated/i,
    'components expose only the insert/update operations required by the invoker RPC',
  );
  assert.doesNotMatch(
    migration,
    /grant delete on table public\.operations_hub_bundle_/i,
    'no client receives hard-delete permission',
  );
  assert.match(
    migration,
    /operations hub bundle definitions client insert[\s\S]*?to anon, authenticated with check/i,
    'definition writes are gated by an explicit RLS insert policy',
  );
  assert.match(
    migration,
    /operations hub bundle components client update[\s\S]*?to anon, authenticated using \(true\)[\s\S]*?with check/i,
    'component updates have explicit USING and WITH CHECK clauses',
  );
  assert.match(
    migration,
    /grant execute on function public\.save_operations_hub_bundle_component_v1\(text, text, integer, text, integer\) to anon, authenticated/i,
    'the current publishable-key client can call only the constrained save RPC',
  );
  assert.match(
    migration,
    /grant execute on function public\.deactivate_operations_hub_bundle_component_v1\(bigint\) to anon, authenticated/i,
    'the current publishable-key client can soft-deactivate only by the constrained RPC',
  );
  assert.match(
    migration,
    /grant execute on function public\.apply_operations_hub_bundle_import_v1\(jsonb\) to anon, authenticated/i,
    'the current publishable-key client can call the bounded import RPC',
  );
  assert.match(
    migration,
    /revoke all on function public\.apply_operations_hub_bundle_import_v1\(jsonb\) from public/i,
    'PUBLIC does not inherit mutation RPC execution',
  );
  for (const rpc of [
    'save_operations_hub_bundle_component_v1',
    'deactivate_operations_hub_bundle_component_v1',
    'apply_operations_hub_bundle_import_v1',
  ]) {
    assert.match(
      migration,
      new RegExp(`${rpc}\\([\\s\\S]*?security invoker[\\s\\S]*?set search_path = pg_catalog, public`, 'i'),
      `${rpc} must preserve the anon/authenticated caller and pass RLS`,
    );
  }
  assert.doesNotMatch(
    migration,
    /security definer/i,
    'the migration must not bypass table privileges or RLS with SECURITY DEFINER',
  );
  assert.match(
    migration,
    /create trigger operations_hub_bundle_component_guard_v1[\s\S]*?create trigger operations_hub_bundle_component_audit_v1/i,
    'direct writes and RPC writes share integrity and audit triggers',
  );
});

test('actual changes and soft deactivations append audit events', () => {
  assert.match(
    migration,
    /create table public\.operations_hub_bundle_events[\s\S]*?before_value jsonb[\s\S]*?after_value jsonb[\s\S]*?changed_by uuid/i,
  );
  assert.match(
    migration,
    /audit_operations_hub_bundle_component_v1[\s\S]*?'COMPONENT_DEACTIVATE'[\s\S]*?'COMPONENT_UPSERT'[\s\S]*?to_jsonb\(old\)[\s\S]*?to_jsonb\(new\)/i,
    'the component audit trigger retains before/after snapshots for direct and RPC writes',
  );
  assert.match(
    migration,
    /create trigger operations_hub_bundle_definition_audit_v1[\s\S]*?audit_operations_hub_bundle_definition_v1/i,
    'definition changes cannot bypass audit logging',
  );
  assert.match(
    migration,
    /operations hub bundle events client insert[\s\S]*?pg_trigger_depth\(\) > 0/i,
    'clients may insert audit rows only while an enforced table trigger is executing',
  );
});

console.log('operations hub canonical BOM V1 database contract tests passed');
