import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../mockups/operations-hub/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../mockups/operations-hub/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../mockups/operations-hub/style.css', import.meta.url), 'utf8');
const data = fs.readFileSync(new URL('../mockups/operations-hub/data-service.js', import.meta.url), 'utf8');
const parser = fs.readFileSync(new URL('../mockups/operations-hub/seller-source-parsers.js', import.meta.url), 'utf8');
const csv = fs.readFileSync(new URL('../mockups/operations-hub/matrix-csv-export.js', import.meta.url), 'utf8');
const schema = fs.readFileSync(new URL('../supabase/migrations/20260821014626_operations_hub_seller_price_components.sql', import.meta.url), 'utf8');
const schemaV2 = fs.readFileSync(new URL('../supabase/migrations/20260821110000_operations_hub_seller_discount_terms_v2.sql', import.meta.url), 'utf8');
const exporter = fs.readFileSync(new URL('../supabase/migrations/20260821020657_operations_hub_export_price_components.sql', import.meta.url), 'utf8');

assert.equal((html.match(/<th>판매가<\/th><th>할인정보<\/th><th>옵션가<\/th><th>최종구매가<\/th>/g) || []).length, 3, 'every seller group must expose discount information between base, option, and final customer prices');
assert.match(app, /priceComponent\.source_base_price[\s\S]*?priceComponent\.source_option_price[\s\S]*?priceComponent\.source_final_price/, 'matrix rows must read all three source components');
assert.match(app, /const discountContent[\s\S]*?discountView\.hasDiscount \? '할인' : '-'[\s\S]*?formatNullableNumber\(effectiveDiscountedBasePrice\)[\s\S]*?const discountCell/, 'compact matrix must preserve the dedicated discount cell and effective discounted price');
assert.match(app, /title="\$\{escapeHtml\(discountView\.detail\)\}[\s\S]*?할인 적용 판매가/, 'full discount conditions and applied price remain available in the tooltip');
assert.match(app, /function matrixDiscountSummary[\s\S]*?판매처 할인가[\s\S]*?조건부/, 'matrix discount summaries must preserve marketplace-reported and conditional discounts');
assert.match(app, /data-price-component="base"[\s\S]*?data-price-component="option"[\s\S]*?data-price-component="final"/, 'matrix base, option, and final prices must be directly editable');
assert.match(app, /class="seller-base-cell"[\s\S]*?data-price-component="base"[\s\S]*?data-price-edit[\s\S]*?>수정<\/button>/, 'seller base prices must expose a hover edit trigger');
assert.match(app, /data-price-edit[\s\S]*?openMatrixInlineEditor\(editable\)[\s\S]*?function openMatrixInlineEditor/, 'the sale-price edit trigger must open the existing inline editor with one click');
assert.match(css, /price-edit-trigger\{[\s\S]*?opacity:0[\s\S]*?seller-base-cell:hover>\.price-edit-trigger[\s\S]*?opacity:1/, 'sale-price edit controls must appear only on hover or keyboard focus');
assert.match(app, /data-drawer-price-component="base"[\s\S]*?data-drawer-discounted-base[\s\S]*?data-drawer-price-component="option"[\s\S]*?data-drawer-price-component="final"[\s\S]*?원본 할인 적용/, 'drawer must expose base, native-discounted base, option, and final customer price');
assert.match(app, /targetBasePrice:priceComponent === 'base'[\s\S]*?inputMode:priceComponent === 'final' \? 'final' : 'option'/, 'inline edits must choose the V2 option-driven or final-driven calculation path');
assert.match(app, /saveSellerPriceDraft\([\s\S]*?targetBasePrice[\s\S]*?inputMode[\s\S]*?targetFinalPrice[\s\S]*?optionPrice/, 'frontend price writes must persist every V2 component atomically');
assert.doesNotMatch(app.slice(app.indexOf('async function flushPendingSellpiaChanges'), app.indexOf('function editableMatrixGrid')), /refreshLiveData\(/, 'Sellpia autosave must not reload the full matrix');
assert.match(data, /load_operations_hub_seller_price_components[\s\S]*?save_operations_hub_seller_price_draft/, 'data service must expose component load and save RPCs');
assert.match(parser, /priceFields\(fields,[\s\S]*?base_price:[\s\S]*?option_price:[\s\S]*?discounted_base_price:[\s\S]*?final_price:/, 'seller parsers must persist source base, native-discounted base, option, and final price components');
assert.match(csv, /function sellerDiscountInformation[\s\S]*?적용가/, 'matrix CSV must serialize the effective discounted price');
assert.match(csv, /discount_information[\s\S]*?할인정보[\s\S]*?sellerDiscountInformation/, 'matrix CSV must expose a marketplace discount-information column');
assert.match(schema, /v_target_base := p_target_final_price - v_target_option[\s\S]*?price_base_after[\s\S]*?price_option_after[\s\S]*?price_final_after/, 'database drafts must derive and persist every component');
assert.match(schemaV2, /save_operations_hub_seller_price_draft_v2[\s\S]*?v_target_discounted[\s\S]*?p_input_mode = 'option'[\s\S]*?v_target_option := v_target_final - v_target_discounted/, 'V2 drafts must apply native discounts before deriving option or final price');
assert.match(exporter, /target_base_price[\s\S]*?target_option_price[\s\S]*?target_final_price[\s\S]*?같은 상품의 옵션별 목표 판매가/, 'export preparation must include the three targets and shared-base validation');

console.log('Operations hub seller price component workflow: passed');
