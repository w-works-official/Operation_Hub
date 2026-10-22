import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {performance} from 'node:perf_hooks';
import {PGlite} from '@electric-sql/pglite';
import '../mockups/operations-hub/current-price-export.js';

const migration=fs.readFileSync(new URL('../supabase/migrations/20261021124448_hub_price_decision_export_read_v1.sql',import.meta.url),'utf8');
const carrierMigration=fs.readFileSync(new URL('../supabase/migrations/20261021131200_hub_price_decision_export_carrier_v2.sql',import.meta.url),'utf8');
const largeMigration=fs.readFileSync(new URL('../supabase/migrations/20261022031818_hub_price_decision_export_large_groups_v3.sql',import.meta.url),'utf8');
const rollback=fs.readFileSync(new URL('../supabase/rollback/20261022031818_hub_price_decision_export_large_groups_v3.rollback.sql',import.meta.url),'utf8');
const sessionMigration=fs.readFileSync(new URL('../supabase/migrations/20261022032759_hub_price_decision_export_v3_session_gate.sql',import.meta.url),'utf8');
const sessionRollback=fs.readFileSync(new URL('../supabase/rollback/20261022032759_hub_price_decision_export_v3_session_gate.rollback.sql',import.meta.url),'utf8');
const original=fs.readFileSync(new URL('../supabase/migrations/20261008022010_hub_price_decisions_v1.sql',import.meta.url),'utf8');
const db=new PGlite();test.after(()=>db.close());
const seller='00000000-0000-4000-8000-000000000001',sellpia='00000000-0000-4000-8000-000000000002';
await db.exec(`
  create role anon;create role authenticated;create role service_role;create schema operations_private;
  grant usage on schema operations_private to anon,authenticated;
  create function operations_private.require_operations_hub_operator_session(token text) returns jsonb language plpgsql stable as $$begin
    if token is distinct from 'test-session' then raise exception using errcode='42501',message='operator session required';end if;
    return '{"username":"isolated-test"}'::jsonb;end$$;
  create function operations_private.hub_input_fingerprint_v1(sku text,source text) returns text language plpgsql stable as $$begin
    if current_setting('qa.forbid_fingerprint',true)='on' then raise exception 'no-decision branch attempted a rule/input fingerprint';end if;
    return 'fp-'||sku||'-'||source||'-'||coalesce(current_setting('qa.rule_version',true),'1');end$$;
  create function public.hub_input_fingerprints_v1(token text,skus text[],source text) returns jsonb language sql stable as $$
    select coalesce(jsonb_object_agg(sku,operations_private.hub_input_fingerprint_v1(sku,source)),'{}'::jsonb) from unnest(skus) sku$$;
  create table public.operations_hub_listing_component_projection(mapping_source text,listing_id bigint,component_id bigint,
    source_channel text,product_code text,option_code text,sellpia_sku_code text,component_qty numeric,component_role text);
  create index mapping_sku on public.operations_hub_listing_component_projection(source_channel,sellpia_sku_code);
  create index mapping_product on public.operations_hub_listing_component_projection(source_channel,btrim(product_code));
  create table operations_private.operations_hub_matrix_export_cache(sellpia_sku_code text primary key,
    smartstore_product_code text,smartstore_option_code text,makeshop_product_code text,makeshop_option_code text,ably_product_code text,ably_option_code text);
  create index cached_smartstore_product on operations_private.operations_hub_matrix_export_cache(smartstore_product_code);
  create table public.operations_hub_seller_listings(listing_id bigint primary key,source_channel text,product_code text,option_code text,is_active boolean);
  create index active_seller_identity on public.operations_hub_seller_listings(source_channel,product_code,option_code) where is_active;
  create table public.operations_hub_listing_components(component_id bigint primary key,listing_id bigint,sellpia_sku_code text,is_active boolean,component_qty numeric,component_role text);
  create index active_component_sku on public.operations_hub_listing_components(sellpia_sku_code,listing_id) where is_active;
  create table public.operations_hub_link_suppressions(source_channel text,product_code text,option_code text,sellpia_sku_code text);
  create table public.seller_inventory_snapshots(snapshot_id uuid primary key,source_channel text,upload_status text,completed_at timestamptz,created_at timestamptz);
  create table public.sellpia_stock_snapshots(snapshot_id uuid primary key,upload_status text,completed_at timestamptz,created_at timestamptz);
  create table public.seller_inventory_snapshot_rows(snapshot_id uuid,product_code text,option_code text,raw_payload jsonb,price numeric,
    base_price numeric,discounted_base_price numeric,option_price numeric,final_price numeric,discount_terms jsonb,source_row_no integer,
    primary key(snapshot_id,product_code,option_code));
  create table public.sellpia_stock_snapshot_rows(snapshot_id uuid,sellpia_sku_code text,raw_payload jsonb,primary key(snapshot_id,sellpia_sku_code));
  create table operations_private.hub_price_decision_groups(source_channel text,seller_product_code text,revision bigint,mapping_fingerprint text,primary key(source_channel,seller_product_code));
  create table operations_private.hub_effective_price_states(source_channel text,seller_product_code text,seller_option_code text,sellpia_sku_code text,
    price jsonb,event_id bigint,revision bigint,decision_source text,effective_at timestamptz,primary key(source_channel,seller_product_code,seller_option_code));
  create index state_sku on operations_private.hub_effective_price_states(sellpia_sku_code,source_channel);
  create table operations_private.hub_rule_assignments(sku text,rule_id text,scope text,target_field text);
  insert into operations_private.hub_rule_assignments select 'SKU-'||lpad(i::text,5,'0'),'rule-'||i,'smartstore','platform_final' from generate_series(1,10000)i;
`);
await db.query(`insert into public.seller_inventory_snapshots values($1,'smartstore','ready','2026-10-21T00:00Z','2026-10-21T00:00Z')`,[seller]);
await db.query(`insert into public.sellpia_stock_snapshots values($1,'ready','2026-10-21T00:00Z','2026-10-21T00:00Z')`,[sellpia]);
await db.exec(`insert into public.seller_inventory_snapshots values
  ('00000000-0000-4000-8000-000000000010','smartstore','failed','2026-10-22T00:00Z','2026-10-22T00:00Z'),
  ('00000000-0000-4000-8000-000000000011','smartstore','uploading',null,'2026-10-22T00:00Z'),
  ('00000000-0000-4000-8000-000000000012','smartstore','ready','2026-10-20T00:00Z','2026-10-22T00:00Z');
  insert into public.sellpia_stock_snapshots values
  ('00000000-0000-4000-8000-000000000013','failed','2026-10-22T00:00Z','2026-10-22T00:00Z'),
  ('00000000-0000-4000-8000-000000000014','uploading',null,'2026-10-22T00:00Z'),
  ('00000000-0000-4000-8000-000000000015','ready','2026-10-20T00:00Z','2026-10-22T00:00Z');`);
await db.exec(`insert into public.operations_hub_listing_component_projection
  select 'explicit',i,i,'smartstore','P-'||lpad(i::text,5,'0'),'1','SKU-'||lpad(i::text,5,'0'),1,'primary' from generate_series(1,15000)i;
  insert into public.operations_hub_listing_component_projection values
    ('explicit',20001,20001,'smartstore','ACTIVE','A','ACTIVE-A',1,'primary'),
    ('explicit',20001,20002,'smartstore','ACTIVE','B','ACTIVE-B',2,'secondary');`);
await db.query(`insert into public.seller_inventory_snapshot_rows
  select $1::uuid,product_code,option_code,'{}',1000,1000,1000,0,1000,'[]',(row_number() over())::integer+1 from public.operations_hub_listing_component_projection`,[seller]);
await db.query(`insert into public.sellpia_stock_snapshot_rows select $1::uuid,sellpia_sku_code,'{"sell_price":"1,200"}' from public.operations_hub_listing_component_projection`,[sellpia]);
await db.exec(`insert into operations_private.operations_hub_matrix_export_cache(sellpia_sku_code,smartstore_product_code,smartstore_option_code)
  select sellpia_sku_code,product_code,option_code from public.operations_hub_listing_component_projection;
  insert into operations_private.operations_hub_matrix_export_cache(sellpia_sku_code,smartstore_product_code,smartstore_option_code)
  select '10055-'||i,'8631469496',(36930749592+i)::text from generate_series(1,5)i;`);
await db.query(`insert into public.seller_inventory_snapshot_rows select $1::uuid,'8631469496',(36930749592+i)::text,'{}',1000,1000,1000,0,1000,'[]',20000+i from generate_series(1,5)i`,[seller]);
await db.query(`insert into public.sellpia_stock_snapshot_rows select $1::uuid,'10055-'||i,'{"sell_price":"1,200"}' from generate_series(1,5)i`,[sellpia]);
// Execute the original functions as the active-group behavioral reference.
await db.exec(original.slice(original.indexOf('create function operations_private.hub_price_decision_mapping_fingerprint_v1'),original.indexOf('create function public.hub_price_decision_apply_v1')));
await db.exec(migration);
await db.exec(carrierMigration);
const oldDefinitions=await functionDefinitions();
await db.exec(largeMigration);
const originalV3Definitions=await v3Definitions();
await db.exec(sessionMigration);
const tables=['public.operations_hub_listing_component_projection','operations_private.operations_hub_matrix_export_cache','public.operations_hub_seller_listings','public.operations_hub_listing_components','public.operations_hub_link_suppressions','public.seller_inventory_snapshots','public.sellpia_stock_snapshots','public.seller_inventory_snapshot_rows','public.sellpia_stock_snapshot_rows','operations_private.hub_price_decision_groups','operations_private.hub_effective_price_states','operations_private.hub_rule_assignments'];
async function image(){const values=[];for(const table of tables)values.push((await db.query(`select count(*)::integer n,md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) digest from ${table} t`)).rows[0]);return values;}
const before=await image();
async function read(skus,token='test-session',source='smartstore',old=false){return (await db.query(`select public.${old?'hub_price_decision_read_v1':'hub_price_decision_export_read_v3'}($1,$2,$3::text[]) result`,[token,source,skus])).rows[0].result;}
async function isolated(fn){await db.exec('begin');try{return await fn();}finally{await db.exec('rollback');}}
async function active(){
  await db.exec(`insert into operations_private.hub_price_decision_groups select 'smartstore','ACTIVE',1,operations_private.hub_price_decision_mapping_fingerprint_v1('smartstore','ACTIVE');
    insert into operations_private.hub_effective_price_states values('smartstore','ACTIVE','A','ACTIVE-A','{"base":1500,"discounted":1500,"option":0,"final":1500,"terms":[]}',7,1,'matrix_manual','2026-10-21T00:01Z');`);
}


async function functionDefinitions(){return (await db.query(`select n.nspname,p.proname,pg_get_functiondef(p.oid) definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname in('hub_price_decision_read_v1','hub_price_decision_export_payload_v1','hub_price_decision_export_payload_v2','hub_price_decision_export_read_v1','hub_price_decision_export_read_v2') order by n.nspname,p.proname`)).rows;}
async function v3Definitions(){return (await db.query(`select n.nspname,p.proname,pg_get_functiondef(p.oid) definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname in('hub_price_decision_export_read_v3','hub_price_decision_export_base_v3','hub_price_decision_export_payload_v3') order by n.nspname,p.proname`)).rows;}
async function previous(skus,source='smartstore'){return (await db.query('select public.hub_price_decision_export_read_v2($1,$2,$3::text[]) result',['test-session',source,skus])).rows[0].result;}
async function rejectInTransaction(fn,pattern){
 await db.exec('savepoint expected_failure');
 try{await assert.rejects(fn,pattern);}finally{await db.exec('rollback to savepoint expected_failure;release savepoint expected_failure');}
}
const sourceSnapshots={smartstore:seller,makeshop:'00000000-0000-4000-8000-000000000030',ably:'00000000-0000-4000-8000-000000000031'};
async function seedGroup(source,product,count,{canonical=true,cache=true,raw=true}={}){
 assert.ok(Object.hasOwn(sourceSnapshots,source));
 const snapshot=sourceSnapshots[source],prefix=`${source}-${product}-`;
 await db.query(`insert into public.seller_inventory_snapshots values($1,$2,'ready','2026-10-21T00:00Z','2026-10-21T00:00Z') on conflict do nothing`,[snapshot,source]);
 if(canonical)await db.query(`insert into public.operations_hub_listing_component_projection select 'explicit',1000000+i,1000000+i,$1,$2,i::text,$3||i,1,'primary' from generate_series(1,$4::integer)i`,[source,product,prefix,count]);
 if(cache)await db.query(`insert into operations_private.operations_hub_matrix_export_cache(sellpia_sku_code,${source}_product_code,${source}_option_code) select $1||i,$2,i::text from generate_series(1,$3::integer)i`,[prefix,product,count]);
 if(raw){
  await db.query(`insert into public.seller_inventory_snapshot_rows select $1::uuid,$2,i::text,'{}',1000,1000,1000,0,1000,'[]',30000+i from generate_series(1,$3::integer)i`,[snapshot,product,count]);
  await db.query(`insert into public.sellpia_stock_snapshot_rows select $1::uuid,$2||i,'{"sell_price":"1,200"}' from generate_series(1,$3::integer)i`,[sellpia,prefix,count]);
 }
 return {prefix,sku:`${prefix}1`,snapshot};
}

test('additive v3 keeps all deployed v1/v2/editor function definitions byte-identical and small-group proofs equal',async()=>{
 assert.deepEqual(await functionDefinitions(),oldDefinitions);
 assert.deepEqual(await read(['SKU-00001']),await previous(['SKU-00001']));
 await isolated(async()=>{await active();assert.deepEqual(await read(['ACTIVE-A']),await previous(['ACTIVE-A']));});
});

test('all three channels return a complete 218-SKU canonical and carrier group without no-state input fingerprints',{timeout:120000},async()=>{
 for(const source of ['smartstore','makeshop','ably'])await isolated(async()=>{
  const group=await seedGroup(source,'LARGE-218',218);
  await db.exec("set local qa.forbid_fingerprint='on'");
  if(source==='smartstore')await rejectInTransaction(()=>previous([group.sku]),/요청 크기 제한/);
  const result=await read([group.sku],'test-session',source);
  assert.equal(result.proof_version,'sellpia-export-v2');assert.deepEqual(result.groups,[]);assert.deepEqual(result.rows,[]);
  assert.equal(result.absence_proofs.length,1);assert.equal(result.carrier_proofs.length,1);
  for(const proof of [...result.absence_proofs,...result.carrier_proofs]){
   assert.equal(proof.source_channel,source);assert.equal(proof.targets.length,218);assert.equal(proof.snapshot_id,group.snapshot);
   assert.equal(new Set(proof.targets.flatMap(row=>row.member_skus)).size,218);
   assert.ok(proof.targets.every(row=>row.source_valid&&row.price.final===1000));
   assert.equal(Object.keys(proof.sellpia_prices).length,218);
  }
  assert.deepEqual((await read([`${group.prefix}218`],'test-session',source)).carrier_proofs,result.carrier_proofs,'full carrier proof is independent of the requested sibling');
 });
});

test('active 218-SKU products keep every unstored sibling, exact current state and full input proof for each channel',{timeout:120000},async()=>{
 for(const source of ['smartstore','makeshop','ably'])await isolated(async()=>{
  const group=await seedGroup(source,'ACTIVE-LARGE',218);
  await db.query(`insert into operations_private.hub_price_decision_groups select $1,$2,4,operations_private.hub_price_decision_mapping_fingerprint_v1($1,$2)`,[source,'ACTIVE-LARGE']);
  const tuple={base:1600,discounted:1500,option:100,final:1600,terms:[]};
  await db.query(`insert into operations_private.hub_effective_price_states values($1,$2,'1',$3,$4,42,4,'matrix_manual','2026-10-21T00:01Z')`,[source,'ACTIVE-LARGE',group.sku,JSON.stringify(tuple)]);
  const result=await read([group.sku],'test-session',source),proof=result.groups[0];
  assert.equal(proof.targets.length,218);assert.equal(Object.keys(proof.input_fingerprints).length,218);
  assert.equal(proof.mapping_valid,true);assert.equal(proof.revision,4);assert.deepEqual(result.absence_proofs,[]);
  assert.equal(proof.targets.filter(row=>row.current_state).length,1,'siblings without an accepted state stay explicit in the complete group');
  assert.deepEqual(result.rows[0].price,tuple);assert.equal(result.rows[0].event_id,42);assert.equal(result.rows[0].mapping_valid,true);
  assert.ok(Object.values(proof.input_fingerprints).every(value=>value.includes(`-${source}-`)));
 });
});

test('cache-only large groups use the exact requested marketplace fields and never promote an orphan decision',{timeout:120000},async()=>{
 for(const source of ['smartstore','makeshop','ably'])await isolated(async()=>{
  const group=await seedGroup(source,'CACHE-LARGE',219,{canonical:false});
  const other=source==='smartstore'?'makeshop':'smartstore';
  await db.query(`update operations_private.operations_hub_matrix_export_cache set ${other}_product_code='OTHER-MARKET',${other}_option_code='different' where sellpia_sku_code like $1`,[`${group.prefix}%`]);
  await db.query(`insert into operations_private.hub_effective_price_states values($1,'CACHE-LARGE','1',$2,'{"base":1700,"discounted":1700,"option":0,"final":1700,"terms":[]}',43,1,'matrix_manual','2026-10-21T00:01Z')`,[source,group.sku]);
  const result=await read([group.sku],'test-session',source);
  assert.deepEqual(result.groups,[]);assert.deepEqual(result.absence_proofs,[]);assert.equal(result.carrier_proofs.length,1);
  assert.equal(result.carrier_proofs[0].seller_product_code,'CACHE-LARGE');assert.equal(result.carrier_proofs[0].targets.length,219);
  assert.equal(result.rows.length,1);assert.equal(result.rows[0].mapping_valid,false,'a cache proof cannot turn an orphan into an accepted canonical decision');
 });
});

test('expanded total groups may exceed the old 1,000-membership limit while preserving every product',{timeout:120000},async()=>isolated(async()=>{
 const seeds=[];for(let i=0;i<5;i++)seeds.push((await seedGroup('smartstore',`TOTAL-${i}`,201)).sku);
 await db.exec("set local qa.forbid_fingerprint='on'");
 const result=await read(seeds);assert.equal(result.absence_proofs.length,5);assert.equal(result.carrier_proofs.length,5);
 assert.equal(result.absence_proofs.reduce((sum,proof)=>sum+proof.targets.length,0),1005);
}));

test('both canonical and cache expansion reject over 5,000 siblings or 20,000 memberships',{timeout:120000},async()=>{
 for(const canonical of [true,false]){
  await isolated(async()=>{
   const group=await seedGroup('smartstore',`TOO-MANY-${canonical}`,5001,{canonical,cache:!canonical,raw:false});
   await rejectInTransaction(()=>read([group.sku]),/요청 크기 제한/);
  });
  await isolated(async()=>{
   const seeds=[];for(let i=0;i<5;i++)seeds.push((await seedGroup('smartstore',`TOO-TOTAL-${canonical}-${i}`,4001,{canonical,cache:!canonical,raw:false})).sku);
   await rejectInTransaction(()=>read(seeds),/요청 크기 제한/);
  });
 }
});

test('request cap, strict operator session, private permissions, source whitelist and read-only execution remain enforced',async()=>{
 for(const token of [null,'bad'])await assert.rejects(read(['SKU-00001'],token),error=>error.code==='42501');
 for(const skus of [[],Array(201).fill('SKU-00001'),[''],['x'.repeat(129)]])await assert.rejects(read(skus));
 await assert.rejects(read(['SKU-00001'],'test-session','unknown'));
 for(const role of ['anon','authenticated'])await isolated(async()=>{
  await db.exec(`set local role ${role}`);assert.equal((await read(['SKU-00001'])).carrier_proofs.length,1);
  for(const helper of ['hub_price_decision_export_base_v3','hub_price_decision_export_payload_v3'])await rejectInTransaction(()=>db.query(`select operations_private.${helper}('smartstore',array['SKU-00001'])`),error=>error.code==='42501');
 });
 const config=(await db.query(`select prosecdef,provolatile,proconfig from pg_proc where oid='public.hub_price_decision_export_read_v3(text,text,text[])'::regprocedure`)).rows[0];
 assert.equal(config.prosecdef,false);assert.equal(config.provolatile,'s');assert.ok(config.proconfig.includes('statement_timeout=20s'));assert.ok(config.proconfig.includes('search_path=pg_catalog'));
 await db.exec('begin read only;set local role anon');try{assert.equal((await read(['SKU-00001'])).carrier_proofs.length,1);}finally{await db.exec('rollback');}
 const rights=(await db.query(`select has_function_privilege('anon','operations_private.hub_price_decision_export_base_v3(text,text[])','EXECUTE') a,has_function_privilege('authenticated','operations_private.hub_price_decision_export_payload_v3(text,text[])','EXECUTE') b,has_function_privilege('service_role','operations_private.hub_price_decision_export_payload_v3(text,text[])','EXECUTE') c`)).rows[0];
 assert.deepEqual(rights,{a:false,b:false,c:false});
});

test('public v3 is invoker-only and its unexposed definer gate always validates the custom session',async()=>{
 const unchanged=(await v3Definitions()).filter(row=>row.nspname==='operations_private');
 assert.deepEqual(unchanged,originalV3Definitions.filter(row=>row.nspname==='operations_private'),'hardening never modifies either pure payload');
 const functions=(await db.query(`select p.proname,p.prosecdef,p.provolatile,p.proconfig,l.lanname,
  exists(select 1 from aclexplode(p.proacl) a where a.grantee=0 and a.privilege_type='EXECUTE') public_execute
  from pg_proc p join pg_language l on l.oid=p.prolang where p.oid in(
   'public.hub_price_decision_export_read_v3(text,text,text[])'::regprocedure,
   'operations_private.hub_price_decision_export_read_session_v3(text,text,text[])'::regprocedure,
   'operations_private.hub_price_decision_export_base_v3(text,text[])'::regprocedure,
   'operations_private.hub_price_decision_export_payload_v3(text,text[])'::regprocedure)`)).rows;
 const byName=new Map(functions.map(row=>[row.proname,row]));
 assert.equal(byName.get('hub_price_decision_export_read_v3').lanname,'sql');
 assert.equal(byName.get('hub_price_decision_export_read_v3').prosecdef,false);
 assert.equal(byName.get('hub_price_decision_export_read_session_v3').prosecdef,true);
 for(const name of ['hub_price_decision_export_base_v3','hub_price_decision_export_payload_v3'])assert.equal(byName.get(name).prosecdef,false);
 assert.ok(functions.every(row=>row.provolatile==='s'&&!row.public_execute));
 for(const role of ['anon','authenticated'])await isolated(async()=>{
  await db.exec(`set local role ${role}`);
  for(const token of [null,'bad'])await rejectInTransaction(()=>db.query(`select operations_private.hub_price_decision_export_read_session_v3($1,'smartstore',array['SKU-00001'])`,[token]),error=>error.code==='42501');
  const direct=(await db.query(`select operations_private.hub_price_decision_export_read_session_v3('test-session','smartstore',array['SKU-00001']) result`)).rows[0].result;
  assert.deepEqual(direct,await read(['SKU-00001']),'calling the private gate directly cannot skip session validation or change proofs');
 });
 const service=(await db.query(`select has_function_privilege('service_role','public.hub_price_decision_export_read_v3(text,text,text[])','EXECUTE') rpc,
  has_function_privilege('service_role','operations_private.hub_price_decision_export_read_session_v3(text,text,text[])','EXECUTE') gate`)).rows[0];
 assert.deepEqual(service,{rpc:false,gate:false});
});

test('session-gate rollback restores exactly the pre-hardening v3 functions and payload',async()=>isolated(async()=>{
 const current=await read(['SKU-00001']);await db.exec(sessionRollback);
 assert.deepEqual(await v3Definitions(),originalV3Definitions);
 assert.equal((await db.query("select to_regprocedure('operations_private.hub_price_decision_export_read_session_v3(text,text,text[])') gone")).rows[0].gone,null);
 assert.deepEqual(await read(['SKU-00001']),current);assert.deepEqual(await functionDefinitions(),oldDefinitions);
}));

test('new reads and rollback preserve every fixture data row and deployed old function definition',async()=>{
 assert.deepEqual(await image(),before);assert.deepEqual(await functionDefinitions(),oldDefinitions);
 await isolated(async()=>{
  await db.exec(sessionRollback);await db.exec(rollback);assert.equal((await db.query("select to_regprocedure('public.hub_price_decision_export_read_v3(text,text,text[])') gone")).rows[0].gone,null);
  assert.deepEqual(await functionDefinitions(),oldDefinitions);assert.deepEqual(await image(),before);
  assert.equal((await previous(['SKU-00001'])).carrier_proofs.length,1);
 });
});
