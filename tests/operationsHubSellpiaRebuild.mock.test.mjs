import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(new URL('../supabase/migrations/20260820150000_sellpia_authoritative_matrix.sql', import.meta.url), 'utf8');
const patchMigration = fs.readFileSync(new URL('../supabase/migrations/20260820220000_operations_hub_sellpia_patch_upload.sql', import.meta.url), 'utf8');
const secureUploadMigration = fs.readFileSync(new URL('../supabase/migrations/20260920025225_operations_hub_original_upload_boundary_v1.sql', import.meta.url), 'utf8');
const dataService = fs.readFileSync(new URL('../mockups/operations-hub/data-service.js', import.meta.url), 'utf8');
const sellpiaParser = fs.readFileSync(new URL('../mockups/operations-hub/sellpia-source-parser.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../mockups/operations-hub/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../mockups/operations-hub/index.html', import.meta.url), 'utf8');

assert.match(migration, /from public\.sellpia_stock_latest stock[\s\S]*left join catalog\.sellpia_products/, 'latest Sellpia snapshot must own the active matrix row set');
assert.doesNotMatch(migration, /with all_skus as/, 'historical catalog and mapping rows must not create active matrix rows');
assert.match(migration, /review\.final_excel_mapping_import[\s\S]*review\.sheet_manual_mappings/, 'mapping history must remain separate and reattach by SKU');
assert.match(migration, /sellpia_snapshot_id uuid[\s\S]*is not distinct from v_recorded_sellpia_snapshot_id/, 'the refresh state must detect a newly-ready Sellpia snapshot');
assert.match(migration, /operations_hub_sellpia_matrix_sync_status[\s\S]*rebuild_pending/, 'the frontend needs a read-only rebuild completion signal');

for (const column of [
  'supplier_code',
  'supplier_name',
  'supplier_group',
  'supplier_address',
  'supplier_market_name',
  'supplier_phone',
  'purchase_product_name',
  'purchase_option_name'
]) {
  assert.match(migration, new RegExp(`add column if not exists ${column} text`), `${column} must be stored in the Sellpia snapshot table`);
  const parserField = {
    supplier_code:'supplierCode',
    supplier_name:'supplierName',
    supplier_group:'supplierGroup',
    supplier_address:'supplierAddress',
    supplier_market_name:'supplierMarketName',
    supplier_phone:'supplierPhone',
    purchase_product_name:'purchaseProductName',
    purchase_option_name:'purchaseOptionName',
  }[column];
  assert.match(sellpiaParser, new RegExp(`${column}:clean\\(cell\\(source, columns, '${parserField}'\\)\\)`), `${column} must be parsed from the normalized header map`);
}

assert.match(sellpiaParser, /REQUIRED_HEADERS[\s\S]*supplierCode:\['매입처코드'\][\s\S]*purchaseOptionName:\['매입옵션명'\]/, 'Sellpia supplier headers must be validated before upload');
assert.match(dataService, /operations_hub_sellpia_matrix_sync_status[\s\S]*waitForSellpiaMatrixRebuild/, 'the data adapter must poll the database rebuild status');
assert.match(app, /await liveData\.waitForSellpiaMatrixRebuild\(result\.snapshotId, showUploadProgress\)/, 'the upload flow must wait for the new matrix version before reloading data');

assert.match(html, /원본 반영 방식[\s\S]*부분 갱신[\s\S]*전체 교체/, 'Sellpia upload UI must expose explicit patch and full modes');
assert.match(app, /\['sellpia','smartstore','makeshop','ably'\][\s\S]*isPatchableUploadSource/, 'Sellpia must participate in the patchable upload mode');
assert.match(dataService, /parseSellpiaUploadFiles\(selectedFiles, \{mode:fields\.mode\}, onProgress\)/, 'Sellpia upload must pass the chosen mode into the shared parser boundary');
assert.match(sellpiaParser, /const mode = options\.mode === 'patch' \? 'patch' : 'full'/, 'the shared parser must normalize the selected mode before validating file count and rows');
assert.match(sellpiaParser, /mode === 'full' && row\.source_row_no !== index \+ 1/, 'only a full Sellpia replacement requires a complete continuous row sequence');
assert.match(dataService, /hub_sellpia_upload_complete_v1[\s\S]*p_intent_id/, 'Sellpia patch upload must finalize through the session-gated completion RPC');
assert.match(secureUploadMigration, /v_intent\.upload_mode='patch'[\s\S]*finalize_operations_hub_sellpia_patch\(v_intent\.snapshot_id,v_intent\.selected_fields\)/, 'the secure completion RPC must invoke the existing patch merge with the verified intent fields');
assert.match(patchMigration, /security invoker[\s\S]*v_base_snapshot_id[\s\S]*upload_status = 'ready'/, 'patch merge must use the latest ready Sellpia snapshot under caller permissions');
for (const selectedFieldFlag of ['v_inventory', 'v_price', 'v_basic', 'v_status']) {
  assert.match(
    patchMigration,
    new RegExp(`case when ${selectedFieldFlag}`),
    `unchecked Sellpia ${selectedFieldFlag} values must be preserved from the previous snapshot`,
  );
}
assert.match(patchMigration, /not exists \([\s\S]*patch_row\.sellpia_sku_code = base_row\.sellpia_sku_code[\s\S]*preserved_row_count/, 'SKUs omitted from a Sellpia patch must remain in the new ready snapshot');

console.log('operations hub Sellpia authoritative rebuild mock checks passed');
