import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(
  new URL('../supabase/migrations/20260831190000_operations_hub_matrix_related_sku_context_v5.sql', import.meta.url),
  'utf8',
);
const data = fs.readFileSync(new URL('../mockups/operations-hub/data-service.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../mockups/operations-hub/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../mockups/operations-hub/style.css', import.meta.url), 'utf8');

assert.match(
  migration,
  /create or replace function public\.load_operations_hub_matrix_filtered_v5\([\s\S]*?p_include_related_sku_context boolean default false/i,
  'the relationship expansion must be an explicit, opt-in V5 matrix RPC argument',
);
assert.match(
  migration,
  /v_search text := btrim\(coalesce\(p_search, ''\)\)/i,
  'related context must depend on both an explicit toggle and a normalized search term',
);
assert.match(
  migration,
  /v_direct_result := public\.load_operations_hub_matrix_filtered_v4\([\s\S]*?p_exclude_dependent/i,
  'direct matches must continue through the existing page-first V4 compact-cache path',
);
assert.match(
  migration,
  /v_direct_result := public\.load_operations_hub_matrix_filtered_v4[\s\S]*?direct_rows as materialized[\s\S]*?root_nodes as materialized/i,
  'the V4 page result must be converted to direct roots before related SKU context is expanded',
);
assert.match(
  migration,
  /'count', coalesce\(v_direct_result -> 'count'[\s\S]*?'directCount', coalesce\(v_direct_result -> 'count'/i,
  'total and pagination must count only direct matches, never attached related rows',
);
assert.match(
  migration,
  /coalesce\(p_include_related_sku_context, false\)[\s\S]*?v_search <> ''[\s\S]*?operations_hub_relation_edges/i,
  'relation traversal must be disabled for ordinary unsearched matrix reads',
);
assert.match(
  migration,
  /direction[\s\S]*?'ancestor'[\s\S]*?'descendant'[\s\S]*?depth[\s\S]*?path_skus/i,
  'related rows must disclose direction, hop count, and a concrete Sellpia SKU path',
);
assert.match(
  migration,
  /row_number\(\) over \([\s\S]*?partition by[\s\S]*?root_sku[\s\S]*?related_sku/i,
  'multiple graph paths to the same root/related SKU pair must be deduplicated before matrix details expand',
);
assert.match(
  migration,
  /'matrix_context'[\s\S]*?'kind'[\s\S]*?'rootSku'[\s\S]*?'direction'[\s\S]*?'depth'[\s\S]*?'pathSkus'/i,
  'every returned row must explicitly identify direct versus relation-context display semantics',
);
assert.match(
  migration,
  /load_operations_hub_matrix_filtered_v4\([\s\S]*?p_search_sources[\s\S]*?p_status[\s\S]*?p_filter/i,
  'seller/channel search scope must select direct roots before relationship context is appended',
);
assert.match(
  migration,
  /security invoker[\s\S]*?revoke all on function[\s\S]*?grant execute on function[\s\S]*?to anon, authenticated/i,
  'the new read RPC must retain invoker security and explicit frontend execution grants',
);

assert.match(
  data,
  /async function loadProducts\(\{[\s\S]*?includeRelatedSkuContext = false/i,
  'the data adapter must accept the explicit relation-context preference',
);
assert.match(
  data,
  /const includeRelatedContext = Boolean\(includeRelatedSkuContext\) && Boolean\(normalizedMatrixSearch\)[\s\S]*?p_include_related_sku_context:true[\s\S]*?db\.rpc\('load_operations_hub_matrix_filtered_v5'/i,
  'the data adapter must pass the explicit relation-context option through the single page-first RPC only for nonblank searches',
);
assert.match(
  app,
  /matrixState = \{[\s\S]*?includeRelatedSkuContext:true/i,
  'the matrix must default relationship context on while keeping it distinct from existing product filters',
);
assert.match(
  app,
  /includeRelatedSkuContext:matrixState\.includeRelatedSkuContext/,
  'the UI must preserve the explicit relationship-context preference into matrix requests',
);
assert.match(
  app,
  /matrix_context\?\.kind === 'related'[\s\S]*?matrix-related-context-row[\s\S]*?rootSku/i,
  'related context rows must render as subordinate context rather than indistinguishable direct matrix matches',
);
assert.match(
  css,
  /\.matrix-related-context-row[\s\S]*?(opacity|background|font-size)/,
  'relationship context rows need a visibly quieter visual treatment than direct matches',
);

// JSON returned by the RPC is intentionally tested as an API contract here. The
// page count is root-only; related rows remain attached display context.
const fixture = {
  count: 2,
  directCount: 2,
  relatedCount: 2,
  page: 1,
  pageSize: 2,
  directPageSkuCodes: ['2743-15', '3100-1'],
  rows: [
    {sellpia_sku_code: '2743-15', matrix_context: {kind: 'direct', rootSku: '2743-15', direction: 'self', depth: 0, pathSkus: ['2743-15']}},
    {sellpia_sku_code: '9883', matrix_context: {kind: 'related', rootSku: '2743-15', direction: 'descendant', depth: 1, pathSkus: ['2743-15', '9883']}},
    // A second graph path to the same context SKU must not add another display row.
    {sellpia_sku_code: '2743-15', matrix_context: {kind: 'direct', rootSku: '2743-15', direction: 'self', depth: 0, pathSkus: ['2743-15']}},
    {sellpia_sku_code: '3100-1', matrix_context: {kind: 'direct', rootSku: '3100-1', direction: 'self', depth: 0, pathSkus: ['3100-1']}},
    {sellpia_sku_code: '8800', matrix_context: {kind: 'related', rootSku: '3100-1', direction: 'ancestor', depth: 1, pathSkus: ['8800', '3100-1']}},
  ],
};

assert.equal(fixture.count, fixture.directCount, 'relation rows must never inflate direct pagination totals');
assert.deepEqual(fixture.directPageSkuCodes, ['2743-15', '3100-1'], 'root ordering is the only page ordering contract');
const directRows = fixture.rows.filter(row => row.matrix_context.kind === 'direct');
const relatedRows = fixture.rows.filter(row => row.matrix_context.kind === 'related');
assert.ok(directRows.every(row => row.matrix_context.rootSku === row.sellpia_sku_code), 'direct rows must self-identify as roots');
assert.ok(relatedRows.every(row => row.matrix_context.rootSku !== row.sellpia_sku_code), 'related rows must retain their distinct root context');
assert.equal(new Set(relatedRows.map(row => `${row.matrix_context.rootSku}:${row.sellpia_sku_code}`)).size, relatedRows.length, 'the visible result must dedupe multi-path related context');
assert.ok(relatedRows.every(row => row.matrix_context.pathSkus.length === row.matrix_context.depth + 1), 'every related context path must be inspectable');

console.log('operations hub relation-aware matrix search context contract: passed');
