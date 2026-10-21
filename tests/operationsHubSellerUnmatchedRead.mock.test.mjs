import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const serviceSource = fs.readFileSync(new URL('../mockups/operations-hub/data-service.js', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('../mockups/operations-hub/app.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const sources = ['smartstore', 'makeshop', 'ably'];
const metrics = {total_sku:26844, connected_sku:24000, unmatched_sku:2844,
  seller_sku_total:50000, seller_connected_sku:41399, seller_unmatched_sku:8601,
  seller_unmatched_smartstore:2075, seller_unmatched_makeshop:5577, seller_unmatched_ably:949,
  inventory_mismatch_sku:123, projected_inventory_mismatch_sku:120,
  inventory_draft_cells:3, inventory_failed_cells:1, today_picked:17, shortage_drawer_qty:2,
  latest_sync_at:'2026-10-21T00:00:00Z'};

function rows(count = 2505) {
  return Array.from({length:count}, (_, index) => ({
    source_channel:index < 1500 ? 'smartstore' : index < 2500 ? 'makeshop' : 'ably',
    product_code:`00${String(Math.floor(index / 3)).padStart(5, '0')}`,
    option_code:index % 3 === 0 ? '' : `00${index % 3}`,
    product_name:`상품 ${index}`, option_name:`옵션 ${index}`
  }));
}

function response(items, args, overrides = {}) {
  const source_counts = Object.fromEntries(sources.map(source => [source, items.filter(row => row.source_channel === source).length]));
  const page = args.p_limit ? items.slice(args.p_offset, args.p_offset + args.p_limit) : [];
  return {contract_version:1, cache_version:'input-version-1', total:items.length, source_counts,
    offset:args.p_offset, rows:plain(page), has_more:args.p_offset + page.length < items.length,
    seller_total:50000, seller_connected:50000 - items.length, seller_excluded:0, ...overrides};
}

function harness({items = rows(), reply = args => ({data:response(items, args), error:null}), metricReply = {data:metrics, error:null}} = {}) {
  const calls = [], tableCalls = [], events = [];
  const db = {
    rpc(name, args) {
      assert.equal(name, 'hub_seller_unmatched_read_v1', 'there is no legacy view or RPC fallback');
      calls.push({name, args:plain(args)});
      const request = Promise.resolve(reply(args, calls.length));
      request.abortSignal = () => request;
      return request;
    },
    from(table) {
      assert.equal(table, 'operations_hub_dashboard_metrics', 'unmatched templates never read the stale public view');
      tableCalls.push(table);
      return {select(){return this;}, async single(){return typeof metricReply === 'function' ? metricReply() : metricReply;}};
    }
  };
  const window = {supabase:{createClient:() => db}, SystemV3SellerParsers:{},
    dispatchEvent:event => events.push(event), CustomEvent:class {constructor(type, init){this.type = type; this.detail = init.detail;}},
    fetch:async () => { throw Error('network forbidden'); }};
  vm.runInNewContext(serviceSource, {window, console, URL, TextEncoder, TextDecoder, performance,
    AbortController, AbortSignal, Blob, setTimeout, clearTimeout});
  window.SystemV3Data.setOperationsHubSessionToken('operator-session');
  return {api:window.SystemV3Data, calls, tableCalls, events};
}

test('seller unmatched templates read every bounded page and recheck the same version before returning', async () => {
  const items = rows(), h = harness({items}), progress = [];
  const result = await h.api.loadAllSellerUnmatchedSkus({onProgress:event => progress.push(event)});
  assert.deepEqual(plain(result), items);
  assert.deepEqual(h.calls.map(call => [call.args.p_offset, call.args.p_limit]), [[0,1000],[1000,1000],[2000,1000],[0,0]]);
  assert.deepEqual(h.calls.map(call => call.args.p_expected_version), [null,'input-version-1','input-version-1','input-version-1']);
  assert.ok(h.calls.every(call => call.args.p_session_token === 'operator-session'));
  assert.equal(h.tableCalls.length, 0);
  assert.equal(result[0].product_code, '0000000', 'identity codes retain their leading zeros');
  assert.equal(result[0].option_code, '');
  assert.equal(progress.at(-1).loaded, 2505);
  assert.equal(progress.at(-1).total, 2505);
});

test('an empty authoritative dataset returns no rows only after a successful final version check', async () => {
  const h = harness({items:[]});
  assert.deepEqual(plain(await h.api.loadAllSellerUnmatchedSkus()), []);
  assert.deepEqual(h.calls.map(call => call.args.p_limit), [1000,0]);
});

test('version changes during paging or in the final summary reject the entire template', async () => {
  for (const changedCall of [2,4]) {
    const items = rows(), h = harness({items, reply:(args, index) => ({data:response(items, args,
      index === changedCall ? {cache_version:'input-version-2'} : {}), error:null})});
    await assert.rejects(h.api.loadAllSellerUnmatchedSkus(), /변경/);
    assert.equal(h.calls.length, changedCall);
  }
});

test('duplicate identities, missing rows, inconsistent totals and source counts cannot produce a partial template', async () => {
  const items = rows();
  const mutations = [
    (data, index) => {if(index === 2) data.rows[0] = plain(items[0]);},
    (data, index) => {if(index === 2) data.rows.pop();},
    data => {data.source_counts.smartstore++;},
    (data, index) => {if(index === 2){data.source_counts.smartstore--;data.source_counts.makeshop++;}},
    data => {data.has_more = false;},
    data => {data.rows[0].source_channel = 'unknown';},
    data => {data.rows[0].product_code = '';},
    data => {data.rows[0].option_code = null;},
    data => {data.cache_version = 1;},
    data => {data.contract_version = 0;},
    data => {data.seller_excluded = -1;},
    data => {data.seller_excluded = 1;}
  ];
  for (const mutate of mutations) {
    const h = harness({items, reply:(args, index) => {const data = response(items, args);mutate(data, index);return {data,error:null};}});
    await assert.rejects(h.api.loadAllSellerUnmatchedSkus(), /중복|건수|집계|식별자|응답/);
    assert.equal(h.tableCalls.length, 0);
  }
});

test('dashboard counts come from the same authoritative reader and preserve unrelated metrics', async () => {
  const items = rows(), h = harness({items});
  const result = await h.api.loadDashboardMetrics();
  assert.equal(result.seller_unmatched_sku, 2505);
  assert.deepEqual(sources.map(source => result[`seller_unmatched_${source}`]), [1500,1000,5]);
  assert.equal(result.seller_unmatched_cache_version, 'input-version-1');
  assert.equal(result.seller_sku_total, 50000);
  assert.equal(result.seller_connected_sku, 47495);
  assert.equal(result.seller_excluded_sku, 0);
  assert.equal(result.total_sku, metrics.total_sku);
  assert.equal(result.unmatched_sku, metrics.unmatched_sku, 'Sellpia unmatched is a separate population');
  assert.equal(result.inventory_mismatch_sku, metrics.inventory_mismatch_sku);
  assert.equal(result.today_picked, 17);
  assert.deepEqual(h.calls.map(call => [call.args.p_offset,call.args.p_limit]), [[0,0]]);
});

test('intentional exclusions remain separate from connected and unmatched seller populations', async () => {
  const items = rows(10), h = harness({items, reply:args => ({data:response(items,args,
    {seller_total:50,seller_connected:37,seller_excluded:3}),error:null})});
  const result = await h.api.loadDashboardMetrics();
  assert.equal(result.seller_sku_total, 50);
  assert.equal(result.seller_connected_sku, 37);
  assert.equal(result.seller_unmatched_sku, 10);
  assert.equal(result.seller_excluded_sku, 3);
  assert.equal((await h.api.loadAllSellerUnmatchedSkus()).length, 10);
});

test('summary failure clears only seller unmatched counts without using old counts or breaking other dashboard metrics', async () => {
  const failure = {code:'57014',message:'synthetic timeout'}, h = harness({reply:() => ({data:null,error:failure})});
  const result = await h.api.loadDashboardMetrics();
  assert.equal(result.total_sku, 26844);
  assert.equal(result.inventory_mismatch_sku, 123);
  assert.equal(result.today_picked, 17);
  assert.equal(result.seller_unmatched_sku, null);
  assert.equal(result.seller_unmatched_cache_version, null);
  assert.ok(sources.every(source => result[`seller_unmatched_${source}`] === null));
  assert.match(result.seller_unmatched_error, /timeout/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.tableCalls.length, 1);
  await assert.rejects(h.api.loadAllSellerUnmatchedSkus(), error => error === failure);
});

test('missing sessions, denied sessions, aborts and logout during reads never fall back or return stale data', async () => {
  const missing = harness();missing.api.setOperationsHubSessionToken('');
  await assert.rejects(missing.api.loadAllSellerUnmatchedSkus(), /로그인/);
  await assert.rejects(missing.api.loadDashboardMetrics(), /로그인/);
  assert.equal(missing.calls.length, 0);
  assert.equal(missing.tableCalls.length, 0);
  const denied = harness({reply:() => ({data:null,error:{code:'42501',message:'denied'}})});
  await assert.rejects(denied.api.loadDashboardMetrics(), error => error.operationsHubAuthRequired === true);
  assert.equal(denied.events.at(-1).type, 'operations-hub-auth-required');
  const aborted = harness(), controller = new AbortController();controller.abort();
  await assert.rejects(aborted.api.loadAllSellerUnmatchedSkus({signal:controller.signal}), {name:'AbortError'});
  assert.equal(aborted.calls.length, 0);
  let finishRead;
  const inFlight = harness({reply:args => new Promise(resolve => {finishRead = () => resolve({data:response(rows(),args),error:null});})});
  const activeController = new AbortController(), cancelled = inFlight.api.loadAllSellerUnmatchedSkus({signal:activeController.signal});
  activeController.abort();finishRead();
  await assert.rejects(cancelled, {name:'AbortError'});
  assert.equal(inFlight.calls.length, 1);
  for (const method of ['loadAllSellerUnmatchedSkus','loadDashboardMetrics']) {
    let release;
    const h = harness({reply:args => new Promise(resolve => {release = () => resolve({data:response(rows(),args),error:null});})});
    const result = h.api[method]();h.api.setOperationsHubSessionToken('');release();
    await assert.rejects(result, {name:'AbortError'});
  }
});

function appHarness(load = async () => ({...metrics, seller_unmatched_cache_version:'verified'})) {
  const elements = new Map(), health = [];
  const element = id => {if(!elements.has(id)) elements.set(id, {textContent:'old',title:''});return elements.get(id);};
  const context = {liveData:{loadDashboardMetrics:load}, operationsAuthState:{authenticated:true,sessionId:'session-1'},
    document:{getElementById:element}, console:{error(){}}, CHANNEL_LABELS:{smartstore:'스마트스토어',makeshop:'메이크샵',ably:'에이블리'},
    formatNumber:value => Number(value).toLocaleString('en-US'), formatLiveTime:() => '2026.10.21 09:00',
    setSystemHealthComponent:(key,value) => health.push([key,value])};
  const start = appSource.indexOf('let liveDashboardMetricsRequestId = 0;');
  const end = appSource.indexOf('\nasync function refreshLiveData(', start);
  assert.ok(start > 0 && end > start);
  vm.createContext(context);vm.runInContext(`${appSource.slice(start,end)}\nthis.load=loadLiveDashboardMetrics;`, context);
  return {context,elements,element,health};
}

test('actual dashboard rendering removes a previously successful unmatched badge on partial failure without displaying zero', async () => {
  let next = {...metrics, seller_unmatched_cache_version:'verified'}, h = appHarness(async () => next);
  assert.equal(await h.context.load(), true);
  assert.equal(h.element('matrix-unmatched-badge').textContent, '8,601');
  assert.match(h.element('matrix-unmatched-badge').title, /셀피아 SKU 미매칭 필터와 별도/);
  next = {...metrics, total_sku:27000, seller_unmatched_error:'timeout', seller_unmatched_cache_version:null,
    seller_unmatched_sku:null, ...Object.fromEntries(sources.map(source => [`seller_unmatched_${source}`,null]))};
  assert.equal(await h.context.load(), false);
  assert.equal(h.element('live-total-sku').textContent, '27,000');
  assert.equal(h.element('live-inventory-mismatch').textContent, '120');
  assert.equal(h.element('matrix-unmatched-badge').textContent, '-');
  assert.equal(h.element('live-unmatched-sku').textContent, '-');
  assert.match(h.element('dashboard-unmatched-alert').textContent, /확인 필요/);
  assert.match(h.element('live-unmatched-detail').textContent, /조회 실패/);
  assert.deepEqual(h.health.at(-1), ['metrics',false]);
  next = {...metrics, seller_unmatched_cache_version:'verified-empty', seller_unmatched_sku:0,
    ...Object.fromEntries(sources.map(source => [`seller_unmatched_${source}`,0]))};
  assert.equal(await h.context.load(), true);
  assert.equal(h.element('live-unmatched-sku').textContent, '0', 'a proven empty result remains distinct from a failed read');
});

test('actual dashboard rendering rejects late success and late errors from superseded requests or sessions', async () => {
  const releases = [], h = appHarness(() => new Promise((resolve,reject) => releases.push({resolve,reject})));
  const first = h.context.load(), second = h.context.load();
  releases[1].resolve({...metrics,seller_unmatched_cache_version:'new',seller_unmatched_smartstore:1,seller_unmatched_makeshop:2,seller_unmatched_ably:3});
  assert.equal(await second, true);
  releases[0].reject(Error('old failure'));
  assert.equal(await first, false);
  assert.equal(h.element('matrix-unmatched-badge').textContent, '6');
  const oldSession = h.context.load();h.context.operationsAuthState.sessionId = 'session-2';
  releases[2].resolve({...metrics,seller_unmatched_cache_version:'old'});
  assert.equal(await oldSession, false);
  assert.equal(h.element('matrix-unmatched-badge').textContent, '6');
});
