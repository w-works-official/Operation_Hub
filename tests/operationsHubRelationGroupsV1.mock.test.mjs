import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const groupsApi = require('../mockups/operations-hub/relation-groups-v1.js');

const migration = fs.readFileSync(
  new URL('../supabase/migrations/20260901043312_operations_hub_relation_groups_v1.sql', import.meta.url),
  'utf8',
);
const moduleSource = fs.readFileSync(
  new URL('../mockups/operations-hub/relation-groups-v1.js', import.meta.url),
  'utf8',
);

test('group/folder, SKU membership, and typed DAG storage stay separate', () => {
  assert.match(
    migration,
    /create table public\.operations_hub_relation_groups[\s\S]*?folder_id bigint[\s\S]*?references public\.operations_hub_relation_folders\(folder_id\)/i,
    'a reusable group belongs to a folder, but must not replace the folder hierarchy itself',
  );
  assert.match(
    migration,
    /create table public\.operations_hub_relation_group_memberships[\s\S]*?group_id bigint[\s\S]*?node_id bigint[\s\S]*?references public\.operations_hub_relation_nodes/i,
    'Sellpia SKU membership must be a durable group-scoped record through the existing SKU-capable relation-node identity',
  );
  assert.match(
    migration,
    /operations_hub_relation_group_memberships[\s\S]*?unique\s*\(\s*group_id\s*,\s*node_id\s*\)/i,
    'one SKU may appear once per group while remaining eligible for other groups',
  );
  assert.match(
    migration,
    /create table public\.operations_hub_relation_group_edges[\s\S]*?from_node_id[\s\S]*?to_node_id[\s\S]*?edge_kind text[\s\S]*?(?:collection_member|set_member)/i,
    'the group graph must persist typed parent-child edges, not an untyped UI-only list',
  );
  assert.match(
    migration,
    /from_node_id\s*<>\s*to_node_id/i,
    'self edges must be rejected at the database boundary',
  );
  assert.match(
    migration,
    /with recursive[\s\S]*?cycle|순환/i,
    'group edge writes must reject indirect cycles',
  );
  assert.doesNotMatch(
    migration,
    /unique\s*\(\s*node_id\s*\)/i,
    'a global relation-node-only unique constraint would incorrectly block multi-group membership',
  );
});

test('group writes are bounded, idempotent, recoverable, and operator-guarded', () => {
  assert.match(
    migration,
    /create table public\.operations_hub_relation_group_requests[\s\S]*?request_id uuid/i,
    'group writes require a durable request-id idempotency log',
  );
  assert.match(
    migration,
    /apply_operations_hub_relation_groups_v1\(\s*p_request_id uuid/i,
    'the atomic group apply RPC must require an explicit request ID',
  );
  assert.match(
    migration,
    /pg_advisory_xact_lock|on conflict[\s\S]*?request_id|idempotent/i,
    'a repeated request ID must serialize or replay instead of duplicating events and edges',
  );
  assert.match(
    migration,
    /jsonb_array_length[\s\S]*?500[\s\S]*?jsonb_array_length[\s\S]*?1000/i,
    'one group request must bound nodes/groups and edges before graph traversal',
  );
  assert.match(
    migration,
    /archive_operations_hub_relation_group_v1[\s\S]*?return public\.apply_operations_hub_relation_groups_v1/i,
    'the archive endpoint must reuse the atomic, idempotent group-apply boundary',
  );
  assert.match(
    migration,
    /update public\.operations_hub_relation_groups[\s\S]*?is_active\s*=\s*false[\s\S]*?insert into public\.operations_hub_relation_group_events[\s\S]*?GROUP_ARCHIVE/i,
    'group deletion must be a soft archive with an audit event',
  );
  assert.match(
    migration,
    /app_metadata[\s\S]*?operator|operator[\s\S]*?app_metadata/i,
    'every group mutation must verify an operator role from immutable app metadata',
  );
  assert.match(
    migration,
    /security invoker/i,
    'the relation-group RPCs must preserve caller/RLS semantics',
  );
  assert.match(
    migration,
    /revoke all on function[\s\S]*?from public/i,
    'new RPCs must not inherit PUBLIC execution',
  );
  assert.doesNotMatch(
    migration,
    /grant\s+(?:select\s*,\s*)?(?:insert|update|delete)[\s\S]{0,220}?on table public\.operations_hub_relation_group(?:s|_memberships|_edges|_requests|_events)[\s\S]{0,180}?to anon/i,
    'anon users must never receive direct mutable table privileges',
  );
  assert.doesNotMatch(
    migration,
    /grant execute on function public\.(?:apply_operations_hub_relation_groups_v1|archive_operations_hub_relation_group_v1)[\s\S]*?to anon/i,
    'anonymous callers must not invoke privileged group mutation RPCs',
  );
});

test('relation grouping remains metadata-only: listing BOM, price, and inventory are unchanged', () => {
  const writeBlock = migration.slice(migration.indexOf('apply_operations_hub_relation_groups_v1'));
  assert.doesNotMatch(
    writeBlock,
    /(?:insert into|update|delete from) public\.operations_hub_listing_components/i,
    'generic group relations must not mutate the seller listing BOM',
  );
  assert.doesNotMatch(
    writeBlock,
    /component_qty\s*=|component_role\s*=|parent_component_id\s*=/i,
    'generic group relations must not alter component quantities, roles, or BOM parentage',
  );
  assert.doesNotMatch(
    writeBlock,
    /(?:insert into|update|delete from) public\.operations_hub_price_rule|(?:insert into|update|delete from) public\.operations_hub_change_queue/i,
    'group editing must not assign price rules or create price/export drafts implicitly',
  );
  assert.doesNotMatch(
    writeBlock,
    /sellpia_current_stock\s*=|system_stock\s*=|system_base_price\s*=|sellpia_sale_price\s*=/i,
    'group editing must not change live inventory or price values',
  );
});

test('UI group module exposes deterministic, staged relationship editing primitives', () => {
  assert.match(moduleSource, /RelationGroupsV1[\s\S]*?GROUP_TYPES/i, 'the module must publish a self-contained group vocabulary');
  for (const name of [
    'createState', 'normalizeState', 'createFolder', 'createGroup', 'upsertSku',
    'addMembership', 'stageAddEdge', 'stageRemoveEdge', 'getActiveEdges',
    'calculateLanes', 'getGroupGraph', 'getChangeSummary', 'renderFixture',
  ]) {
    assert.match(moduleSource, new RegExp(`(?:function\\s+${name}\\b|${name}\\s*:)`), `${name} must remain callable without loading the matrix app`);
  }
  assert.match(moduleSource, /EDGE_TYPES[\s\S]*?collection_member[\s\S]*?set_member/i, 'staged edges must carry an allowed semantic type rather than an untyped link');
  assert.match(moduleSource, /defaultEdgeType[\s\S]*?edgeType/i, 'a group type must deterministically supply the edge type when the caller omits it');
  assert.match(moduleSource, /parentSkuId[\s\S]*?childSkuId/i, 'the UI state must preserve direction by SKU node identity');
  assert.match(moduleSource, /staged(?:Adds|Removes|AddEdges|RemoveEdges)|stageRemoveEdge/i, 'removal must stay staged until the user saves an atomic request');
  assert.match(moduleSource, /groupId[\s\S]*?folderId/i, 'folder placement and group identity must be separate UI fields');
});

// This fixture documents the required UI contract independently of DOM layout.
// A SKU can belong to more than one collection, while each staged removal is
// visible before save and direct edges stay unique per group/type.
const fixture = {
  folders:[{id:'folder-collection', name:'모음전'}],
  groups:[
    {id:'collection-a', folderId:'folder-collection', type:'collection'},
    {id:'collection-b', folderId:'folder-collection', type:'collection'},
  ],
  memberships:[
    {groupId:'collection-a', skuId:'sku-a'}, {groupId:'collection-a', skuId:'sku-b'}, {groupId:'collection-a', skuId:'sku-c'},
    {groupId:'collection-b', skuId:'sku-a'}, {groupId:'collection-b', skuId:'sku-d'},
  ],
  activeEdges:[
    {id:'edge-a-b', groupId:'collection-a', parentSkuId:'sku-a', childSkuId:'sku-b', edgeType:'collection_member'},
    {id:'edge-a-c', groupId:'collection-a', parentSkuId:'sku-a', childSkuId:'sku-c', edgeType:'collection_member'},
    {id:'edge-d-a', groupId:'collection-b', parentSkuId:'sku-d', childSkuId:'sku-a', edgeType:'collection_member'},
  ],
  stagedRemoveEdgeIds:['edge-a-c'],
};

test('fixture covers 1:N, N:1 membership, and a staged removal summary', () => {
  const membersOfA = fixture.memberships.filter(row => row.groupId === 'collection-a').map(row => row.skuId);
  const groupsForA = fixture.memberships.filter(row => row.skuId === 'sku-a').map(row => row.groupId);
  assert.deepEqual(membersOfA, ['sku-a', 'sku-b', 'sku-c'], 'one collection supports one-to-many SKU membership');
  assert.deepEqual(groupsForA, ['collection-a', 'collection-b'], 'one SKU supports many collection memberships');
  const visibleEdges = fixture.activeEdges.filter(edge => !fixture.stagedRemoveEdgeIds.includes(edge.id));
  assert.deepEqual(visibleEdges.map(edge => edge.id), ['edge-a-b', 'edge-d-a'], 'staged removal hides only the intended edge before save');
  const summary = {
    addCount:0,
    removeCount:fixture.stagedRemoveEdgeIds.length,
    activeAfterSave:visibleEdges.length,
  };
  assert.deepEqual(summary, {addCount:0, removeCount:1, activeAfterSave:2}, 'the save review can present a deterministic staged-remove summary');
});

test('group module handles 1:N, N:1, cycles, and staged remove without calculation side effects', () => {
  let state = groupsApi.createState({
    folders:[{id:'folder-collection', name:'모음전'}],
    groups:[
      {id:'collection-a', folderId:'folder-collection', name:'모음전 A', type:'collection'},
      {id:'collection-b', folderId:'folder-collection', name:'모음전 B', type:'collection'},
    ],
    skus:[
      {id:'sku-a', sku:'1000-1'}, {id:'sku-b', sku:'1000-2'},
      {id:'sku-c', sku:'1000-3'}, {id:'sku-d', sku:'2000-1'},
    ],
    memberships:[
      {groupId:'collection-a', skuId:'sku-a'},
      {groupId:'collection-a', skuId:'sku-c'},
    ],
    edges:[
      {id:'edge-a-c', groupId:'collection-a', parentSkuId:'sku-a', childSkuId:'sku-c', edgeType:'collection_member'},
    ],
  });
  state = groupsApi.stageAddEdge(state, {id:'edge-a-b', groupId:'collection-a', parentSkuId:'sku-a', childSkuId:'sku-b'});
  state = groupsApi.stageAddEdge(state, {id:'edge-a-c', groupId:'collection-a', parentSkuId:'sku-a', childSkuId:'sku-c'});
  state = groupsApi.stageAddEdge(state, {id:'edge-d-a', groupId:'collection-b', parentSkuId:'sku-d', childSkuId:'sku-a'});
  assert.equal(groupsApi.getActiveEdges(state, 'collection-a').length, 2, 'one parent may stage multiple children in a collection');
  assert.deepEqual(
    state.memberships.filter(item => item.skuId === 'sku-a').map(item => item.groupId).sort(),
    ['collection-a', 'collection-b'],
    'one SKU may belong to multiple relation groups',
  );
  assert.throws(
    () => groupsApi.stageAddEdge(state, {id:'edge-self', groupId:'collection-a', parentSkuId:'sku-a', childSkuId:'sku-a'}),
    /같은 SKU|자기 자신/i,
    'the module must reject self edges before persistence',
  );
  assert.throws(
    () => groupsApi.stageAddEdge(state, {id:'edge-cycle', groupId:'collection-a', parentSkuId:'sku-b', childSkuId:'sku-a'}),
    /순환/i,
    'the module must reject a staged graph cycle before persistence',
  );
  state = groupsApi.stageRemoveEdge(state, 'edge-a-c');
  const summary = groupsApi.getChangeSummary(state);
  assert.equal(summary.additionCount, 2, 'the review summary must retain only staged additions that are still pending');
  assert.equal(summary.removalCount, 1, 'the review summary must expose staged removals');
  assert.equal(summary.affectsPrice, false, 'relation groups must not imply price calculations');
  assert.equal(summary.affectsInventory, false, 'relation groups must not imply inventory calculations');
  const graph = groupsApi.getGroupGraph(state, 'collection-a');
  assert.equal(graph.edges.length, 1, 'staged removal must be excluded from the rendered group graph');
  assert.match(groupsApi.renderFixture(state, 'collection-a'), /모음전 A|collection-a/, 'the fixture renderer must be usable for isolated UI QA');
});

console.log('operations hub relation groups V1 contract tests passed');
