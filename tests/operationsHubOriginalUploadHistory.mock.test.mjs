import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';

const serviceSource = await readFile(new URL('../mockups/operations-hub/data-service.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function createService({sellpia = [], sellers = [], session = true, queryError = null, sessionError = null} = {}) {
  const queries = [], rpcCalls = [], events = [];
  const tables = {sellpia_stock_snapshots:sellpia, seller_inventory_snapshots:sellers};
  const db = {
    rpc(name, args) {
      rpcCalls.push({name, args});
      assert.equal(name, 'operations_hub_check_session_v1', 'history only validates the operator session through RPC');
      return Promise.resolve({data:{authenticated:session}, error:sessionError});
    },
    from(table) {
      assert.ok(Object.hasOwn(tables, table), `unexpected table read: ${table}`);
      const query = {table, columns:null, orders:[], filters:[], from:0, to:null, limit:null};
      queries.push(query);
      const builder = {
        select(columns) { query.columns = columns; return this; },
        eq(key, value) { query.filters.push(row => row[key] === value); return this; },
        in(key, values) { query.filters.push(row => values.includes(row[key])); return this; },
        order(key, options = {}) { query.orders.push({key, ...options}); return this; },
        range(from, to) { query.from = from; query.to = to; return this; },
        limit(limit) { query.limit = limit; return this; },
        abortSignal(signal) { query.signal = signal; return this; },
        then(resolve, reject) {
          const error = typeof queryError === 'function' ? queryError(table) : queryError;
          if (error) return Promise.resolve({data:null, error}).then(resolve, reject);
          const rows = tables[table].filter(row => query.filters.every(filter => filter(row))).slice();
          rows.sort((left, right) => {
            for (const {key, ascending = true, nullsFirst = false} of query.orders) {
              if (left[key] === right[key]) continue;
              if (left[key] == null) return nullsFirst ? -1 : 1;
              if (right[key] == null) return nullsFirst ? 1 : -1;
              const result = left[key] < right[key] ? -1 : 1;
              return ascending ? result : -result;
            }
            return 0;
          });
          const end = query.to == null ? (query.limit == null ? rows.length : query.from + query.limit) : query.to + 1;
          return Promise.resolve({data:rows.slice(query.from, end), error:null}).then(resolve, reject);
        }
      };
      return builder;
    },
    storage: new Proxy({}, {get() { throw Error('history must never access stored file content'); }})
  };
  const win = {
    supabase:{createClient:() => db},
    SystemV3SellerParsers:{},
    crypto:{randomUUID:() => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},
    CustomEvent:class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    dispatchEvent(event) { events.push(event); },
    fetch:async () => { throw Error('history must not download file content or call external mutation endpoints'); }
  };
  const context = vm.createContext({
    window:win, URL, TextEncoder, TextDecoder, CustomEvent:win.CustomEvent,
    AbortController, AbortSignal, Blob, File:globalThis.File, performance,
    crypto:win.crypto, console, setTimeout, clearTimeout, structuredClone, Buffer
  });
  vm.runInContext(serviceSource, context, {filename:'data-service.js'});
  win.SystemV3Data.setOperationsHubSessionToken('valid-session');
  return {api:win.SystemV3Data, queries, rpcCalls, events};
}

function sellpiaRow(id, createdAt, overrides = {}) {
  return {
    snapshot_id:id, source_file_name:`${id}.xlsx`, source_row_count:10,
    valid_row_count:10, invalid_row_count:0, upload_status:'ready',
    created_at:createdAt, completed_at:createdAt, metadata:{}, ...overrides
  };
}

function sellerRow(id, source, createdAt, overrides = {}) {
  return {
    snapshot_id:id, source_channel:source, source_file_names:[`${id}.xlsx`],
    source_storage_files:[], source_row_count:10, valid_row_count:10,
    invalid_row_count:0, upload_status:'ready', upload_mode:'full',
    created_at:createdAt, completed_at:createdAt, metadata:{}, ...overrides
  };
}

test('upload history merges actual channel snapshots by upload time and keeps failed or active runs', async () => {
  const {api, queries, rpcCalls} = createService({
    sellpia:[sellpiaRow('sellpia-patch', '2026-10-20T01:24:38Z')],
    sellers:[
      sellerRow('older-completed', 'smartstore', '2026-10-13T06:49:00Z', {completed_at:'2026-10-20T04:00:00Z'}),
      sellerRow('failed', 'makeshop', '2026-10-20T02:00:00Z', {upload_status:'failed', upload_note:'원본 업로드 실패'}),
      sellerRow('active', 'ably', '2026-10-20T03:00:00Z', {upload_status:'uploading', completed_at:null})
    ]
  });
  const result = await api.loadOriginalUploadHistory();
  assert.deepEqual(plain(result.rows.map(row => row.snapshotId)), ['active', 'failed', 'sellpia-patch', 'older-completed']);
  assert.deepEqual(plain(result.rows.map(row => row.source)), ['ably', 'makeshop', 'sellpia', 'smartstore']);
  assert.deepEqual(plain(result.rows.map(row => row.status)), ['uploading', 'failed', 'ready', 'ready']);
  assert.equal(result.rows[0].completedAt, null, 'an unfinished upload cannot invent a completion timestamp');
  assert.equal(result.rows[1].errorMessage, '원본 업로드 실패');
  assert.equal(result.hasMore, false);
  assert.equal(rpcCalls.length, 1);
  assert.equal(queries.length, 2, 'history reads only the two snapshot summary tables');
  assert.ok(queries.every(query => query.columns && !query.columns.split(',').includes('*')), 'read only required summary columns');
});

test('partial Sellpia history separates uploaded rows from the retained final snapshot', async () => {
  const {api} = createService({sellpia:[sellpiaRow('patch-45', '2026-10-20T01:24:38Z', {
    source_row_count:45, valid_row_count:24544, metadata:{
      upload_mode:'patch', uploaded_row_count:45, final_row_count:24544,
      preserved_row_count:24499, source_files:[{name:'exported-list_2026-10-20_10.23.41.xlsx', size:1999}],
      selected_fields:{inventory:true}
    }
  })]});
  const {rows} = await api.loadOriginalUploadHistory();
  assert.equal(rows[0].uploadedRows, 45);
  assert.equal(rows[0].effectiveRows, 24544);
  assert.equal(rows[0].invalidRows, 0);
  assert.equal(rows[0].uploadMode, 'patch');
  assert.equal(rows[0].fileCount, 1);
  assert.deepEqual(plain(rows[0].fileNames), ['exported-list_2026-10-20_10.23.41.xlsx']);
  assert.equal(rows[0].createdAt, '2026-10-20T01:24:38Z');
});

test('narrow metadata projections retain explicit zero counts instead of substituting source or final counts', async () => {
  const {api} = createService({sellpia:[sellpiaRow('count-zero', '2026-10-20T01:24:38Z', {
    source_row_count:12, valid_row_count:24544, invalid_row_count:0,
    metadata_upload_mode:'inventory_count', metadata_uploaded_rows:'0',
    metadata_final_rows:'24544', metadata_source_files:[{name:'count.xlsx'}]
  })], sellers:[sellerRow('zero-seller', 'smartstore', '2026-10-19T01:24:38Z', {
    source_row_count:12, valid_row_count:100, metadata_uploaded_rows:'0', metadata_effective_rows:'0'
  })]});
  const {rows} = await api.loadOriginalUploadHistory();
  assert.equal(rows[0].uploadedRows, 0);
  assert.equal(rows[0].effectiveRows, 24544);
  assert.equal(rows[0].uploadMode, 'inventory_count');
  assert.equal(rows[1].uploadedRows, 0);
  assert.equal(rows[1].effectiveRows, 0);
});

test('file counts use recorded manifests and unknown counts stay unknown', async () => {
  const {api} = createService({
    sellpia:[
      sellpiaRow('legacy-files', '2026-10-20T03:00:00Z', {source_file_name:'stock.xlsx | price.xlsx | basic.xlsx'}),
      sellpiaRow('unknown-files', '2026-10-20T02:00:00Z', {source_file_name:null})
    ],
    sellers:[
      sellerRow('two-files', 'smartstore', '2026-10-20T04:00:00Z', {source_file_names:['products.xlsx', 'options.xlsx']}),
      sellerRow('stored-files', 'ably', '2026-10-20T01:00:00Z', {source_file_names:[], source_storage_files:[{name:'ably.xlsx', path:'ably/id/01.xlsx'}]}),
      sellerRow('empty-manifest', 'makeshop', '2026-10-20T00:00:00Z', {source_file_names:[], source_storage_files:[]})
    ]
  });
  const {rows} = await api.loadOriginalUploadHistory();
  const byId = new Map(rows.map(row => [row.snapshotId, row]));
  assert.equal(byId.get('two-files').fileCount, 2);
  assert.equal(byId.get('legacy-files').fileCount, 3);
  assert.equal(byId.get('stored-files').fileCount, 1);
  assert.equal(byId.get('empty-manifest').fileCount, 0);
  assert.equal(byId.get('unknown-files').fileCount, null);
});

test('any snapshot query error rejects the history instead of exposing a partial successful feed', async () => {
  for (const failedTable of ['sellpia_stock_snapshots', 'seller_inventory_snapshots']) {
    const {api} = createService({
      sellpia:[sellpiaRow('visible-if-partial', '2026-10-20T03:00:00Z')],
      sellers:[sellerRow('seller-if-partial', 'smartstore', '2026-10-20T03:00:00Z')],
      queryError:table => table === failedTable ? {message:'snapshot query unavailable', code:'NETWORK_ERROR'} : null
    });
    await assert.rejects(api.loadOriginalUploadHistory(), error => error.message === 'snapshot query unavailable');
  }
});

test('missing, expired, or unverifiable operator sessions never read snapshot history', async () => {
  const missing = createService();
  missing.api.setOperationsHubSessionToken('');
  await assert.rejects(missing.api.loadOriginalUploadHistory(), error => error.operationsHubAuthRequired === true);
  assert.equal(missing.queries.length, 0);
  assert.equal(missing.rpcCalls.length, 0);
  const expired = createService({session:false});
  await assert.rejects(expired.api.loadOriginalUploadHistory(), error => error.operationsHubAuthRequired === true);
  assert.equal(expired.queries.length, 0);
  const unavailable = createService({sessionError:{message:'session unavailable'}});
  await assert.rejects(unavailable.api.loadOriginalUploadHistory(), error => error.message === 'session unavailable');
  assert.equal(unavailable.queries.length, 0);
});

test('merged pagination remains bounded and has no overlapping or skipped runs', async () => {
  const sellpia = [], sellers = [];
  for (let index = 0; index < 30; index++) {
    const timestamp = new Date(Date.UTC(2026, 9, 20, 0, 0, 30 - index)).toISOString();
    if (index % 2) sellers.push(sellerRow(`run-${String(index).padStart(2, '0')}`, 'smartstore', timestamp));
    else sellpia.push(sellpiaRow(`run-${String(index).padStart(2, '0')}`, timestamp));
  }
  const {api, queries} = createService({sellpia:sellpia.reverse(), sellers:sellers.reverse()});
  const ids = [];
  for (let offset = 0; offset <= 30; offset += 5) {
    const start = queries.length;
    const page = await api.loadOriginalUploadHistory({limit:5, offset});
    ids.push(...page.rows.map(row => row.snapshotId));
    assert.equal(page.hasMore, offset < 25);
    assert.ok(queries.slice(start).every(query => query.from === 0 && query.to === offset + 5), 'each channel fetch is capped to the prefix needed for this merged page');
  }
  assert.deepEqual(ids, Array.from({length:30}, (_, index) => `run-${String(index).padStart(2, '0')}`));
  assert.equal(new Set(ids).size, 30);
});

test('equal upload timestamps have deterministic snapshot ordering across pages', async () => {
  const timestamp = '2026-10-20T01:00:00Z';
  const {api} = createService({
    sellpia:[sellpiaRow('s-b', timestamp), sellpiaRow('s-d', timestamp)],
    sellers:[sellerRow('s-a', 'smartstore', timestamp), sellerRow('s-c', 'ably', timestamp)]
  });
  const first = await api.loadOriginalUploadHistory({limit:2});
  const second = await api.loadOriginalUploadHistory({limit:2, offset:2});
  assert.deepEqual(plain([...first.rows, ...second.rows].map(row => row.snapshotId)), ['s-d', 's-c', 's-b', 's-a']);
});

test('invalid pagination rejects before reads and pre-aborted history cannot begin snapshot requests', async () => {
  for (const options of [{limit:101}, {limit:0}, {offset:901}, {offset:-1}]) {
    const {api, queries} = createService();
    await assert.rejects(api.loadOriginalUploadHistory(options));
    assert.equal(queries.length, 0);
  }
  const {api, queries} = createService();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(api.loadOriginalUploadHistory({signal:controller.signal}), error => error.name === 'AbortError');
  assert.equal(queries.length, 0);
});
