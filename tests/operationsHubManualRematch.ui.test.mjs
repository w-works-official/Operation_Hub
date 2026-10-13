import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {chromium} from 'playwright';

const browserOptions = {
  headless:true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? {executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}
    : process.platform === 'win32' ? {channel:'msedge'} : {}),
};

async function startFixture() {
  const root = path.resolve('mockups/operations-hub');
  const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    const ext = path.extname(file);
    res.setHeader('Content-Type', ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {server, url:`http://127.0.0.1:${server.address().port}/index.html`};
}

async function installMappingFixture(page) {
  await page.route('https://**/*', route => route.fulfill({
    contentType:'text/javascript',
    body:'window.supabase={createClient:()=>({rpc:async()=>({data:{}})})};',
  }));
  await page.addInitScript(() => {
    const productCode = '10807677752';
    const base = (sku, overrides = {}) => ({
      sellpia_sku_code:sku, sellpia_product_name:'14K 큐빅 피어싱',
      sellpia_option_name:'골드 / 밀키 / 6mm', sellpia_product_code:'11017',
      system_stock:100, system_base_price:181000, sellpia_current_stock:100,
      sellpia_source_stock:100, sellpia_source_sale_price:181000,
      __hubActivePriceRules:{smartstore:false, makeshop:false, ably:false},
      ...overrides,
    });
    const link = (sku, optionCode = 'OLD-OPTION') => ({
      source_channel:'smartstore', sellpia_sku_code:sku, product_code:productCode,
      option_code:optionCode, product_name:'14K 스마트스토어 상품', option_name:'이전 옵션',
      mapping_origin:'manual', match_tier:'MANUAL_LINKED', match_score:100,
    });
    const rows = [
      // Compact Matrix can lose the display identity when the source option
      // has been deleted, although the official manual link still exists.
      base('11017-1'),
      base('11017-2'),
      base('11017-3', {smartstore_product_code:productCode, smartstore_option_code:'EXPLICIT-OLD', smartstore_match_tier:'EXACT', smartstore_listing_count:1}),
      base('11017-4', {smartstore_product_code:productCode, smartstore_option_code:'MULTI-A', smartstore_match_tier:'EXACT', smartstore_listing_count:2, __linkBadges:{smartstore:{listing_count:2, relation_type:'multi'}}}),
      base('11017-5', {smartstore_product_code:productCode, __sellerProductLinkDrafts:{smartstore:{source_channel:'smartstore',sellpia_sku_code:'11017-5',product_code:productCode}}}),
      base('11017-6', {__manualLinks:{smartstore:link('11017-6')}}),
      base('11017-7', {ably_product_code:'ABLY-01',ably_option_code:'A-01',ably_match_tier:'EXACT',ably_listing_count:1}),
    ];
    const fresh = new Map(rows.map(row => [row.sellpia_sku_code, structuredClone(row)]));
    for (const sku of ['11017-1','11017-2']) {
      const manual = link(sku);
      fresh.set(sku, base(sku, {
        smartstore_product_code:productCode, smartstore_option_code:manual.option_code,
        smartstore_match_tier:'MANUAL_LINKED', smartstore_listing_count:1,
        __manualLinks:{smartstore:manual},
      }));
    }
    const details = {
      '11017-3':{smartstore:[{product_code:productCode,option_code:'EXPLICIT-OLD',mapping_source:'explicit',product_name:'저장된 구성',stock:100,price:181000}],makeshop:[],ably:[]},
      '11017-4':{smartstore:['MULTI-A','MULTI-B'].map(option_code => ({product_code:productCode,option_code,mapping_source:'legacy',product_name:'다중 상품',option_name:option_code,stock:100,price:181000})), makeshop:[], ably:[]},
      '11017-7':{smartstore:[],makeshop:[],ably:[{product_code:'ABLY-01',option_code:'A-01',mapping_source:'verified_solution_code',product_name:'검증된 에이블리 상품',stock:100,price:181000}]},
    };
    const state = window.rematchFixture = {
      freshReads:[], searchCalls:[], optionCalls:[], connectionReads:[],
      manualWrites:[], draftWrites:[], componentWrites:[], disconnects:[],
      confirmations:[], confirmAnswer:false,
      deferFreshSku:'', resolveFresh:null, failFreshSku:'',
      deferWriteSku:'', resolveWrite:null, writeReleased:false,
      latestItems:[
        {product_code:productCode, option_code:'60372395148', product_name:'새 스마트스토어 상품', option_name:'골드 / 밀키 / 6mm', stock:100,price:181000,linked_skus:[]},
        {product_code:productCode, option_code:'60372395149', product_name:'새 스마트스토어 상품', option_name:'골드 / 밀키 / 8mm', stock:100,price:185500,linked_skus:['OTHER-SKU']},
      ],
    };
    window.confirm = message => {state.confirmations.push(message); return state.confirmAnswer;};
    const expiresAt = new Date(Date.now() + 3600000).toISOString();
    sessionStorage.setItem('system-v3-operations-session-v1', JSON.stringify({token:'a'.repeat(64),expiresAt}));
    const api = {
      mode:'live', pageSize:200, setOperationsHubSessionToken:()=>{},
      checkOperationsHubSession:async()=>({authenticated:true,expiresAt}),
      loginOperationsHub:async()=>({authenticated:true,expiresAt}), logoutOperationsHub:async()=>{},
      loadFullMatrixDataset:async()=>({rows:structuredClone(rows),count:rows.length,elapsed:1,metrics:{requests:1,bytes:1}}),
      loadProductsBySkus:async skus => {
        state.freshReads.push([...skus]);
        if (skus.includes(state.failFreshSku)) throw Error('연결 상세 조회 실패');
        const value = () => skus.map(sku=>structuredClone(fresh.get(sku))).filter(Boolean);
        if (skus.includes(state.deferFreshSku)) {
          state.deferFreshSku='';
          return await new Promise(resolve=>{state.resolveFresh=()=>{state.resolveFresh=null;resolve(value());};});
        }
        return value();
      },
      loadMatrixSellerListingsBySkus:async skus=>new Map(skus.map(sku=>[sku,structuredClone(details[sku] || {smartstore:[],makeshop:[],ably:[]})])),
      loadListingConnection:async args => {
        state.connectionReads.push(structuredClone(args));
        if (args.optionCode === 'EXPLICIT-OLD') return {source_channel:args.source,product_code:args.productCode,option_code:args.optionCode,is_explicit:true,components:[{componentId:31,sku:'11017-3',qty:1,role:'primary'}]};
        const sku = args.optionCode === 'OLD-OPTION' ? '11017-1' : args.optionCode === 'MULTI-A' ? '11017-4' : '';
        return sku ? {source_channel:args.source,product_code:args.productCode,option_code:args.optionCode,is_explicit:false,components:[{componentId:null,sku,qty:1,role:'primary'},...(args.optionCode==='OLD-OPTION'?[{componentId:null,sku:'OTHER-LEGACY',qty:1,role:'additional'}]:[])]} : null;
      },
      searchSellerItems:async (source,query,page,pageSize) => {state.searchCalls.push({source,query,page,pageSize});return {rows:structuredClone(state.latestItems),count:state.latestItems.length,page:1,pageSize};},
      loadSellerProductOptions:async (source,code) => {state.optionCalls.push({source,code});return structuredClone(state.latestItems);},
      linkSellerItem:async args => {
        state.manualWrites.push(structuredClone(args));
        const found = state.latestItems.find(item=>item.product_code===args.productCode&&item.option_code===args.optionCode);
        if (!found) throw Error('최신 원본에 없는 옵션');
        if (args.sku===state.deferWriteSku) {
          state.deferWriteSku='';
          await new Promise(resolve=>{state.resolveWrite=()=>{state.resolveWrite=null;state.writeReleased=true;resolve();};});
        }
        const committed = {...link(args.sku,args.optionCode),...found,sellpia_sku_code:args.sku,source_channel:args.source};
        const current = fresh.get(args.sku);
        fresh.set(args.sku,{...current,smartstore_product_code:args.productCode,smartstore_option_code:args.optionCode,__manualLinks:{smartstore:committed}});
        return structuredClone(committed);
      },
      saveProductLinkDraft:async args => {state.draftWrites.push(structuredClone(args));throw Error('실제 매칭을 상품코드 복제로 우회하면 안 됩니다');},
      linkProductDraftOption:async args => {state.draftWrites.push(structuredClone(args));return {...link(args.sku,args.optionCode),product_code:productCode};},
      saveListingComponent:async args => {state.componentWrites.push(structuredClone(args));},
      removeListingComponent:async args => {state.disconnects.push(structuredClone(args));},
      searchMatrixSellerListingSkus:async()=>[], loadMappingSyncStatus:async()=>({}),
      loadSourceStatus:async()=>({events:[],latest:{}}), loadDashboardMetrics:async()=>({total_sku:rows.length}),
      loadTagCatalog:async()=>({rows:[]}), loadSellerInventoryPolicies:async()=>[], loadPresets:async()=>[],
      loadPendingPurchasePriceRecalculations:async()=>({skus:[],pendingCount:0}),
      loadRelationNodes:async()=>({nodes:[],edges:[]}),loadRelationFolders:async()=>({folders:[],unorganizedExplicitCount:0}),listBundleGraph:async()=>({bundles:[],components:[]}),
      loadAblyInventoryMappings:async()=>({rows:[]}),
    };
    const data = new Proxy(api,{get:(target,key)=>key in target?target[key]:async()=>({rows:[],count:0})});
    Object.defineProperty(window,'SystemV3Data',{configurable:true,get:()=>data,set:()=>{}});
  });
}

function productButton(page, sku) {
  return page.locator(`#matrix-body tr[data-sku="${sku}"] [data-link-source="smartstore"][data-code-kind="product"]`).first();
}

async function openContext(page, sku, source='smartstore') {
  const cell = page.locator(`#matrix-body tr[data-sku="${sku}"] td[data-channel="${source}"]:is(.seller-product-code-cell,.seller-option-identity)`).first();
  await cell.scrollIntoViewIfNeeded();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await cell.click({button:'right'});
  await page.locator('#matrix-context-menu').waitFor({state:'visible'});
}

test('Manual rematch replaces a deleted source option through exact seller linking while retaining draft and composition boundaries', {timeout:90_000}, async () => {
  const {server,url} = await startFixture();
  const browser = await chromium.launch(browserOptions);
  try {
    const page = await browser.newPage({viewport:{width:2200,height:1200}});
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror',error=>errors.push(error.message));
    await installMappingFixture(page);
    await page.goto(url);
    await page.locator('[data-page="matching"]').first().click();
    await page.waitForFunction(()=>document.querySelectorAll('#matrix-body tr[data-sku]').length===7);

    // Closing while the authoritative read is pending cancels opening a new
    // picker. A failed fresh read must leave the existing mapping untouched.
    await page.evaluate(()=>{rematchFixture.deferFreshSku='11017-1';});
    await productButton(page,'11017-1').click();
    await page.locator('#listing-link-change').click();
    await page.waitForFunction(()=>Boolean(rematchFixture.resolveFresh));
    await page.locator('#listing-link-close').click();
    await page.evaluate(()=>rematchFixture.resolveFresh());
    await page.waitForFunction(()=>!document.getElementById('listing-link-change').disabled);
    assert.equal(await page.locator('#mapping-popover').isVisible(),false,'a delayed read cannot reopen after the operator closes the manager');
    assert.equal(await page.evaluate(()=>rematchFixture.searchCalls.length),0);
    await page.evaluate(()=>{rematchFixture.failFreshSku='11017-1';});
    await productButton(page,'11017-1').click();
    await page.locator('#listing-link-change').click();
    await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('연결 변경 준비 실패'));
    assert.equal(await page.locator('#mapping-popover').isVisible(),false,'failed fresh reads cannot offer an unvalidated write path');
    assert.equal(await page.evaluate(()=>rematchFixture.manualWrites.length+rematchFixture.draftWrites.length+rematchFixture.disconnects.length),0);
    await page.locator('#listing-link-close').click();
    await page.evaluate(()=>{rematchFixture.failFreshSku='';});

    await page.evaluate(()=>{rematchFixture.deferFreshSku='11017-2';});
    await openContext(page,'11017-2');
    await page.locator('#matrix-context-link-change').click();
    await page.waitForFunction(()=>Boolean(rematchFixture.resolveFresh));
    await page.keyboard.press('Escape');
    await page.evaluate(()=>rematchFixture.resolveFresh());
    await page.waitForFunction(()=>!document.getElementById('matrix-context-link-change').disabled);
    assert.equal(await page.locator('#mapping-popover').isVisible(),false,'Escape cancels a context-menu rematch even while its fresh read is pending');
    assert.equal(await page.evaluate(()=>rematchFixture.searchCalls.length),0);

    await productButton(page,'11017-1').click();
    await page.locator('#listing-link-change').waitFor({state:'visible'});
    await page.locator('#listing-link-change').click();
    await page.locator('#mapping-popover').waitFor({state:'visible'});
    await page.locator('[data-map-option="60372395148"]').waitFor({state:'visible'});
    assert.equal(await page.locator('#mapping-search-input').inputValue(),'10807677752','fresh manual identity seeds the editable search despite a blank Matrix cell');
    assert.equal(await page.locator('#mapping-search-input').getAttribute('readonly'),null,'replacement is a generic seller search, not product draft completion');
    assert.equal(await page.locator('[data-map-option="OLD-OPTION"]').count(),0,'the deleted old option is absent from the latest seller source');
    assert.equal(await page.evaluate(()=>rematchFixture.manualWrites.length+rematchFixture.draftWrites.length+rematchFixture.disconnects.length),0,'opening replacement and selecting a search result list performs no write');
    assert.ok(await page.evaluate(()=>rematchFixture.freshReads.some(skus=>skus.length===1&&skus[0]==='11017-1')),'rematch reads this SKU afresh');
    const viewportWidth=await page.evaluate(()=>window.innerWidth);
    const pickerBounds=await page.locator('#mapping-popover').boundingBox();
    const closeBounds=await page.locator('#close-mapping-popover').boundingBox();
    assert.ok(pickerBounds&&pickerBounds.x>=0&&pickerBounds.x+pickerBounds.width<=viewportWidth,'the seller picker remains inside the viewport near a right-side seller cell');
    assert.equal(await page.locator('#close-mapping-popover').isVisible(),true);
    assert.ok(closeBounds&&closeBounds.x>=0&&closeBounds.x+closeBounds.width<=viewportWidth,'the picker close button remains reachable inside the viewport');
    fs.mkdirSync('outputs/ui-qa',{recursive:true});
    await page.screenshot({path:'outputs/ui-qa/20261013-manual-rematch-picker.png'});
    await page.locator('[data-map-option="60372395148"]').click();
    await page.waitForFunction(()=>rematchFixture.manualWrites.length===1&&document.getElementById('mapping-popover').hidden);
    assert.deepEqual(await page.evaluate(()=>rematchFixture.manualWrites),[{sku:'11017-1',source:'smartstore',productCode:'10807677752',optionCode:'60372395148'}]);
    assert.deepEqual(await page.evaluate(()=>rematchFixture.disconnects),[],'old manual mapping need not be disconnected before replacing it');
    assert.deepEqual(await page.evaluate(()=>rematchFixture.draftWrites),[],'manual replacement never saves a product-only draft');
    assert.deepEqual(await page.evaluate(()=>rematchFixture.componentWrites),[],'replacement never adds an explicit composition');

    // The context menu is the second entry point and keeps the established
    // confirmation before reusing a seller option already linked elsewhere.
    await openContext(page,'11017-2');
    await page.locator('#matrix-context-link-change').click();
    await page.locator('[data-map-option="60372395149"]').waitFor({state:'visible'});
    await page.locator('[data-map-option="60372395149"]').click();
    assert.equal(await page.evaluate(()=>rematchFixture.manualWrites.length),1,'declining the other-SKU confirmation prevents a write');
    assert.match(await page.evaluate(()=>rematchFixture.confirmations.at(-1)),/OTHER-SKU/);
    await page.evaluate(()=>{rematchFixture.confirmAnswer=true;});
    await page.locator('[data-map-option="60372395149"]').click();
    await page.waitForFunction(()=>rematchFixture.manualWrites.length===2&&document.getElementById('mapping-popover').hidden);

    // Copying a product code is still staging for a truly unlinked SKU.
    // A retained official manual mapping must not be mistaken for one.
    await openContext(page,'11017-6');
    assert.equal(await page.locator('#matrix-context-product-copy').isDisabled(),true,'hidden official manual link blocks the product-only copy route');
    await page.keyboard.press('Escape');

    // The existing remaining-options flow continues to complete a saved
    // product draft through its dedicated atomic adapter.
    const draftOption = page.locator('#matrix-body tr[data-sku="11017-5"] [data-link-source="smartstore"][data-code-kind="option"]').first();
    await draftOption.click();
    await page.locator('[data-map-option="60372395148"]').waitFor({state:'visible'});
    assert.equal(await page.locator('#mapping-search-input').inputValue(),'10807677752');
    assert.equal(await page.locator('#mapping-search-input').getAttribute('readonly'),'','draft completion keeps its fixed product');
    assert.equal(await page.locator('[data-map-option="60372395149"]').count(),0,'remaining options still exclude already linked identities');
    await page.locator('[data-map-option="60372395148"]').click();
    await page.waitForFunction(()=>rematchFixture.draftWrites.length===1&&document.getElementById('mapping-popover').hidden);
    assert.deepEqual(await page.evaluate(()=>rematchFixture.draftWrites),[{sku:'11017-5',source:'smartstore',optionCode:'60372395148'}]);
    assert.equal(await page.evaluate(()=>rematchFixture.manualWrites.length),2,'draft completion does not use ordinary rematching');

    for (const sku of ['11017-3','11017-4']) {
      await openContext(page,sku);
      await page.locator('#matrix-context-link-change').click();
      await page.waitForFunction(()=>document.getElementById('multi-links').classList.contains('active-page'));
      assert.equal(await page.locator('#multi-link-search').inputValue(),sku,'explicit composition and one-SKU fan-out preserve the dedicated management route');
      assert.equal(await page.locator('#mapping-popover').isVisible(),false,'dedicated composition handling cannot silently replace only the legacy manual row');
      assert.equal(await page.evaluate(()=>rematchFixture.manualWrites.length),2);
      await page.locator('[data-page="matching"]').first().click();
    }
    await page.locator('#matrix-body tr[data-sku="11017-7"] [data-link-source="ably"][data-code-kind="product"]').first().click();
    await page.locator('#listing-link-change').click();
    await page.waitForFunction(()=>document.getElementById('inventory').classList.contains('active-page'));
    assert.equal(await page.locator('#ably-mapping-management').evaluate(element=>element.closest('details').open),true,'verified Ably solution-code mappings keep the existing mapping management route');
    assert.equal(await page.locator('#mapping-popover').isVisible(),false);
    assert.equal(await page.evaluate(()=>rematchFixture.manualWrites.length),2);
    assert.deepEqual(await page.evaluate(()=>rematchFixture.disconnects),[]);
    assert.deepEqual(await page.evaluate(()=>rematchFixture.componentWrites),[]);

    // If a save response arrives after the operator opens a different SKU,
    // it must refresh its own target without closing that newer picker.
    await page.locator('[data-page="matching"]').first().click();
    await page.evaluate(()=>{rematchFixture.deferWriteSku='11017-1';});
    await productButton(page,'11017-1').click();
    await page.locator('#listing-link-change').click();
    await page.locator('[data-map-option="60372395148"]').click();
    await page.waitForFunction(()=>Boolean(rematchFixture.resolveWrite));
    await page.keyboard.press('Escape');
    await page.locator('#matrix-body tr[data-sku="11017-2"] [data-link-source="smartstore"][data-code-kind="option"]').first().click();
    await page.locator('#listing-link-change').click();
    await page.waitForFunction(()=>document.getElementById('mapping-target-sku').textContent==='11017-2'&&!document.getElementById('mapping-popover').hidden);
    const readsBeforeResponse=await page.evaluate(()=>rematchFixture.freshReads.length);
    await page.evaluate(()=>rematchFixture.resolveWrite());
    await page.waitForFunction(count=>rematchFixture.freshReads.length>count,readsBeforeResponse);
    assert.equal(await page.locator('#mapping-popover').isVisible(),true,'a late response does not close a newer SKU picker');
    assert.equal(await page.locator('#mapping-target-sku').textContent(),'11017-2');
    assert.deepEqual(await page.evaluate(()=>rematchFixture.freshReads.at(-1)),['11017-1'],'post-save refresh retains the request SKU even after the picker changes');
    assert.deepEqual(await page.evaluate(()=>rematchFixture.manualWrites.at(-1)),{sku:'11017-1',source:'smartstore',productCode:'10807677752',optionCode:'60372395148'});
    assert.deepEqual(errors,[]);
  } finally {
    await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
});
