import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {performance} from 'node:perf_hooks';
import {PGlite} from '@electric-sql/pglite';

const migration=fs.readFileSync(new URL('../supabase/migrations/20261021124448_hub_price_decision_export_read_v1.sql',import.meta.url),'utf8');
const original=fs.readFileSync(new URL('../supabase/migrations/20261008022010_hub_price_decisions_v1.sql',import.meta.url),'utf8');
const db=new PGlite();test.after(()=>db.close());
const seller='00000000-0000-4000-8000-000000000001',sellpia='00000000-0000-4000-8000-000000000002';
await db.exec(`
  create role anon;create role authenticated;create role service_role;create schema operations_private;
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
// Execute the original functions as the active-group behavioral reference.
await db.exec(original.slice(original.indexOf('create function operations_private.hub_price_decision_mapping_fingerprint_v1'),original.indexOf('create function public.hub_price_decision_apply_v1')));
await db.exec(migration);
const tables=['public.operations_hub_listing_component_projection','public.seller_inventory_snapshots','public.sellpia_stock_snapshots','public.seller_inventory_snapshot_rows','public.sellpia_stock_snapshot_rows','operations_private.hub_price_decision_groups','operations_private.hub_effective_price_states','operations_private.hub_rule_assignments'];
async function image(){const values=[];for(const table of tables)values.push((await db.query(`select count(*)::integer n,md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) digest from ${table} t`)).rows[0]);return values;}
const before=await image();
async function read(skus,token='test-session',source='smartstore',old=false){return (await db.query(`select public.${old?'hub_price_decision_read_v1':'hub_price_decision_export_read_v1'}($1,$2,$3::text[]) result`,[token,source,skus])).rows[0].result;}
async function isolated(fn){await db.exec('begin');try{return await fn();}finally{await db.exec('rollback');}}
async function active(){
  await db.exec(`insert into operations_private.hub_price_decision_groups select 'smartstore','ACTIVE',1,operations_private.hub_price_decision_mapping_fingerprint_v1('smartstore','ACTIVE');
    insert into operations_private.hub_effective_price_states values('smartstore','ACTIVE','A','ACTIVE-A','{"base":1500,"discounted":1500,"option":0,"final":1500,"terms":[]}',7,1,'matrix_manual','2026-10-21T00:01Z');`);
}

test('actual export SQL handles 4,587 predominantly no-decision SKUs without any rule/input fingerprint', {timeout:120000}, async()=>{
  await db.exec("set qa.forbid_fingerprint='on'");
  const skus=Array.from({length:4587},(_,i)=>`SKU-${String(i+1).padStart(5,'0')}`),proofs=[],started=performance.now();
  for(let offset=0;offset<skus.length;offset+=200){
    await db.exec('begin read only;set local role anon');
    let result;try{result=await read(skus.slice(offset,offset+200));}finally{await db.exec('rollback');}
    assert.deepEqual(result.rows,[]);assert.deepEqual(result.groups,[]);
    assert.equal(result.proof_version,'sellpia-export-v1');
    assert.equal(result.snapshots.seller_snapshot_id,seller);assert.equal(result.snapshots.sellpia_snapshot_id,sellpia);
    proofs.push(...result.absence_proofs);
  }
  assert.equal(proofs.length,4587);assert.equal(new Set(proofs.map(entry=>entry.seller_product_code)).size,4587);
  assert.ok(proofs.every(entry=>entry.targets.length===1&&entry.targets[0].source_valid&&entry.revision===0&&Object.values(entry.sellpia_prices)[0]===1200));
  assert.ok(proofs.every(entry=>entry.targets[0].component_members[0].component_qty===1));
  console.log(JSON.stringify({fixture_raw_rows:15002,fixture_rule_assignments:10000,selected_skus:4587,calls:23,no_state_fingerprint_calls:0,local_sql_ms:Math.round(performance.now()-started)}));
  await db.exec("set qa.forbid_fingerprint='off'");
});

test('active products retain the complete existing group and exact current-state rows',async()=>isolated(async()=>{
  await active();
  const previous=await read(['ACTIVE-A'],'test-session','smartstore',true),result=await read(['ACTIVE-A']);
  assert.deepEqual(result.rows,previous.rows);assert.deepEqual(result.groups,previous.groups);
  assert.equal(result.groups[0].targets.length,2,'requesting one SKU retains the full product sibling group');
  assert.deepEqual(result.absence_proofs,[]);
  const oldProof=result.groups[0].input_fingerprints;
  await db.exec("set local qa.rule_version='2'");
  assert.notDeepEqual((await read(['ACTIVE-A'])).groups[0].input_fingerprints,oldProof,'active rule input changes remain part of the proof');
}));

test('invalid orphan state is returned as invalid instead of disappearing into a no-decision result',async()=>isolated(async()=>{
  await db.exec(`insert into operations_private.hub_effective_price_states values('smartstore','ORPHAN','1','SKU-00001','{"base":1500,"discounted":1500,"option":0,"final":1500,"terms":[]}',9,1,'matrix_manual','2026-10-21T00:01Z')`);
  const result=await read(['SKU-00001']);
  assert.equal(result.rows.length,1);assert.equal(result.rows[0].seller_product_code,'ORPHAN');assert.equal(result.rows[0].mapping_valid,false);
}));

test('a mapped identity missing from the current raw snapshot remains explicit invalid source evidence',async()=>isolated(async()=>{
  await db.exec("delete from public.seller_inventory_snapshot_rows where product_code='P-00001'");
  const result=await read(['SKU-00001']);
  assert.equal(result.absence_proofs.length,1);assert.equal(result.absence_proofs[0].targets.length,1);
  assert.equal(result.absence_proofs[0].targets[0].source_valid,false);assert.equal(result.absence_proofs[0].targets[0].price,null);
}));

test('no-decision proof changes with mapping quantity, raw source values, seller tuple or a newly accepted decision',async()=>{
  const initial=await read(['SKU-00001']);
  for(const sql of [
    "update public.operations_hub_listing_component_projection set component_qty=2 where sellpia_sku_code='SKU-00001'",
    `update public.sellpia_stock_snapshot_rows set raw_payload='{"sell_price":"1,500"}' where sellpia_sku_code='SKU-00001'`,
    "update public.seller_inventory_snapshot_rows set final_price=1100 where product_code='P-00001'"
  ])await isolated(async()=>{await db.exec(sql);assert.notDeepEqual((await read(['SKU-00001'])).absence_proofs,initial.absence_proofs);});
  await isolated(async()=>{
    await db.exec(`insert into operations_private.hub_price_decision_groups select 'smartstore','P-00001',1,operations_private.hub_price_decision_mapping_fingerprint_v1('smartstore','P-00001')`);
    const changed=await read(['SKU-00001']);assert.equal(changed.absence_proofs.length,0);assert.equal(changed.groups.length,1);
  });
  await isolated(async()=>{
    await db.exec(`insert into public.sellpia_stock_snapshots values('00000000-0000-4000-8000-000000000003','ready','2026-10-21T00:05Z','2026-10-21T00:05Z')`);
    assert.notDeepEqual((await read(['SKU-00001'])).snapshots,initial.snapshots);
  });
});

test('operator/session guards, bounded scope and private helper privileges are preserved',async()=>{
  for(const token of [null,'bad'])await assert.rejects(read(['SKU-00001'],token),error=>error.code==='42501');
  for(const [skus,source] of [[[],'smartstore'],[Array(201).fill('SKU-00001'),'smartstore'],[[''],'smartstore'],[['SKU-00001'],'makeshop']])await assert.rejects(read(skus,'test-session',source));
  await db.exec('set role anon');
  try{
    await assert.rejects(db.query("select operations_private.hub_price_decision_export_payload_v1('smartstore',array['SKU-00001'])"),error=>error.code==='42501');
    await assert.rejects(db.query('select * from operations_private.hub_effective_price_states'),error=>error.code==='42501');
    await assert.rejects(db.query("delete from public.seller_inventory_snapshot_rows where product_code='P-00001'"),error=>error.code==='42501');
  }finally{await db.exec('reset role');}
  const proc=(await db.query("select prosecdef,provolatile from pg_proc where oid='public.hub_price_decision_export_read_v1(text,text,text[])'::regprocedure")).rows[0];
  assert.deepEqual(proc,{prosecdef:true,provolatile:'s'});
  const rights=(await db.query("select has_function_privilege('anon','operations_private.hub_price_decision_export_payload_v1(text,text[])','EXECUTE') anon_private,has_function_privilege('authenticated','operations_private.hub_price_decision_export_payload_v1(text,text[])','EXECUTE') auth_private,has_function_privilege('service_role','operations_private.hub_price_decision_export_payload_v1(text,text[])','EXECUTE') service_private")).rows[0];
  assert.deepEqual(rights,{anon_private:false,auth_private:false,service_private:false});
});

test('all export reads leave real fixture sources, mappings, price states and rule assignments unchanged',async()=>{
  assert.deepEqual(await image(),before);
});
