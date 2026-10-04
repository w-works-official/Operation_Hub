import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../mockups/operations-hub/index.html", import.meta.url), "utf8");
const source = fs.readFileSync(new URL("../mockups/operations-hub/app.js", import.meta.url), "utf8");
const dataSource = fs.readFileSync(new URL("../mockups/operations-hub/data-service.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../mockups/operations-hub/style.css", import.meta.url), "utf8");
const migration = fs.readFileSync(
  new URL("../supabase/migrations/20260812070000_operations_hub_sellpia_inventory.sql", import.meta.url),
  "utf8",
);
const presetMigration = fs.readFileSync(
  new URL("../supabase/migrations/20260812080000_operations_hub_matrix_presets.sql", import.meta.url),
  "utf8",
);
const editMigration = fs.readFileSync(
  new URL("../supabase/migrations/20260812170000_operations_hub_sellpia_edits.sql", import.meta.url),
  "utf8",
);
const sellerDetailMigration = fs.readFileSync(
  new URL("../supabase/migrations/20260814020007_operations_hub_manual_links_and_seller_details.sql", import.meta.url),
  "utf8",
);
const searchDraftMigration = fs.readFileSync(
  new URL("../supabase/migrations/20260814063641_operations_hub_search_drafts_projection.sql", import.meta.url),
  "utf8",
);
const mappingSyncMigration = fs.readFileSync(
  new URL("../supabase/migrations/20260818013437_operations_hub_mapping_sync.sql", import.meta.url),
  "utf8",
);
const binaryConnectionMigration = fs.readFileSync(
  new URL("../supabase/migrations/20260825070000_binary_connection_status_filters.sql", import.meta.url),
  "utf8",
);
const sellerUnmatchedCacheMigration = fs.readFileSync(
  new URL("../supabase/migrations/20260910095000_hub_seller_unmatched_template_cache.sql", import.meta.url),
  "utf8",
);
const mappingSyncIndexMigration = fs.readFileSync(
  new URL("../supabase/migrations/20260915134000_optimize_mapping_sync_status.sql", import.meta.url),
  "utf8",
);

assert.match(html, /id="matrix-zoom-out"[\s\S]*?id="matrix-zoom-value"[\s\S]*?id="matrix-zoom-in"/, "matrix zoom controls must be visible together");
assert.match(source, /MATRIX_ZOOM_MIN = 80;[\s\S]*?MATRIX_ZOOM_MAX = 140;[\s\S]*?localStorage\.setItem\(MATRIX_ZOOM_KEY/, "matrix-only zoom must be bounded and persisted");
assert.match(source, /MATRIX_ZOOM_STEP = 5;/, "matrix zoom must move in five-percent steps");
assert.match(html, /value="80">80%[\s\S]*?value="85">85%[\s\S]*?value="140">140%/, "preset zoom options must include five-percent increments");
assert.match(css, /\.matrix-table\{zoom:var\(--matrix-zoom,1\)\}/, "zoom must apply to the matrix table only");
assert.match(css, /\.matrix-table \.sellpia-sku-col\{left:var\(--image-col-width\)[\s\S]*?\.matrix-table \.sellpia-name-col\{left:calc\(var\(--image-col-width\) \+ 110px\)[\s\S]*?\.matrix-table \.sellpia-option-name-col\{left:calc\(var\(--image-col-width\) \+ 370px\)[\s\S]*?\.matrix-table \.own-code-col\{left:calc\(var\(--image-col-width\) \+ 590px\)[\s\S]*?\.matrix-table \.sellpia-price-col\{left:calc\(var\(--image-col-width\) \+ 844px\)/, "the four Sellpia identity cells must anchor the frozen system pane to the image boundary");
assert.doesNotMatch(html, /legend-edit/, "editable cells must not be singled out in the matrix legend");
assert.match(css, /\.matrix-table \.editable-cell\{border-color:transparent;border-radius:0;background:transparent\}[\s\S]*?mapping-code-button\.unmatched[\s\S]*?border-color:transparent[\s\S]*?inbound-cost-cell[\s\S]*?border-color:transparent/, "editable, unmatched-code, and inbound-cost cells must not use decorative edit borders");
assert.match(css, /\.matrix-table \.select-col\{display:none\}/, "row-selection checkboxes must be removed from the visible matrix");
assert.match(html, /id="matrix-freeze-toggle"[^>]*aria-pressed="true"[^>]*>셀피아 고정 ON/, "the toolbar must expose an accessible Sellpia freeze toggle");
assert.match(source, /MATRIX_FREEZE_KEY = 'system-v3-matrix-sellpia-freeze'[\s\S]*?applyMatrixSellpiaFreeze[\s\S]*?localStorage\.setItem\(MATRIX_FREEZE_KEY/, "the Sellpia freeze preference must be applied and persisted");
assert.match(css, /\.matrix-table\.sellpia-unfrozen \.sticky-col\{left:auto\}[\s\S]*?tbody \.sticky-col\{position:static\}[\s\S]*?sellpia-group\{box-shadow:none\}/, "unfrozen mode must remove horizontal sticky positioning and the frozen boundary");
assert.match(html, /data-preset-id="all"/, "built-in matrix presets must remain selectable");
assert.match(html, /id="custom-preset-select"/, "personal matrix presets must remain selectable from the permanent action panel");
assert.match(html, /id="view-settings-modal"[\s\S]*?id="save-view-preset"/, "matrix view settings must support saving personal presets");
assert.match(source, /MATRIX_PRESETS_KEY = 'system-v3-matrix-presets-v1'/, "personal presets must persist locally");
assert.match(source, /modifiedPresetSourceId = activePresetId;[\s\S]*?findIndex\(item => item\.id === editablePresetId\)/, "editing a selected personal preset must update that preset instead of creating a stray copy");
assert.match(source, /function applyColumnVisibility\([\s\S]*?function applyViewPreset\(/, "presets must control matrix columns and view state");
assert.match(source, /const visible = new Set\(\[1,2,3,4,5,6\]\);[\s\S]*?if \(view\.showInventory\) visible\.add\(7\);[\s\S]*?if \(view\.showPrice\) \[8,9,10,11,12\]/, "Sellpia inventory and price-procurement columns must obey the same view switches as seller columns");
assert.match(source, /\['\.sellpia-group', \[3,4,5,6,7,8,9,10,11,12\]\]/, "the Sellpia group header must shrink with its visible columns");
assert.match(html, /재고·가격 표시를 끄면 셀피아 기준 영역의 재고·가격·매입·발주 관련 열도 함께 숨겨집니다/, "view settings must explain that Sellpia operational columns also hide");
assert.match(html, /id="matrix-status-filter"><option value="all">전체 연결상태<\/option><option value="connected">연결 완료<\/option><option value="unmatched">미매칭<\/option><\/select>/, "the connection filter must expose only connected and unmatched states");
assert.match(source, /function normalizeConnectionStatus\([\s\S]*?status === 'review'[\s\S]*?return 'connected'[\s\S]*?status === 'attention'[\s\S]*?return 'unmatched'/, "legacy review and attention presets must migrate into the binary connection model");
assert.match(source, /function matchState\(tier\)[\s\S]*?if \(!tier\)[\s\S]*?unmatched[\s\S]*?return \{key:'connected', label:'연결 완료'\}/, "every seller link tier, including FAST_REVIEW, must render as connected");
assert.match(dataSource, /normalizeConnectionStatus\(status\)[\s\S]*?load_operations_hub_matrix_page_v3[\s\S]*?p_status:status/, "binary connection filters must be normalized before the page-first RPC");
assert.match(binaryConnectionMigration, /v_status in \('connected','review'\)[\s\S]*?matrix\.overall_status <> 'unmatched'[\s\S]*?v_status in \('unmatched','attention'\)[\s\S]*?matrix\.overall_status = 'unmatched'/, "paged and exported server filters must use the same binary status semantics");
assert.match(dataSource, /MATRIX_VIEW = 'operations_hub_matrix_managed_live'[\s\S]*?\.from\(MATRIX_VIEW\)/, "the UI must read the managed wrapper over the non-blocking system-owned matrix");
assert.match(migration, /with \(security_invoker = true\)/, "the live matrix view must honor underlying RLS");
assert.match(presetMigration, /end::text as overall_status/, "the live matrix view must expose server-filterable overall status");
assert.match(html, /class="side-metrics"[\s\S]*?id="live-connected-sku"[\s\S]*?id="live-inventory-mismatch"[\s\S]*?id="live-today-picked"/, "compact sidebar metrics must keep the live-data targets");
assert.match(dataSource, /\.from\('operations_hub_dashboard_metrics'\)/, "dashboard metrics must load from the database");
assert.match(dataSource, /projected_inventory_mismatch_sku[\s\S]*?inventory_draft_cells/, "dashboard metrics must distinguish projected mismatches from raw snapshots");
assert.match(dataSource, /seller_unmatched_sku/, "dashboard metrics must request the seller-side unmatched count");
assert.match(source, /seller_unmatched_sku \?\? metrics\.unmatched_sku/, "the sidebar must prefer seller SKUs with no Sellpia connection");
assert.match(html, /판매처 미연결[\s\S]*?셀피아 SKU 연결 없음/, "the sidebar label must state the seller-side unmatched definition");
assert.match(dataSource, /seller_unmatched_smartstore[\s\S]*?seller_unmatched_makeshop[\s\S]*?seller_unmatched_ably/, "dashboard metrics must carry a per-channel seller unmatched breakdown");
assert.match(source, /스마트스토어.*메이크샵.*에이블리/, "the sidebar detail must render each marketplace separately");
assert.match(sellerUnmatchedCacheMigration, /operations_hub_seller_unmatched_cache[\s\S]*?refresh materialized view concurrently operations_private\.operations_hub_seller_unmatched_cache/, "seller unmatched template rows must use a refreshable cache");
assert.match(source, /live-inventory-mismatch-detail[\s\S]*?원본 \$\{formatNumber\(mismatched\)\}/, "the metric loader must retain raw and draft-projected inventory counts");
assert.match(dataSource, /\.from\('operations_hub_active_seller_drafts'\)/, "matrix draft colors must load from the de-duplicated active draft view");
assert.doesNotMatch(dataSource, /operations_hub_active_seller_drafts'[\s\S]{0,500}?\.limit\(1000\)/, "active seller drafts must not be truncated at 1,000 history rows");
assert.match(searchDraftMigration, /distinct on \(queue\.sellpia_sku_code, queue\.source_channel, queue\.field_key\)[\s\S]*?projected_inventory_mismatch_sku/, "the database must expose one latest draft per seller cell and projected mismatch totals");
assert.match(source, /data-field-key="\$\{fieldKey\}"[\s\S]*?fieldKey:cell\.dataset\.fieldKey/, "Sellpia matrix cells must retain database field keys while editing");
assert.match(dataSource, /apply_operations_hub_sellpia_changes/, "Sellpia matrix changes must save through the database RPC");
assert.match(source, /image-drop-cell[\s\S]*?uploadSellpiaImage/, "image cells must support Sellpia SKU image drops");
assert.match(dataSource, /`sellpia\/\$\{safeSku\}\.jpg`[\s\S]*?upsert:true/, "dropped images must be normalized to the Sellpia SKU filename");
assert.match(editMigration, /operations_hub_sellpia_overrides[\s\S]*?operations_hub_change_queue[\s\S]*?operations_hub_dashboard_metrics/, "Sellpia edits, seller outbox, and live dashboard metrics must persist in Supabase");
assert.match(css, /--thumb-width:84px;--thumb-height:63px[\s\S]*?object-fit:contain/, "matrix thumbnails must be larger and show the complete image without cropping");
assert.match(html, /스마트스토어[\s\S]*?상품코드[\s\S]*?상품명[\s\S]*?옵션코드 \/ 옵션명[\s\S]*?메이크샵[\s\S]*?에이블리/, "every seller group must expose independently copyable product codes and names plus option identities");
assert.match(html, /style\.css\?v=[^"\s]+[\s\S]*?data-service\.js\?v=[^"\s]+[\s\S]*?app\.js\?v=[^"\s]+/, "the deployed page must invalidate cached assets for bundled matrix metadata reads");
assert.match(source, /function applyMatrixGroupBoundaries\(visible\)[\s\S]*?smartstore[\s\S]*?makeshop[\s\S]*?ably[\s\S]*?operations[\s\S]*?firstVisible[\s\S]*?data-matrix-column/, "seller group dividers must follow the first visible column of every channel instead of fixed column positions");
assert.match(css, /matrix-group-start-smartstore[\s\S]*?inset 5px[\s\S]*?matrix-group-start-makeshop[\s\S]*?matrix-group-start-ably[\s\S]*?matrix-group-start-operations/, "every visible seller and operations group must have a strong color-coded vertical divider");
assert.match(source, /seller-product-code-cell[\s\S]*?mappingCodeButton[\s\S]*?seller-product-name-cell[\s\S]*?seller-option-identity/, "seller product codes and product names must render in separate matrix cells");
assert.doesNotMatch(html, /id="preset-show-status"/, "seller connection labels must not return through view settings");
assert.doesNotMatch(source.slice(source.indexOf('function viewColumnIndexes'), source.indexOf('function indexMatrixBodyColumns')), /groups\.status/, "seller connection-status columns must stay hidden in every matrix preset");
assert.match(html, /id="preset-show-codes"[\s\S]*?id="preset-show-seller-names"[\s\S]*?id="preset-image-size"/, "view settings must still independently control codes, seller names, and image size");
assert.doesNotMatch(source, /sellpiaEditor\('sellpia_product_name'/, "Sellpia product names must not be editable inline in the matrix");
assert.doesNotMatch(source, /sellpiaEditor\('sellpia_option_name'/, "Sellpia option names must not be editable inline in the matrix");
assert.match(source, /sellpiaEditor\('sellpia_own_code'[\s\S]*?systemOperationalCell\(product, 'system_stock'[\s\S]*?systemOperationalCell\(product, 'system_base_price'/, "own code plus system-owned stock and base price must remain inline editable");
assert.match(source, /mapping-code-button[\s\S]*?openListingLinkManager[\s\S]*?openMappingSearch[\s\S]*?linkSellerItem/, "seller code cells must open link management first and keep source search for unmatched rows");
assert.match(source, /listing-link-add-toggle[\s\S]*?event\.stopPropagation\(\)[\s\S]*?openMappingSearch/, "opening seller search from the link manager must not be closed by the same bubbled click");
assert.match(source, /data-open-sku-links[\s\S]*?drawerState\.activeTab = 'connections'[\s\S]*?openProductDrawer\(row\)/, "clicking a Sellpia SKU must open its connection information directly");
assert.match(source, /function matrixRowName\(row\)[\s\S]*?matrixRowsBySku\.get\(sku\)[\s\S]*?sellpia-name-col span[\s\S]*?sellpia-option-name-col span/, "the product drawer must read the current separated Sellpia name cells without relying on removed product-cell markup");
assert.match(dataSource, /search_operations_hub_seller_items[\s\S]*?link_operations_hub_seller_item[\s\S]*?save_operations_hub_seller_listing/, "seller search, linking, and detail drafts must use database RPCs");
assert.match(dataSource, /search_operations_hub_seller_items_v2[\s\S]*?p_page[\s\S]*?p_page_size/, "seller matching search must be paginated instead of silently capped");
assert.match(dataSource, /async function loadSellerProductOptions[\s\S]*?exactProductCode[\s\S]*?searchSellerItems[\s\S]*?row\.product_code[\s\S]*?exactProductCode/, "same-product option linking must page through seller search results and keep only the exact product code");
assert.match(source, /상품명 \/ 옵션명[\s\S]*?mapping-pagination[\s\S]*?전체 \$\{formatNumber\(mappingState\.count\)\}개/, "seller search must explain intersection syntax and show total result count");
assert.match(searchDraftMigration, /product_name[\s\S]*?ilike[\s\S]*?product_term[\s\S]*?option_name[\s\S]*?ilike[\s\S]*?option_term/, "seller search must apply product and option name terms as an intersection");
assert.match(html, /id="drawer-smart-name"[\s\S]*?id="drawer-make-name"[\s\S]*?id="drawer-ably-name"/, "the detail drawer must edit seller-specific names independently");
assert.match(source, /price-hover-target[\s\S]*?function showPricePopover[\s\S]*?판매처 원본가[\s\S]*?시스템 기준가격[\s\S]*?판매처별 수식 계산가[\s\S]*?내보내기 예정가/, "seller price cells must keep source, system, policy, and export-draft prices visibly separate");
assert.match(sellerDetailMigration, /operations_hub_manual_links[\s\S]*?search_operations_hub_seller_items[\s\S]*?link_operations_hub_seller_item[\s\S]*?smartstore_option_name/, "manual links and seller detail names must persist in the live matrix schema");
assert.match(mappingSyncMigration, /operations_hub_manual_links_backup_20260818_013437[\s\S]*?mapping_origin[\s\S]*?mapping_batch_id/, "mapping storage changes must retain a rollback copy and preserve origin metadata");
assert.match(mappingSyncMigration, /save_operations_hub_mapping_batch[\s\S]*?jsonb_array_length\(p_items\)[\s\S]*?operations_hub_manual_links[\s\S]*?operations_hub_link_history/, "automatic and imported mappings must use the audited official overlay path in bounded batches");
assert.match(mappingSyncMigration, /refresh materialized view concurrently operations_private\.operations_hub_matrix_core[\s\S]*?operations_hub_matrix_refresh_state/, "legacy mapping refreshes must record the completed matrix-core version");
assert.match(mappingSyncMigration, /operations_hub_mapping_sync_status[\s\S]*?core_refresh_needed[\s\S]*?mapping_version/, "the database must expose saved, core-refreshed, and visible mapping state separately");
assert.match(mappingSyncIndexMigration, /final_excel_mapping_import_imported_at_desc_idx[\s\S]*?final_excel_mapping_import \(imported_at desc\)/, "mapping status polls must use an index for the latest legacy import timestamp");
assert.match(html, /id="matrix-mapping-sync"[\s\S]*?id="matrix-mapping-sync-state"[\s\S]*?id="matrix-mapping-sync-time"/, "the permanent action panel must show mapping synchronization state");
assert.match(dataSource, /operations_hub_mapping_sync_status[\s\S]*?loadMappingSyncStatus/, "the frontend must read mapping synchronization state from Supabase");
assert.match(source, /MAPPING_SYNC_POLL_INTERVAL_MS = 60000[\s\S]*?loadMappingSyncStatus\(\{autoRefresh:true\}\)/, "the matrix must detect external mapping changes without aggressive polling");
assert.match(source, /function matrixSelectionClipboardText\([\s\S]*?matrixSelectedBounds[\s\S]*?matrixCellSelection\.selected\.has\(cell\)[\s\S]*?rows\.join\('\\n'\)/, "selected contiguous or disjoint cells must copy to an Excel-compatible tab and newline grid");
assert.match(source, /document\.addEventListener\('paste'[\s\S]*?normalizePastedRows[\s\S]*?commitEditableCellValue/, "Excel clipboard grids must paste into the selected editable Sellpia cell range");
assert.match(source, /function parseEditableInputValue\([\s\S]*?signedNumber[\s\S]*?\^\-\?\\d\+[\s\S]*?valid/, "clipboard paste and inline editing must share numeric validation, including signed option prices");
assert.match(source, /function commitEditableCellValue\([\s\S]*?parseEditableInputValue\(value, cell\.dataset\.valueType\)[\s\S]*?parsed\.valid/, "clipboard paste must reject invalid stock and price values through the common parser");
assert.match(html, /한 번 클릭은 셀 선택[\s\S]*?Ctrl\+C \/ Ctrl\+V/, "the matrix must explain spreadsheet-style clipboard controls");
assert.match(css, /td\.matrix-cell-selected[\s\S]*?td\.matrix-cell-anchor/, "selected matrix cells and the anchor cell must remain visually distinct");
assert.match(source, /matrixBody\.addEventListener\('click'[\s\S]*?selectMatrixCell\(cell[\s\S]*?matrixBody\.addEventListener\('dblclick'[\s\S]*?openProductDrawer\(row\)/, "single click must select a cell while double click opens row details");

console.log("Operations hub seller verification, linking, detail drawer, and live matrix contract: passed");
