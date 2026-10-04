import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../mockups/operations-hub/app.js', import.meta.url), 'utf8');
const dataService = readFileSync(new URL('../mockups/operations-hub/data-service.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../mockups/operations-hub/index.html', import.meta.url), 'utf8');

test('listing graph and seller write RPCs use the new safe contracts', () => {
  assert.match(dataService, /db\.rpc\('list_operations_hub_listing_graph_v3'/);
  assert.doesNotMatch(dataService, /db\.rpc\('list_operations_hub_listing_graph_v2'/);
  assert.match(dataService, /db\.rpc\('stage_operations_hub_seller_inventory_match_batch_v2',[\s\S]*?p_session_token:requireOperationsHubSessionToken\(\)/);
  assert.match(dataService, /db\.rpc\('prepare_operations_hub_change_export',[\s\S]*?p_session_token:requireOperationsHubSessionToken\(\)/);
});

test('jobs page is batch centered while retaining row audit history', () => {
  assert.match(html, /id="queue-batch-list"/);
  assert.match(html, /value="operational">스마트스토어·에이블리/);
  assert.match(html, /메이크샵은 수동 작업 예정이며 데이터는 유지됩니다/);
  assert.match(html, /id="queue-body"/);
  assert.match(html, /id="queue-event-panel"/);
  assert.match(dataService, /list_operations_hub_change_batch_summaries_v1/);
  assert.match(dataService, /preview_operations_hub_change_target_safety_v1/);
  assert.match(dataService, /source === 'operational'\) query = query\.overlaps\('target_channels', \['smartstore','ably'\]\)/);
  assert.match(app, /function renderQueueBatches\(/);
  assert.match(app, /function renderQueueTargetSafety\(/);
  assert.match(app, /queueState\.selectedBatchId = button\.dataset\.queueBatch;\s*document\.getElementById\('queue-status-filter'\)\.value = 'all';\s*loadChangeQueue\(\)/);
});

test('relation drawer exposes authenticated history and only renders allowed undo actions', () => {
  assert.match(html, /id="relation-edge-history-list"/);
  assert.match(dataService, /list_operations_hub_relation_edge_history_v1[\s\S]*?p_session_token:requireOperationsHubSessionToken\(\)/);
  assert.match(dataService, /undo_operations_hub_relation_edge_event_v1[\s\S]*?p_session_token:requireOperationsHubSessionToken\(\)/);
  assert.match(app, /event\.canUndo \? `<button type="button" data-undo-relation-event=/);
  assert.match(app, /await liveData\.undoRelationEdgeEvent\(eventId\)/);
  assert.match(app, /if \(multiLinkWorkspaceState\.allLoaded\) await loadMultiLinks\(\);\s*else await loadRelationGraph\(\)/);
  assert.match(app, /await loadRelationEdgeHistory\(edgeId\)/);
});

test('relation meanings, searchable filter fields, and Makeshop manual defaults are explicit', () => {
  assert.match(html, /상품 관계<\/b>분류·화면 표시만/);
  assert.match(html, /세트·번들<\/b>구성수량으로 재고 계산/);
  assert.match(html, /판매처 구성<\/b>판매처 옵션의 구성 SKU/);
  assert.match(html, /id="advanced-filter-field-search"/);
  assert.match(app, /item\.field !== selectedField && searchTerms\.some/);
  assert.match(app, /item\.field !== selectedField && searchTerms\.some\(term => !haystack\.includes\(term\)\)\) return/);
  assert.match(app, /advancedFilterFieldOptions\(condition\.field, advancedFilterFieldSearch\?\.value\)/);
  assert.match(html, /value="makeshop"><i class="dot make"/);
  assert.doesNotMatch(html, /value="makeshop" checked><i class="dot make"><\/i><span><b>메이크샵<\/b><em>수동 작업 예정/);
  assert.match(app, /input\.checked = input\.value !== 'makeshop'/);
});
