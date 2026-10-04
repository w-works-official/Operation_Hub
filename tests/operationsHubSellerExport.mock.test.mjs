import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../mockups/operations-hub/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../mockups/operations-hub/app.js', import.meta.url), 'utf8');
const data = fs.readFileSync(new URL('../mockups/operations-hub/data-service.js', import.meta.url), 'utf8');
const adapterSource = fs.readFileSync(new URL('../mockups/operations-hub/seller-export-adapter.js', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../supabase/migrations/20260814131808_operations_hub_seller_export.sql', import.meta.url), 'utf8');
const failureMigration = fs.readFileSync(new URL('../supabase/migrations/20260814140500_operations_hub_export_failure_finalize.sql', import.meta.url), 'utf8');
const partialMigration = fs.readFileSync(new URL('../supabase/migrations/20260814143500_operations_hub_export_partial_success.sql', import.meta.url), 'utf8');
const draftMigration = fs.readFileSync(new URL('../supabase/migrations/20260814153000_operations_hub_seller_drafts_and_originals.sql', import.meta.url), 'utf8');
const aliasMigration = fs.readFileSync(new URL('../supabase/migrations/20260814154500_operations_hub_export_source_alias.sql', import.meta.url), 'utf8');
const bulkMigration = fs.readFileSync(new URL('../supabase/migrations/20260814173000_operations_hub_export_bulk_prepare.sql', import.meta.url), 'utf8');
const conflictMigration = fs.readFileSync(new URL('../supabase/migrations/20260814183000_operations_hub_export_row_conflicts.sql', import.meta.url), 'utf8');
const inventoryBatchMigration = fs.readFileSync(new URL('../supabase/migrations/20260814190000_operations_hub_inventory_match_batches.sql', import.meta.url), 'utf8');
const inventoryTimeoutMigration = fs.readFileSync(new URL('../supabase/migrations/20260903094500_operations_hub_inventory_draft_timeout.sql', import.meta.url), 'utf8');
const priceComponentMigration = fs.readFileSync(new URL('../supabase/migrations/20260821014626_operations_hub_seller_price_components.sql', import.meta.url), 'utf8');
const priceExportMigration = fs.readFileSync(new URL('../supabase/migrations/20260821020657_operations_hub_export_price_components.sql', import.meta.url), 'utf8');
const lifecycleMigration = fs.readFileSync(new URL('../supabase/migrations/20260827023043_separate_change_state_from_export_history.sql', import.meta.url), 'utf8');
const cancellationOptimization = fs.readFileSync(new URL('../supabase/migrations/20260827023224_optimize_cancelled_export_invalidation.sql', import.meta.url), 'utf8');

for (const table of ['operations_hub_export_batches', 'operations_hub_export_items']) {
  assert.match(migration, new RegExp(`create table if not exists public\\.${table}`), `${table} must persist the export audit trail`);
  assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`), `${table} must enable RLS`);
}
for (const rpc of ['prepare_operations_hub_export', 'complete_operations_hub_export', 'confirm_operations_hub_changes_applied']) {
  assert.match(migration + failureMigration, new RegExp(`create or replace function public\\.${rpc}`), `${rpc} must exist`);
}
assert.doesNotMatch(migration + failureMigration, /security definer/i, 'export RPCs must not bypass RLS');
assert.match(lifecycleMigration, /status in \('pending', 'validated', 'applied', 'failed', 'saved', 'cancelled'\)/, 'queue state must exclude file-generation states');
assert.match(lifecycleMigration, /where status in \('processing', 'exported'\)[\s\S]*?normalize_operations_hub_change_status/, 'legacy file states must normalize without deleting export history');
assert.match(lifecycleMigration, /operations_hub_export_items[\s\S]*?status = 'cancelled'[\s\S]*?최신 반영본이 아닙니다/, 'cancelling an edit must mark its exported file audit stale');
assert.doesNotMatch(cancellationOptimization, /update public\.operations_hub_export_batches/, 'per-edit cancellation must not rescan or rewrite the immutable export batch');
assert.match(lifecycleMigration, /queue\.status = 'validated'[\s\S]*?item\.status = 'exported'[\s\S]*?set status = 'applied'/, 'manual apply confirmation must require a separate exported item');
assert.match(migration, /else[\s\S]*?sellpia_current_stock is distinct from t\.seller_stock/, 'inventory reconciliation must export only stock differences');
assert.match(partialMigration, /blocking_reason is null[\s\S]*?then 'exported' else 'failed'/, 'valid rows must export while unresolved original rows remain failed');

for (const id of ['matrix-match-stock-btn','matrix-export-btn','queue-export','queue-confirm-applied','seller-export-modal','seller-export-run','seller-export-scope','seller-export-preview','seller-export-selected-scope','seller-export-tag-scope','seller-export-tag-picker','seller-export-tag-select']) {
  assert.match(html, new RegExp(`id="${id}"`), `export UI must include ${id}`);
}
assert.doesNotMatch(html, /id="seller-export-include-stock"/, 'direct export stock is display-only and must not have a calculation checkbox');
assert.match(html, /seller-source-parsers\.js[\s\S]*?seller-export-adapter\.js[\s\S]*?data-service\.js/, 'the export adapter must load before application startup');
const localAssets = [...html.matchAll(/(?:href|src)="(\.\/[^\"]+)"/g)].map(match => match[1]);
assert.ok(localAssets.length >= 18, 'the export page must retain its local asset bundle');
assert.ok(localAssets.every(asset => /\?v=[^&\"]+$/.test(asset)), 'all local export assets must be versioned');
assert.match(html,/discount-price-math\.js\?v=20260914-matrix-visible-export-v2/,'shared matrix display math keeps its deployed version');
assert.match(html,/seller-export-adapter\.js\?v=20260922-makeshop-batch-row-patch-v2/,'MakeShop workbook batch row serializer uses the latest version');
assert.match(html,/app\.js\?v=[^"']+/,'carrier guard remains cache-versioned');
assert.match(html,/current-price-export\.js\?v=20261001-seller-fanout-v1/,'source-price preview and fan-out classifier uses a fresh release version');
assert.match(html,/ably-price-projection\.js\?v=20260929-ably-carrier-policy-v1[\s\S]*?ably-playauto-export\.js\?v=20260929-ably-carrier-policy-v1/,'Ably projection loads before its PlayAuto adapter with a fresh version');
assert.match(html,/seller-file-workflow-v2\.js\?v=[^"']+/,'seller file workflow remains cache-versioned');
assert.match(html,/data-service\.js\?v=[^"']+/,'targeted carrier lookup data service remains cache-versioned');
assert.doesNotMatch(html, /class="seller-export-files"/, 'export must reuse the latest stored originals instead of asking for files again');
for (const scope of ['filtered','selected','tag','all']) assert.match(html, new RegExp(`name="seller-export-scope" value="${scope}"`), `export scope must include ${scope}`);
assert.match(draftMigration, /source_storage_files jsonb[^]*?seller-originals/, 'seller snapshots must retain immutable original file references');
assert.match(draftMigration, /save_operations_hub_seller_value_draft[^]*?stage_operations_hub_seller_inventory_match/, 'seller cells and bulk stock matching must create reviewable drafts');
assert.match(aliasMigration, /source\.source_channel as export_source_channel[^]*?r\.export_source_channel/, 'queue source and expanded export source must never share an ambiguous alias');
assert.match(bulkMigration, /prepare_operations_hub_change_export[^]*?set statement_timeout = '45s'/, 'bulk export preparation must have a function-scoped timeout');
assert.match(bulkMigration, /source_specific as materialized[^]*?seller_product_code[^]*?global_changes/, 'source-specific drafts must use their stored seller codes without rescanning the matrix');
assert.match(bulkMigration, /returns table\(item_count integer, blocked_count integer, batch_status text\)/, 'bulk preparation must return only a compact summary');
assert.match(bulkMigration, /alter function public\.complete_operations_hub_export[^]*?statement_timeout = '45s'/, 'bulk export completion must allow the queue status update to finish');
assert.match(conflictMigration, /p_skipped_items jsonb[^]*?jsonb_to_recordset[^]*?blocking_reason[^]*?status = 'failed'/, 'runtime source conflicts must be finalized as item-level failures');
assert.doesNotMatch(conflictMigration, /security definer/i, 'runtime conflict finalization must not bypass RLS');
assert.match(data, /downloadLatestSellerOriginals[^]*?storage\.from\('seller-originals'\)\.download/, 'export must download the latest stored originals');
assert.match(data, /loadSellerDraftRows\(\{sources = \[\], skus = null\}/, 'draft lookup must accept an optional SKU scope');
assert.match(data, /loadSellerDraftRows[\s\S]*?if\(batch\)q=q\.in\('sellpia_sku_code',batch\)/, 'draft lookup must filter saved changes by Sellpia SKU in bounded batches');
assert.match(app, /matrixHasActiveExportFilter\(\)[^]*?defaultScope = matrixHasActiveExportFilter\(\) \? 'filtered'/, 'an active matrix filter must become the default export scope');
assert.match(app, /scope === 'selected'[^]*?scope === 'filtered'[^]*?collectSellerExportFilteredSkus/, 'checked and filtered SKU scopes must resolve separately');
assert.match(app, /scope === 'tag'[^]*?collectSellerExportTagSkus/, 'tag scope must resolve through the authoritative server member reader');
assert.match(app, /loadTagMembers\(\{tagId,search:'',page,pageSize:1000\}\)/, 'tag scope must page through the complete server-side assignment set');
assert.match(app, /expected!==null&&expected!==count[^]*?skus\.length!==expected/, 'tag scope must fail closed if membership changes or rows are missing');
assert.match(app, /HubCurrentPriceExport\.refreshItems[\s\S]*?skus:scopeSkusForRules/, 'tag scope must reach the same bounded seller carrier resolver as other SKU scopes');
assert.match(app, /let firstChunk = true[^]*?while \(firstChunk \|\| offset < filter\.total\)/, 'filtered export must query once even when the matrix total is still loading');
assert.match(app, /const includeStockDrafts = Boolean\(sellerExportState\.rows\?\.length\)/, 'only an explicit saved-change export may validate queue rows');
assert.match(app, /if \(sellerExportState\.rows\.length\)[\s\S]*?reviewSellerDraftsForExport\(\{sources, changeIds:/, 'explicit queue rows must retain their validation path');
assert.match(app, /includeStockDrafts \? '재고 수정안 확인 중' : '저장 가격 조회 준비'/, 'direct matrix export must read saved matrix state without a calculation option');
assert.match(app, /HubCurrentPriceExport\.refreshItems[\s\S]*?includeRules:!sellerExportState\.rows\.length/, 'matrix export must route price-only export through the stored-price adapter');
assert.match(app, /stageSellerInventoryDraftBatch[^]*?loadLiveMatrix/, 'inventory matching must stop at a reviewable matrix draft');
assert.match(data, /stageSellerInventoryDraftBatch[^]*?p_after_sku:[^]*?p_batch_size:/, 'the frontend must stage large inventory matches through cursor batches');
assert.match(app, /stageSellerInventoryDraftBatch\(\{sources, skus, batchId, afterSku, batchSize:100\}\)/, 'inventory drafts must use smaller transactions for reliable matrix-wide staging');
assert.match(app, /isDraftAction && !liveData\?\.stageSellerInventoryDraftBatch[\s\S]*?!isDraftAction && \(!sellerExport \|\| !globalThis\.HubCurrentPriceExport/, 'draft creation must not depend on the ZIP export adapter or original-file export RPC');
assert.match(app, /includeStockDrafts && \(!liveData\?\.prepareSellerExport \|\| !liveData\?\.reviewSellerDraftsForExport\)/, 'direct matrix export must not require inventory queue APIs');
assert.match(app, /isDraftAction \? '수정안 생성 실패' : '내보내기 실패'[\s\S]*?isDraftAction \? '수정안 생성' : '원본 내보내기'/, 'draft failures and export failures must keep distinct labels');
assert.match(app, /while \(hasMore\)[^]*?processed \/ total[^]*?수정안 생성 중/, 'bulk inventory matching must show real SKU progress for each committed batch');
assert.match(inventoryBatchMigration, /operations_hub_change_queue_inventory_active_idx[^]*?field_key = 'sellpia_current_stock'/, 'active inventory drafts need a focused replacement index');
assert.match(inventoryBatchMigration, /with candidates as materialized[^]*?sku_page as materialized[^]*?limit v_batch_size/, 'inventory staging must bound each database transaction');
assert.equal((inventoryBatchMigration.match(/from public\.operations_hub_matrix_live matrix/g) || []).length, 1, 'each batch must scan the live matrix only once');
assert.match(inventoryBatchMigration, /cancelled as \([^]*?inserted as \([^]*?processed_count < batch_stats\.total_count/, 'each batch must replace stale drafts and return a real continuation signal');
assert.doesNotMatch(inventoryBatchMigration, /security definer/i, 'inventory batching must not bypass RLS');
assert.match(inventoryTimeoutMigration, /stage_operations_hub_seller_inventory_match_batch[\s\S]*?statement_timeout = '45s'/, 'inventory draft staging needs a function-scoped timeout without changing global DB settings');
assert.match(data, /prepareSellerExport[\s\S]*?range\(from, from \+ pageSize - 1\)/, 'large export plans must be read through pagination');
assert.match(data, /rpc\('prepare_operations_hub_change_export'/, 'the frontend must use the optimized bulk preparation RPC');
assert.match(data, /completeSellerExport[\s\S]*?confirmChangesApplied/, 'the frontend adapter must expose export and manual apply confirmation');
assert.match(data, /p_skipped_items:[\s\S]*?export_item_id[\s\S]*?reason/, 'runtime export conflicts must be sent back to the database');
assert.match(app, /HubCurrentPriceExport\.buildArchive[\s\S]*?completeSellerExport\(\{batchId, success:result\.appliedItems\.length > 0/, 'stored-price files must be built before their export audit is finalized');
assert.match(data, /attachChangeExportAudit[\s\S]*?has_exported_file:audit\.exported_file_count > 0/, 'queue rows must derive file history from export items');
assert.match(app, /row\.status === 'validated' && row\.has_exported_file/, 'manual apply confirmation must use validated edits with an exported-file audit');
assert.doesNotMatch(html, /<option value="(?:processing|exported)">/, 'file lifecycle states must not appear in the change-status filter');
assert.match(app, /skippedItems:result\.skippedItems[\s\S]*?제외목록 CSV/, 'successful exports must report row conflicts without aborting the whole archive');
assert.match(adapterSource, /SystemV3_내보내기_제외목록\.csv/, 'the archive must include a CSV describing skipped conflicts');
assert.match(app, /confirmChangesApplied/, 'marketplace upload confirmation must be a separate action');
assert.match(priceComponentMigration, /v_target_base := p_target_final_price - v_target_option/, 'seller price drafts must derive the shared base price from final minus option');
assert.match(priceExportMigration, /target_base_price[\s\S]*?target_option_price[\s\S]*?target_final_price/, 'export plans must preserve all three target price components');
assert.match(priceExportMigration, /같은 상품의 옵션별 목표 판매가가 서로 다릅니다[\s\S]*?모든 옵션 가격을 함께 검토/, 'unsafe shared base-price changes must be blocked before file generation');

const context = {console, setTimeout, URL:{createObjectURL(){}, revokeObjectURL(){}}, Blob};
vm.createContext(context);
vm.runInContext(adapterSource, context);
const adapter = context.SystemV3SellerExport;

const smartRow = '<row r="3"><c r="F3"><v>5200</v></c><c r="P3" t="inlineStr"><is><t xml:space="preserve">op1\nop2</t></is></c><c r="Q3" t="inlineStr"><is><t xml:space="preserve">실버\n골드</t></is></c><c r="R3" t="inlineStr"><is><t xml:space="preserve">0\n200</t></is></c><c r="S3" t="inlineStr"><is><t xml:space="preserve">2\n3</t></is></c></row>';
const smartPatched = adapter.patchSmartstoreRow(smartRow, [
  {source_row_no:3, source_channel:'smartstore', sellpia_sku_code:'1014-2', seller_option_code:'op2', field_key:'sellpia_current_stock', expected_source_value:3, after_value:9},
  {source_row_no:3, source_channel:'smartstore', sellpia_sku_code:'1014-2', seller_option_code:'op2', field_key:'sellpia_sale_price', expected_source_value:5400, after_value:5700, target_base_price:5400, target_option_price:300, target_final_price:5700},
], []);
assert.equal(adapter.cellValue(smartPatched, 'S3', []), '2\n9');
assert.equal(adapter.cellValue(smartPatched, 'F3', []), '5400');
assert.equal(adapter.cellValue(smartPatched, 'R3', []), '0\n300');

const smartDiscountRow = '<row r="5"><c r="F5"><v>5200</v></c><c r="P5" t="inlineStr"><is><t xml:space="preserve">op1\nop2</t></is></c><c r="Q5" t="inlineStr"><is><t xml:space="preserve">실버\n골드</t></is></c><c r="R5" t="inlineStr"><is><t xml:space="preserve">0\n200</t></is></c><c r="BF5"><v>10</v></c><c r="BG5" t="inlineStr"><is><t>%</t></is></c></row>';
const smartDiscountPatched = adapter.patchSmartstoreRow(smartDiscountRow, [
  {source_row_no:5, source_channel:'smartstore', sellpia_sku_code:'1014-2', seller_option_code:'op2', field_key:'sellpia_sale_price', expected_source_value:4880, after_value:5700, target_base_price:6000, target_discounted_base_price:4500, target_option_price:1200, target_final_price:5700,
    source_discount_terms:[{term_key:'basic',value:10,unit:'percent'}],
    target_discount_terms:[{term_key:'basic',value:1500,unit:'amount',is_baseline:true},{term_key:'mobile',value:1000,unit:'amount',is_baseline:false}]},
], []);
assert.equal(adapter.cellValue(smartDiscountPatched, 'F5', []), '6000', 'Smartstore export must write the pre-discount sale price');
assert.equal(adapter.cellValue(smartDiscountPatched, 'R5', []), '0\n1200', 'Smartstore export must derive the option against the discounted sale price');
assert.equal(adapter.cellValue(smartDiscountPatched, 'BF5', []), '1500', 'Smartstore basic discount must export as a fixed amount');
assert.equal(adapter.cellValue(smartDiscountPatched, 'BG5', []), '원', 'Smartstore basic discount unit must be fixed to won');
assert.equal(adapter.cellValue(smartDiscountPatched, 'BH5', []), '1000', 'Smartstore mobile discount value must be exported separately');
assert.equal(adapter.cellValue(smartDiscountPatched, 'BI5', []), '원', 'Smartstore mobile discount unit must be exported separately');

const smartGroupSheet = `<worksheet><sheetData>${smartRow}</sheetData></worksheet>`;
const smartGroupItems = [
  {source_row_no:3, source_channel:'smartstore', source_file_name:'smart.xlsx', sellpia_sku_code:'1014-1', seller_product_code:'product-1', seller_option_code:'op1', field_key:'sellpia_sale_price', expected_source_value:5200, after_value:5700, target_base_price:5400, target_option_price:300, target_final_price:5700},
  {source_row_no:3, source_channel:'smartstore', source_file_name:'smart.xlsx', sellpia_sku_code:'1014-2', seller_product_code:'product-1', seller_option_code:'op2', field_key:'sellpia_sale_price', expected_source_value:9999, after_value:5700, target_base_price:5400, target_option_price:300, target_final_price:5700},
];
const smartGroupConflicts = [];
const smartPreflight = adapter.preflightSharedPriceGroups(smartGroupSheet, smartGroupItems, [], conflict => smartGroupConflicts.push(conflict));
assert.equal(smartPreflight.workingSheetXml, smartGroupSheet, 'Smartstore shared base must not change before the full option group passes verification');
assert.equal(smartGroupConflicts.length, 2, 'one conflicting Smartstore option must exclude the full shared-price group');
assert.equal(smartGroupItems.every(item => item._preflight_conflict), true);

const changedSmartRefs = [];
const changedSmartHighlights = [];
adapter.patchSmartstoreRow(smartRow, [
  {source_row_no:3, source_channel:'smartstore', sellpia_sku_code:'1014-2', seller_option_code:'op2', field_key:'sellpia_current_stock', expected_source_value:3, after_value:9},
  {source_row_no:3, source_channel:'smartstore', sellpia_sku_code:'1014-2', seller_option_code:'op2', field_key:'sellpia_sale_price', expected_source_value:5400, after_value:5700, target_base_price:5400, target_option_price:300, target_final_price:5700},
], [], null, (_, reference, highlight) => { changedSmartRefs.push(reference); changedSmartHighlights.push({reference, ...highlight}); });
assert.equal(JSON.stringify(changedSmartRefs), JSON.stringify(['S3',[{reference:'F3'},{reference:'R3',lineIndex:1}]]), 'Smartstore price writes must identify both the shared base cell and option line');
assert.equal(JSON.stringify(changedSmartHighlights), JSON.stringify([{reference:'S3',lineIndex:1},{reference:[{reference:'F3'},{reference:'R3',lineIndex:1}],lineIndex:null}]), 'Smartstore option changes must retain the modified line index');

const styleFixture = '<?xml version="1.0"?><styleSheet><fonts count="2"><font><name val="Arial"/><sz val="10"/></font><font><b/><name val="Arial"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="2"><border/><border><left style="thin"/></border></borders><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="4" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="right"/></xf></cellXfs></styleSheet>';
const sheetFixture = '<worksheet><sheetData><row r="3"><c r="F3" s="1"><v>5200</v></c><c r="G3" s="1"><v>untouched</v></c><c r="S3"><v>9</v></c></row></sheetData></worksheet>';
const highlighted = adapter.applyChangeHighlights(sheetFixture, styleFixture, ['F3','S3']);
assert.match(highlighted.stylesXml, /<fills count="3">[\s\S]*?fgColor rgb="FFFFFF00"/, 'review highlighting must add a fluorescent yellow fill');
assert.match(highlighted.stylesXml, /<fonts count="3">[\s\S]*?<font><b\/><name val="Arial"\/><sz val="10"\/><\/font>/, 'review highlighting must add a bold version of the original font');
assert.match(highlighted.stylesXml, /<cellXfs count="4">/, 'one highlighted style must be derived for each original cell style');
assert.match(highlighted.stylesXml, /<xf (?=[^>]*numFmtId="4")(?=[^>]*fontId="2")(?=[^>]*fillId="2")(?=[^>]*borderId="1")(?=[^>]*applyAlignment="1")(?=[^>]*applyFont="1")(?=[^>]*applyFill="1")[^>]*><alignment horizontal="right"\/><\/xf>/, 'highlighting must preserve number format, border, and alignment');
assert.match(highlighted.sheetXml, /<c r="F3" s="2">/, 'a changed styled cell must point to its derived review style');
assert.match(highlighted.sheetXml, /<c r="S3" s="3">/, 'a changed unstyled cell must point to a derived default review style');
assert.match(highlighted.sheetXml, /<c r="G3" s="1">/, 'an untouched cell must keep its original style');
assert.match(adapterSource, /highlights=remapHighlights\(appliedHighlights,result\.rowMap\)/, 'changed-only export must remap original cell references to compacted rows');
assert.match(adapterSource, /applyChangeHighlights\(scoped,stylesXml,highlights\)/, 'the XLSX export path must highlight the successfully applied compacted cells');

const multilineSheetFixture = '<worksheet><sheetData><row r="3"><c r="S3" t="inlineStr"><is><t xml:space="preserve">2\n9</t></is></c></row></sheetData></worksheet>';
const multilineHighlighted = adapter.applyChangeHighlights(multilineSheetFixture, styleFixture, [{reference:'S3',lineIndex:1}]);
assert.match(multilineHighlighted.sheetXml, /<c r="S3" t="inlineStr" s="2"><is><r><t xml:space="preserve">2\n<\/t><\/r><r><rPr><b\/><\/rPr><t xml:space="preserve">9<\/t><\/r><\/is><\/c>/, 'only the modified Smartstore line must be bold rich text');
assert.match(multilineHighlighted.stylesXml, /<fonts count="2">/, 'partial rich text highlighting must not create a whole-cell bold font');
assert.match(multilineHighlighted.stylesXml, /<cellXfs count="3">[\s\S]*?<xf (?=[^>]*fontId="0")(?=[^>]*fillId="2")(?=[^>]*applyFill="1")[^>]*\/>/, 'partial rich text highlighting must keep the base font and add only the yellow fill');

const actualSmartstoreEntityRow = '<row r="710"><c r="P710" s="65" t="inlineStr"><is><t>57894360638&#xa;57894360640&#xa;57894360641</t></is></c><c r="S710" s="65" t="inlineStr"><is><t>100&#xa;99&#xa;100</t></is></c></row>';
assert.equal(adapter.cellValue(actualSmartstoreEntityRow, 'P710', []), '57894360638\n57894360640\n57894360641', 'real Smartstore OOXML line-break entities must decode consistently');
let actualSmartstoreHighlight = null;
const actualEntityPatched = adapter.patchSmartstoreRow(actualSmartstoreEntityRow, [
  {source_row_no:710, source_channel:'smartstore', sellpia_sku_code:'10784-103', seller_option_code:'57894360640', field_key:'sellpia_current_stock', expected_source_value:99, after_value:100},
], [], null, (_, reference, highlight) => { actualSmartstoreHighlight = {reference, ...highlight}; });
assert.equal(adapter.cellValue(actualEntityPatched, 'S710', []), '100\n100\n100', 'the actual Smartstore option line must be updated');
const actualEntityHighlighted = adapter.applyChangeHighlights(`<worksheet><sheetData>${actualEntityPatched}</sheetData></worksheet>`, styleFixture, [actualSmartstoreHighlight]);
assert.match(actualEntityHighlighted.stylesXml, /fgColor rgb="FFFFFF00"/, 'an actual Smartstore entity-backed changed cell must receive the yellow fill');
assert.match(actualEntityHighlighted.sheetXml, /<r><rPr><b\/><\/rPr><t xml:space="preserve">100\n<\/t><\/r>/, 'only the actual changed Smartstore option line must be bold');

const wholeTextSheetFixture = '<worksheet><sheetData><row r="3"><c r="D3" t="inlineStr"><is><t xml:space="preserve">변경된\n상품명</t></is></c></row></sheetData></worksheet>';
const wholeTextHighlighted = adapter.applyChangeHighlights(wholeTextSheetFixture, styleFixture, [{reference:'D3',lineIndex:null}]);
assert.equal((wholeTextHighlighted.sheetXml.match(/<rPr><b\/><\/rPr>/g) || []).length, 2, 'a whole-value text change must bold every line of the changed value');

const makeRow = '<row r="4"><c r="AD4" t="inlineStr"><is><t>골드</t></is></c><c r="AF4"><v>200</v></c><c r="AG4"><v>3</v></c><c r="AR4"><v>425</v></c></row>';
const makePatched = adapter.patchMakeshopRow(makeRow, [
  {source_row_no:4, source_channel:'makeshop', sellpia_sku_code:'1014-2', seller_option_code:'425', field_key:'sellpia_current_stock', expected_source_value:3, after_value:8},
  {source_row_no:4, source_channel:'makeshop', sellpia_sku_code:'1014-2', seller_option_code:'425', field_key:'sellpia_sale_price', expected_source_value:5400, after_value:5600, base_price:5200, option_price:200, target_base_price:5300, target_option_price:300, target_final_price:5600, _product_row_no:2},
], []);
assert.equal(adapter.cellValue(makePatched, 'AG4', []), '8');
assert.equal(adapter.cellValue(makePatched, 'AF4', []), '300');
assert.equal(adapter.outputName('원본.xlsx'), '원본_SystemV3반영.xlsx');

const makeProductRow = '<row r="2"><c r="E2" t="inlineStr"><is><t>product-1</t></is></c><c r="U2" t="inlineStr"><is><t>골드</t></is></c><c r="V2" t="inlineStr"><is><t>200</t></is></c><c r="AS2"><v>5200</v></c></row>';
const makeGroupSheet = `<worksheet><sheetData>${makeProductRow}${makeRow}</sheetData></worksheet>`;
const makeGroupItems = [
  {source_row_no:4, source_channel:'makeshop', source_file_name:'make.xlsx', sellpia_sku_code:'1014-2', seller_product_code:'product-1', seller_option_code:'425', field_key:'sellpia_sale_price', expected_source_value:5400, after_value:5600, base_price:5200, option_price:200, target_base_price:5300, target_discounted_base_price:4770, target_option_price:830, target_final_price:5600,
    source_discount_terms:[], target_discount_terms:[{term_key:'period',rule_code:'M10',value:10,unit:'percent',rounding_mode:'down',rounding_unit:10},{term_key:'membership',value:5,unit:'percent',is_baseline:false}]},
];
const makePreflight = adapter.preflightSharedPriceGroups(makeGroupSheet, makeGroupItems, [], conflict => { throw new Error(conflict.reason); });
assert.equal(adapter.cellValue(makePreflight.workingSheetXml, 'AS2', []), '5300', 'MakeShop shared base changes only after every option in the group passes');
assert.equal(adapter.cellValue(makePreflight.workingSheetXml, 'DD2', []), '10% 십원절사', 'MakeShop period code must export its percent and rounding rule together');
assert.equal(adapter.cellValue(makePreflight.workingSheetXml, 'AT2', []), '5', 'MakeShop membership discount must be exported separately');
assert.equal(makeGroupItems[0]._product_row_no, 2);
assert.equal(adapter.discountTermsFingerprint([{value:10,term_key:'period',unit:'percent'},{term_key:'membership',value:5}]), adapter.discountTermsFingerprint([{value:5,term_key:'membership'},{unit:'percent',term_key:'period',value:10}]), 'term and object-key order must not create a false discount change');
const discountAudit = adapter.auditCsv(makeGroupItems);
assert.match(discountAudit, /할인코드/);
assert.match(discountAudit, /M10/, 'the audit file must retain the operator-facing MakeShop code');

const conflicts = [];
const applied = [];
const partialMakePatched = adapter.patchMakeshopRow(makeRow, [
  {export_item_id:41, source_row_no:4, source_channel:'makeshop', sellpia_sku_code:'11334-1', seller_option_code:'425', field_key:'sellpia_current_stock', expected_source_value:102, after_value:100},
  {export_item_id:42, source_row_no:4, source_channel:'makeshop', sellpia_sku_code:'1014-2', seller_option_code:'425', field_key:'sellpia_sale_price', expected_source_value:5400, after_value:5600, base_price:5200, option_price:200, target_base_price:5300, target_option_price:300, target_final_price:5600, _product_row_no:2},
], [], conflict => conflicts.push(conflict), item => applied.push(item));
assert.equal(adapter.cellValue(partialMakePatched, 'AG4', []), '3', 'a conflicting stock item must leave the original cell untouched');
assert.equal(adapter.cellValue(partialMakePatched, 'AF4', []), '300', 'a valid sibling item must still be applied');
assert.equal(conflicts.length, 1, 'only the conflicting item must be skipped');
assert.equal(conflicts[0].item.export_item_id, 41);
assert.equal(applied.length, 1);

console.log('Operations hub seller original export and inventory reconciliation: passed');
