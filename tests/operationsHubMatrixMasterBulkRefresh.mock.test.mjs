import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const html = read('mockups/operations-hub/index.html');
const app = read('mockups/operations-hub/app.js');
const dataService = read('mockups/operations-hub/data-service.js');
const css = read('mockups/operations-hub/ui-scale-matrix.css');

const allowedFields = [
  'system_stock',
  'system_base_price',
  'sellpia_purchase_price',
  'sellpia_order_unit',
  'sellpia_minimum_order_unit'
];

assert.match(html, /id="matrix-bulk-source-refresh-btn"[^>]*>컬럼 원본 갱신/);
assert.match(html, /id="view-settings-bulk-source-refresh"/);
assert.match(html, /id="bulk-source-refresh-modal"[\s\S]*현재 화면이 아니라 전체 DB가 대상입니다/);
assert.match(html, /id="bulk-source-refresh-preview-run"[\s\S]*영향 미리보기/);
assert.match(html, /id="bulk-source-refresh-confirm"[\s\S]*id="bulk-source-refresh-apply"/);
for (const fieldKey of allowedFields) {
  assert.match(html, new RegExp(`value="${fieldKey}"`), `${fieldKey} must be an explicit bulk-refresh choice`);
  assert.match(app, new RegExp(`${fieldKey}:\\{label:`), `${fieldKey} must be client-whitelisted`);
}
assert.doesNotMatch(html.slice(html.indexOf('id="bulk-source-refresh-columns"'), html.indexOf('id="bulk-source-refresh-preview"')), /actual_inbound_cost/);

assert.match(app, /previewBulkSourceRefresh[\s\S]*refreshMasterColumnFromSource\(\{fieldKey, actor:'operations-hub', requestId, dryRun:true\}\)/);
assert.match(app, /applyBulkSourceRefresh[\s\S]*refreshMasterColumnFromSource\(\{[\s\S]*fieldKey:preview\.fieldKey[\s\S]*requestId:preview\.requestId[\s\S]*dryRun:false/);
assert.match(app, /bulkSourceRefreshConfirmationPhrase[\s\S]*전체 원본값 갱신:/);
assert.match(html, /id="bulk-source-refresh-progress"[\s\S]*id="bulk-source-refresh-progress-summary"[\s\S]*id="bulk-source-refresh-progress-phases"/, 'bulk refresh modal must provide the phase progress surface');
assert.match(app, /const bulkSourceRefreshState = \{[\s\S]*startedAt:null[\s\S]*phase:'idle'[\s\S]*fieldStatuses:\{\}[\s\S]*priceProgress:[\s\S]*matrixStatus:'pending'[\s\S]*finalStatus:'idle'/, 'bulk refresh state must retain execution progress');
assert.match(app, /function renderBulkSourceRefreshProgress\(\)[\s\S]*bulk-source-refresh-progress-summary[\s\S]*bulk-source-refresh-progress-phases/, 'bulk refresh progress must be rendered into the modal');
assert.doesNotMatch(app, /applyBulkSourceRefresh[\s\S]*loadAllFilteredSkus\(\{status:'all'\}\)/, 'bulk refresh must not recalculate the full Matrix catalog');
assert.match(app, /const priceSkus = \[\.\.\.new Set\(priceRefreshes\.flatMap\(row=>row\.affectedSkus\)\)\][\s\S]*materializeHubPrices\(priceSkus,\{[\s\S]*reason:'bulk-source-price-refresh'[\s\S]*onProgress:progress=>[\s\S]*completedSkus[\s\S]*totalSkus/, 'bulk refresh must materialize only exact source-changed SKUs and retain progress');
assert.match(app, /markMatrixAffected\(refreshSkus\)[\s\S]*refreshHubPriceProjection\(\)/, 'bulk refresh must patch affected Matrix rows instead of rebuilding the full dataset');
assert.match(app, /bulkSourceRefreshState\.finalStatus = warnings\.length \? 'completed_with_warning' : 'completed'/);
assert.match(app, /bulkSourceRefreshState\.finalStatus = completed\.length \? 'completed_with_warning' : 'failed'/);
const applyBody = app.slice(app.indexOf('async function applyBulkSourceRefresh()'), app.indexOf("document.getElementById('matrix-bulk-source-refresh-btn')"));
assert.doesNotMatch(applyBody, /closeBulkSourceRefresh\(\)/, 'successful refresh must leave the completion summary open');
assert.match(dataService, /async function refreshMasterColumnFromSource\(/, 'data service must expose the DB-owned bulk refresh RPC adapter');
assert.match(dataService, /refresh_operations_hub_master_column_from_source_v1/);
assert.match(dataService, /read_operations_hub_bulk_source_refresh_affected_skus_v1[\s\S]*affected_skus/);

assert.match(app, /systemOperationalCell\(product, 'sellpia_purchase_price', '매입가', product\.sellpia_source_purchase_price\)/);
assert.match(app, /systemOperationalCell\(product, 'sellpia_order_unit', '발주단위', product\.sellpia_source_order_unit\)/);
assert.match(app, /systemOperationalCell\(product, 'sellpia_minimum_order_unit', '최소발주단위', product\.sellpia_source_minimum_order_unit\)/);
assert.match(app, /sellpia_purchase_price:product\?\.sellpia_purchase_price_updated_at[\s\S]*sellpia_order_unit:product\?\.sellpia_order_unit_updated_at[\s\S]*sellpia_minimum_order_unit:product\?\.sellpia_minimum_order_unit_updated_at/, 'each procurement field must compare source freshness against its own saved timestamp');
assert.match(app, /클릭하여 실입고가 직접 입력 또는 수식태그 설정[\s\S]*data-inbound-cost-edit/);

assert.equal((html.match(/data-drawer-disconnect-source=/g) || []).length, 3);
assert.match(html, /data-drawer-disconnect-source="smartstore"[^>]*>연결만 해제/);
assert.match(app, /data-drawer-disconnect-source[\s\S]*removeListingComponent\(\{source, productCode, optionCode, sku\}\)/);
assert.match(app, /data-drawer-component-remove>연결만 해제/);

assert.doesNotMatch(app, /그룹 대표 표시행/);
assert.doesNotMatch(app, /실제 가격 출처 SKU를 의미하지 않습니다/);
assert.match(app, /price-basis-row/);
assert.match(css, /\.price-basis-cell/);
assert.match(css, /\.bulk-source-refresh-modal/);
assert.match(css, /\.inbound-cost-cell:focus-visible/);

console.log('Operations hub matrix master-column refresh and drawer disconnect contract: passed');
