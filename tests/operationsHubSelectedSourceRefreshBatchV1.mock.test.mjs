import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(new URL('../supabase/migrations/20260903055355_operations_hub_selected_source_refresh_batch_v1.sql', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../mockups/operations-hub/app.js', import.meta.url), 'utf8');
const data = fs.readFileSync(new URL('../mockups/operations-hub/data-service.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../mockups/operations-hub/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../mockups/operations-hub/ui-scale-matrix.css', import.meta.url), 'utf8');

assert.match(migration, /operations_hub_selected_source_refresh_batches[\s\S]*?preview_request_id uuid not null unique[\s\S]*?apply_request_id uuid unique/);
assert.match(migration, /operations_hub_selected_source_refresh_items[\s\S]*?preview_status[\s\S]*?apply_status[\s\S]*?result_status[\s\S]*?verified boolean/);
assert.match(migration, /require_operations_hub_operator_session\(p_session_token\)/);
assert.match(migration, /payload_hash <> v_payload_hash[\s\S]*?같은 요청 ID를 다른 선택 범위에 다시 사용할 수 없습니다/);
assert.match(migration, /p_retry_failed_only_from[\s\S]*?result_status = 'failed'[\s\S]*?retryFailedOnly/);
assert.match(migration, /from public\.operations_hub_active_seller_drafts draft[\s\S]*?draft\.sellpia_sku_code = v_sku/, 'active seller drafts must use exact-target projection from the target-safety migration');
assert.match(migration, /queue\.source_channel=v_item\.source_channel[\s\S]*?seller_product_code[\s\S]*?seller_option_code[\s\S]*?queue\.field_key=case/, 'source restore must replace only the exact marketplace target');
assert.match(migration, /v_fresh -> 'sourceValue' is distinct from v_item\.source_value[\s\S]*?미리보기 후 원본값이 변경/);
assert.match(migration, /v_lock_key := case[\s\S]*?seller_stock[\s\S]*?'sellpia_current_stock'[\s\S]*?'sellpia_sale_price'[\s\S]*?pg_advisory_xact_lock\(hashtextextended\('operations_hub_selected_source_refresh_target:' \|\| v_lock_key/, 'all price components for one exact seller target must share one concurrency lock');
assert.match(migration, /stateFingerprint[\s\S]*?activeChangeId[\s\S]*?v_fresh -> 'beforeValue' is distinct from v_item\.before_value[\s\S]*?stale_preview/);
assert.match(migration, /v_resolution := v_fresh[\s\S]*?\{applyContext,targetBasePrice\}/, 'writes must use the apply-time price context after stale-preview checks');
assert.match(migration, /resolve_operations_hub_selected_source_refresh_target_v1\(v_item\.target_payload\)[\s\S]*?DB 재조회 값이 원본과 일치하지 않습니다/);
assert.match(migration, /exception when others[\s\S]*?apply_status='failed'[\s\S]*?result_status='failed'/);
assert.match(migration, /security definer[\s\S]*?set search_path = pg_catalog[\s\S]*?revoke all on function public\.run_operations_hub_selected_source_refresh_batch_v1/);
assert.match(migration, /prune_operations_hub_selected_source_refresh_details_v1[\s\S]*?interval '90 days'[\s\S]*?operations-hub-selected-source-refresh-retention/);

assert.match(data, /async function runSelectedSourceRefreshBatch[\s\S]*?db\.rpc\('run_operations_hub_selected_source_refresh_batch_v1'[\s\S]*?p_session_token:requireOperationsHubSessionToken\(\)/);
assert.match(data, /targets\.length > 50[\s\S]*?databaseTargetCount:safeTargets\.length/);
assert.match(app, /function selectedSourceRefreshBatchTargets[\s\S]*?groupSize > 1[\s\S]*?matrixState\.rows\.filter/);
assert.match(app, /function selectedSourceRefreshScopeFor[\s\S]*?current_page_columns[\s\S]*?selectedCellCount[\s\S]*?databaseTargetCount/);
assert.match(app, /SELECTED_SOURCE_REFRESH_CHUNK_SIZE = 40[\s\S]*?previewSelectedSourceRefreshBatch[\s\S]*?targets\.slice\(offset, offset \+ SELECTED_SOURCE_REFRESH_CHUNK_SIZE\)[\s\S]*?dryRun:true/);
assert.match(app, /applySelectedSourceRefreshBatch[\s\S]*?applyRequestIds\[index\] \|\| createRequestId\(\)[\s\S]*?dryRun:false/);
assert.match(app, /retryFailedSelectedSourceRefreshChunks[\s\S]*?retryFailedOnlyFrom:result\.batchId/);
assert.match(app, /reloadSelectedSourceRefreshRows[\s\S]*?loadProductsBySkus[\s\S]*?verifySourceRefreshTargets/);
const selectedFlow = app.slice(app.indexOf('async function refreshSelectedSystemValuesFromSource'), app.indexOf('function matrixCellClipboardValue'));
assert.doesNotMatch(selectedFlow, /saveSellerValueDraft|saveSellerPriceDraft|saveSellerDiscountDraft|saveSellerProductBaseDrafts/, 'the selected flow must not perform browser-side seller writes');

assert.match(html, /id="selected-source-refresh-modal"[\s\S]*?id="selected-source-refresh-scope"[\s\S]*?id="selected-source-refresh-results"[\s\S]*?실패 항목만 다시 미리보기/);
assert.match(css, /selected-source-refresh-modal[\s\S]*?selected-source-refresh-counts[\s\S]*?selected-source-refresh-result\[data-status="failed"\]/);

console.log('Operations hub selected source-refresh batch V1 contract: passed');
