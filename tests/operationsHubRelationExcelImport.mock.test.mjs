import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../mockups/operations-hub/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../mockups/operations-hub/app.js', import.meta.url), 'utf8');
const data = fs.readFileSync(new URL('../mockups/operations-hub/data-service.js', import.meta.url), 'utf8');
const sql = fs.readFileSync(new URL('../supabase/migrations/20260831093000_resolve_relation_import_codes.sql', import.meta.url), 'utf8');

assert.match(html, /id="relation-import-panel"[\s\S]*상품코드-옵션코드[\s\S]*헤더 A, B, C[\s\S]*id="relation-import-save"/);
assert.match(html, /relation-import-parser\.js\?v=[^"\s]+/);
assert.match(app, /parseRelationHierarchyRows[\s\S]*resolveRelationImportCodes[\s\S]*buildRelationImportPlan/);
assert.match(app, /applyRelationBoard\(\{nodes:plan\.nodes, edges:plan\.edges, removeEdgeIds:\[\]\}\)/, 'Excel import must add reviewed edges atomically without deleting existing edges');
assert.match(app, /relationReady[\s\S]*먼저 SKU 매칭 필요/, 'unlinked seller identities must be blocked before save');
assert.match(data, /resolve_operations_hub_relation_import_codes[\s\S]*p_codes:normalized/);
assert.match(sql, /security invoker/);
assert.match(sql, /candidate_count > 1 then 'ambiguous'/);
assert.match(sql, /listing\.listing_id is not null/);
assert.match(sql, /revoke all on function public\.resolve_operations_hub_relation_import_codes/);

console.log('operations hub relation Excel import contract tests passed');
