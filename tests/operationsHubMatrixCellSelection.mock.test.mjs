import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../mockups/operations-hub/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../mockups/operations-hub/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../mockups/operations-hub/style.css', import.meta.url), 'utf8');

assert.doesNotMatch(html, /id="select-all-matrix"/, 'the matrix header must not expose row checkbox selection');
assert.match(css, /\.matrix-table \.select-col\{display:none\}/, 'legacy placeholder cells must remain visually removed');
assert.match(app, /function matrixCellGrid\(\)[\s\S]*?td:not\(\.select-col\)/, 'cell selection coordinates must ignore the removed checkbox column');
assert.match(app, /function selectedMatrixTargets\(\)[\s\S]*?matrixCellSelection\.selected[\s\S]*?selectedCells\.has\(cell\)[\s\S]*?cell\.dataset\.channel[\s\S]*?skus:\[\.\.\.skus\][\s\S]*?sourceSkus:Object\.fromEntries/, 'selected cells must resolve disjoint SKU rows, seller channels, and exact seller-SKU pairs');
assert.match(app, /const selectedTargets = selectedMatrixTargets\(\)[\s\S]*?selectedSkus = selectedTargets\.skus[\s\S]*?선택한 셀이 속한 SKU 행만 작업/, 'price-combination work must consume selected row SKUs regardless of the selected column');
assert.match(app, /data-channel="\$\{prefix\}"[\s\S]*?data-price-component="base"[\s\S]*?data-price-component="option"[\s\S]*?data-price-component="final"/, 'seller cells must carry their channel identity');
assert.match(app, /function selectedSourceRefreshTargets\(\)[\s\S]*?sellpia_source_stock[\s\S]*?sellpia_source_sale_price[\s\S]*?for \(const cell of matrixCellSelection\.selected\)[\s\S]*?system-master-cell/, 'source refresh must resolve only selected system stock and base-price cells, including selections outside the virtual viewport');
assert.doesNotMatch(html, /id="matrix-source-refresh-btn"/, 'source refresh must no longer occupy a permanent work-tool button');
assert.match(html, /id="matrix-context-menu"[\s\S]*?id="matrix-context-source-refresh"[\s\S]*?id="matrix-context-product-copy"[\s\S]*?id="matrix-context-option-add"[\s\S]*?id="matrix-context-price-basis"[\s\S]*?id="matrix-context-disconnect"/, 'the matrix must expose separate product-copy, later option-add, basis-price selection, refresh, and disconnect actions');
assert.match(app, /function updateSourceRefreshAction\(\)[\s\S]*?matrixContextSourceRefresh\.disabled[\s\S]*?matrixContextSourceRefreshCount\.textContent/, 'the right-click source refresh action must reflect the selected cells and save state');
assert.match(app, /matrixContextSourceRefresh\?\.addEventListener\('click'[\s\S]*?closeMatrixContextMenu\(\)[\s\S]*?refreshSelectedSystemValuesFromSource\(\)/, 'the context-menu source refresh action must close the menu and invoke the existing selected-cell persistence flow');
assert.match(app, /function matrixProductCopyContext\(anchorCell\)[\s\S]*?sellpiaProductGroupKey[\s\S]*?candidateCodes\.length > 1[\s\S]*?코드만 복제/, 'each product-code copy target must be limited to one unambiguous same-product candidate');
assert.match(app, /function selectedMatrixProductCopyContexts[\s\S]*?selectedMatrixTargets\(\)\.cells[\s\S]*?seller-product-code-cell[\s\S]*?targets\.push\(target\)[\s\S]*?개 행 · 상품코드만 복제/, 'all selected seller product-code cells must resolve into independent copy targets');
assert.match(app, /matrixContextProductCopy\?\.addEventListener\('click'[\s\S]*?targets = \[\.\.\.matrixContextProductCopyTargets\][\s\S]*?offset \+= 3[\s\S]*?Promise\.allSettled[\s\S]*?saveProductLinkDraft[\s\S]*?applyLocalProductLinkDraft[\s\S]*?refreshMatrixSkus\(skus\)[\s\S]*?옵션은 아직 연결되지 않았습니다/, 'multi-cell product-code copy must save every eligible row in bounded batches without immediately linking options');
assert.match(app, /function matrixOptionAddContext\(anchorCell\)[\s\S]*?__sellerProductLinkDrafts[\s\S]*?미연결 옵션만 보기[\s\S]*?matrixContextOptionAdd\?\.addEventListener\('click'[\s\S]*?openMappingSearch\(\{[\s\S]*?fixedProductCode:target\.productCode/, 'option addition must be a separate later action available only for a staged product code');
assert.match(app, /remainingOptionsMode[\s\S]*?옵션코드[\s\S]*?옵션명[\s\S]*?loadSellerProductOptions[\s\S]*?linked_skus[\s\S]*?length === 0/, 'fixed-product mode must show option identities and exclude options already linked to any SKU');
assert.match(app, /matrixBody\.addEventListener\('contextmenu'[\s\S]*?cell\.classList\.contains\('matrix-cell-selected'\)[\s\S]*?openMatrixContextMenu/, 'right-clicking an unselected matrix cell must select it before opening the work menu');
assert.match(app, /matrixCellSelection = \{[^}]*selected:new Set\(\)[^}]*dragBase:new Set\(\)[^}]*dragMode:'replace'/, 'matrix selection must retain a persistent set for non-contiguous cells');
assert.match(app, /const selectionModifier = event\.ctrlKey \|\| event\.metaKey[\s\S]*?selectMatrixCell\(cell, \{extend:event\.shiftKey, toggle:selectionModifier\}\)/, 'Ctrl or Command click must toggle a cell without replacing the existing selection');
assert.match(app, /matrixBody\.addEventListener\('click', event => \{[\s\S]*?\(event\.ctrlKey \|\| event\.metaKey\)[\s\S]*?closest\('td'\)[\s\S]*?return/, 'modified clicks on nested cell buttons must remain selection-only and not open another action');
assert.match(app, /function applyMatrixDragSelection[\s\S]*?dragMode === 'toggle'[\s\S]*?next\.has\(cell\) \? next\.delete\(cell\) : next\.add\(cell\)/, 'Ctrl drag must add or remove the dragged rectangle relative to the prior selection');
assert.match(html, /Ctrl\+클릭\/드래그로 떨어진 셀 추가·제거/, 'the matrix legend must explain non-contiguous add and remove controls');
assert.match(app, /function selectedMatrixDisconnectTargets\(\)[\s\S]*?selectedMatrixTargets\(\)[\s\S]*?selected\.sourceSkus[\s\S]*?productCode[\s\S]*?optionCode[\s\S]*?seen\.has\(key\)/, 'disconnect targets must resolve and deduplicate the exact seller listing tuple per Sellpia SKU');
assert.match(app, /function selectedMatrixDisconnectTargets\(\)[\s\S]*?__sellerProductLinkDrafts\?\.\[source\][\s\S]*?match_tier[^]*?continue/, 'product-code-only drafts must never be treated as real disconnectable links');
assert.match(app, /function resolveMatrixDisconnectComponentIds[\s\S]*?loadListingConnection[\s\S]*?components\.find[\s\S]*?componentId/, 'disconnect must load the exact listing graph and use an explicit component id when available');
assert.match(app, /function disconnectSelectedMatrixLinks[\s\S]*?같은 조합의 다른 구성 SKU는 유지됩니다[\s\S]*?offset \+= 3[\s\S]*?Promise\.allSettled[\s\S]*?removeListingComponent[\s\S]*?loadLiveMatrix\(\)/, 'bulk disconnect must confirm its scope, use bounded batches, preserve sibling components, and reload once');

console.log('Operations hub matrix cell selection contract: passed');
