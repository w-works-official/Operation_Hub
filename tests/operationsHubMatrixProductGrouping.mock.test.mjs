import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../mockups/operations-hub/app.js', import.meta.url), 'utf8');
const data = fs.readFileSync(new URL('../mockups/operations-hub/data-service.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../mockups/operations-hub/style.css', import.meta.url), 'utf8');

assert.match(app, /function sellpiaProductGroupKey\(product\)[\s\S]*?sellpia_product_code[\s\S]*?replace\(\/-\\d\+\$\//, 'Sellpia product groups must prefer the DB product code and retain a SKU-prefix fallback');
assert.match(app, /function renderLiveMatrixRows\(products\)[\s\S]*?product-group-start[\s\S]*?data-product-group/, 'matrix rows must expose the product-group boundary');
assert.match(css, /product-group-start:not\(:first-child\)>td\{border-top:3px solid/, 'product groups must have a thick visual separator');
assert.match(app, /function buildSellerBaseMerges\(products\)[\s\S]*?sellerBaseMergeSignature[\s\S]*?rowspan[\s\S]*?hidden:true/, 'seller base prices must merge only when the price signature is compatible');
assert.match(app, /function buildProductIdentityMerges\(products\)[\s\S]*?sources = \['smartstore', 'makeshop', 'ably'\][\s\S]*?rowspan[\s\S]*?hidden:true/, 'seller product codes and names must merge vertically while SKU option rows stay separate');
assert.match(app, /sellpia-sku-col sellpia-code-cell[\s\S]*?sellpia-name-col sellpia-text-cell[\s\S]*?sellpia-option-name-col sellpia-text-cell[\s\S]*?own-code-col[\s\S]*?sellpia_own_code/, 'Sellpia SKU, product name, option name, and own code must remain four separate per-SKU cells');
assert.doesNotMatch(app, /sellpiaProductMerge|sellpiaProductCell/, 'Sellpia identity cells must not be vertically merged');
assert.match(app, /sellerIdentityCells\(product, prefix, label, state, identityMerge, relationBadge\)/, 'seller product identity merges must not merge seller option identities');
assert.match(css, /sellpia-code-cell,\.matrix-table \.sellpia-text-cell,\.matrix-table \.own-code-col\{text-align:center;vertical-align:middle\}/, 'Sellpia identity cells must share centered alignment');
assert.match(css, /product-cell b,[\s\S]*?option-cell b,[\s\S]*?mapping-code-button\{[\s\S]*?font-size:12px[\s\S]*?product-cell em,[\s\S]*?option-cell em,[\s\S]*?seller-identity-cell>em\{[\s\S]*?font-size:10px/, 'product and option codes and names must use one readable primary and secondary text scale');
assert.match(css, /sellpia-text-cell span\{[\s\S]*?color:#111827[\s\S]*?product-cell em,[\s\S]*?option-cell em,[\s\S]*?seller-identity-cell>em\{color:#111827/, 'Sellpia and seller product and option names must render in a dark readable color');
assert.match(app, /seller-name-missing[\s\S]*?상품명 없음[\s\S]*?seller-name-missing[\s\S]*?옵션명 없음/, 'missing seller product and option names must carry an explicit subdued state');
assert.match(css, /seller-identity-cell>em\.seller-name-missing\{color:#a0a9b5;font-weight:600\}/, 'missing seller names must render as quiet gray secondary text');
assert.match(app, /seller-option-identity[\s\S]*?relationBadge/, 'multi-link relation badges must move with option identity when status columns are hidden');
assert.match(app, /seller-base-merged-cell[\s\S]*?data-seller-product-code[\s\S]*?data-group-size/, 'merged seller base-price cells must carry their bulk-save identity');
assert.match(app, /function matrixCellGrid\(\)[\s\S]*?cell\.rowSpan[\s\S]*?grid\[rowIndex \+ rowOffset\]/, 'cell selection must expand rowspans into a logical matrix grid');
assert.match(app, /function indexMatrixBodyColumns\(\)[\s\S]*?cell\.dataset\.matrixColumn[\s\S]*?grid\[rowIndex \+ rowOffset\]/, 'column visibility must index logical columns across merged seller price cells');
assert.match(app, /function applyColumnVisibility\([\s\S]*?data-matrix-column/, 'column visibility must target logical column identities instead of DOM positions');
assert.doesNotMatch(app, /td:nth-child\(\$\{index\}\)/, 'merged seller price rows must not shift columns through nth-child visibility rules');
assert.match(data, /async function saveSellerProductBaseDrafts\([\s\S]*?operations_hub_matrix_cached[\s\S]*?saveSellerPriceDraft/, 'editing a merged seller base price must save every linked option while preserving option prices');
assert.match(data, /async function loadRulePlatformSiblings\([\s\S]*?from\('operations_hub_matrix_cached'\)[\s\S]*?from\('operations_hub_matrix_cached'\)/, 'formula materialization must expand seller siblings from the fast matrix cache instead of the managed live view');
assert.match(app, /saveSellerProductBaseDrafts\([\s\S]*?groupResult\.items[\s\S]*?applyLocalSellerPriceDraft/, 'bulk base-price results must update visible matrix rows without a manual refresh');

console.log('Operations hub product grouping and seller base-price merge contract: passed');
