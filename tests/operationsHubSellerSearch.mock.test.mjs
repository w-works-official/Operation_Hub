import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../mockups/operations-hub/data-service.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function service(reply = () => ({data:[], error:null})) {
  const calls = [];
  const db = {
    async rpc(name, args) {
      assert.equal(name, 'search_operations_hub_seller_items_v3');
      calls.push({name, args:plain(args)});
      return reply(args, calls.length);
    },
    from() { throw Error('seller search must use the bounded RPC'); },
    storage:new Proxy({}, {get() { throw Error('seller search must not read or mutate files'); }})
  };
  const window = {
    supabase:{createClient:() => db}, SystemV3SellerParsers:{},
    fetch:async () => { throw Error('network access is forbidden in this fixture'); }
  };
  vm.runInNewContext(source, {window, console, URL, setTimeout, clearTimeout, TextEncoder, TextDecoder, Blob, AbortController, performance});
  return {api:window.SystemV3Data, calls};
}

test('seller search routes the actual data service to V3 with the same rows, totals, and normalized paging', async () => {
  const rows = [{source_channel:'smartstore', product_code:'13805953338', option_code:'60358079673', linked_skus:['11595-6'], total_count:'6'}];
  const {api, calls} = service(() => ({data:rows, error:null}));
  assert.deepEqual(plain(await api.searchSellerItems(' smartstore ', ' 13805953338 ')), {rows, count:6, page:1, pageSize:24});
  assert.deepEqual(calls[0].args, {p_source:'smartstore', p_query:'13805953338', p_page:1, p_page_size:24, p_match_mode:'auto'});
  await api.searchSellerItems('ably', ' code ', -3, 1000, {matchMode:'product'});
  assert.deepEqual(calls[1].args, {p_source:'ably', p_query:'code', p_page:1, p_page_size:100, p_match_mode:'product'});
  await api.searchSellerItems('makeshop', '', '2', -5, {matchMode:'unsupported'});
  assert.deepEqual(calls[2].args, {p_source:'makeshop', p_query:'', p_page:2, p_page_size:1, p_match_mode:'auto'});
});

test('seller search validates the source and propagates RPC failure without a fallback read', async () => {
  const failure = {code:'57014', message:'canceling statement due to statement timeout'};
  const {api, calls} = service(() => ({data:null, error:failure}));
  await assert.rejects(api.searchSellerItems('other', 'query'), /판매처/);
  assert.equal(calls.length, 0);
  await assert.rejects(api.searchSellerItems('smartstore', 'query'), error => error === failure);
  assert.equal(calls.length, 1);
});

test('same-product option loading uses product-only pages and filters, deduplicates, and sorts returned identities', async () => {
  const product = '13805953338';
  const {api, calls} = service(args => ({data:args.p_page === 1
    ? Array.from({length:100}, (_, i) => ({product_code:product, option_code:String(100 - i), total_count:103}))
    : [{product_code:product, option_code:'2', total_count:103}, {product_code:product, option_code:'101', total_count:103}, {product_code:'other', option_code:'foreign', total_count:103}], error:null}));
  const result = await api.loadSellerProductOptions('smartstore', ` ${product} `);
  assert.equal(result.length, 101);
  assert.deepEqual(plain(result.slice(0, 3).map(row => row.option_code)), ['1', '2', '3']);
  assert.equal(result.at(-1).option_code, '101');
  assert.ok(result.every(row => row.product_code === product));
  assert.deepEqual(calls.map(call => call.args), [1, 2].map(p_page => ({p_source:'smartstore', p_query:product, p_page, p_page_size:100, p_match_mode:'product'})));
});

test('same-product option loading accepts exactly 2,000 options and rejects a truncated larger product', async () => {
  for (const total of [2000, 2001]) {
    const {api, calls} = service(args => ({data:Array.from({length:100}, (_, i) => ({product_code:'P', option_code:String((args.p_page - 1) * 100 + i), total_count:total})), error:null}));
    if (total === 2000) assert.equal((await api.loadSellerProductOptions('smartstore', 'P')).length, 2000);
    else await assert.rejects(api.loadSellerProductOptions('smartstore', 'P'), /2,000개를 초과/);
    assert.equal(calls.length, 20, 'the adapter never requests an unbounded number of pages');
    assert.ok(calls.every(call => call.args.p_match_mode === 'product' && call.args.p_page_size === 100));
  }
});

test('same-product loading refuses a blank code and retains RPC errors instead of reporting complete empty results', async () => {
  const failure = {code:'57014', message:'timeout'};
  const {api, calls} = service(() => ({data:null, error:failure}));
  await assert.rejects(api.loadSellerProductOptions('smartstore', ' '), /상품코드/);
  assert.equal(calls.length, 0);
  await assert.rejects(api.loadSellerProductOptions('smartstore', 'P'), error => error === failure);
  assert.equal(calls.length, 1);
});
