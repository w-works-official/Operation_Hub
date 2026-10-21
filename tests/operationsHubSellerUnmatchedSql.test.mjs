import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';

// The deployment migration is executed below against real PostgreSQL views,
// materialized views and roles. No production transport or credentials exist.
const migration = fs.readFileSync(new URL('../supabase/migrations/20261021140435_hub_seller_unmatched_authority_v1.sql', import.meta.url), 'utf8');
const inventory = fs.readFileSync(new URL('../supabase/migrations/20260812093000_operations_hub_seller_inventory.sql', import.meta.url), 'utf8');
const oldConnection = fs.readFileSync(new URL('../supabase/migrations/20260910090000_hub_seller_unmatched_templates.sql', import.meta.url), 'utf8');
const oldMetrics = fs.readFileSync(new URL('../supabase/migrations/20260910093000_hub_dashboard_seller_unmatched_breakdown.sql', import.meta.url), 'utf8');
const oldCache = fs.readFileSync(new URL('../supabase/migrations/20260910095000_hub_seller_unmatched_template_cache.sql', import.meta.url), 'utf8');
const db = new PGlite();
test.after(() => db.close());
const snapshots = {
  smartstore:'00000000-0000-4000-8000-000000000001',
  makeshop:'00000000-0000-4000-8000-000000000002',
  ably:'00000000-0000-4000-8000-000000000003',
  old:'00000000-0000-4000-8000-000000000004',
  failed:'00000000-0000-4000-8000-000000000005',
  uploading:'00000000-0000-4000-8000-000000000006',
  lateCreated:'00000000-0000-4000-8000-000000000007'
};

await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema operations_private;
  grant usage on schema operations_private to anon,authenticated,service_role;
  create function operations_private.require_operations_hub_operator_session(token text)
  returns jsonb language plpgsql stable as $$begin
    if token is distinct from 'test-session' then raise exception using errcode='42501',message='operator session required';end if;
    return '{"username":"isolated-test"}'::jsonb;end$$;
  create table public.seller_inventory_snapshots(snapshot_id uuid primary key,source_channel text,upload_status text,completed_at timestamptz,created_at timestamptz,valid_row_count integer default 0);
  create table public.sellpia_stock_snapshots(snapshot_id uuid primary key,upload_status text,created_at timestamptz);
  insert into public.sellpia_stock_snapshots values('00000000-0000-4000-8000-000000000099','ready','2026-10-21T00:00Z');
  create table public.seller_inventory_snapshot_rows(snapshot_id uuid,product_code text,option_code text not null default '',seller_code text,
    product_name text,option_name text,stock integer,price numeric,sale_status text,primary key(snapshot_id,product_code,option_code));
  create table public.qa_sellpia_current(sellpia_sku_code text primary key);
  create view public.sellpia_stock_latest as select sellpia_sku_code from public.qa_sellpia_current;
  create table public.operations_hub_seller_listings(listing_id bigint primary key,source_channel text,product_code text,option_code text,is_active boolean,updated_at timestamptz default '2026-10-21T00:00Z');
  create table public.operations_hub_listing_components(component_id bigint primary key,listing_id bigint,sellpia_sku_code text,is_active boolean,
    component_qty numeric default 1,component_role text default 'primary',parent_component_id bigint,updated_at timestamptz default '2026-10-21T00:00Z');
  create table public.operations_hub_listing_legacy_cache(source_channel text,product_code text,option_code text,sellpia_sku_code text,
    product_name text,option_name text,refreshed_at timestamptz default '2026-10-21T00:00Z');
  create table public.operations_hub_manual_links(source_channel text,product_code text,option_code text,sellpia_sku_code text,
    mapping_origin text default 'manual',updated_by text default 'fixture',updated_at timestamptz default '2026-10-21T00:00Z');
  create table public.operations_hub_link_suppressions(source_channel text,product_code text,option_code text,sellpia_sku_code text,
    reason text default 'operator_disconnect',suppressed_at timestamptz default '2026-10-21T00:00Z');
  create table public.operations_hub_ably_inventory_mappings(product_code text,option_code text,solution_code text,sellpia_sku_code text,
    candidate_sku_code text,mapping_state text,is_active boolean,stock_policy text default 'shared',updated_at timestamptz default '2026-10-21T00:00Z');
  create table public.operations_hub_active_seller_drafts(change_id bigint,sellpia_sku_code text,source_channel text,field_key text,status text,after_value jsonb);
  create table public.qa_matrix_input(sellpia_sku_code text primary key,overall_status text default 'connected',
    smartstore_product_code text,smartstore_option_code text,makeshop_product_code text,makeshop_option_code text,ably_product_code text,ably_option_code text,
    sellpia_current_stock integer default 1,smartstore_stock integer,makeshop_stock integer,ably_stock integer,
    sellpia_inventory_at timestamptz,smartstore_inventory_at timestamptz,makeshop_inventory_at timestamptz,ably_inventory_at timestamptz,
    sellpia_override_updated_at timestamptz,cache_refreshed_at timestamptz default '2026-10-21T00:00Z');
  create table operations_private.operations_hub_matrix_core(sellpia_sku_code text primary key,
    smartstore_product_code text,smartstore_option_code text,makeshop_product_code text,makeshop_option_code text,ably_product_code text,ably_option_code text,updated_at timestamptz default '2026-10-21T00:00Z');
  create materialized view operations_private.operations_hub_matrix_export_cache as select * from public.qa_matrix_input;
  create unique index fixture_matrix_cache_sku on operations_private.operations_hub_matrix_export_cache(sellpia_sku_code);
  grant select on all tables in schema public,operations_private to anon,authenticated,service_role;
`);
await db.exec(inventory.slice(inventory.indexOf('create or replace view public.seller_inventory_latest'), inventory.indexOf('create or replace view public.operations_hub_matrix_live')));
await db.query(`insert into public.seller_inventory_snapshots(snapshot_id,source_channel,upload_status,completed_at,created_at) values
  ($1,'smartstore','ready','2026-10-21T00:00Z','2026-10-21T00:00Z'),
  ($2,'makeshop','ready','2026-10-21T00:00Z','2026-10-21T00:00Z'),
  ($3,'ably','ready','2026-10-21T00:00Z','2026-10-21T00:00Z'),
  ($4,'smartstore','ready','2026-10-20T00:00Z','2026-10-20T00:00Z'),
  ($5,'smartstore','failed','2026-10-22T00:00Z','2026-10-22T00:00Z'),
  ($6,'smartstore','uploading',null,'2026-10-22T00:00Z'),
  ($7,'smartstore','ready','2026-10-19T00:00Z','2026-10-23T00:00Z')`, Object.values(snapshots));

const expected = new Map();
const excluded = new Set([
  ['smartstore','EXPLICIT-SUPPRESSED','1'],['smartstore','EMPTY','1'],['smartstore','DISCONNECTED','1'],
  ['ably','IDENTITY-SUPPRESSED','1'],['ably','VERIFIED-TOMBSTONE','1'],['smartstore','SUPPRESSION-ONLY','1']
].map(identity=>JSON.stringify(identity)));
async function seller(source, product, option = '1', connected = false) {
  await db.query(`insert into public.seller_inventory_snapshot_rows(snapshot_id,product_code,option_code,product_name,option_name,stock,price,sale_status)
    values($1,$2,$3,$4,$5,0,1200,'판매중')`, [snapshots[source],product,option,`${product} name`,`${option} option`]);
  expected.set(JSON.stringify([source,product,option]), connected);
}
async function current(...skus) {
  for(const sku of skus) await db.query('insert into public.qa_sellpia_current values($1) on conflict do nothing',[sku]);
}
async function cached(sku,source,product,option='1') {
  const columns = {smartstore:['smartstore_product_code','smartstore_option_code'],makeshop:['makeshop_product_code','makeshop_option_code'],ably:['ably_product_code','ably_option_code']}[source];
  await db.query(`insert into public.qa_matrix_input(sellpia_sku_code,${columns[0]},${columns[1]}) values($1,$2,$3)
    on conflict(sellpia_sku_code) do update set ${columns[0]}=excluded.${columns[0]},${columns[1]}=excluded.${columns[1]}`,[sku,product,option]);
}
let listingId=1,componentId=1;
async function listing(source,product,option,skus,{active=true,componentsActive=true}={}) {
  const id=listingId++;
  await db.query('insert into public.operations_hub_seller_listings(listing_id,source_channel,product_code,option_code,is_active) values($1,$2,$3,$4,$5)',[id,source,product,option,active]);
  for(const sku of skus)await db.query('insert into public.operations_hub_listing_components(component_id,listing_id,sellpia_sku_code,is_active) values($1,$2,$3,$4)',[componentId++,id,sku,componentsActive]);
  return id;
}
async function suppress(source,product,option,sku) {
  await db.query('insert into public.operations_hub_link_suppressions(source_channel,product_code,option_code,sellpia_sku_code) values($1,$2,$3,$4)',[source,product,option,sku]);
}
async function ably(product,sku,state='verified',active=true) {
  await db.query(`insert into public.operations_hub_ably_inventory_mappings(product_code,option_code,solution_code,sellpia_sku_code,candidate_sku_code,mapping_state,is_active)
    values($1,'1',$2,$3,$3,$4,$5)`,[product,`sellpia_${sku}`,sku,state,active]);
}

await current('EXPLICIT','STALE-CACHE','EXPLICIT-OLD-OWNER','CACHE','LEGACY','EMPTY','DISCONNECTED','OTHER-SUP','INACTIVE-CACHE','SECOND-OWNER','ONE-TO-MANY','ABLY-VERIFIED','ABLY-OFF','ABLY-OLD','ABLY-CONFLICT-CACHE','ABLY-NEW','ABLY-REVIEW','ABLY-REVIEW-CACHE','ABLY-TOMBSTONE','CROSS','MANUAL','CORE');
await seller('smartstore','EXPLICIT','1',true);await cached('STALE-CACHE','smartstore','EXPLICIT');await listing('smartstore','EXPLICIT','1',['EXPLICIT']);await suppress('smartstore','EXPLICIT','1','STALE-CACHE');
await seller('smartstore','EXPLICIT-SUPPRESSED');await cached('OTHER-SUP','smartstore','EXPLICIT-SUPPRESSED');await listing('smartstore','EXPLICIT-SUPPRESSED','1',['EXPLICIT']);await suppress('smartstore','EXPLICIT-SUPPRESSED','1','EXPLICIT');
await seller('smartstore','CACHE','1',true);await cached('CACHE','smartstore','CACHE');
await seller('smartstore','LEGACY','1',true);await db.exec("insert into public.operations_hub_listing_legacy_cache(source_channel,product_code,option_code,sellpia_sku_code) values('smartstore','LEGACY','1','LEGACY')");
await seller('smartstore','EMPTY');await cached('EMPTY','smartstore','EMPTY');await listing('smartstore','EMPTY','1',[]);
await seller('smartstore','DISCONNECTED');await cached('DISCONNECTED','smartstore','DISCONNECTED');await listing('smartstore','DISCONNECTED','1',['DISCONNECTED'],{componentsActive:false});await suppress('smartstore','DISCONNECTED','1','DISCONNECTED');
await seller('smartstore','INACTIVE','1',true);await cached('INACTIVE-CACHE','smartstore','INACTIVE');await listing('smartstore','INACTIVE','1',['EXPLICIT'],{active:false});
await seller('smartstore','NOOPTION','',true);await listing('smartstore','NOOPTION',null,['EXPLICIT']);
await seller('smartstore','STALE-OPTION','NEW');await listing('smartstore','STALE-OPTION','OLD',['EXPLICIT']);
await seller('smartstore','ABSENT-SKU');await cached('NOT-CURRENT','smartstore','ABSENT-SKU');
await seller('smartstore','EXPLICIT-ABSENT-SKU');await cached('EXPLICIT-OLD-OWNER','smartstore','EXPLICIT-ABSENT-SKU');await listing('smartstore','EXPLICIT-ABSENT-SKU','1',['NOT-CURRENT']);
await seller('smartstore','MANUAL-NEW','1',true);await seller('smartstore','MANUAL-OLD');await cached('MANUAL','smartstore','MANUAL-OLD');
await db.exec("insert into public.operations_hub_manual_links(source_channel,product_code,option_code,sellpia_sku_code) values('smartstore','MANUAL-NEW','1','MANUAL');insert into public.operations_hub_listing_legacy_cache(source_channel,product_code,option_code,sellpia_sku_code) values('smartstore','MANUAL-OLD','1','MANUAL')");
await seller('smartstore','CORE','1',true);await db.exec("insert into operations_private.operations_hub_matrix_core(sellpia_sku_code,smartstore_product_code,smartstore_option_code) values('CORE','CORE','1')");
await seller('smartstore','UNMATCHED');
await seller('smartstore','SUPPRESSION-ONLY');await suppress('smartstore','SUPPRESSION-ONLY','1','EXPLICIT');
await seller('makeshop','MULTI','1',true);await cached('STALE-CACHE','makeshop','MULTI');await cached('SECOND-OWNER','makeshop','MULTI');
await seller('makeshop','1N-A','1',true);await listing('makeshop','1N-A','1',['ONE-TO-MANY']);
await seller('makeshop','1N-B','1',true);await listing('makeshop','1N-B','1',['ONE-TO-MANY']);
await seller('makeshop','OTHER-SKU-SUP','1',true);await listing('makeshop','OTHER-SKU-SUP','1',['EXPLICIT']);await suppress('makeshop','OTHER-SKU-SUP','1','STALE-CACHE');
await seller('makeshop','CROSS','1',true);await listing('makeshop','CROSS','1',['CROSS']);await seller('smartstore','CROSS');
await seller('ably','VERIFIED','1',true);await ably('VERIFIED','ABLY-VERIFIED');
await seller('ably','VERIFIED-EXPORT-OFF','1',true);await ably('VERIFIED-EXPORT-OFF','ABLY-OFF','verified',false);
await seller('ably','REVIEW');await ably('REVIEW','ABLY-REVIEW','review',false);
await seller('ably','REVIEW-WITH-CACHE','1',true);await cached('ABLY-REVIEW-CACHE','ably','REVIEW-WITH-CACHE');await ably('REVIEW-WITH-CACHE','ABLY-REVIEW','review',false);
await seller('ably','CONFLICT');await cached('ABLY-CONFLICT-CACHE','ably','CONFLICT');await ably('CONFLICT','ABLY-NEW','conflict',false);
await seller('ably','VERIFIED-OVERRIDE','1',true);await cached('ABLY-OLD','ably','VERIFIED-OVERRIDE');await ably('VERIFIED-OVERRIDE','ABLY-NEW');
await seller('ably','IDENTITY-SUPPRESSED');await ably('IDENTITY-SUPPRESSED','ABLY-VERIFIED');await suppress('ably','IDENTITY-SUPPRESSED','1','ABLY-OLD');
await seller('ably','VERIFIED-TOMBSTONE');await ably('VERIFIED-TOMBSTONE','ABLY-TOMBSTONE');await listing('ably','VERIFIED-TOMBSTONE','1',[]);
await seller('ably','ABSENT-VERIFIED-SKU');await ably('ABSENT-VERIFIED-SKU','NOT-CURRENT');
for(const id of [snapshots.old,snapshots.failed,snapshots.uploading,snapshots.lateCreated])await db.query("insert into public.seller_inventory_snapshot_rows(snapshot_id,product_code,option_code,product_name) values($1::uuid,'NOT-LATEST-'||$1::text,'1','Old or unfinished source')",[id]);
await db.query(`insert into public.seller_inventory_snapshot_rows(snapshot_id,product_code,option_code,product_name,option_name)
  select $1::uuid,'BULK-'||lpad(i::text,4,'0'),'1','Current unmatched background','Current option' from generate_series(1,1205)i`,[snapshots.makeshop]);
for(let i=1;i<=1205;i++)expected.set(JSON.stringify(['makeshop',`BULK-${String(i).padStart(4,'0')}`,'1']),false);
await db.exec('refresh materialized view operations_private.operations_hub_matrix_export_cache');
await db.exec(oldConnection);await db.exec(oldMetrics);await db.exec(oldCache);
// Replay the actual historical cycle: refreshing its MV reads the public view
// which was rebound to that same MV, so a new source row never enters it.
await seller('smartstore','CACHE-CYCLE-FRESHNESS');
await db.exec('refresh materialized view operations_private.operations_hub_seller_unmatched_cache');
const oldCacheMissedNewSource=(await db.query("select count(*)::integer n from public.operations_hub_seller_unmatched_live where product_code='CACHE-CYCLE-FRESHNESS'")).rows[0].n===0;

const protectedTables=['public.seller_inventory_snapshots','public.sellpia_stock_snapshots','public.seller_inventory_snapshot_rows','public.qa_sellpia_current','public.qa_matrix_input','operations_private.operations_hub_matrix_core','public.operations_hub_seller_listings','public.operations_hub_listing_components','public.operations_hub_listing_legacy_cache','public.operations_hub_manual_links','public.operations_hub_link_suppressions','public.operations_hub_ably_inventory_mappings','public.operations_hub_active_seller_drafts'];
async function dataImage(){const out=[];for(const table of protectedTables)out.push((await db.query(`select count(*)::integer n,md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) digest from ${table} t`)).rows[0]);return out;}
const before=await dataImage();
await db.exec(migration);
async function isolated(fn){await db.exec('begin');try{return await fn();}finally{await db.exec('rollback');}}
async function read({offset=0,limit=1000,version=null,token='test-session',role='anon'}={}) {
  await db.exec(`begin read only;set local role ${role}`);
  try{return (await db.query('select public.hub_seller_unmatched_read_v1($1,$2,$3,$4) result',[token,offset,limit,version])).rows[0].result;}
  finally{await db.exec('rollback');}
}
const identity=row=>JSON.stringify([row.source_channel,row.product_code,row.option_code??'']);
async function allRows(size=1000){const first=await read({limit:size}),rows=[...first.rows];for(let offset=size;offset<first.total;offset+=size)rows.push(...(await read({offset,limit:size,version:first.cache_version})).rows);return {...first,rows};}

test('actual SQL uses latest ready source identities and effective links without reviving disconnected or stale mappings',async()=>{
  const rows=(await db.query('select * from operations_private.hub_seller_connection_state_v1()')).rows;
  assert.equal(rows.length,expected.size);
  assert.equal(new Set(rows.map(identity)).size,rows.length,'multiple owners never multiply a seller identity');
  for(const row of rows){assert.equal(row.is_connected,expected.get(identity(row)),identity(row));assert.equal(row.is_excluded,excluded.has(identity(row)),`exclusion ${identity(row)}`);}
  assert.ok(rows.every(row=>!row.product_code.startsWith('NOT-LATEST-')));
  assert.equal(rows.find(row=>row.product_code==='MULTI').is_connected,true,'ambiguous ownership remains a connection, not export approval');
  assert.equal(rows.filter(row=>row.product_code.startsWith('1N-')).length,2,'one SKU can connect multiple seller identities');
});

test('the list, zero-size summary, and per-source totals use one exact identity population',async()=>{
  const response=await allRows(),summary=await read({limit:0});
  const missing=[...expected].filter(([key,connected])=>!connected&&!excluded.has(key)).map(([key])=>key).sort();
  assert.equal(response.contract_version,1);assert.equal(typeof response.cache_version,'string');assert.ok(response.cache_version);
  assert.deepEqual(response.rows.map(identity).sort(),missing);
  assert.equal(response.total,missing.length);assert.equal(response.seller_total,expected.size);assert.equal(response.seller_connected,[...expected.values()].filter(Boolean).length);assert.equal(response.seller_excluded,excluded.size);
  assert.equal(response.seller_total,response.total+response.seller_connected+response.seller_excluded);
  assert.deepEqual(summary.rows,[]);assert.equal(summary.total,response.total);assert.equal(summary.cache_version,response.cache_version);
  assert.deepEqual(summary.source_counts,response.source_counts);
  for(const source of ['smartstore','makeshop','ably'])assert.equal(response.source_counts[source],response.rows.filter(row=>row.source_channel===source).length);
  assert.equal(Object.values(response.source_counts).reduce((n,count)=>n+count,0),response.total);
});

test('the real historical self-refresh cache is replaced by an independently refreshable source cache',async()=>{
  assert.equal(oldCacheMissedNewSource,true,'the fixture must reproduce the old cache bug before deploying the migration');
  const current=(await db.query("select * from public.operations_hub_seller_unmatched_live where product_code='CACHE-CYCLE-FRESHNESS'")).rows;
  assert.equal(current.length,1,'the replacement cached view must include the latest source identity');
  const view=(await db.query("select pg_get_viewdef('public.operations_hub_seller_unmatched_live'::regclass,true) definition")).rows[0].definition;
  assert.doesNotMatch(view,/\boperations_hub_seller_unmatched_cache\b/,'the public list must not read the old self-referencing MV');
  await isolated(async()=>{
    await db.query("insert into public.seller_inventory_snapshot_rows(snapshot_id,product_code,option_code,product_name) values($1,'REFRESH-FRESHNESS','1','Changed source')",[snapshots.smartstore]);
    const fresh=(await db.query("select public.hub_seller_unmatched_read_v1('test-session',0,0,null) result")).rows[0].result;
    assert.equal((await db.query("select count(*)::integer n from public.operations_hub_seller_unmatched_live where product_code='REFRESH-FRESHNESS'")).rows[0].n,0,'a stale background generation must not be mistaken for the guarded current response');
    const first=(await db.query("select operations_private.refresh_hub_seller_connection_cache_v1('fixture_refresh') result")).rows[0].result;
    assert.equal(first.status,'refreshed');
    assert.equal((await db.query("select count(*)::integer n from public.operations_hub_seller_unmatched_live where product_code='REFRESH-FRESHNESS'")).rows[0].n,1);
    assert.equal((await db.query("select count(*)::integer n from operations_private.operations_hub_seller_unmatched_cache where product_code='REFRESH-FRESHNESS'")).rows[0].n,1,'the historical compatibility cache refreshes from the independent generation');
    const cachedSummary=(await db.query('select source_channel,seller_unmatched_sku from public.operations_hub_seller_connection_summary')).rows;
    assert.deepEqual(Object.fromEntries(cachedSummary.map(row=>[row.source_channel,row.seller_unmatched_sku])),fresh.source_counts);
    const dashboard=(await db.query('select seller_unmatched_sku,seller_unmatched_smartstore,seller_unmatched_makeshop,seller_unmatched_ably from public.operations_hub_dashboard_metrics')).rows[0];
    assert.equal(dashboard.seller_unmatched_sku,fresh.total);
    for(const source of ['smartstore','makeshop','ably'])assert.equal(dashboard[`seller_unmatched_${source}`],fresh.source_counts[source]);
    assert.equal((await db.query("select operations_private.refresh_hub_seller_connection_cache_v1('fixture_refresh_again') result")).rows[0].result.status,'skipped','an unchanged generation does not rewrite the caches');
  });
});

test('bounded pagination retains every unmatched identity exactly once and detects a changed list version',async()=>{
  const first=await read({limit:400}),all=[...first.rows];
  for(let offset=400;offset<first.total;offset+=400){const page=await read({offset,limit:400,version:first.cache_version});assert.equal(page.offset,offset);assert.equal(page.total,first.total);assert.equal(page.cache_version,first.cache_version);all.push(...page.rows);}
  assert.equal(all.length,first.total);assert.equal(new Set(all.map(identity)).size,all.length);
  assert.deepEqual(all,(await allRows()).rows);
  await isolated(async()=>{
    await db.query("insert into public.seller_inventory_snapshot_rows(snapshot_id,product_code,option_code,product_name) values($1,'NEW-LIVE-ROW','1','New source identity')",[snapshots.smartstore]);
    const fresh=(await db.query("select public.hub_seller_unmatched_read_v1('test-session',0,1000,null) result")).rows[0].result;
    assert.equal(fresh.total,first.total+1);assert.notEqual(fresh.cache_version,first.cache_version);
    await assert.rejects(db.query("select public.hub_seller_unmatched_read_v1('test-session',400,400,$1)",[first.cache_version]),/version|변경|다시|stale/i);
  });
});

test('source reuploads and mapping changes are visible through the guarded live read before any background cache refresh',async()=>{
  const initial=await read({limit:0});
  await isolated(async()=>{
    await db.query("update public.seller_inventory_snapshot_rows set product_name='Changed current source label' where snapshot_id=$1 and product_code='BULK-0001'",[snapshots.makeshop]);
    const changed=(await db.query("select public.hub_seller_unmatched_read_v1('test-session',0,1000,null) result")).rows[0].result;
    assert.equal(changed.total,initial.total);assert.notEqual(changed.cache_version,initial.cache_version,'a changed workbook label cannot be mixed across pages');
    assert.equal(changed.rows.find(row=>row.product_code==='BULK-0001').product_name,'Changed current source label');
  });
  await isolated(async()=>{
    await db.query("update public.seller_inventory_snapshots set upload_status='ready',completed_at='2026-10-23T00:00Z' where snapshot_id=$1",[snapshots.uploading]);
    const changed=(await db.query("select public.hub_seller_unmatched_read_v1('test-session',0,1000,null) result")).rows[0].result;
    assert.notEqual(changed.cache_version,initial.cache_version);
    const state=(await db.query('select * from operations_private.hub_seller_connection_state_v1() where source_channel=\'smartstore\'')).rows;
    assert.equal(state.length,1);assert.ok(state[0].product_code.startsWith('NOT-LATEST-'));
    assert.equal(changed.source_counts.smartstore,1,'the replacement snapshot, not the previous identity population, is counted');
  });
  await isolated(async()=>{
    const empty=(await db.query("select listing_id from public.operations_hub_seller_listings where product_code='EMPTY'")).rows[0].listing_id;
    await db.query("insert into public.operations_hub_listing_components(component_id,listing_id,sellpia_sku_code,is_active) values(9000,$1,'EMPTY',true)",[empty]);
    const changed=(await db.query("select public.hub_seller_unmatched_read_v1('test-session',0,1000,null) result")).rows[0].result;
    assert.equal(changed.total,initial.total);assert.equal(changed.seller_excluded,initial.seller_excluded-1);assert.equal(changed.seller_connected,initial.seller_connected+1);assert.notEqual(changed.cache_version,initial.cache_version);
  });
});

test('operator sessions and bounded query arguments fail closed without an anonymous legacy-view fallback',async()=>{
  for(const token of [null,'','invalid'])await assert.rejects(read({token}),/operator session|required|인증|세션/i);
  for(const args of [{offset:-1},{limit:-1},{limit:1001}])await assert.rejects(read(args),/limit|offset|범위|페이지|1,000|1000|invalid/i);
  assert.equal((await read({offset:1000000})).rows.length,0);
  await db.exec('begin read only;set local role anon');
  try{await assert.rejects(db.query('select * from operations_private.hub_seller_connection_state_v1()'),/permission denied|권한/i);}
  finally{await db.exec('rollback');}
});

test('an actually empty current source is an authenticated zero population instead of stale cached identities',async()=>isolated(async()=>{
  await db.exec('delete from public.seller_inventory_snapshot_rows');
  const empty=(await db.query("select public.hub_seller_unmatched_read_v1('test-session',0,1000,null) result")).rows[0].result;
  assert.deepEqual(empty.rows,[]);assert.equal(empty.total,0);assert.equal(empty.seller_total,0);assert.equal(empty.seller_connected,0);assert.equal(empty.seller_excluded,0);assert.equal(empty.has_more,false);
  assert.deepEqual(empty.source_counts,{smartstore:0,makeshop:0,ably:0});
}));

test('the deployment and all reads preserve source, mapping, disconnect, suppression, drafts, and operator history bytes',async()=>{
  assert.deepEqual(await dataImage(),before);
});
