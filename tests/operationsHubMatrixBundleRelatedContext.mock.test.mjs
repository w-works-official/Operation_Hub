import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(
  new URL('../supabase/migrations/20260901170000_operations_hub_matrix_bundle_context_v6.sql', import.meta.url),
  'utf8',
);
const data = fs.readFileSync(new URL('../mockups/operations-hub/data-service.js', import.meta.url), 'utf8');

assert.match(
  migration,
  /create or replace function public\.load_operations_hub_matrix_filtered_v6\([\s\S]*?p_include_related_sku_context boolean default false/i,
  'bundle-aware matrix context must remain an explicit opt-in read RPC',
);
assert.match(
  migration,
  /v_direct_result := public\.load_operations_hub_matrix_filtered_v4\([\s\S]*?p_exclude_dependent/i,
  'V4 must remain the authority for direct filtering, sorting, and paging',
);
assert.match(
  migration,
  /operations_hub_relation_edges[\s\S]*?'relation'::text as relationship_family/i,
  'generic relation edges must retain their own relationship family',
);
assert.match(
  migration,
  /operations_hub_bundle_definitions[\s\S]*?operations_hub_bundle_components[\s\S]*?'bundle_component'[\s\S]*?'bundle_parent'/i,
  'canonical bundle traversal must work from a bundle to components and from a component to containing bundles',
);
assert.match(
  migration,
  /seller_bundle_candidates as materialized[\s\S]*?'seller_bundle_sibling'[\s\S]*?operations_hub_listing_components root_component[\s\S]*?operations_hub_seller_listings listing[\s\S]*?operations_hub_listing_components peer_component/i,
  'seller-only bundles must use their listing as a hub and return real Sellpia co-component rows',
);
assert.match(
  migration,
  /listing\.relation_kind in \('one_plus_one', 'set'\)/i,
  'ordinary one-to-one seller listings must not be mislabeled as seller bundles',
);
assert.match(
  migration,
  /partition by all_related_candidates\.root_sku, all_related_candidates\.related_sku[\s\S]*?path_rank = 1/i,
  'the same related SKU reached by multiple paths or families must render once per direct root',
);
assert.match(
  migration,
  /'matrix_context'[\s\S]*?'relationshipFamily'[\s\S]*?'relationshipType'[\s\S]*?'relationshipDetails'/i,
  'returned related rows must disclose their relationship source without flattening the schemas',
);
assert.match(
  migration,
  /'count', coalesce\(v_direct_result -> 'count'[\s\S]*?'directCount', coalesce\(v_direct_result -> 'count'/i,
  'bundle context rows must not inflate direct result count or pagination',
);
assert.match(
  migration,
  /security invoker[\s\S]*?revoke all on function[\s\S]*?grant execute on function[\s\S]*?to anon, authenticated/i,
  'the additive read RPC must preserve invoker security and explicit execution grants',
);

assert.match(
  data,
  /db\.rpc\('load_operations_hub_matrix_filtered_v6'[\s\S]*?isMissingMatrixRpc\(v6Error, 'load_operations_hub_matrix_filtered_v6'\)[\s\S]*?db\.rpc\('load_operations_hub_matrix_filtered_v5'/i,
  'the frontend must prefer V6 and fall back only when the additive RPC is genuinely missing',
);
assert.match(
  data,
  /const relationshipFamily = cleanText\([\s\S]*?context\.relationshipFamily[\s\S]*?relationshipType[\s\S]*?relationshipDetails/i,
  'the data adapter must retain relationship family, type, and details for the UI',
);

const fixture = {
  count: 1,
  directCount: 1,
  relatedCount: 3,
  rows: [
    {sellpia_sku_code: 'SET-1', matrix_context: {kind: 'direct', rootSku: 'SET-1', relationshipFamily: 'direct'}},
    {sellpia_sku_code: 'COMP-1', matrix_context: {kind: 'related', rootSku: 'SET-1', direction: 'bundle_component', relationshipFamily: 'canonical_bundle'}},
    {sellpia_sku_code: 'COMP-2', matrix_context: {kind: 'related', rootSku: 'SET-1', direction: 'seller_bundle_sibling', relationshipFamily: 'seller_bundle'}},
    {sellpia_sku_code: 'CHILD-1', matrix_context: {kind: 'related', rootSku: 'SET-1', direction: 'descendant', relationshipFamily: 'relation'}},
  ],
};

assert.equal(fixture.count, fixture.directCount, 'direct pagination stays root-only');
assert.deepEqual(
  new Set(fixture.rows.filter(row => row.matrix_context.kind === 'related').map(row => row.matrix_context.relationshipFamily)),
  new Set(['relation', 'canonical_bundle', 'seller_bundle']),
  'all saved relationship families can coexist in one searched matrix context',
);

console.log('operations hub bundle-aware matrix related context contract: passed');
