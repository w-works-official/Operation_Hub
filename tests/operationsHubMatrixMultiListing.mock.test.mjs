import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const helperSource = fs.readFileSync(new URL('../mockups/operations-hub/matrix-multilisting.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../mockups/operations-hub/app.js', import.meta.url), 'utf8');
const data = fs.readFileSync(new URL('../mockups/operations-hub/data-service.js', import.meta.url), 'utf8');
const datasetSource = fs.readFileSync(new URL('../mockups/operations-hub/matrix-dataset.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../mockups/operations-hub/style.css', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../mockups/operations-hub/index.html', import.meta.url), 'utf8');

const context = {console, Intl};
context.globalThis = context;
vm.runInNewContext(helperSource, context);
const multi = context.HubMatrixMultilisting;

const row = (smartstore, makeshop, ably) => ({
  sellpia_sku_code:'SKU-A',
  __linkBadges:{
    smartstore:{listing_count:smartstore},
    makeshop:{listing_count:makeshop},
    ably:{listing_count:ably}
  }
});

assert.equal(multi.groupHeight(row(1, 1, 1)), 1, 'A: all single listings remain one row high');
assert.equal(multi.groupHeight(row(3, 1, 1)), 3, 'B: one multi-listing seller sets the group height');
assert.equal(multi.groupHeight(row(3, 2, 4)), 4, 'C: group height is max, never the Cartesian product');
assert.notEqual(multi.groupHeight(row(3, 2, 4)), 24, 'C: Cartesian expansion is forbidden');
assert.equal(multi.groupHeight(row(2, 0, 1)), 2, 'D: a missing seller does not add placeholder rows');

const projection = [
  {source_channel:'smartstore', product_code:'P-1', option_code:'O-1', product_name:'one', option_name:'red', sellpia_sku_code:'SKU-A', component_qty:1},
  {source_channel:'smartstore', product_code:'P-2', option_code:'O-2', product_name:'two', option_name:'blue', sellpia_sku_code:'SKU-A', component_qty:1},
  {source_channel:'smartstore', product_code:'P-1', option_code:'O-1', product_name:'duplicate edge', sellpia_sku_code:'SKU-A', component_qty:1},
  {source_channel:'makeshop', product_code:'M-1', option_code:'', sellpia_sku_code:'SKU-A', component_qty:1}
];
const inventory = [
  {source_channel:'smartstore', product_code:'P-1', option_code:'O-1', product_name:'판매처 상품 1', option_name:'빨강', stock:3, price:12000, sale_status:'판매중'},
  {source_channel:'smartstore', product_code:'P-2', option_code:'O-2', product_name:'판매처 상품 2', option_name:'파랑', stock:7, price:13500, sale_status:'판매중'},
  {source_channel:'makeshop', product_code:'M-1', option_code:'', product_name:'메이크샵 상품', stock:9, price:11900, sale_status:'판매중'}
];
const combined = multi.combine(projection, inventory).get('SKU-A');
assert.equal(combined.smartstore.length, 2, 'E: normal fan-out displays every distinct identity and deduplicates an identical edge');
assert.deepEqual(Array.from(combined.smartstore, item => item.product_code), ['P-1', 'P-2']);
assert.deepEqual(Array.from(combined.smartstore, item => item.stock), [3, 7], 'H: seller-specific values remain independent');
assert.equal(combined.makeshop.length, 1);
assert.equal(combined.ably.length, 0);

const rows = [row(1, 1, 1), row(3, 1, 1), row(3, 2, 4), row(2, 0, 1)];
const layout = multi.virtualLayout(rows, 72);
assert.deepEqual(Array.from(layout.offsets), [0, 72, 288, 576, 720], 'variable-height virtualization uses SKU group heights');
const visible = multi.virtualRange(layout, 80, 180, 0);
assert.equal(JSON.stringify(visible), JSON.stringify({start:1, end:2, top:72, bottom:432}), 'viewport range keeps a multi-listing SKU group intact');

assert.match(data, /loadMatrixSellerListingsBySkus[\s\S]*?operations_hub_listing_component_projection[\s\S]*?\.in\('sellpia_sku_code', skuChunk\)/, 'visible SKU identities must use a bounded batch query');
assert.match(data, /seller_inventory_latest[\s\S]*?\.in\('product_code', codeChunk\)/, 'seller values must be enriched in bounded seller batches');
assert.doesNotMatch(data.slice(data.indexOf('async function loadMatrixSellerListingsBySkus'), data.indexOf('async function attachLinkSuppressions')), /for \(const sku of skus\)[\s\S]*?\.rpc\(/, 'the viewport enrichment must not issue one RPC per SKU');
assert.match(data, /searchMatrixSellerListingSkus[\s\S]*?relationType:'all'[\s\S]*?component\?\.sku/, 'seller identity search must resolve matching groups back to Sellpia SKUs');
assert.match(app, /matrixMultiListingCells[\s\S]*?sellerListings\.length > 1/, 'single-listing rendering stays on the existing renderer');
assert.match(app, /matrixExpectedListingCount[\s\S]*?ensureMatrixSellerListings[\s\S]*?slice\(0,100\)/, 'only visible multi-listing groups are enriched in a bounded request');
assert.match(app, /targets\.forEach\(sku=>matrixSellerListingsCache\.delete\(sku\)\)[\s\S]*?matrixDataset\.patch/, 'J: targeted refresh invalidates listing detail before patching the SKU');
assert.match(app, /matrixVirtualLayout[\s\S]*?virtualRange[\s\S]*?rows\.slice\(start,end\)/, 'dynamic row height must preserve virtualized viewport rendering');
assert.match(app, /data-link-product-code[\s\S]*?data-link-option-code[\s\S]*?openListingLinkManager/, 'each visible identity opens the exact existing relation manager target');
assert.match(app, /__hubShadow\?\.\[prefix\]\?\.lookup === 'conflict'[\s\S]*?label:'충돌'/, 'F: inverse ambiguity remains visibly conflicted');
assert.match(app, /relationType === 'bundle'[\s\S]*?조합/, 'bundle/component rows remain visually distinct from normal 1:N fan-out');
assert.match(datasetSource, /sellerIdentitySkus[\s\S]*?identitySkus\.has\(r\.sellpia_sku_code\)/, 'I: seller identity search returns the whole SKU group');
assert.match(css, /matrix-multi-listing-row>td\{height:calc\(72px \* var\(--matrix-listing-rows\)\)/, 'SKU-level cells span the full visual group height');
assert.match(css, /matrix-listing-stack[\s\S]*?grid-auto-rows:72px/, 'seller identities render as independent vertical subrows');
assert.match(html, /matrix-multilisting\.js\?v=20261001-matrix-multilisting-v1[\s\S]*?data-service\.js/, 'the helper loads before the data adapter and app');

console.log('Operations Hub Matrix multi-listing row-group contract: passed');
