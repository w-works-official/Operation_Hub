import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../mockups/operations-hub/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../mockups/operations-hub/app.js', import.meta.url), 'utf8');
const data = fs.readFileSync(new URL('../mockups/operations-hub/data-service.js', import.meta.url), 'utf8');
const csvSource = fs.readFileSync(new URL('../mockups/operations-hub/matrix-csv-export.js', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../supabase/migrations/20260820093000_operations_hub_filtered_csv_export.sql', import.meta.url), 'utf8');
const optimizationMigration = fs.readFileSync(new URL('../supabase/migrations/20260820094500_optimize_operations_hub_filtered_csv_export.sql', import.meta.url), 'utf8');
const cacheMigration = fs.readFileSync(new URL('../supabase/migrations/20260820120500_cache_operations_hub_csv_export.sql', import.meta.url), 'utf8');
const nonblockingCacheMigration = fs.readFileSync(new URL('../supabase/migrations/20260820123000_nonblocking_operations_hub_csv_cache.sql', import.meta.url), 'utf8');

const context = {window:{}, Blob, URL, console, setTimeout};
vm.createContext(context);
vm.runInContext(csvSource, context);
const csv = context.window.SystemV3MatrixCsv;

assert.ok(csv, 'the CSV serializer must expose a browser module');
for (const id of ['matrix-csv-btn','matrix-csv-modal','matrix-csv-count','matrix-csv-progress','matrix-csv-cancel','matrix-csv-run']) {
  assert.match(html, new RegExp(`id="${id}"`), `CSV UI must include ${id}`);
}
assert.match(html, /matrix-csv-export\.js\?v=[^"']+/, 'the serializer must load before the data and app modules');
assert.match(data, /function loadMatrixExportChunk[\s\S]*?rpc\('export_operations_hub_matrix_chunk'/, 'the data adapter must expose the chunk RPC');
assert.match(app, /while \(processed < total\)[\s\S]*?matrixCsvState\.cancelRequested[\s\S]*?loadMatrixCsvChunk/, 'large exports must page and honor cancellation between chunks');
assert.match(app, /const chunkSize = codeListMode \? 200 : 400/, 'wide matrix exports must stay below the observed 1,000-row statement-timeout boundary');
assert.match(app, /isMatrixCsvTimeout[\s\S]*?limit = Math\.max\(100, Math\.floor\(limit \/ 2\)\)/, 'timed-out chunks must automatically retry at a smaller size without restarting the export');
assert.match(app, /완료된.*processed.*행부터 이어갑니다/, 'timeout recovery must tell the operator that completed rows are preserved');
assert.match(app, /loadCodeListCsvChunk[\s\S]*?matrixState\.codeListRows\.slice[\s\S]*?__codeList:codeRow/, 'Excel code-list exports must preserve input-row order and duplicates');
assert.match(migration, /security invoker/i, 'CSV export must not bypass row-level security');
assert.doesNotMatch(migration, /security definer/i, 'CSV export must never use definer privileges');
assert.match(migration, /least\(coalesce\(p_limit, 1000\), 1000\)/, 'each server response must be bounded');
assert.match(migration, /operations_hub_product_profiles profile[\s\S]*?operations_hub_active_seller_drafts draft/, 'export rows must include profile metadata and projected seller drafts');
assert.match(migration, /operations_hub_matrix_condition_matches/, 'CSV rows must use the same validated advanced-condition evaluator');
assert.match(optimizationMigration, /v_needs_profile[\s\S]*?filter_profile on v_needs_profile/, 'profile filtering must be skipped for ordinary matrix-only conditions');
assert.match(optimizationMigration, /offset v_offset[\s\S]*?limit v_limit[\s\S]*?operations_hub_product_profiles profile/, 'profile metadata must join only after the requested page is bounded');
assert.match(cacheMigration, /operations_hub_matrix_export_cache[\s\S]*?enable row level security[\s\S]*?for select[\s\S]*?to anon, authenticated/, 'the initial public cache must be read-only through an explicit RLS policy');
assert.match(nonblockingCacheMigration, /create materialized view operations_private\.operations_hub_matrix_export_cache[\s\S]*?create unique index/, 'the final CSV cache must use an indexed private materialized snapshot');
assert.match(nonblockingCacheMigration, /refresh materialized view concurrently operations_private\.operations_hub_matrix_export_cache/, 'minute refreshes must not block CSV readers');
assert.match(nonblockingCacheMigration, /drop table if exists public\.operations_hub_matrix_export_cache/, 'the temporary public cache table must be removed after the private snapshot is active');
assert.doesNotMatch(cacheMigration + nonblockingCacheMigration, /security definer/i, 'CSV cache maintenance must not introduce definer privileges');

const visible = csv.buildColumns({
  scope:'visible',
  view:{channels:{smartstore:true,makeshop:false,ably:false},showStatus:true,showCodes:true,showSellerNames:true,showInventory:true,showPrice:false,showAttributes:true,showSync:true},
  codeListMode:true
});
const labels = visible.map(column => column.label);
assert.ok(labels.includes('입력 행') && labels.includes('입력 코드'), 'code-list metadata must lead the export');
assert.ok(labels.includes('스마트스토어 판매처재고'), 'visible channel stock must be exported');
assert.ok(!labels.includes('스마트스토어 연결상태'), 'hidden matrix connection-status columns must stay out of visible-scope CSV');
assert.ok(!labels.includes('스마트스토어 판매가격'), 'hidden price columns must stay out of visible-scope CSV');
assert.ok(!labels.some(label => label.startsWith('메이크샵 ')), 'hidden channels must stay out of visible-scope CSV');

const discountColumns = csv.buildColumns({
  scope:'visible',
  view:{channels:{smartstore:true,makeshop:false,ably:false},showStatus:false,showCodes:false,showSellerNames:false,showInventory:false,showPrice:true,showDiscount:true,showAttributes:false,showSync:false}
});
const smartstoreDiscount = discountColumns.find(column => column.label === '스마트스토어 할인정보');
assert.ok(smartstoreDiscount, 'visible-scope CSV must include the requested marketplace discount-information column');
const serializedDiscount = csv.serializeRows([{
  smartstore_price:9000,
  __sellerPriceComponents:{smartstore:{
    source_base_price:10000,
    source_discounted_base_price:9000,
    source_option_price:0,
    source_final_price:9000,
    source_discount_terms:[{title:'기본할인',value:10,unit:'percent',is_baseline:true}]
  }}
}], [smartstoreDiscount]);
assert.match(serializedDiscount, /기본할인 10% · 적용가 9,000원/, 'discount CSV cells must include both the discount condition and effective sale price');

const sample = [{
  sellpia_sku_code:'00123-1',
  sellpia_own_code:'=unsafe',
  sellpia_product_name:'테스트, 상품',
  sellpia_current_stock:0,
  smartstore_stock:3,
  smartstore_match_tier:'EXACT',
  __codeList:{input_row:2,source_channel:'sellpia',input_code:'00123-1',match_status:'matched'},
  __profile:{material:'써지컬',product_group:'피어싱',shape:'바벨',tag_summary:'테스트'}
}];
const serialized = csv.serializeHeader(visible) + csv.serializeRows(sample, visible);
assert.equal(serialized.charCodeAt(0), 0xfeff, 'CSV must include a UTF-8 BOM');
assert.match(serialized, /=""00123-1""/, 'code cells must open in Excel without scientific notation or lost leading zero');
assert.match(serialized, /"테스트, 상품"/, 'commas in Korean names must remain quoted');
assert.match(serialized, /(?:^|,)0(?:,|\r\n)/, 'numeric zero must remain numeric instead of becoming blank');

console.log('Operations hub filtered CSV export contract: passed');
