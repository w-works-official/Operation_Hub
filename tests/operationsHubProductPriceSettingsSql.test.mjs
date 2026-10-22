import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';

const migration=fs.readFileSync(new URL('../supabase/migrations/20261022044548_hub_product_price_settings_v1.sql',import.meta.url),'utf8');
const rollback=fs.readFileSync(new URL('../supabase/rollback/20261022044548_hub_product_price_settings_v1.rollback.sql',import.meta.url),'utf8');
const db=new PGlite();test.after(()=>db.close());
const oldSnapshot='00000000-0000-4000-8000-000000000001',currentSnapshot='00000000-0000-4000-8000-000000000002';
await db.exec(`
 create role anon;create role authenticated;create role service_role;create schema operations_private;
 grant usage on schema operations_private to anon,authenticated;
 create table operations_private.test_operator_sessions(token text primary key,username text,active boolean);
 insert into operations_private.test_operator_sessions values('session-a','operator-a',true),('session-b','operator-b',true);
 create function operations_private.require_operations_hub_operator_session(token text) returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
 declare actor jsonb;begin select jsonb_build_object('username',username,'session_id','test-session-id') into actor from operations_private.test_operator_sessions where test_operator_sessions.token= $1 and active;
 if actor is null then raise exception using errcode='42501',message='operator session required';end if;return actor;end$$;
 create table public.seller_inventory_snapshots(snapshot_id uuid primary key,source_channel text,upload_status text,created_at timestamptz,completed_at timestamptz);
 create table public.seller_inventory_snapshot_rows(snapshot_id uuid,product_code text,option_code text,raw_payload jsonb,primary key(snapshot_id,product_code,option_code));
 create table public.sellpia_stock_snapshot_rows(sellpia_sku_code text primary key,stock integer,available_stock integer,raw_payload jsonb);
 create table public.operations_hub_manual_links(id integer primary key,sellpia_sku_code text,source_channel text,product_code text);
 create table operations_private.hub_effective_price_states(id integer primary key,price jsonb);
 insert into public.sellpia_stock_snapshot_rows values('SKU-1',3,2,'{"sell_price":7000}');
 insert into public.operations_hub_manual_links values(1,'SKU-1','smartstore','P0001');
 insert into operations_private.hub_effective_price_states values(1,'{"base":9000,"discounted":7000,"option":0,"final":7000}');
`);
await db.query(`insert into public.seller_inventory_snapshots values($1,'smartstore','ready','2026-10-20','2026-10-20'),($2,'smartstore','ready','2026-10-21','2026-10-21'),('00000000-0000-4000-8000-000000000003','smartstore','uploading','2026-10-22',null)`,[oldSnapshot,currentSnapshot]);
await db.query(`insert into public.seller_inventory_snapshot_rows select $1,'P'||lpad(i::text,4,'0'),'OPTION-'||j,'{"base":10000,"discount":3000}' from generate_series(1,500)i cross join generate_series(1,2)j`,[currentSnapshot]);
await db.query(`insert into public.seller_inventory_snapshot_rows values($1,'STALE','OLD','{}')`,[oldSnapshot]);
const protectedTables=['public.seller_inventory_snapshots','public.seller_inventory_snapshot_rows','public.sellpia_stock_snapshot_rows','public.operations_hub_manual_links','operations_private.hub_effective_price_states','operations_private.test_operator_sessions'];
async function image(){const result=[];for(const table of protectedTables)result.push((await db.query(`select count(*)::integer n,md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) digest from ${table} t`)).rows[0]);return result;}
async function existingSecurity(){return {
 roles:(await db.query("select rolname,rolsuper,rolcanlogin,rolbypassrls from pg_roles where rolname in('anon','authenticated','service_role') order by rolname")).rows,
 schemas:(await db.query("select nspname,nspacl::text acl from pg_namespace where nspname in('public','operations_private') order by nspname")).rows,
 tables:(await db.query("select c.oid::regclass::text relation,c.relrowsecurity,c.relacl::text acl from pg_class c where c.oid=any($1::regclass[]) order by 1",[protectedTables])).rows
};}
const before=await image(),guardBefore=(await db.query("select pg_get_functiondef('operations_private.require_operations_hub_operator_session(text)'::regprocedure) definition")).rows[0].definition;
const securityBefore=await existingSecurity();
await db.exec(migration);
const setting=(product_code,expected_revision=0,base_price=9000,basic_discount=2000)=>({product_code,base_price,basic_discount,expected_revision});
async function read(codes=['P0001'],token='session-a',source='smartstore'){return (await db.query('select public.hub_product_price_settings_read_v1($1,$2,$3::text[]) result',[token,source,codes])).rows[0].result;}
async function save(settings,requestId=randomUUID(),token='session-a',source='smartstore'){return (await db.query('select public.hub_product_price_settings_save_v1($1,$2,$3::jsonb,$4::uuid) result',[token,source,JSON.stringify(settings),requestId])).rows[0].result;}
async function isolated(fn){await db.exec('begin');try{return await fn();}finally{await db.exec('rollback');}}
async function reject(fn,code){await db.exec('savepoint expected_failure');try{await assert.rejects(fn,error=>error.code===code);}finally{await db.exec('rollback to savepoint expected_failure;release savepoint expected_failure');}}
async function counts(){return (await db.query('select (select count(*)::integer from operations_private.hub_product_price_settings) settings,(select count(*)::integer from operations_private.hub_product_price_setting_requests) receipts')).rows[0];}

test('automatic reads are stable, authenticated, bounded and never initialize settings or receipts',async()=>{
 assert.deepEqual(await read(),{contract_version:1,source:'smartstore',settings:[]});assert.deepEqual(await counts(),{settings:0,receipts:0});
 await db.exec('begin read only;set local role anon');try{assert.deepEqual((await read(['P0001','P0002'])).settings,[]);}finally{await db.exec('rollback');}
 assert.deepEqual(await counts(),{settings:0,receipts:0});
 for(const codes of [[],Array(201).fill('P0001'),[null],[''],[' P0001'],['x'.repeat(129)]])await assert.rejects(read(codes),error=>error.code==='22023');
 for(const token of [null,'expired'])await assert.rejects(read(['P0001'],token),error=>error.code==='42501');
});

test('explicit atomic batch save creates revision one and updates only B/basic with correct CAS',async()=>isolated(async()=>{
 const first=await save([setting('P0002',0,12000,4000),setting('P0001')]);
 assert.equal(first.idempotent,false);assert.equal(first.contract_version,1);assert.deepEqual(first.settings.map(row=>[row.product_code,row.base_price,row.basic_discount,row.revision]),[['P0001',9000,2000,1],['P0002',12000,4000,1]]);
 assert.ok(first.settings.every(row=>row.updated_by==='operator-a'&&row.updated_at));
 const updated=await save([setting('P0001',1,10000,3000)]);assert.equal(updated.settings[0].revision,2);
 const loaded=await read(['P0002','P0001','P0001','ABSENT']);assert.equal(loaded.settings.length,2);assert.equal(loaded.settings[0].revision,2);
 assert.deepEqual(await image(),before);assert.deepEqual(await counts(),{settings:2,receipts:2});
 const columns=(await db.query("select column_name from information_schema.columns where table_schema='operations_private' and table_name='hub_product_price_settings'")).rows.map(row=>row.column_name);
 assert.ok(!columns.some(name=>/final|option|rule|snapshot|mapping/.test(name)),'fixed finals and inputs are never persisted as product preferences');
}));

test('one conflicting revision rejects the entire batch and does not create a receipt',async()=>isolated(async()=>{
 await save([setting('P0001'),setting('P0002')]);const snapshot=await read(['P0001','P0002']);
 await reject(()=>save([setting('P0001',1,13000,5000),setting('P0002',0,14000,6000)]),'40001');
 assert.deepEqual(await read(['P0001','P0002']),snapshot);assert.deepEqual(await counts(),{settings:2,receipts:1});
 await reject(()=>save([setting('P0001',0)]),'40001');await reject(()=>save([setting('P0003',1)]),'40001');
 assert.deepEqual(await counts(),{settings:2,receipts:1});
}));

test('request receipts replay an exact canonical batch without advancing revisions even after another save',async()=>isolated(async()=>{
 const request=randomUUID(),body=[setting('P0002'),setting('P0001')],first=await save(body,request);
 const again=await save([...body].reverse(),request);assert.deepEqual(again,{...first,idempotent:true});assert.deepEqual(await counts(),{settings:2,receipts:1});
 await save([setting('P0001',1,11000,4000)]);
 assert.deepEqual(await save(body,request),{...first,idempotent:true});assert.equal((await read(['P0001'])).settings[0].revision,2);
 await reject(()=>save([setting('P0001',0,9100,2000),setting('P0002')],request),'22023');
 await reject(()=>save(body,request,'session-b'),'42501');assert.deepEqual(await counts(),{settings:2,receipts:2});
}));

test('strict JSON, whole-batch bounds, safe integers and source identity validation precede any write',async()=>isolated(async()=>{
 for(const body of [null,{},[],Array.from({length:501},(_,index)=>setting(`P${index}`)),[setting('P0001'),setting('P0001')],
  [{...setting('P0001'),final:7000}],[{...setting('P0001'),base_price:'9000'}],[{...setting('P0001'),base_price:9000.5}],
  [setting('P0001',0,-1,0)],[setting('P0001',0,10,11)],[setting('P0001',0,Number.MAX_SAFE_INTEGER+1,0)],
  [setting('P0001',-1)],[setting('P0001',Number.MAX_SAFE_INTEGER)],[setting('P0001',0,null,0)],
  [{base_price:9000,basic_discount:2000,expected_revision:0}],[setting(' P0001')],
 ])await reject(()=>save(body),'22023');
 await reject(()=>save([setting('P0001')],null),'22023');
 await reject(()=>save([setting('P0001')],randomUUID(),'session-a','makeshop'),'22023');
 assert.deepEqual(await counts(),{settings:0,receipts:0});
 const zero=await save([setting('P0001',0,0,0)]);assert.equal(zero.settings[0].base_price,0);assert.equal(zero.settings[0].basic_discount,0);
}));

test('only latest READY seller identities can be saved and receipt replay survives later source removal',async()=>isolated(async()=>{
 for(const product of ['UNKNOWN','STALE'])await reject(()=>save([setting(product)]),'22023');
 const id=randomUUID(),body=[setting('P0001')],saved=await save(body,id);
 await db.query('delete from public.seller_inventory_snapshot_rows where snapshot_id=$1 and product_code=$2',[currentSnapshot,'P0001']);
 assert.deepEqual(await save(body,id),{...saved,idempotent:true},'an already committed request remains recoverable when the source later changes');
 await reject(()=>save([setting('P0001',1)]),'22023');
}));

test('maximal 500-product explicit batch is atomic and read batches stay within 200 identities',async()=>isolated(async()=>{
 const body=Array.from({length:500},(_,index)=>setting(`P${String(index+1).padStart(4,'0')}`)),saved=await save(body);
 assert.equal(saved.settings.length,500);assert.deepEqual(await counts(),{settings:500,receipts:1});
 const all=[];for(let offset=0;offset<500;offset+=200)all.push(...(await read(body.slice(offset,offset+200).map(row=>row.product_code))).settings);
 assert.equal(all.length,500);assert.equal(new Set(all.map(row=>row.product_code)).size,500);assert.deepEqual(await image(),before);
}));

test('simultaneously submitted creates have one CAS winner with no partial losing batch or extra receipt',async()=>{
 const ids=[randomUUID(),randomUUID()],body=[setting('P0499'),setting('P0500')];
 const outcomes=await Promise.allSettled([save(body,ids[0]),save([...body].reverse(),ids[1])]);
 assert.equal(outcomes.filter(value=>value.status==='fulfilled').length,1);assert.equal(outcomes.filter(value=>value.status==='rejected'&&value.reason.code==='40001').length,1);
 assert.deepEqual(await counts(),{settings:2,receipts:1});assert.ok((await read(['P0499','P0500'])).settings.every(value=>value.revision===1));
 await db.query("delete from operations_private.hub_product_price_settings where source_channel='smartstore' and product_code=any($1::text[])",[['P0499','P0500']]);
 await db.query('delete from operations_private.hub_product_price_setting_requests where request_id=any($1::uuid[])',[ids]);
 assert.deepEqual(await counts(),{settings:0,receipts:0});
});

test('direct table access is denied, public functions are invokers and private gates revalidate sessions',async()=>{
 for(const role of ['anon','authenticated'])await isolated(async()=>{
  await db.exec(`set local role ${role}`);assert.deepEqual((await read()).settings,[]);
  for(const table of ['hub_product_price_settings','hub_product_price_setting_requests'])for(const sql of [`select * from operations_private.${table}`,`delete from operations_private.${table}`,`insert into operations_private.${table} default values`])await reject(()=>db.query(sql),'42501');
  await reject(()=>db.query("select operations_private.hub_product_price_settings_read_session_v1('bad','smartstore',array['P0001'])"),'42501');
  await reject(()=>db.query("select operations_private.hub_product_price_settings_save_session_v1('bad','smartstore',$1::jsonb,$2::uuid)",[JSON.stringify([setting('P0001')]),randomUUID()]),'42501');
  await reject(()=>save([setting('P0001')],randomUUID(),'bad'),'42501');
  const saved=await save([setting('P0001')]);assert.equal(saved.settings[0].revision,1);
 });
 const policies=(await db.query("select relname,relrowsecurity from pg_class where oid in('operations_private.hub_product_price_settings'::regclass,'operations_private.hub_product_price_setting_requests'::regclass)")).rows;
 assert.ok(policies.every(row=>row.relrowsecurity));
 const functions=(await db.query("select proname,prosecdef,provolatile,proconfig from pg_proc where proname like 'hub_product_price_settings_%v1'")).rows;
 assert.equal(functions.length,4);assert.ok(functions.every(row=>row.proconfig.includes('search_path=pg_catalog')&&row.proconfig.includes('statement_timeout=20s')));
 for(const row of functions){assert.equal(row.prosecdef,row.proname.includes('_session_'));assert.equal(row.provolatile,row.proname.includes('_read_')?'s':'v');}
 const service=(await db.query("select has_table_privilege('service_role','operations_private.hub_product_price_settings','SELECT') table_read,has_function_privilege('service_role','public.hub_product_price_settings_save_v1(text,text,jsonb,uuid)','EXECUTE') save_rpc")).rows[0];assert.deepEqual(service,{table_read:false,save_rpc:false});
});

test('read-only sessions cannot save and expired sessions cannot read or mutate settings',async()=>{
 await db.exec('begin read only;set local role anon');try{await assert.rejects(save([setting('P0001')]),error=>error.code==='25006');}finally{await db.exec('rollback');}
 await isolated(async()=>{await db.exec("update operations_private.test_operator_sessions set active=false where token='session-a'");await reject(()=>read(),'42501');await reject(()=>save([setting('P0001')]),'42501');});
 assert.deepEqual(await counts(),{settings:0,receipts:0});
});

test('rollback disables APIs while preserving saved operator settings, receipts and original source data',async()=>isolated(async()=>{
 const response=await save([setting('P0001')]),countBefore=await counts();await db.exec(rollback);
 assert.deepEqual(await counts(),countBefore);
 assert.equal((await db.query("select to_regprocedure('public.hub_product_price_settings_save_v1(text,text,jsonb,uuid)') gone")).rows[0].gone,null);
 assert.deepEqual(await image(),before);
 await db.exec(migration);assert.deepEqual((await read()).settings,response.settings,'re-enabling only these APIs recovers durable settings');
}));

test('read and explicit settings transactions leave existing source, mapping, effective prices and auth functions unchanged',async()=>{
 assert.deepEqual(await image(),before);assert.deepEqual(await counts(),{settings:0,receipts:0});
 assert.deepEqual(await existingSecurity(),securityBefore);
 assert.equal((await db.query("select pg_get_functiondef('operations_private.require_operations_hub_operator_session(text)'::regprocedure) definition")).rows[0].definition,guardBefore);
});
