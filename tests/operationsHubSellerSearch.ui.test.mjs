import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium} from 'playwright';

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const html = read('mockups/operations-hub/index.html');
const app = read('mockups/operations-hub/app.js');
const service = read('mockups/operations-hub/data-service.js');
const css = read('mockups/operations-hub/style.css');
const pickerSource = app.slice(app.indexOf('const mappingPopover ='), app.indexOf('const pricePopover ='));
assert.ok(pickerSource.includes('async function runMappingSearch'), 'fixture executes the production picker handlers');
let browser;

before(async () => {
  browser = await chromium.launch({headless:true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}
      : process.platform === 'win32' ? {channel:'msedge'} : {})});
});
after(async () => { await browser?.close(); });

async function fixture() {
  const page = await browser.newPage({viewport:{width:1100,height:850}});
  const panel = html.match(/<section id="mapping-popover"[\s\S]*?<\/section>/)?.[0];
  assert.ok(panel, 'fixture uses the actual picker HTML');
  await page.setContent(`<style>${css}</style>${panel}`);
  await page.evaluate(() => {
    window.searchFixture = {calls:[],queue:[],pending:{}};
    window.supabase = {createClient:() => ({
      rpc:async (name,args) => {
        if (name !== 'search_operations_hub_seller_items_v3') throw Error(`Unexpected RPC: ${name}`);
        const state = window.searchFixture;
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
    ${pickerSource}
    window.searchFixture.open = options => openMappingSearch({source:'smartstore',sku:'11595-6',...options});
    window.searchFixture.close = closeMappingSearch;
    window.searchFixture.search = runMappingSearch;
  `});
  return page;
}

const item = (option = '60358079673', overrides = {}) => ({
  source_channel:'smartstore',product_code:'13805953338',option_code:option,
  product_name:'14K 클래식 볼륨 원터치 링',option_name:'옐로우골드/S',stock:5,price:59000,
  linked_skus:[],total_count:1,...overrides
});

test('exact-code picker uses actual V3 data service and preserves result pagination and linked warnings', async () => {
  const page = await fixture();
  try {
    const rows = Array.from({length:24},(_,i) => item(String(i),{total_count:25,linked_skus:i===0?['OTHER-SKU']:[]}));
    rows[1].product_name = '<img src=x onerror="window.injected=true">';
    await page.evaluate(rows => {
      searchFixture.queue.push({data:rows,error:null});
      searchFixture.open({initialQuery:'13805953338'});
    },rows);
    await page.locator('[data-map-option="23"]').waitFor();
    assert.equal(await page.locator('[data-map-product]').count(),24);
    assert.match(await page.locator('#mapping-search-results').innerText(),/전체 25개 · 1\/2쪽/);
    assert.match(await page.locator('#mapping-search-results').innerText(),/OTHER-SKU/);
    assert.equal(await page.locator('#mapping-search-results img').count(),0);
    assert.deepEqual(await page.evaluate(() => searchFixture.calls[0]),{
      name:'search_operations_hub_seller_items_v3',
      args:{p_source:'smartstore',p_query:'13805953338',p_page:1,p_page_size:24,p_match_mode:'auto'}
    });
    await page.evaluate(row => searchFixture.queue.push({data:[row],error:null}),item('24',{total_count:25}));
    await page.getByRole('button',{name:'다음',exact:true}).click();
    await page.locator('[data-map-option="24"]').waitFor();
    assert.match(await page.locator('#mapping-search-results').innerText(),/전체 25개 · 2\/2쪽/);
    assert.equal(await page.evaluate(() => searchFixture.calls[1].args.p_page),2);
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

test('timeout offers a read-only retry and stays distinct from an empty result', async () => {
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
    await page.evaluate(() => searchFixture.queue.push({data:[],error:null}));
    await page.getByRole('button',{name:'다시 검색',exact:true}).click();
    await page.getByText('검색 결과가 없습니다.',{exact:true}).waitFor();
    assert.equal(await page.locator('.mapping-empty.error').count(),0);
    assert.equal(await page.evaluate(() => searchFixture.calls.length),2);
    await page.evaluate(() => {
      searchFixture.queue.push({data:null,error:{code:'XX000',message:'<img src=x onerror="window.injected=true">검색 실패'}});
      void searchFixture.search();
    });
    await page.getByText('검색하지 못했습니다.',{exact:true}).waitFor();
    assert.equal(await page.locator('#mapping-search-results img').count(),0,'database error details remain escaped');
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
