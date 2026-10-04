import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(
  new URL('../supabase/migrations/20260821110000_operations_hub_seller_discount_terms_v2.sql', import.meta.url),
  'utf8'
);
const exportBridge = fs.readFileSync(
  new URL('../supabase/migrations/20260821113000_operations_hub_export_discount_bridge_v2.sql', import.meta.url),
  'utf8'
);
const exportAdapter = fs.readFileSync(
  new URL('../mockups/operations-hub/seller-export-adapter.js', import.meta.url),
  'utf8'
);
const editableDiscounts = fs.readFileSync(
  new URL('../supabase/migrations/20260821190000_operations_hub_editable_seller_discounts.sql', import.meta.url),
  'utf8'
);
const productDiscountEditor = fs.readFileSync(
  new URL('../supabase/migrations/20260824033753_operations_hub_product_discount_editor.sql', import.meta.url),
  'utf8'
);
const discountAnchor = fs.readFileSync(
  new URL('../supabase/migrations/20260824043243_preserve_target_price_when_editing_discounts.sql', import.meta.url),
  'utf8'
);
const tagGatedDiscount = fs.readFileSync(
  new URL('../supabase/migrations/20260824082310_production_price_rules_and_tag_gated_discounts.sql', import.meta.url),
  'utf8'
);
const partialAssignmentCleanup = fs.readFileSync(
  new URL('../supabase/migrations/20260824082536_remove_partial_production_price_rule_assignments.sql', import.meta.url),
  'utf8'
);
const splitTags = fs.readFileSync(
  new URL('../supabase/migrations/20260825043000_split_price_and_discount_rule_tags.sql', import.meta.url),
  'utf8'
);
const calculationMode = fs.readFileSync(
  new URL('../supabase/migrations/20260906151217_operations_hub_discount_calculation_mode_v1.sql', import.meta.url),
  'utf8'
);
const app = fs.readFileSync(new URL('../mockups/operations-hub/app.js', import.meta.url), 'utf8');
const dataService = fs.readFileSync(new URL('../mockups/operations-hub/data-service.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../mockups/operations-hub/index.html', import.meta.url), 'utf8');

assert.match(migration, /discount_terms jsonb[\s\S]*?discounted_base_price numeric[\s\S]*?source_discount_fingerprint/, 'source discount terms and derived prices must be durable');
assert.match(migration, /price_calculation_version[\s\S]*?pricing_input_mode[\s\S]*?legacy_final/, 'existing V1 drafts must be distinguishable from V2 drafts');
assert.match(migration, /calculate_operations_hub_discounted_base[\s\S]*?is_baseline[\s\S]*?percent[\s\S]*?amount[\s\S]*?rounding_mode/, 'native discount calculation must ignore conditional terms and retain rounding');
assert.match(migration, /v_price_selected[\s\S]*?v_discount_selected[\s\S]*?previous_row\.discount_terms/, 'partial uploads must preserve unselected price and discount fields independently');
assert.match(migration, /save_operations_hub_seller_price_draft_v2[\s\S]*?p_input_mode[\s\S]*?if p_input_mode = 'option'[\s\S]*?v_target_final := v_target_discounted \+ v_target_option[\s\S]*?v_target_option := v_target_final - v_target_discounted/, 'V2 must support option-driven and final-driven input modes');
assert.match(migration, /price_discounted_base_before[\s\S]*?price_discounted_base_after[\s\S]*?source_snapshot_id[\s\S]*?source_discount_fingerprint/, 'drafts must be auditable against the exact source discount snapshot');
assert.doesNotMatch(migration, /drop function if exists public\.save_operations_hub_seller_price_draft\(/, 'V1 save RPC must remain available while old clients and drafts exist');
assert.match(exportBridge, /target_discounted_base_price[\s\S]*?price_calculation_version[\s\S]*?pricing_input_mode/, 'existing export preparation must be enriched with V2 price components');
assert.match(exportBridge, /source_discount_fingerprint is distinct from[\s\S]*?price_base_before is distinct from[\s\S]*?price_option_before is distinct from[\s\S]*?price_final_before is distinct from/, 'V2 export must block source prices or discounts that changed after review');
assert.match(exportAdapter, /smartstoreDiscountedBase[\s\S]*?`BF\$\{row\}`[\s\S]*?`BG\$\{row\}`/, 'Smartstore export verification must use its native discount value and unit');
assert.match(exportAdapter, /makeshopDiscountedBase[\s\S]*?`DD\$\{row\}`[\s\S]*?roundingMode/, 'MakeShop export verification must use its saved discount expression and rounding mode');
assert.match(exportAdapter, /row\[4\]=targets\.base;[\s\S]*?row\[5\]=targets\.discountedBase;[\s\S]*?row\[6\]=targets\.finalPrice;/, 'Ably export must preserve base, discounted, and customer-final price columns separately');
assert.match(editableDiscounts, /price_discount_terms_before jsonb[\s\S]*?price_discount_terms_after jsonb[\s\S]*?save_operations_hub_seller_discount_draft/, 'edited discount terms must remain durable in the reviewed price draft');
assert.match(editableDiscounts, /target_discount_terms[\s\S]*?source_discount_fingerprint is distinct from/, 'export items must carry reviewed discount terms while retaining stale-source protection');
assert.match(productDiscountEditor, /save_operations_hub_seller_product_discount_draft[\s\S]*?security invoker[\s\S]*?for v_item in[\s\S]*?save_operations_hub_seller_discount_draft/, 'one product RPC must save every connected option in one invoker transaction');
assert.doesNotMatch(productDiscountEditor, /security definer/i, 'product discount editing must not bypass the caller RLS context');
assert.match(productDiscountEditor, /smartstore[\s\S]*?term ->> 'unit' <> 'amount'/, 'Smartstore basic discounts must be validated as fixed won amounts');
for (const code of ['NONE','M10','M15','M20']) assert.match(productDiscountEditor, new RegExp(`'${code}'`), `MakeShop code ${code} must be validated server-side`);
assert.match(productDiscountEditor, /affected_sku_count[\s\S]*?v_batch_id uuid :=[\s\S]*?v_batch_id/, 'all option drafts must share one batch and report the affected product size');
assert.match(discountAnchor, /gross_operations_hub_discount_base[\s\S]*?calculate_operations_hub_discounted_base[\s\S]*?v_result <> v_target/, 'discount editing must gross up a whole-won base price to the anchored discounted price');
assert.match(discountAnchor, /v_valid_count = 0[\s\S]*?원본에 상품코드[\s\S]*?v_valid_count <> v_count/, 'product discount saves must preflight every linked option against the latest seller source');
assert.match(tagGatedDiscount, /PROD_SET_SAME[\s\S]*?PROD_SET_ADD_200[\s\S]*?PROD_SET_ADD_500[\s\S]*?PROD_SET_SMART_14K_ADD_4000/, 'production fixed-add price rules must be seeded by stable codes');
assert.match(tagGatedDiscount, /bool_and\(match_tier='MANUAL_LINKED'\)[\s\S]*?product_evidence\.min_difference=product_evidence\.max_difference/, 'automatic assignment must require manual links and one uniform product-wide difference');
assert.match(tagGatedDiscount, /v_assignment_count not in \(0, v_count\)[\s\S]*?v_assignment_rule_count > 1/, 'partial or mixed product price tags must block discount edits atomically');
assert.match(tagGatedDiscount, /price_rule_set_id=case when v_has_price_rule then v_rule_set_id else null end[\s\S]*?가격 태그 없음 · 판매가 유지/, 'saved drafts must preserve price-rule provenance and explicitly mark the untagged policy');
assert.match(partialAssignmentCleanup, /assigned_skus<>total_skus[\s\S]*?assigned_rules<>1[\s\S]*?set is_active=false/, 'partial or mixed automatic assignments must be removed from the entire seller product');
assert.match(calculationMode, /p_calculation_mode text default 'forward'[\s\S]*?v_mode not in \('forward', 'reverse-base'\)/, 'the product discount RPC must expose explicit forward and reverse-base modes');
assert.match(calculationMode, /for v_item in[\s\S]*?save_operations_hub_seller_discount_draft\([\s\S]*?case when v_mode = 'reverse-base' then 'discount_anchor' else 'option' end/, 'both modes must save every product option in one transaction using the audited single-SKU price engine');
assert.match(calculationMode, /security invoker[\s\S]*?revoke all[\s\S]*?grant execute/, 'the calculation-mode wrapper must retain caller permissions and explicit Data API grants');
assert.doesNotMatch(calculationMode, /security definer/i, 'the calculation-mode wrapper must not bypass RLS');
assert.match(dataService, /normalizedSource !== 'ably'[\s\S]*?save_operations_hub_seller_product_discount_mode_v1[\s\S]*?p_calculation_mode/, 'Smartstore and MakeShop product discounts must pass the selected calculation mode to the atomic RPC');
assert.match(dataService, /normalizedSource !== 'ably'[\s\S]*?operations_hub_matrix_cached[\s\S]*?saveSellerDiscountDraft/, 'Ably must retain the existing per-SKU fanout path');
assert.match(html, /id="discount-editor-modal"[\s\S]*?id="discount-editor-amount"[\s\S]*?<b>원<\/b>[\s\S]*?value="M10"[\s\S]*?value="M15"[\s\S]*?value="M20"/, 'the matrix editor must expose Smartstore won input and MakeShop code choices');
assert.match(html, /name="discount-calculation-mode" value="forward"[\s\S]*?name="discount-calculation-mode" value="reverse-base"[\s\S]*?최종판가 유지[\s\S]*?판매가 역산/, 'the discount editor must let the operator choose forward pricing or final-price-preserving inversion');
assert.match(html, /discount-price-math\.js[\s\S]*?data-service\.js[\s\S]*?app\.js/, 'native discount preview math must load before the application');
assert.match(html, /discount-editor-anchor-source[\s\S]*?discount-editor-anchor-price-label[\s\S]*?discount-editor-preview-label/, 'the editor must explain whether the tag target or current seller base is being preserved');
assert.match(app, /prefix === 'ably' \? discountContent[\s\S]*?data-discount-edit/, 'only Smartstore and MakeShop discount cells may expose the direct edit button');
assert.match(app, /matrixBody\.addEventListener\('mousedown'[\s\S]*?\[data-discount-edit\]/, 'discount edit buttons must not be swallowed by matrix drag selection');
assert.match(app, /saveDiscountEditor[\s\S]*?saveSellerProductDiscountDrafts[\s\S]*?for \(const item of saved\.items\) applyLocalSellerPriceDraft/, 'the direct editor must persist and repaint every option result');
assert.match(app, /function updateDiscountCalculationMode[\s\S]*?value === 'reverse-base'[\s\S]*?updateDiscountEditorPreview/, 'the selected reverse-base mode must immediately refresh the price preview');
assert.match(app, /function updateDiscountEditorPreview[\s\S]*?autoAdjustBase[\s\S]*?grossBaseForTarget[\s\S]*?판매가를[\s\S]*?역산/, 'the reverse preview must solve the gross sale price while the forward preview keeps the current base');
assert.match(app, /saveSellerProductDiscountDrafts\([\s\S]*?calculationMode:discountEditorState\.autoAdjustBase \? 'reverse-base' : 'forward'/, 'the selected preview mode must be persisted by the product-wide save');
assert.match(splitTags, /tag_role text not null default 'price'[\s\S]*?discount_source_channel[\s\S]*?discount_rule_code/, 'atomic tags must store their price or seller-discount role');
assert.match(splitTags, /calculate_operations_hub_price_rule_plan[\s\S]*?gross_price[\s\S]*?discounted_base_price[\s\S]*?discount_terms/, 'the rule plan must expose gross price and native discount results separately');
assert.match(splitTags, /save_operations_hub_seller_rule_draft[\s\S]*?price_calculation_version[\s\S]*?3, 'rule_tags'/, 'tag-driven seller drafts must persist exact gross, discount, option, and final components');
assert.match(app, /source === 'smartstore' \|\| source === 'makeshop'[\s\S]*?매트릭스 할인정보 열/, 'the drawer must route scoped discount changes to the matrix column');
const drawerPricing = app.slice(app.indexOf('function renderDrawerInventoryChannel('), app.indexOf('function renderDrawerInventory('));
assert.match(drawerPricing, /const calculated = product\?\.__hubRulePrices[\s\S]*?const priceDraft = product\?\.__sellerDrafts[\s\S]*?matrixVisibleValues\([\s\S]*?priceDraft[\s\S]*?calculatedPrice:calculated[\s\S]*?const savedDiscountTerms = visibleValues\.effectiveDiscountTerms/, 'the drawer must select effective discount terms through the shared draft-first matrix resolver');
assert.match(exportAdapter, /patchSmartstoreDiscounts[\s\S]*?'basic','BF','BG'[\s\S]*?'mobile','BH','BI'[\s\S]*?target_discount_terms/, 'Smartstore export must patch its original discount value and unit columns');
assert.match(exportAdapter, /canonicalDiscountTerms[\s\S]*?discountTermsFingerprint/, 'discount comparison must ignore term and object-key ordering');
assert.match(exportAdapter, /'할인코드'[\s\S]*?discountRuleCode/, 'the export audit CSV must include the MakeShop discount code');

console.log('Operations hub seller discount pricing V2 contract: passed');
