import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';

const migration = await readFile(new URL('../supabase/migrations/20261020061833_operations_hub_seller_search_v3_exact_page.sql', import.meta.url), 'utf8');
const prior = await readFile(new URL('../supabase/migrations/20260814063641_operations_hub_search_drafts_projection.sql', import.meta.url), 'utf8');
const inventory = await readFile(new URL('../supabase/migrations/20260812093000_operations_hub_seller_inventory.sql', import.meta.url), 'utf8');
const db = new PGlite();
test.after(() => db.close());
const product = '13805953338';
const active = 'a495efaa-20a1-48ea-9011-d2e8a76934b9';
const old = '00000000-0000-4000-8000-000000000001';
const uploading = '00000000-0000-4000-8000-000000000002';
const failed = '00000000-0000-4000-8000-000000000003';
const stale = '00000000-0000-4000-8000-000000000004';
const make = '00000000-0000-4000-8000-000000000005';
const ably = '00000000-0000-4000-8000-000000000006';

await db.exec(`
  create role anon; create role authenticated; create schema operations_private;
  grant usage on schema operations_private to anon,authenticated;
  create table public.seller_inventory_snapshots (
    snapshot_id uuid primary key, source_channel text not null, upload_status text not null,
    completed_at timestamptz, created_at timestamptz not null
  );
  create index seller_inventory_snapshots_latest_idx on public.seller_inventory_snapshots
    (source_channel,completed_at desc,created_at desc) where upload_status='ready';
  create table public.seller_inventory_snapshot_rows (
    snapshot_id uuid not null references public.seller_inventory_snapshots,
    product_code text not null, option_code text not null default '', seller_code text,
    product_name text, option_name text, stock integer, price numeric, sale_status text,
    primary key(snapshot_id,product_code,option_code)
  );
  create table operations_private.operations_hub_matrix_core (
    sellpia_sku_code text primary key,
    smartstore_product_code text, smartstore_option_code text,
    makeshop_product_code text, makeshop_option_code text,
    ably_product_code text, ably_option_code text
  );
  create table public.operations_hub_manual_links (
    source_channel text not null, sellpia_sku_code text not null,
    product_code text not null, option_code text not null default '',
    primary key(source_channel,sellpia_sku_code)
  );
  create index operations_hub_manual_links_listing_idx on public.operations_hub_manual_links(source_channel,product_code,option_code);
  grant select on public.seller_inventory_snapshots,public.seller_inventory_snapshot_rows,
    public.operations_hub_manual_links,operations_private.operations_hub_matrix_core to anon,authenticated;
  alter table public.seller_inventory_snapshot_rows enable row level security;
  create policy visible_inventory on public.seller_inventory_snapshot_rows for select
    to anon,authenticated using(seller_code is distinct from 'HIDDEN');
`);
await db.query(`insert into public.seller_inventory_snapshots values
  ($1,'smartstore','ready','2026-10-20T05:15:39Z','2026-10-20T05:15:30Z'),
  ($2,'smartstore','ready','2026-10-13T06:49:29Z','2026-10-13T06:49:19Z'),
  ($3,'smartstore','uploading',null,'2026-10-20T06:00:00Z'),
  ($4,'smartstore','failed','2026-10-20T06:10:00Z','2026-10-20T06:00:00Z'),
  ($5,'smartstore','ready','2026-10-12T06:00:00Z','2026-10-20T08:00:00Z'),
  ($6,'makeshop','ready','2026-10-20T05:00:00Z','2026-10-20T04:59:00Z'),
  ($7,'ably','ready','2026-10-20T04:00:00Z','2026-10-20T03:59:00Z')`, [active, old, uploading, failed, stale, make, ably]);

const targetRows = Array.from({length:6}, (_, i) => ({snapshot_id:active, product_code:product,
  option_code:String(60358079673 + i), seller_code:'TARGET-SOURCE', product_name:'14K 클래식 볼륨 원터치 링 피어싱',
  option_name:['옐로우골드/S','옐로우골드/M','옐로우골드/L','로즈골드/S','로즈골드/M','로즈골드/L'][i],
  stock:100, price:175000 + i * 500, sale_status:'판매중'}));
const fixtureRows = [
  ...targetRows,
  {snapshot_id:active, product_code:'AMBIGUOUS', option_code:product, product_name:'Other item'},
  {snapshot_id:active, product_code:`${product}-suffix`, option_code:'X', product_name:`Contains ${product}`},
  {snapshot_id:active, product_code:'NAMES1', option_code:'RED', product_name:'Classic volume ring', option_name:'Yellow M'},
  {snapshot_id:active, product_code:'NAMES2', option_code:'BLUE', product_name:'Classic volume ring', option_name:'Rose S'},
  {snapshot_id:active, product_code:'SAME', option_code:'SAME', product_name:'Equal product and option'},
  {snapshot_id:active, product_code:'NOOPTION', option_code:'', product_name:'No option'},
  {snapshot_id:active, product_code:'LIST', option_code:'01', product_name:'Listing identity'},
  {snapshot_id:active, product_code:'LIST-01', option_code:'EXTRA', product_name:'Ambiguous listing and product'},
  {snapshot_id:active, product_code:'SELLERCODE', option_code:'Z', seller_code:'UNIQUE-SELLER-44', product_name:'Other item'},
  {snapshot_id:active, product_code:'HIDDEN-CODE', option_code:'', seller_code:'HIDDEN', product_name:'Hidden by fixture RLS'},
  ...Array.from({length:7}, (_, i) => ({snapshot_id:active, product_code:`PAGE-0${i + 1}`, option_code:'', product_name:'Pagination fixture'})),
  ...[old, uploading, failed, stale].map((snapshot_id, i) => ({snapshot_id, product_code:product, option_code:`IGNORED-${i}`, product_name:'Not latest ready'})),
  {snapshot_id:old, product_code:'OLD-ONLY', option_code:'', product_name:'Not latest ready'},
  {snapshot_id:make, product_code:product, option_code:'60358079673', product_name:'Makeshop source'},
  {snapshot_id:ably, product_code:product, option_code:'60358079673', product_name:'Ably source'}
];
await db.query(`insert into public.seller_inventory_snapshot_rows
  select snapshot_id,product_code,coalesce(option_code,''),seller_code,product_name,option_name,stock,price,sale_status
  from jsonb_to_recordset($1::jsonb) as x(snapshot_id uuid,product_code text,option_code text,seller_code text,
    product_name text,option_name text,stock integer,price numeric,sale_status text)`, [JSON.stringify(fixtureRows)]);
await db.query(`insert into public.seller_inventory_snapshot_rows(snapshot_id,product_code,option_code,product_name)
  select $1::uuid,'UNRELATED-'||lpad(i::text,5,'0'),'','Background inventory' from generate_series(1,15300) i`, [active]);
await db.query(`insert into operations_private.operations_hub_matrix_core values
  ('SKU-A',$1,'60358079673',null,null,null,null),
  ('SKU-B',$1,'60358079673',$1,'60358079673',null,null),
  ('SKU-C',$1,'60358079673',null,null,null,null),
  ('SKU-D',$1,'60358079673',null,null,null,null),
  ('SKU-ABLY',null,null,null,null,$1,'60358079673')`, [product]);
await db.query(`insert into public.operations_hub_manual_links values
  ('smartstore','SKU-B',$1,'60358079674'),
  ('smartstore','SKU-D',$1,'60358079673'),
  ('smartstore','SKU-MANUAL',$1,'60358079673'),
  ('makeshop','SKU-C','OTHER-MAKE',''),
  ('ably','SKU-MANUAL',$1,'60358079673')`, [product]);

// Load the original persisted latest-view and V2 function definitions, not a JS reimplementation.
await db.exec(inventory.slice(inventory.indexOf('create or replace view public.seller_inventory_latest'), inventory.indexOf('create or replace view public.operations_hub_matrix_live')));
await db.exec(prior.slice(prior.indexOf('create or replace function public.search_operations_hub_seller_items_v2'), prior.indexOf('create or replace view public.operations_hub_dashboard_metrics')));
const dataTables = ['public.seller_inventory_snapshots','public.seller_inventory_snapshot_rows','operations_private.operations_hub_matrix_core','public.operations_hub_manual_links'];
async function dataImage() {
  return Promise.all(dataTables.map(async table => (await db.query(`select count(*)::integer as rows,md5(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text) as digest from ${table} t`)).rows[0]));
}
const before = await dataImage();
await db.exec(migration);

async function search(query = '', {source = 'smartstore', page = 1, size = 24, mode = 'auto', role = 'anon', version = 3} = {}) {
  await db.exec(`begin read only; set local role ${role};`);
  try {
    const sql = version === 2
      ? 'select * from public.search_operations_hub_seller_items_v2($1,$2,$3,$4)'
      : 'select * from public.search_operations_hub_seller_items_v3($1,$2,$3,$4,$5)';
    return (await db.query(sql, version === 2 ? [source,query,page,size] : [source,query,page,size,mode])).rows;
  } finally { await db.exec('rollback'); }
}

test('V3 executes anonymously in a read-only transaction and returns exact product options from the latest ready snapshot', async () => {
  const rows = await search(` ${product} `, {mode:'product'});
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map(row => row.option_code), targetRows.map(row => row.option_code));
  assert.ok(rows.every(row => row.product_code === product && Number(row.total_count) === 6));
  assert.equal(new Date(rows[0].snapshot_completed_at).toISOString(), '2026-10-20T05:15:39.000Z');
  assert.equal(rows[0].stock, 100);
  assert.equal(Number(rows[0].price), 175000);
  assert.equal(rows[0].sale_status, '판매중');
  assert.deepEqual(await search('OLD-ONLY'), []);
  assert.deepEqual(await search('Contains', {mode:'product'}), [], 'product-only lookup never falls back to names');
});

test('auto mode unions exact product, option, and listing identities without fuzzy spillover or duplicates', async () => {
  const rows = await search(product);
  assert.equal(rows.length, 7, 'the six exact product options and another exact option remain visible');
  assert.ok(rows.slice(0, 6).every(row => row.product_code === product));
  assert.equal(rows[6].product_code, 'AMBIGUOUS');
  assert.ok(rows.every(row => Number(row.total_count) === 7));
  assert.equal(new Set(rows.map(row => `${row.product_code}/${row.option_code}`)).size, rows.length);
  assert.deepEqual((await search('60358079673')).map(row => row.product_code), [product]);
  assert.deepEqual((await search('LIST-01')).map(row => [row.product_code,row.option_code]), [['LIST','01'], ['LIST-01','EXTRA']]);
  assert.equal((await search('SAME')).length, 1);
  assert.equal((await search('NOOPTION')).length, 1);
});

test('fallback retains partial codes, seller codes, names and product/option intersection search', async () => {
  assert.equal((await search('5807967')).length, 6);
  assert.deepEqual((await search('SELLER-44')).map(row => row.product_code), ['SELLERCODE']);
  assert.deepEqual((await search('Classic')).map(row => row.product_code), ['NAMES1','NAMES2']);
  assert.deepEqual((await search('Classic / Yellow')).map(row => row.product_code), ['NAMES1']);
  assert.equal((await search('클래식 / 로즈골드')).length, 3);
  assert.deepEqual(await search('not-present-anywhere'), []);
});

test('counts and deterministic paging describe candidates before page-scoped link lookup', async () => {
  const pages = [];
  for (const page of [1,2,3,4]) pages.push(await search('Pagination fixture', {page, size:2}));
  assert.deepEqual(pages.map(rows => rows.map(row => row.product_code)), [['PAGE-01','PAGE-02'],['PAGE-03','PAGE-04'],['PAGE-05','PAGE-06'],['PAGE-07']]);
  assert.ok(pages.flat().every(row => Number(row.total_count) === 7));
  assert.ok(pages.flat().every(row => row.linked_skus.length === 0));
  assert.deepEqual(await search('Pagination fixture', {page:5, size:2}), []);
  assert.equal((await search('', {page:-1, size:0})).length, 1);
  assert.equal((await search('', {size:500})).length, 100);
  assert.equal((await search('', {page:null, size:null})).length, 24);
  assert.deepEqual(await search('', {page:2147483647, size:100}), [], 'offset arithmetic cannot overflow a signed integer');
});

test('page links preserve original V2 manual-over-automatic precedence, channel boundaries and SKU deduplication', async () => {
  const rows = await search('클래식');
  assert.deepEqual(rows[0].linked_skus, ['SKU-A','SKU-C','SKU-D','SKU-MANUAL']);
  assert.deepEqual(rows[1].linked_skus, ['SKU-B']);
  assert.ok(rows.slice(2).every(row => row.linked_skus.length === 0));
  const previous = await search('클래식', {version:2});
  assert.deepEqual(rows.map(({product_code,option_code,linked_skus}) => ({product_code,option_code,linked_skus})), previous.map(({product_code,option_code,linked_skus}) => ({product_code,option_code,linked_skus})));
  assert.deepEqual((await search(product, {source:'makeshop'}))[0].linked_skus, ['SKU-B'], 'a Smartstore manual override does not suppress Makeshop automatic ownership');
  assert.deepEqual((await search(product, {source:'ably'}))[0].linked_skus, ['SKU-ABLY','SKU-MANUAL']);
});

test('V3 retains invoker security, source isolation, role grants and caller row policies', async () => {
  assert.deepEqual(await search(product, {source:'unknown'}), []);
  assert.deepEqual(await search('HIDDEN-CODE'), [], 'the function cannot bypass the caller row policy');
  assert.equal((await search(product, {source:' MAKESHOP ', role:'authenticated'})).length, 1);
  const [contract] = (await db.query(`select p.prosecdef,p.provolatile,
    has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
    has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute
    from pg_proc p where p.oid='public.search_operations_hub_seller_items_v3(text,text,integer,integer,text)'::regprocedure`)).rows;
  assert.deepEqual(contract, {prosecdef:false, provolatile:'s', anon_execute:true, authenticated_execute:true});
  await db.exec('set role anon');
  try {
    await assert.rejects(db.query("insert into public.operations_hub_manual_links values('smartstore','UNAUTHORIZED','P','')"), error => error.code === '42501');
  } finally { await db.exec('reset role'); }
});

test('migration rerun and all searches leave source rows and existing mappings unchanged', async () => {
  await db.exec(migration);
  assert.deepEqual(await dataImage(), before);
});
