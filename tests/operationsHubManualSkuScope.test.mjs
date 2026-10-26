import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../mockups/operations-hub/manual-sku-scope.js', import.meta.url), 'utf8'), context);
const api = context.HubManualSkuScope;
const plain = value => JSON.parse(JSON.stringify(value));
const row = (entry, sku = null, scope = sku === null ? 'none' : sku === entry.code ? 'sku' : 'prefix') => ({
  input_row:entry.row_no, source_channel:'sellpia', input_code:entry.code,
  match_scope:scope, match_status:sku === null ? 'not_found' : 'matched',
  sellpia_sku_code:sku, product_code:null, option_code:null
});
const resolver = codes => async entries => entries.flatMap(entry => {
  if (codes.includes(entry.code)) return [row(entry, entry.code)];
  const matches = codes.filter(sku => sku.startsWith(`${entry.code}-`));
  return matches.length ? matches.map(sku => row(entry, sku, 'prefix')) : [row(entry)];
});

test('parsing preserves text and leading zeroes while deduplicating commas and whitespace in first input order', () => {
  assert.deepEqual(plain(api.parse(' 00123,8008-3\r\n00123\t8008\u00a0A-01  ')), [
    {row_no:1,source:'sellpia',code:'00123'}, {row_no:2,source:'sellpia',code:'8008-3'},
    {row_no:3,source:'sellpia',code:'8008'}, {row_no:4,source:'sellpia',code:'A-01'}
  ]);
  for (const raw of ['', ' ,\r\n\t ', null, undefined, 123, ['123']]) assert.throws(() => api.parse(raw), /문자열|하나 이상/);
  assert.equal(Object.isFrozen(api), true);
});

test('four product prefixes expand to 12 + 3 + 10 + 3 complete option SKUs', async () => {
  const groups = [['8008',12],['9009',3],['1010',10],['1111',3]];
  const codes = groups.flatMap(([prefix, count]) => Array.from({length:count}, (_, index) => `${prefix}-${index + 1}`));
  let calls = 0;
  const result = await api.resolve('8008,9009\n1010 1111', {resolveEntries:async entries => {
    calls++; assert.deepEqual(plain(entries), groups.map(([code], index) => ({row_no:index + 1,source:'sellpia',code})));
    return (await resolver(codes)(entries)).reverse();
  }});
  assert.equal(calls, 1);
  assert.equal(result.skus.length, 28);
  assert.deepEqual(plain(result.entries.map(entry => entry.skus.length)), [12,3,10,3]);
  assert.deepEqual(plain(result.unresolved), []);
  assert.ok(result.entries.every(entry => entry.status === 'matched' && entry.matchScope === 'prefix'));
  assert.ok(result.skus.every(sku => sku.includes('-')), 'no bare product prefix reaches the export scope');
});

test('mixed prefixes, exact SKUs and repeated tokens deduplicate full strings without widening exact SKU matches', async () => {
  const codes = ['8008-1','8008-3','8008-30','8008-3-1','9009-1'];
  const result = await api.resolve('8008-3 8008,8008-3 9009-1', {resolveEntries:resolver(codes)});
  assert.deepEqual(plain(result.inputs), ['8008-3','8008','9009-1']);
  assert.deepEqual(plain(result.entries[0]), {inputCode:'8008-3',matchScope:'sku',status:'matched',skus:['8008-3']});
  assert.deepEqual(plain(result.skus), [...codes].sort());
  const exact = await api.resolve('8008-3', {resolveEntries:resolver(codes)});
  assert.deepEqual(plain(exact.skus), ['8008-3']);
});

test('a bare exact SKU has priority over option prefixes and all numbers remain literal strings', async () => {
  const result = await api.resolve('00123 123 9007199254740993', {resolveEntries:resolver(['00123','00123-1','123-1','9007199254740993'])});
  assert.deepEqual(plain(result.entries.map(entry => [entry.inputCode,entry.matchScope,entry.skus])), [
    ['00123','sku',['00123']], ['123','prefix',['123-1']], ['9007199254740993','sku',['9007199254740993']]
  ]);
});

test('unknown inputs remain visible for partial and wholly unresolved scopes', async () => {
  const partial = await api.resolve('8008 missing 00000', {resolveEntries:resolver(['8008-1'])});
  assert.deepEqual(plain(partial.skus), ['8008-1']);
  assert.deepEqual(plain(partial.unresolved), [{inputCode:'missing',status:'not_found'},{inputCode:'00000',status:'not_found'}]);
  const none = await api.resolve('missing absent', {resolveEntries:resolver([])});
  assert.deepEqual(plain(none.skus), []);
  assert.equal(none.unresolved.length, 2);
  assert.ok(none.entries.every(entry => entry.matchScope === 'none' && entry.status === 'not_found' && entry.skus.length === 0));
});

test('canonical proofs ignore response order, repeated rows, separators and input reordering but bind exact resolution changes', async () => {
  const codes = ['A-1','A-2','B'];
  const first = await api.resolve('A,B unknown', {resolveEntries:resolver(codes)});
  const second = await api.resolve(' unknown B\nA,A', {resolveEntries:async entries => {
    const rows = await resolver(codes)(entries);return [...rows.reverse(), ...rows];
  }});
  assert.equal(first.key, second.key);
  for (const changed of [await api.resolve('A B unknown', {resolveEntries:resolver([...codes,'A-3'])}), await api.resolve('A B', {resolveEntries:resolver(codes)})]) assert.notEqual(first.key, changed.key);
  assert.deepEqual(JSON.parse(first.key).entries.map(entry => entry.inputCode), ['A','B','unknown']);
});

test('resolution does not mutate response rows and injected argument mutation cannot change expected identities', async () => {
  const entry = {row_no:1,source:'sellpia',code:'8008'};
  const response = [Object.freeze(row(entry, '8008-1'))], before = JSON.stringify(response);
  const result = await api.resolve('8008', {resolveEntries:async entries => {
    entries[0].code = 'different';entries.push({row_no:2,source:'ably',code:'extra'});return response;
  }});
  assert.deepEqual(plain(result.inputs), ['8008']);
  assert.deepEqual(plain(result.skus), ['8008-1']);
  assert.equal(JSON.stringify(response), before);
});

test('non-array, malformed, foreign, missing and contradictory input identities fail closed', async () => {
  const entry = {row_no:1,source:'sellpia',code:'8008'}, valid = row(entry, '8008-1');
  const invalidResponses = [null, {}, {rows:[valid]}, [], [null], ['8008-1'], [[]],
    [{...valid,input_row:'1'}], [{...valid,input_row:2}], [{...valid,input_row:1.5}],
    [{...valid,source_channel:'ably'}], [{...valid,input_code:'80080'}],
    [{...valid,product_code:'SELLER-P'}], [{...valid,option_code:'SELLER-O'}],
    [{...valid,product_code:undefined}], [{...valid,match_status:'unmapped'}],
    [{...valid,match_status:'invalid_source'}], [{...valid,match_status:'ambiguous'}],
    [{...valid,match_scope:'product'}], [{...valid,match_scope:'option'}],
    [{...valid,match_status:'not_found'}], [{...row(entry),sellpia_sku_code:'8008-1'}],
    [{...valid,match_scope:'sku'}], [{...valid,sellpia_sku_code:8008}],
    [{...valid,sellpia_sku_code:' 8008-1'}], [{...valid,sellpia_sku_code:''}],
    [valid,row(entry)], [valid,row(entry,'8008','sku')]
  ];
  for (const response of invalidResponses) await assert.rejects(api.resolve('8008', {resolveEntries:async () => response}), /조회 응답/);
  await assert.rejects(api.resolve('8008 9009', {resolveEntries:async entries => [row(entries[0],'8008-1')]}), /9009.*누락/);
});

test('prefix boundary errors and expansion of a complete SKU reject the entire response instead of selecting a similar product', async () => {
  for (const sku of ['80080-1','8008','8008-', 'X8008-1']) {
    await assert.rejects(api.resolve('8008', {resolveEntries:async entries => [row(entries[0],sku,'prefix')]}), /접두어 경계/);
  }
  await assert.rejects(api.resolve('8008-3', {resolveEntries:async entries => [row(entries[0],'8008-3-1','prefix')]}), /접두어 경계/);
  await assert.rejects(api.resolve('8008-3', {resolveEntries:async entries => [row(entries[0],'8008-30','sku')]}), /정확한 SKU/);
});

test('cross-input contradictions reject an absent or prefix code proven to be an exact SKU elsewhere', async () => {
  await assert.rejects(api.resolve('8008 8008-3', {resolveEntries:async entries => [row(entries[0],'8008-3'),row(entries[1])]}), /존재 여부/);
  await assert.rejects(api.resolve('A A-B', {resolveEntries:async entries => [row(entries[0],'A-B'),row(entries[1],'A-B-C','prefix')]}), /접두어 경계|존재 여부/);
});

test('missing transport and RPC failures propagate without a local guess or partial result', async () => {
  await assert.rejects(api.resolve('8008'), /조회 기능/);
  await assert.rejects(api.resolve('8008', {resolveEntries:42}), /조회 기능/);
  const error = Object.assign(new Error('resolver timeout'), {code:'57014'});
  await assert.rejects(api.resolve('8008', {resolveEntries:async () => {throw error;}}), actual => actual === error);
  let calls = 0;
  await assert.rejects(api.resolve(' , ', {resolveEntries:async () => {calls++;return [];}}), /하나 이상/);
  assert.equal(calls, 0);
});
