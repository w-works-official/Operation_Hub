import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {chromium} from 'playwright';

test('Matrix keeps one SKU row and expands seller identities vertically without a Cartesian product', async () => {
  const root = path.resolve('mockups/operations-hub');
  const server = http.createServer((req, res) => {
    const file = path.join(root, new URL(req.url, 'http://localhost').pathname);
    if (!file.startsWith(root) || !fs.existsSync(file)) return void res.writeHead(404).end();
    const ext = path.extname(file);
    res.setHeader('Content-Type', ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({channel:'msedge', headless:true});
  try {
    const page = await browser.newPage({viewport:{width:3000, height:1100}});
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://**/*', route => route.fulfill({contentType:'text/javascript', body:'window.supabase={createClient:()=>({rpc:async()=>({data:{}})})};'}));
    await page.addInitScript(() => {
      const details = {
        'SKU-MULTI':{
          smartstore:[1,2,3].map(i => ({product_code:`S-${i}`, option_code:`SO-${i}`, product_name:`스마트 상품 ${i}`, option_name:`스마트 옵션 ${i}`, stock:i, price:10000+i*100, sale_status:'판매중'})),
          makeshop:[1,2].map(i => ({product_code:`M-${i}`, option_code:`MO-${i}`, product_name:`메이크 상품 ${i}`, option_name:`메이크 옵션 ${i}`, stock:10+i, price:11000+i*100, sale_status:'판매중'})),
          ably:[1,2,3,4].map(i => ({product_code:`A-${i}`, option_code:`AO-${i}`, product_name:`에이블리 상품 ${i}`, option_name:`에이블리 옵션 ${i}`, stock:20+i, price:12000+i*100, sale_status:'판매중'}))
        }
      };
      const rows = [
        {sellpia_sku_code:'SKU-MULTI', sellpia_product_name:'다중연결 상품', sellpia_option_name:'기준 옵션', system_stock:8, system_base_price:9000, sellpia_source_stock:8, sellpia_source_sale_price:9000, smartstore_product_code:'S-1', smartstore_option_code:'SO-1', smartstore_listing_count:3, smartstore_match_tier:'EXACT', makeshop_product_code:'M-1', makeshop_option_code:'MO-1', makeshop_listing_count:2, makeshop_match_tier:'EXACT', ably_product_code:'A-1', ably_option_code:'AO-1', ably_listing_count:4, ably_match_tier:'EXACT', __linkBadges:{smartstore:{listing_count:3,relation_type:'multi'},makeshop:{listing_count:2,relation_type:'multi'},ably:{listing_count:4,relation_type:'multi'}}, __hubActivePriceRules:{smartstore:false,makeshop:false,ably:false}},
        {sellpia_sku_code:'SKU-SINGLE', sellpia_product_name:'단일연결 상품', sellpia_option_name:'단일 옵션', system_stock:3, system_base_price:5000, sellpia_source_stock:3, sellpia_source_sale_price:5000, smartstore_product_code:'ONLY-1', smartstore_option_code:'O-1', smartstore_listing_count:1, smartstore_match_tier:'EXACT', __linkBadges:{smartstore:{listing_count:1,relation_type:'single'}}, __hubActivePriceRules:{smartstore:false,makeshop:false,ably:false}}
      ];
      const expiresAt = new Date(Date.now() + 3600000).toISOString();
      sessionStorage.setItem('system-v3-operations-session-v1', JSON.stringify({token:'a'.repeat(64), expiresAt}));
      const data = {
        mode:'live', pageSize:200, setOperationsHubSessionToken:()=>{},
        checkOperationsHubSession:async()=>({authenticated:true, expiresAt}), loginOperationsHub:async()=>({authenticated:true, expiresAt}), logoutOperationsHub:async()=>{},
        loadFullMatrixDataset:async()=>({rows, count:rows.length, elapsed:1, metrics:{requests:1,bytes:1}}),
        loadMatrixSellerListingsBySkus:async skus=>new Map(skus.map(sku=>[sku, details[sku] || {smartstore:[],makeshop:[],ably:[]} ])),
        searchMatrixSellerListingSkus:async term=>term.includes('AO-4')?['SKU-MULTI']:[],
        loadProductsBySkus:async skus=>rows.filter(row=>skus.includes(row.sellpia_sku_code)),
        loadMappingSyncStatus:async()=>({}), loadSourceStatus:async()=>({events:[],latest:{}}), loadDashboardMetrics:async()=>({total_sku:rows.length}), loadTagCatalog:async()=>({rows:[]}), loadSellerInventoryPolicies:async()=>[], loadPresets:async()=>[]
      };
      const api = new Proxy(data, {get:(target,key)=>key in target?target[key]:async()=>({rows:[],count:0})});
      Object.defineProperty(window, 'SystemV3Data', {configurable:true, get:()=>api, set:()=>{}});
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
    await page.locator('[data-page="matching"]').first().click();
    await page.waitForFunction(() => document.querySelectorAll('#matrix-body tr[data-sku="SKU-MULTI"] .matrix-multi-listing-cell').length === 27);
    const multiRow = page.locator('#matrix-body tr[data-sku="SKU-MULTI"]');
    assert.equal(await multiRow.getAttribute('data-listing-rows'), '4');
    assert.equal(await multiRow.locator('td[data-channel="smartstore"] .matrix-listing-subrow').count(), 27, '3 identities × 9 seller columns');
    assert.equal(await multiRow.locator('td[data-channel="makeshop"] .matrix-listing-subrow').count(), 18, '2 identities × 9 seller columns');
    assert.equal(await multiRow.locator('td[data-channel="ably"] .matrix-listing-subrow').count(), 36, '4 identities × 9 seller columns');
    assert.equal(await multiRow.locator('.select-col .row-check').count(), 1, 'selection remains SKU-scoped');
    assert.ok((await multiRow.boundingBox()).height >= 280, 'multi-listing row expands to four visual subrows');
    const singleRow = page.locator('#matrix-body tr[data-sku="SKU-SINGLE"]');
    assert.equal(await singleRow.getAttribute('data-listing-rows'), '1');
    assert.ok((await singleRow.boundingBox()).height < 150, 'single-listing density remains compact');
    assert.equal(await multiRow.locator('[data-code-kind="product"][data-link-product-code="A-4"][data-link-option-code="AO-4"]').count(), 1, 'exact identity is carried into the existing manager action');
    await page.locator('#matrix-search').fill('AO-4');
    await page.waitForFunction(() => document.getElementById('matrix-total-count').textContent === '1');
    assert.equal(await page.locator('#matrix-body tr[data-sku]').count(), 1, 'seller identity search keeps the whole SKU group');
    assert.deepEqual(errors, []);
    await page.locator('#matrix-search').fill('');
    await page.waitForFunction(() => document.getElementById('matrix-total-count').textContent === '2');
    await page.locator('.matrix-shell').evaluate(element => { element.scrollLeft = 0; });
    await page.evaluate(() => { const toast=document.getElementById('toast'); if(toast)toast.style.display='none'; });
    fs.mkdirSync('outputs/ui-qa', {recursive:true});
    await page.screenshot({path:'outputs/ui-qa/matrix-multilisting-row-group.png', fullPage:true});
    await page.locator('.matrix-shell').evaluate(element => { element.scrollLeft = element.scrollWidth; });
    await page.screenshot({path:'outputs/ui-qa/matrix-multilisting-row-group-sellers-right.png', fullPage:true});
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
