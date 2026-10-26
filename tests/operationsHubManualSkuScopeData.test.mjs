import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../mockups/operations-hub/data-service.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const row = (entry, sku, {scope = 'prefix', status = 'matched', product = null, option = null} = {}) => ({
  input_row:entry.row_no, source_channel:entry.source.toLowerCase(), input_code:entry.code,
  match_scope:scope, match_status:status, sellpia_sku_code:sku, product_code:product, option_code:option
});
function harness(handler) {
  const calls = [];
  const db = {
    rpc(name, args, options) {
      const call = {name, args:plain(args), options:plain(options), range:null};calls.push(call);
      const request = {
        range(from, to) {call.range = [from,to];return request;},
        then(resolve, reject) {
          assert.equal(name, 'resolve_operations_hub_code_entries', 'the lookup never calls a writer');
          assert.deepEqual(plain(options), {count:'exact'});assert.ok(call.range, 'every response must be paginated');
          return Promise.resolve().then(() => handler(call, calls.length - 1)).then(resolve, reject);
        }
      };
      return request;
    },
    from() {throw Error('direct table access is forbidden');},
    storage:new Proxy({}, {get() {throw Error('storage access is forbidden');}})
  };
  const win = {supabase:{createClient:() => db}};
  vm.runInContext(source, vm.createContext({window:win, URL, TextEncoder, TextDecoder, performance, console, setTimeout, clearTimeout}), {filename:'data-service.js'});
  return {api:win.SystemV3Data, calls};
}
const page = (rows, from, to) => ({data:rows.slice(from,to + 1), error:null, count:rows.length});

test('the actual data service reads every result of one prefix beyond 1000 rows and preserves source order', async () => {
  const entry = {row_no:1,source:'sellpia',code:'00123'};
  const rows = Array.from({length:2505}, (_, index) => row(entry, `00123-${String(index).padStart(4,'0')}`));
  const before = plain(rows), h = harness(call => page(rows,...call.range));
  const result = await h.api.resolveCodeEntries([entry]);
  assert.equal(result.length, 2505);assert.deepEqual(plain(result), rows);
  assert.deepEqual(h.calls.map(call => call.range), [[0,999],[1000,1999],[2000,2999]]);
  assert.ok(h.calls.every(call => call.args.p_entries.length === 1 && call.args.p_entries[0].code === '00123'));
  assert.deepEqual(rows, before);
});

test('500-entry transport chunks each page their full expansion before the next chunk, without a total SKU cap', async () => {
  const entries = Array.from({length:1001}, (_, index) => ({row_no:index + 1,source:'sellpia',code:`P${index}`})), before = plain(entries);
  const h = harness(call => {
    const rows = call.args.p_entries.flatMap(entry => Array.from({length:3}, (_, i) => row(entry, `${entry.code}-${i + 1}`)));
    return page(rows,...call.range);
  });
  const result = await h.api.resolveCodeEntries(entries);
  assert.equal(result.length, 3003);
  assert.deepEqual(h.calls.map(call => [call.args.p_entries.length,...call.range]), [[500,0,999],[500,1000,1999],[500,0,999],[500,1000,1999],[1,0,999]]);
  assert.equal(result[1500].input_code, 'P500');assert.equal(result.at(-1).input_code, 'P1000');
  assert.deepEqual(entries, before);
});

test('exact count permits smaller server pages and stops at an exact 1000-row boundary without an extra out-of-range request', async () => {
  const entry = {row_no:1,source:'sellpia',code:'A'}, rows = Array.from({length:1000}, (_, index) => row(entry, `A-${index}`));
  const exact = harness(call => page(rows,...call.range));
  assert.equal((await exact.api.resolveCodeEntries([entry])).length, 1000);assert.equal(exact.calls.length, 1);
  const smaller = harness(call => page(rows,call.range[0],Math.min(call.range[1],call.range[0] + 299)));
  assert.equal((await smaller.api.resolveCodeEntries([entry])).length, 1000);
  assert.deepEqual(smaller.calls.map(call => call.range[0]), [0,300,600,900]);
});

test('generic code-list callers retain seller, unmapped and invalid-source rows plus duplicate input occurrences', async () => {
  const entries = [
    {row_no:8,source:'SMARTSTORE',code:'P-O'}, {row_no:3,source:'makeshop',code:'M'},
    {row_no:3,source:'ably',code:'A'}, {row_no:9,source:'unknown',code:'X'},
    {row_no:10,source:'sellpia',code:'EXACT'}, {row_no:10,source:'sellpia',code:'EXACT'}
  ];
  const h = harness(call => {
    const rows = call.args.p_entries.map(entry => entry.source === 'SMARTSTORE' ? row(entry,'S-1',{scope:'option',product:'P',option:'O'})
      : entry.source === 'makeshop' ? row(entry,null,{scope:'product',status:'unmapped'})
      : entry.source === 'ably' ? row(entry,null,{scope:'none',status:'not_found'})
      : entry.source === 'unknown' ? row(entry,null,{scope:'none',status:'invalid_source'})
      : row(entry,entry.code,{scope:'sku'}));
    return page(rows,...call.range);
  });
  const result = await h.api.resolveCodeEntries(entries);
  assert.deepEqual(plain(result.map(value => value.match_status)), ['matched','unmapped','not_found','invalid_source','matched','matched']);
  assert.deepEqual(plain(result.map(value => value.input_row)), [8,3,3,9,10,10], 'outer ordering never rearranges the original input sequence');
  assert.equal(result.filter(value => value.sellpia_sku_code === 'EXACT').length, 2);
  const empty = await h.api.resolveCodeEntries([{code:'  '}, {source:'sellpia',code:null}]);
  assert.deepEqual(plain(empty), []);assert.equal(h.calls.length, 1);
});

test('null or malformed pages, missing counts, wrong identities and absent input results fail closed', async () => {
  const entries = [{row_no:1,source:'sellpia',code:'A'},{row_no:2,source:'sellpia',code:'B'}];
  const valid = entries.map(entry => row(entry,`${entry.code}-1`));
  const responses = [
    {data:null,error:null,count:2}, {data:{rows:valid},error:null,count:2}, {data:valid,error:null},
    ...[null,'2',-1,1.5,Number.MAX_SAFE_INTEGER + 1].map(count => ({data:valid,error:null,count})),
    {data:[null],error:null,count:1}, {data:[[]],error:null,count:1},
    ...[{input_row:9},{input_row:'1'},{source_channel:'ably'},{input_code:'OTHER'}].map(change => ({data:[{...valid[0],...change},valid[1]],error:null,count:2})),
    {data:[valid[0]],error:null,count:1}, {data:[],error:null,count:0},
    {data:[valid[0]],error:null,count:0}, {data:[],error:null,count:2}
  ];
  for (const response of responses) {
    const h = harness(() => response);await assert.rejects(h.api.resolveCodeEntries(entries), /코드|조회/);
  }
});

test('repeated or overlapping pages, a changing count, changed match scope and a premature empty page reject partial results', async () => {
  const entry = {row_no:1,source:'sellpia',code:'A'}, rows = Array.from({length:1200}, (_, index) => row(entry,`A-${index}`));
  for (const change of ['repeat','overlap','count','scope','empty']) {
    const h = harness((call,index) => {
      if (!index) return page(rows,...call.range);
      if (change === 'repeat') return {...page(rows,0,199),count:1200};
      if (change === 'overlap') return {...page(rows,999,1198),count:1200};
      if (change === 'count') return {...page(rows,...call.range),count:1201};
      if (change === 'scope') return {data:rows.slice(1000).map(value => ({...value,match_scope:'sku'})),error:null,count:1200};
      return {data:[],error:null,count:1200};
    });
    await assert.rejects(h.api.resolveCodeEntries([entry]), /누락|변경|반복|중복/);assert.equal(h.calls.length, 2);
  }
});

test('an RPC failure on a later page or chunk propagates and never returns an apparently complete partial scope', async () => {
  const error = {code:'57014',message:'resolver timeout'};
  const h = harness((call,index) => index ? {data:null,error,count:null} : {data:Array.from({length:1000}, (_, i) => row(call.args.p_entries[0],`A-${i}`)),error:null,count:1001});
  await assert.rejects(h.api.resolveCodeEntries([{row_no:1,source:'sellpia',code:'A'}]), actual => actual === error);assert.equal(h.calls.length, 2);
  const chunk = harness((call,index) => index ? {data:null,error,count:null} : {data:call.args.p_entries.map(entry => row(entry,entry.code,{scope:'sku'})),error:null,count:500});
  await assert.rejects(chunk.api.resolveCodeEntries(Array.from({length:501}, (_, i) => ({row_no:i + 1,source:'sellpia',code:`A${i}`}))), actual => actual === error);assert.equal(chunk.calls.length, 2);
});
