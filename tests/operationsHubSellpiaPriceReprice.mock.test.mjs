import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(
  new URL('../supabase/migrations/20260825060000_system_owned_price_stock_and_pricing_reset.sql', import.meta.url),
  'utf8'
);
const data = fs.readFileSync(new URL('../mockups/operations-hub/data-service.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../mockups/operations-hub/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../mockups/operations-hub/index.html', import.meta.url), 'utf8');
const csv = fs.readFileSync(new URL('../mockups/operations-hub/matrix-csv-export.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../mockups/operations-hub/style.css', import.meta.url), 'utf8');

assert.match(migration, /create table if not exists public\.operations_hub_sku_operational_master[\s\S]*?base_price numeric[\s\S]*?stock_quantity integer/, 'system base price and stock must live in a dedicated canonical table');
assert.match(migration, /operations_hub_sku_operational_events[\s\S]*?system_base_price[\s\S]*?system_stock/, 'canonical master changes must retain an audit event stream');
assert.match(migration, /operations_hub_matrix_system_live[\s\S]*?sellpia_source_sale_price[\s\S]*?sellpia_source_stock[\s\S]*?system_base_price[\s\S]*?system_stock/, 'the matrix overlay must expose immutable source comparisons beside system values');
assert.match(migration, /save_operations_hub_sku_operational_value[\s\S]*?on conflict \(sellpia_sku_code\) do update[\s\S]*?operations_hub_sku_operational_events/, 'system edits must save immediately and atomically append audit history');
assert.match(migration, /Source uploads[\s\S]*?never write this table[\s\S]*?operations_hub_sellpia_overrides/, 'only explicit system saves may update the compatibility mirror used by existing seller exporters');
assert.match(migration, /operations_hub_pricing_reset_archives[\s\S]*?price_rule_assignment[\s\S]*?update public\.operations_hub_price_rule_assignments[\s\S]*?is_active = false/, 'the inferred pricing catalog must be archived before being retired');
assert.match(migration, /enforce_operations_hub_price_assignment_system_base[\s\S]*?base_price is not null[\s\S]*?시스템 기준가격을 먼저 저장/, 'a price combination cannot be assigned before its system base exists');

assert.match(data, /MATRIX_VIEW = 'operations_hub_matrix_managed_live'/, 'interactive reads must use the managed wrapper over the canonical system overlay');
assert.match(data, /saveSellpiaChanges[\s\S]*?system_base_price[\s\S]*?system_stock[\s\S]*?sellpia_purchase_price[\s\S]*?sellpia_order_unit[\s\S]*?sellpia_minimum_order_unit[\s\S]*?save_operations_hub_sku_operational_value/, 'system stock, price, and procurement edits must route to the immediate canonical-save RPC');
assert.match(data, /systemChangeSource[\s\S]*?p_change_source:systemChangeSource[\s\S]*?p_metadata:systemMetadata/, 'explicit source acceptance must be preserved in the canonical audit event');
assert.match(data, /previewPriceRuleSet[\s\S]*?시스템 기준가격을 먼저 저장해주세요/, 'price calculations must reject missing canonical base prices instead of treating them as zero');

assert.match(app, /systemOperationalCell\(product, 'system_stock'[\s\S]*?systemOperationalCell\(product, 'system_base_price'/, 'the matrix must show editable system stock and price cells');
assert.match(app, /원본 미반영[\s\S]*?원본 갱신 있음[\s\S]*?원본과 다름[\s\S]*?원본과 일치/, 'canonical cells must expose source state without rendering the source number as the system value');
assert.doesNotMatch(app, /<em>원본 \$\{hasSource \? formatNullableNumber\(sourceValue\)/, 'the matrix must not print raw source numbers inside canonical cells');
assert.match(app, /원본 숫자는 자동 반영되지 않으며[\s\S]*?선택 셀 원본값 갱신/, 'canonical cell help must state that copying a source value is explicit only');
assert.match(app, /async function refreshSelectedSystemValuesFromSource[\s\S]*?await previewSelectedSourceRefreshBatch\(\)/, 'selected source values must start with a write-free server preview');
assert.match(app, /async function applySelectedSourceRefreshBatch[\s\S]*?dryRun:false[\s\S]*?reloadSelectedSourceRefreshRows/, 'the previewed batch must be applied separately');
assert.match(app, /reloadSelectedSourceRefreshRows[\s\S]*?loadProductsBySkus[\s\S]*?verifySourceRefreshTargets/, 'completed source refreshes must repaint from a targeted database reread');
assert.doesNotMatch(app.slice(app.indexOf('async function refreshSelectedSystemValuesFromSource'), app.indexOf('function matrixCellClipboardValue')), /if \(!product\) continue/, 'a missing selected SKU must fail visibly instead of being silently skipped');
assert.doesNotMatch(app.slice(app.indexOf('async function refreshSelectedSystemValuesFromSource'), app.indexOf('function matrixCellClipboardValue')), /원본값 \$\{changes\.length\}개를 저장/, 'the success message must not reuse the requested-cell count as the persisted count');
assert.match(data, /loadProductsBySkus[\s\S]*?\.from\(MATRIX_VIEW\)[\s\S]*?attachProductMetadata/, 'source refresh verification must reread the saved SKUs with active draft and price metadata attached');
assert.match(app, /selectedSourceRefreshTargets[\s\S]*?seller-edit\[data-source\]\[data-field-key\][\s\S]*?seller_price[\s\S]*?seller_discount/, 'selected source refresh must recognize seller stock, price component, and discount cells in addition to system cells');
assert.match(app, /sellerEditor\.dataset\.baseline[\s\S]*?selectedSourceRefreshBatchTargets[\s\S]*?runSelectedSourceRefreshBatch/, 'seller source refresh must be expanded to exact server-batch targets rather than saved one by one in the browser');
assert.match(app, /selectedSourceRefreshBatchTargets[\s\S]*?groupSize > 1[\s\S]*?priceComponent === 'base'[\s\S]*?matrixState\.rows\.filter/, 'a merged seller base-price cell must expand to its visible exact SKU targets before preview');
assert.match(data, /saveSellerProductBaseDrafts\(\{source, productCode, targetBasePrice, basePriceSource = 'manual'\}\)[\s\S]*?basePriceSource:cleanText\(basePriceSource\)/, 'group base-price saves must accept an explicit source ownership marker while preserving manual edits by default');
assert.match(app, /basePrice:product\.system_base_price/, 'price combinations must calculate from the canonical system base price');
assert.doesNotMatch(app, /basePrice:product\??\.sellpia_sale_price/, 'price combinations must never calculate from the uploaded Sellpia price snapshot');
assert.match(app, /계산 태그[\s\S]*?가격 조합/, 'user-facing pricing terminology must separate atomic calculation tags from ordered combinations');

assert.match(html, /시스템 기준 · 셀피아 원본 비교[\s\S]*?>SKU<[\s\S]*?>상품명<[\s\S]*?>옵션명<[\s\S]*?>자사코드<[\s\S]*?기준재고[\s\S]*?기준가격/, 'the matrix header must expose separate Sellpia identities and canonical values');
assert.doesNotMatch(html, /id="matrix-source-refresh-btn"/, 'selected-cell source refresh must not remain in the permanent work tools');
assert.match(html, /id="matrix-context-source-refresh"[\s\S]*?원본값으로 갱신[\s\S]*?id="matrix-context-source-refresh-count"/, 'the right-click work menu must expose selected-cell source refresh');
assert.match(app, /matrixContextSourceRefresh\.title = targets\.length === 0[\s\S]*?원본값을 가진 기준값 또는 판매처 셀을 선택해주세요\./, 'the source-refresh action must explain that seller cells are supported');
assert.match(csv, /시스템 기준재고[\s\S]*?셀피아 원본재고[\s\S]*?시스템 기준가격[\s\S]*?셀피아 원본 판매가/, 'CSV output must preserve both canonical and source comparison columns');
assert.match(css, /sellpia-sku-col[\s\S]*?sellpia-name-col[\s\S]*?sellpia-option-name-col[\s\S]*?own-code-col[\s\S]*?system-master-cell/, 'separate Sellpia identities and canonical values must have dedicated frozen-cell styling');

console.log('Operations hub system-owned price and stock contract: passed');
