import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const html = read('mockups/operations-hub/index.html');
const app = read('mockups/operations-hub/app.js');
const service = read('mockups/operations-hub/data-service.js');
const localStyles = [...html.matchAll(/<link\s+rel="stylesheet"\s+href="\.\/([^"?]+)[^"]*"/g)].map(match => match[1]);
assert.ok(localStyles.indexOf('ui-scale-matrix.css') > localStyles.indexOf('style.css'), 'fixture preserves the real CSS cascade, including the enlarged Matrix popup');
const css = localStyles.map(file => read(`mockups/operations-hub/${file}`)).join('\n');
const pickerSource = app.slice(app.indexOf('const mappingPopover ='), app.indexOf('const pricePopover ='));
assert.ok(pickerSource.includes('async function runMappingSearch'), 'fixture executes the production picker handlers');
const sourceControls = app.indexOf("const sourceSelect = document.getElementById('source-select')");
const outsideClickSource = app.slice(app.lastIndexOf("document.addEventListener('click', event => {", sourceControls), sourceControls);
assert.ok(outsideClickSource.includes('closeMappingSearch()'), 'fixture also executes the production global outside-click handler');
let browser;

before(async () => {
  browser = await chromium.launch({headless:true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}
      : process.platform === 'win32' ? {channel:'msedge'} : {})});
});
after(async () => { await browser?.close(); });

async function fixture({viewport = {width:1100,height:850}} = {}) {
  const page = await browser.newPage({viewport});
  const panel = html.match(/<section id="mapping-popover"[\s\S]*?<\/section>/)?.[0];
  assert.ok(panel, 'fixture uses the actual picker HTML');
  await page.setContent(`<style>${css}</style>${panel}`);
  await page.evaluate(() => {
    window.searchFixture = {calls:[],queue:[],pending:{},linkCalls:[],linkQueue:[],effects:[]};
    window.supabase = {createClient:() => ({
      rpc:async (name,args) => {
        const state = window.searchFixture;
        if (name === 'link_operations_hub_seller_item_v2') {
          state.linkCalls.push({name,args:structuredClone(args)});
          const next = state.linkQueue.shift();
          if (next?.defer) return await new Promise(resolve => { state.pending[next.defer] = resolve; });
          return next || {data:{source_channel:args.p_source,sellpia_sku_code:args.p_sku,product_code:args.p_product_code,option_code:args.p_option_code},error:null};
        }
        if (name !== 'search_operations_hub_seller_items_v3') throw Error(`Unexpected RPC: ${name}`);
        state.calls.push({name,args:structuredClone(args)});
        const next = state.queue.shift();
        if (!next) throw Error('Missing search response');
        if (next.defer) return await new Promise(resolve => { state.pending[next.defer] = resolve; });
        return next;
      },
      from:() => { throw Error('Picker search must not mutate or read tables directly'); }
    })};
  });
  await page.addScriptTag({content:service});
  await page.addScriptTag({content:`
    const liveData = window.SystemV3Data;
    let currentSkuRematchRequestId = 0;
    const CHANNEL_LABELS = {smartstore:'스마트스토어',makeshop:'메이크샵',ably:'에이블리'};
    const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    const formatNumber = value => Number(value).toLocaleString('ko-KR');
    const formatNullableNumber = value => value == null ? '-' : formatNumber(value);
    const matrixRowsBySku = new Map([['11595-6',{sellpia_sku_code:'11595-6'}]]);
    const matrixState = {rows:[matrixRowsBySku.get('11595-6')]};
    function closeProductDrawer() { searchFixture.effects.push('close-drawer'); }
    function renderLiveMatrixRows() { searchFixture.effects.push('render-matrix'); }
    function showToast(message) { searchFixture.effects.push(message); }
    function showPage() {}
    async function refreshMatrixSkus(skus) { searchFixture.effects.push({refresh:skus}); }
    async function loadLiveDashboardMetrics() { searchFixture.effects.push('refresh-dashboard'); }
    ${pickerSource}
    ${outsideClickSource}
    window.searchFixture.open = options => openMappingSearch({source:'smartstore',sku:'11595-6',...options});
    window.searchFixture.close = closeMappingSearch;
    window.searchFixture.search = runMappingSearch;
    window.searchFixture.matrixRow = () => structuredClone(matrixRowsBySku.get('11595-6'));
  `});
  return page;
}

const item = (option = '60358079673', overrides = {}) => ({
  source_channel:'smartstore',product_code:'13805953338',option_code:option,
  product_name:'14K 클래식 볼륨 원터치 링',option_name:'옐로우골드/S',stock:5,price:59000,
  linked_skus:[],total_count:1,...overrides
});
const batch = (start, length, total, overrides = {}) => Array.from({length}, (_, i) => item(`option-${start + i}`, {total_count:total,...overrides}));
async function scrollToEnd(page, repeat = 1) {
  await page.locator('#mapping-search-results').evaluate((node, repeat) => {
    node.scrollTop = node.scrollHeight;
    for (let i = 0; i < repeat; i += 1) node.dispatchEvent(new Event('scroll'));
  }, repeat);
}
async function resolve(page, key, rows, error = null) {
  await page.evaluate(({key, rows, error}) => { searchFixture.pending[key]({data:rows,error}); }, {key,rows,error});
}

test('continuous search retains more than two pages, exact counts, scroll position and linked warnings without page controls', async () => {
  const page = await fixture();
  try {
    const rows = batch(0,100,230);
    rows[0].linked_skus = ['OTHER-SKU'];
    rows[1].product_name = '<img src=x onerror="window.injected=true">';
    await page.evaluate(rows => {
      searchFixture.queue.push({data:rows,error:null},{defer:'page-2'});
      searchFixture.open({initialQuery:'13805953338'});
    },rows);
    await page.locator('[data-map-option="option-99"]').waitFor();
    assert.equal(await page.locator('[data-map-product]').count(),100);
    assert.match(await page.locator('#mapping-search-results').innerText(),/전체 230개/);
    assert.match(await page.locator('#mapping-search-results').innerText(),/OTHER-SKU/);
    assert.equal(await page.locator('#mapping-search-results img').count(),0);
    assert.equal(await page.locator('[data-mapping-page]').count(),0);
    await page.evaluate(() => { searchFixture.firstRowNode = document.querySelector('[data-map-option="option-0"]'); });
    assert.deepEqual(await page.evaluate(() => searchFixture.calls[0]),{
      name:'search_operations_hub_seller_items_v3',
      args:{p_source:'smartstore',p_query:'13805953338',p_page:1,p_page_size:100,p_match_mode:'auto'}
    });
    await scrollToEnd(page,8);
    await page.waitForFunction(() => searchFixture.pending['page-2']);
    await scrollToEnd(page,8);
    assert.equal(await page.evaluate(() => searchFixture.calls.length),2,'repeated scroll events share one append request');
    assert.equal(await page.locator('[data-map-product]').count(),100,'loading the next batch keeps the existing list');
    const oldScroll = await page.locator('#mapping-search-results').evaluate(node => node.scrollTop);
    await resolve(page,'page-2',batch(100,100,230));
    await page.locator('[data-map-option="option-199"]').waitFor();
    assert.equal(await page.locator('[data-map-product]').count(),200);
    assert.equal(await page.locator('[data-map-option="option-0"]').count(),1);
    assert.equal(await page.evaluate(() => searchFixture.firstRowNode === document.querySelector('[data-map-option="option-0"]')),true,'append preserves existing option nodes');
    assert.ok(Math.abs(await page.locator('#mapping-search-results').evaluate(node => node.scrollTop) - oldScroll) < 20,'append preserves the reader position');
    assert.equal(await page.evaluate(() => searchFixture.calls[1].args.p_page),2);
    await page.evaluate(rows => searchFixture.queue.push({data:rows,error:null}),batch(200,30,230));
    await scrollToEnd(page);
    await page.locator('[data-map-option="option-229"]').waitFor();
    assert.equal(await page.locator('[data-map-product]').count(),230);
    assert.match(await page.locator('#mapping-search-results').innerText(),/전체 230개/);
    await scrollToEnd(page,8);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => searchFixture.calls.length),3,'the completed list cannot request another page');
    assert.equal(await page.locator('#mapping-popover').isVisible(),true);
    assert.equal(await page.locator('#mapping-search-results').getAttribute('aria-busy'),'false');
  } finally { await page.close(); }
});

test('remaining-options picker uses exact-product-only mode and excludes linked options without fuzzy fallback', async () => {
  const page = await fixture();
  try {
    await page.evaluate(rows => {
      searchFixture.queue.push({data:rows,error:null});
      searchFixture.open({fixedProductCode:'13805953338'});
    },[item('free'),item('linked',{linked_skus:['OTHER-SKU']})]);
    await page.locator('[data-map-option="free"]').waitFor();
    assert.equal(await page.locator('[data-map-option="linked"]').count(),0);
    assert.equal(await page.locator('#mapping-search-input').evaluate(node => node.readOnly),true);
    assert.deepEqual(await page.evaluate(() => searchFixture.calls[0].args),{
      p_source:'smartstore',p_query:'13805953338',p_page:1,p_page_size:100,p_match_mode:'product'
    });
    await page.evaluate(() => {
      searchFixture.queue.push({data:[],error:null});
      searchFixture.open({fixedProductCode:'MISSING-PRODUCT'});
    });
    await page.getByText('남은 옵션이 없습니다.',{exact:true}).waitFor();
    assert.equal(await page.evaluate(() => searchFixture.calls.length),2,'no general search follows an absent exact product');
    assert.equal(await page.evaluate(() => searchFixture.calls[1].args.p_match_mode),'product');
  } finally { await page.close(); }
});

test('initial retry survives a detached clicked button in the actual outside-click listener, while an outside click closes', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      searchFixture.queue.push({data:null,error:{code:'57014',message:'canceling statement due to statement timeout'}});
      searchFixture.open({initialQuery:'13805953338'});
    });
    await page.getByText('검색 시간이 초과됐습니다.',{exact:true}).waitFor();
    assert.equal(await page.locator('#mapping-search-results').getAttribute('aria-busy'),'false');
    assert.equal(await page.locator('#mapping-search-results').getAttribute('aria-live'),'polite');
    await page.waitForTimeout(350);
    assert.equal(await page.evaluate(() => searchFixture.calls.length),1,'timeout does not silently replay requests');
    await page.evaluate(() => searchFixture.queue.push({defer:'retry'}));
    await page.getByRole('button',{name:'다시 검색',exact:true}).click();
    await page.waitForFunction(() => searchFixture.pending.retry);
    assert.equal(await page.locator('#mapping-popover').isVisible(),true,'replacing the clicked retry button must not turn its click into an outside click');
    await resolve(page,'retry',[]);
    await page.getByText('검색 결과가 없습니다.',{exact:true}).waitFor();
    assert.equal(await page.locator('.mapping-empty.error').count(),0);
    assert.equal(await page.evaluate(() => searchFixture.calls.length),2);
    await page.evaluate(() => {
      searchFixture.queue.push({data:null,error:{code:'XX000',message:'<img src=x onerror="window.injected=true">검색 실패'}});
      void searchFixture.search();
    });
    await page.getByText('검색하지 못했습니다.',{exact:true}).waitFor();
    assert.equal(await page.locator('#mapping-search-results img').count(),0,'database error details remain escaped');
    await page.mouse.click(1000,800);
    assert.equal(await page.locator('#mapping-popover').isVisible(),false,'a real click outside still dismisses the popup');
  } finally { await page.close(); }
});

test('append errors retain loaded options and retry only that batch without closing the popup', async () => {
  const page = await fixture();
  try {
    await page.evaluate(rows => {
      searchFixture.queue.push({data:rows,error:null},{data:null,error:{code:'57014',message:'statement timeout'}});
      searchFixture.open({initialQuery:'13805953338'});
    },batch(0,100,150));
    await page.locator('[data-map-option="option-99"]').waitFor();
    await scrollToEnd(page);
    await page.locator('[data-mapping-retry]').waitFor();
    assert.equal(await page.locator('[data-map-product]').count(),100);
    await scrollToEnd(page,8);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => searchFixture.calls.length),2,'failed append waits for an explicit retry');
    await page.evaluate(() => searchFixture.queue.push({defer:'append-retry'}));
    await page.locator('[data-mapping-retry]').click();
    await page.waitForFunction(() => searchFixture.pending['append-retry']);
    assert.equal(await page.locator('#mapping-popover').isVisible(),true,'the retry footer can replace itself while its click bubbles');
    assert.equal(await page.locator('[data-map-product]').count(),100);
    assert.equal(await page.evaluate(() => searchFixture.calls[2].args.p_page),2);
    await resolve(page,'append-retry',batch(100,50,150));
    await page.locator('[data-map-option="option-149"]').waitFor();
    assert.equal(await page.locator('[data-map-product]').count(),150);
    assert.equal(await page.locator('[data-map-option="option-0"]').count(),1);
    assert.equal(await page.locator('#mapping-popover').isVisible(),true);
  } finally { await page.close(); }
});

test('new input invalidates old errors before debounce and closed or replaced searches cannot publish late results', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      searchFixture.queue.push({defer:'old-error'},{data:[],error:null});
      searchFixture.open({initialQuery:'old'});
    });
    await page.waitForFunction(() => searchFixture.pending['old-error']);
    await page.locator('#mapping-search-input').fill('new');
    await page.evaluate(async () => {
      searchFixture.pending['old-error']({data:null,error:{code:'57014',message:'statement timeout'}});
      await Promise.resolve();
    });
    assert.doesNotMatch(await page.locator('#mapping-search-results').innerText(),/초과|못했습니다/);
    await page.getByText('검색 결과가 없습니다.',{exact:true}).waitFor();
    assert.equal(await page.evaluate(() => searchFixture.calls[1].args.p_query),'new');
    await page.evaluate(() => {
      searchFixture.queue.push({defer:'old-success'});
      searchFixture.open({initialQuery:'old-success'});
    });
    await page.waitForFunction(() => searchFixture.pending['old-success']);
    await page.locator('#close-mapping-popover').click();
    assert.equal(await page.locator('#mapping-search-results').getAttribute('aria-busy'),'false');
    await page.evaluate(row => {
      searchFixture.queue.push({data:[row],error:null});
      searchFixture.open({source:'makeshop',initialQuery:'LATEST'});
    },item('latest',{product_code:'LATEST',source_channel:'makeshop'}));
    await page.locator('[data-map-option="latest"]').waitFor();
    await page.evaluate(async row => {
      searchFixture.pending['old-success']({data:[row],error:null});
      await Promise.resolve();
    },item('outdated'));
    assert.equal(await page.locator('[data-map-option="outdated"]').count(),0);
    assert.equal(await page.locator('[data-map-option="latest"]').count(),1);
    assert.match(await page.locator('#mapping-source-label').innerText(),/메이크샵/);
  } finally { await page.close(); }
});

test('late append cannot publish into a changed query or a reopened popup', async () => {
  const page = await fixture();
  try {
    await page.evaluate(rows => {
      searchFixture.queue.push({data:rows,error:null},{defer:'old-append'});
      searchFixture.open({initialQuery:'old'});
    },batch(0,100,150));
    await page.locator('[data-map-option="option-99"]').waitFor();
    await scrollToEnd(page);
    await page.waitForFunction(() => searchFixture.pending['old-append']);
    await page.evaluate(row => searchFixture.queue.push({data:[row],error:null}),item('new-result',{product_code:'NEW'}));
    await page.locator('#mapping-search-input').fill('new');
    await resolve(page,'old-append',batch(100,50,150));
    await page.locator('[data-map-option="new-result"]').waitFor();
    assert.equal(await page.locator('[data-map-product]').count(),1);
    assert.equal(await page.locator('[data-map-option="option-149"]').count(),0);
    await page.evaluate(rows => {
      searchFixture.queue.push({data:rows,error:null},{defer:'closed-append'});
      searchFixture.open({initialQuery:'closing'});
    },batch(0,100,150));
    await page.locator('[data-map-option="option-99"]').waitFor();
    await scrollToEnd(page);
    await page.waitForFunction(() => searchFixture.pending['closed-append']);
    await page.locator('#close-mapping-popover').click();
    await page.evaluate(row => {
      searchFixture.queue.push({data:[row],error:null});
      searchFixture.open({source:'makeshop',initialQuery:'LATEST'});
    },item('latest',{product_code:'LATEST',source_channel:'makeshop'}));
    await page.locator('[data-map-option="latest"]').waitFor();
    await resolve(page,'closed-append',batch(100,50,150));
    assert.equal(await page.locator('[data-map-product]').count(),1);
    assert.equal(await page.locator('[data-map-option="latest"]').count(),1);
    assert.match(await page.locator('#mapping-source-label').innerText(),/메이크샵/);
  } finally { await page.close(); }
});

test('inconsistent append pages retain unique rows and require restart instead of looping or claiming completeness', async () => {
  const cases = [
    {kind:'empty',total:200,next:[],loaded:100,reported:200},
    {kind:'duplicate-only',total:200,next:batch(0,100,200),loaded:100,reported:200},
    {kind:'partial-overlap',total:105,next:[...batch(100,4,105),item('option-0',{total_count:105})],loaded:104,reported:105},
    {kind:'decreased-total',total:105,next:batch(100,5,103),loaded:105,reported:103}
  ];
  for (const scenario of cases) {
    const page = await fixture();
    try {
      await page.evaluate(({rows,next}) => {
        searchFixture.queue.push({data:rows,error:null},{data:next,error:null});
        searchFixture.open({initialQuery:'13805953338'});
      },{rows:batch(0,100,scenario.total),next:scenario.next});
      await page.locator('[data-map-option="option-99"]').waitFor();
      await scrollToEnd(page);
      await page.waitForFunction(() => searchFixture.calls.length === 2 && document.getElementById('mapping-search-results').getAttribute('aria-busy') === 'false');
      await scrollToEnd(page,8);
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => searchFixture.calls.length),2);
      assert.equal(await page.locator('[data-map-product]').count(),scenario.loaded,`${scenario.kind} retains every unique loaded row`);
      assert.equal(await page.locator('.mapping-search-footer.error').count(),1);
      assert.equal(await page.getByRole('button',{name:'처음부터 다시 검색',exact:true}).count(),1);
      const footer = await page.locator('.mapping-search-footer').innerText();
      assert.match(footer,new RegExp(`전체 ${scenario.reported}개`));
      assert.match(footer,new RegExp(`${scenario.loaded}개 표시`));
      assert.doesNotMatch(footer,/모두/,'incomplete or changed results cannot claim complete loading');
      assert.equal(await page.locator('#mapping-popover').isVisible(),true);
      if (scenario.kind === 'partial-overlap') {
        await page.evaluate(rows => searchFixture.queue.push({data:rows,error:null}),batch(500,3,3));
        await page.getByRole('button',{name:'처음부터 다시 검색',exact:true}).click();
        await page.locator('[data-map-option="option-502"]').waitFor();
        assert.equal(await page.locator('[data-map-product]').count(),3,'an explicit restart replaces the inconsistent list');
        assert.equal(await page.evaluate(() => searchFixture.calls[2].args.p_page),1);
        assert.equal(await page.locator('#mapping-popover').isVisible(),true);
      }
    } finally { await page.close(); }
  }
});

test('selecting a loaded option still completes if another batch is appended while its link request is pending', async () => {
  const page = await fixture();
  try {
    await page.evaluate(rows => {
      searchFixture.queue.push({data:rows,error:null},{defer:'during-link'});
      searchFixture.linkQueue.push({defer:'selected-option'});
      searchFixture.open({initialQuery:'13805953338'});
    },batch(0,100,150));
    await page.locator('[data-map-option="option-0"]').click();
    await page.waitForFunction(() => searchFixture.pending['selected-option']);
    await page.evaluate(() => { searchFixture.selectedNode = document.querySelector('[data-map-option="option-0"]'); });
    await scrollToEnd(page);
    await page.waitForFunction(() => searchFixture.pending['during-link']);
    await resolve(page,'during-link',batch(100,50,150));
    await page.locator('[data-map-option="option-149"]').waitFor();
    assert.equal(await page.evaluate(() => searchFixture.selectedNode === document.querySelector('[data-map-option="option-0"]')),true);
    assert.equal(await page.locator('[data-map-option="option-0"]').isDisabled(),true,'an append cannot reactivate a mapping button with a pending save');
    await page.evaluate(() => searchFixture.pending['selected-option']({data:{source_channel:'smartstore',sellpia_sku_code:'11595-6',product_code:'13805953338',option_code:'option-0'},error:null}));
    await page.waitForFunction(() => document.getElementById('mapping-popover').hidden);
    assert.deepEqual(await page.evaluate(() => searchFixture.linkCalls[0].args),{p_sku:'11595-6',p_source:'smartstore',p_product_code:'13805953338',p_option_code:'option-0'});
    assert.equal(await page.evaluate(() => searchFixture.matrixRow().smartstore_option_code),'option-0');
    assert.ok((await page.evaluate(() => searchFixture.effects)).includes('close-drawer'));
  } finally { await page.close(); }
});

test('short viewports keep the popup inside the window and the last loaded option reachable by scrolling', async () => {
  const page = await fixture({viewport:{width:1100,height:300}});
  try {
    await page.evaluate(rows => {
      searchFixture.queue.push({data:rows,error:null});
      searchFixture.open({initialQuery:'13805953338'});
    },batch(0,100,100));
    await page.locator('[data-map-option="option-99"]').waitFor();
    const panel = await page.locator('#mapping-popover').boundingBox();
    assert.ok(panel.y >= 0 && panel.y + panel.height <= 288.5,`popup bounds ${JSON.stringify(panel)} fit the short viewport`);
    const scroll = await page.locator('#mapping-search-results').evaluate(node => ({client:node.clientHeight,height:node.scrollHeight}));
    assert.ok(scroll.client > 0 && scroll.height > scroll.client,'the result region can shrink and scroll');
    await page.locator('[data-map-option="option-99"]').scrollIntoViewIfNeeded();
    const last = await page.locator('[data-map-option="option-99"]').boundingBox();
    assert.ok(last.y >= 0 && last.y + last.height <= 300,'the last option remains reachable');
    await scrollToEnd(page);
    fs.mkdirSync(new URL('../outputs/ui-qa/',import.meta.url),{recursive:true});
    await page.screenshot({path:fileURLToPath(new URL('../outputs/ui-qa/seller-search-scroll.png',import.meta.url))});
    await page.setViewportSize({width:1100,height:700});
    await page.evaluate(rows => {
      const anchor = document.createElement('button');
      anchor.className = 'mapping-code-button';
      anchor.textContent = '연결 상품';
      anchor.style.cssText = 'position:fixed;left:20px;top:80px;height:30px';
      document.body.append(anchor);
      searchFixture.queue.push({data:rows,error:null});
      searchFixture.open({initialQuery:'13805953338',anchor});
    },batch(0,100,100));
    await page.waitForFunction(() => searchFixture.calls.length === 2 && document.getElementById('mapping-search-results').getAttribute('aria-busy') === 'false');
    const anchored = await page.locator('#mapping-popover').boundingBox();
    assert.ok(anchored.y > 12 && anchored.y + anchored.height <= 688.5,`anchored popup bounds ${JSON.stringify(anchored)} honor the space below the anchor`);
    const anchoredScroll = await page.locator('#mapping-search-results').evaluate(node => ({client:node.clientHeight,height:node.scrollHeight}));
    assert.ok(anchoredScroll.client > 0 && anchoredScroll.height > anchoredScroll.client);
    await page.locator('[data-map-option="option-99"]').scrollIntoViewIfNeeded();
    await scrollToEnd(page);
    await page.screenshot({path:fileURLToPath(new URL('../outputs/ui-qa/seller-search-scroll-anchor.png',import.meta.url))});
  } finally { await page.close(); }
});
