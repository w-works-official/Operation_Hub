import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
const read=name=>fs.readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
const archived=name=>JSON.parse(fs.readFileSync(new URL('../supabase/baseline/statements/'+name,import.meta.url),'utf8')).statements.map(s=>s.text).join('\n');
function extractFunction(text,name){
 const start=text.search(new RegExp('create(?: or replace)?\\s+function\\s+operations_private\\.'+name+'\\s*\\(','i'));
 if(start<0)throw Error(`Missing ${name}`);const tail=text.slice(start),marker=/as\s+(\$\w*\$)/i.exec(tail);if(!marker)throw Error(name);
 const end=tail.indexOf(marker[1],marker.index+marker[0].length);return tail.slice(0,end+marker[1].length)+';';
}

const representativeSql=archived('20260917120255_hub_product_representative_price_v1.statements.json');
const baseline={functions:['hub_sync_product_price_rules_v1','hub_sync_tag_rules'].map(name=>({body:extractFunction(representativeSql,name)}))};
const target='00000000-0000-4000-8000-000000000003';
async function initialize(){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create schema operations_private;
 create table public.product_tags(tag_id uuid primary key default gen_random_uuid(),tag_name text not null unique,tag_color text,tag_group text,is_active boolean not null default true,created_by text,created_at timestamptz default now(),updated_at timestamptz default now());
 create table public.sellpia_stock_snapshots(snapshot_id int primary key,upload_status text,created_at timestamptz);
 create index ix_sellpia_stock_snapshots_ready_created on public.sellpia_stock_snapshots(upload_status,created_at desc);
 insert into public.sellpia_stock_snapshots values(1,'ready','2026-11-03');
 create table public.sellpia_stock_snapshot_rows(snapshot_id int references public.sellpia_stock_snapshots,sellpia_sku_code text,sellpia_product_code text,primary key(snapshot_id,sellpia_sku_code));
 create index ix_sellpia_stock_snapshot_rows_sku on public.sellpia_stock_snapshot_rows(sellpia_sku_code);
 insert into public.sellpia_stock_snapshot_rows select 1,'SKU'||lpad(g::text,5,'0'),'PRODUCT'||(floor((g-1)*4622.0/26828)+1)::int from generate_series(1,26828)g;
 create view public.sellpia_stock_latest as select r.* from public.sellpia_stock_snapshot_rows r join public.sellpia_stock_snapshots s using(snapshot_id) where s.snapshot_id=(select snapshot_id from public.sellpia_stock_snapshots where upload_status='ready' order by created_at desc limit 1);
 create table public.sellpia_tag_assignments(assignment_id bigint generated always as identity primary key,tag_id uuid not null references public.product_tags(tag_id),tag_scope text not null,sellpia_sku_code text,sellpia_product_code text,is_active boolean not null default true,reviewer text,memo text,source_file_name text,source_row_no int,created_at timestamptz default now(),updated_at timestamptz default now());
 create index ix_sellpia_tag_assignments_sku on public.sellpia_tag_assignments(sellpia_sku_code,is_active);
 create index ix_sellpia_tag_assignments_product on public.sellpia_tag_assignments(sellpia_product_code,is_active);
 create index ix_sellpia_tag_assignments_tag on public.sellpia_tag_assignments(tag_id,is_active);
 create unique index ux_sellpia_tag_assignments_active_target on public.sellpia_tag_assignments(tag_id,tag_scope,coalesce(sellpia_product_code,''),coalesce(sellpia_sku_code,'')) where is_active;
 create view public.operations_hub_product_profiles as select sellpia_sku_code,sellpia_product_code,'[]'::jsonb product_tags,'[]'::jsonb sku_tags from public.sellpia_stock_latest;
 create materialized view operations_private.operations_hub_matrix_export_cache as select sellpia_sku_code,'{}'::jsonb profile_json from public.operations_hub_product_profiles;
 create unique index cache_sku_idx on operations_private.operations_hub_matrix_export_cache(sellpia_sku_code);
 create table public.operations_hub_relation_nodes(node_id bigint primary key,sellpia_sku_code text,is_active boolean);
 create table public.operations_hub_relation_edges(edge_id bigint primary key,parent_node_id bigint,child_node_id bigint,is_active boolean);
 create function operations_private.require_operations_hub_operator_session(token text) returns jsonb language plpgsql as $$begin if token is distinct from 'isolated-benchmark' then raise exception 'unauthorized';end if;return '{"username":"local-benchmark"}'::jsonb;end$$;
 insert into public.product_tags(tag_id,tag_name) values('00000000-0000-4000-8000-000000000001','background-one'),('00000000-0000-4000-8000-000000000002','background-two'),('${target}','benchmark-nonformula-target');
 insert into public.sellpia_tag_assignments(tag_id,tag_scope,sellpia_sku_code,is_active)
 select case when g<=26828 then '00000000-0000-4000-8000-000000000001'::uuid else '00000000-0000-4000-8000-000000000002'::uuid end,'option','SKU'||lpad((((g-1)%26828)+1)::text,5,'0'),g<=18138 from generate_series(1,47907)g;
 `);
 for(const name of ['20260910031047_hub_field_dependencies.sql','20260910031709_hub_platform_stage_inputs.sql','20260910041347_hub_platform_rule_group_save.sql','20260910043254_hub_tag_rule_assignments.sql','20260910044039_hub_tag_rule_query_optimization.sql','20260910050448_hub_tag_apply_performance.sql'])await db.exec(read(name));
 const representative=archived('20260917120255_hub_product_representative_price_v1.statements.json');
 for(const name of ['hub_product_price_rules','hub_product_price_assignments']){const start=representative.search(new RegExp('create table operations_private\\.'+name+'\\s*\\(','i'));await db.exec(representative.slice(start,representative.indexOf(';',start)+1));}
 await db.exec('create unique index hub_product_price_rule_tag_owner on operations_private.hub_product_price_rules(tag_id) where is_active');
 await db.exec(extractFunction(archived('20260917085449_hub_tag_rename_output_ownership_v1.statements.json'),'hub_output_ownership_v1'));
 for(const fn of baseline.functions)await db.exec(fn.body);
 await db.exec('revoke all on function operations_private.hub_sync_product_price_rules_v1(text[],text) from public,anon,authenticated');
 await db.exec(read('20260912211000_hub_tag_bulk_sync.sql'));
 await db.exec(read('20260918060019_hub_tag_row_partial_apply_v2.sql'));
 await db.exec(read('20260918061313_hub_tag_partial_private_boundary_v2.sql'));
 await db.exec('analyze');
 return db;
}

const migration=read('20261103085344_skip_empty_product_price_rule_sync_v1.sql');
const rollback=fs.readFileSync(new URL('../supabase/rollback/20261103085344_skip_empty_product_price_rule_sync_v1.rollback.sql',import.meta.url),'utf8');
const signature='operations_private.hub_sync_product_price_rules_v1(text[],text)';
let db,beforeMetadata,beforeBody,beforeImage;
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0];
const normalize=text=>text.replace(/\r/g,'');
const metadata=()=>scalar(`select oid::text,proargtypes::text,proargnames,prorettype::text,prosecdef,provolatile,proconfig,proacl::text from pg_proc where oid=$1::regprocedure`,[signature]);
async function image(){
 const tables=['public.product_tags','public.sellpia_stock_snapshots','public.sellpia_stock_snapshot_rows','public.sellpia_tag_assignments','operations_private.hub_rules','operations_private.hub_rule_assignments','operations_private.hub_field_references','operations_private.hub_rule_events','operations_private.hub_product_price_rules','operations_private.hub_product_price_assignments'];
 const result={};for(const table of tables)result[table]=(await scalar(`select count(*)::int count,md5(coalesce(string_agg(to_jsonb(t)::text,'' order by to_jsonb(t)::text),'')) digest from ${table} t`));return result;
}
async function isolated(fn){await db.exec('begin');try{return await fn();}finally{await db.exec('rollback');}}
async function expectedFailure(fn,check){await db.exec('savepoint expected_failure');try{await assert.rejects(fn,check);}finally{await db.exec('rollback to savepoint expected_failure;release savepoint expected_failure');}}
const sync=skus=>db.query('select operations_private.hub_sync_product_price_rules_v1($1::text[],$2)',[skus,'fixture']);
const createRule=async({tag=target,active=true,selection='lowest'}={})=>(await scalar('insert into operations_private.hub_product_price_rules(tag_id,selection,is_active,updated_by) values($1,$2,$3,\'fixture\') returning id',[tag,selection,active])).id;

test.before(async()=>{db=await initialize();beforeMetadata=await metadata();beforeBody=(await scalar('select prosrc from pg_proc where oid=$1::regprocedure',[signature])).prosrc;beforeImage=await image();await db.exec(migration);});
test.after(async()=>{await db?.close();});

test('the complete migration adds only the locked empty-registry return and preserves function identity, ACL and all stored rows',async()=>{
 assert.deepEqual(await metadata(),beforeMetadata);assert.equal(beforeMetadata.prosecdef,false);assert.deepEqual(beforeMetadata.proconfig,['search_path=pg_catalog']);
 const body=normalize((await scalar('select prosrc from pg_proc where oid=$1::regprocedure',[signature])).prosrc);
 assert.ok(body.indexOf('pg_advisory_xact_lock')<body.indexOf('if not exists(select 1 from operations_private.hub_product_price_rules where is_active)'));
 assert.equal(body.replace(/\n -- With no active[\s\S]*?\n end if;\n/,'\n'),normalize(beforeBody));
 assert.deepEqual(await image(),beforeImage);await db.exec(migration);assert.deepEqual(await metadata(),beforeMetadata);assert.deepEqual(await image(),beforeImage);
});

test('actual v2 partial import atomically saves 16154 nonformula assignments with the empty representative registry',async()=>isolated(async()=>{
 const rows=Array.from({length:16154},(_,i)=>({sku:'SKU'+String(i+1).padStart(5,'0')}));
 const receipt=(await scalar('select public.hub_tag_bulk_import_v2($1,$2::jsonb,$3::uuid,false) result',['isolated-benchmark',JSON.stringify(rows),target])).result;
 assert.equal(receipt.row_count,16154);assert.equal(receipt.applied_count,16154);assert.equal(receipt.apply_count,16154);assert.equal(receipt.row_results.length,16154);assert.equal(receipt.invalid_count,0);assert.equal(receipt.blocked_count,0);assert.equal(receipt.rule_assignment_count,0);
 assert.equal((await scalar('select count(*)::int n from public.sellpia_tag_assignments')).n,47907+16154);
 assert.equal((await scalar('select count(*)::int n from public.sellpia_tag_assignments where tag_id=$1 and is_active',[target])).n,16154);
 assert.equal((await scalar('select count(*)::int n from operations_private.hub_product_price_assignments')).n,0);
 const after=await image();for(const table of ['public.sellpia_stock_snapshot_rows','operations_private.hub_rules','operations_private.hub_rule_assignments','operations_private.hub_field_references','operations_private.hub_product_price_rules'])assert.deepEqual(after[table],beforeImage[table],table);
}));

test('actual bulk sync saves the full requested set through the same helper and leaves sources unchanged',async()=>isolated(async()=>{
 const skus=Array.from({length:2000},(_,i)=>'SKU'+String(i+1).padStart(5,'0'));
 const receipt=(await scalar('select public.hub_tag_bulk_sync_v1($1,$2::uuid,$3::text[],false) result',['isolated-benchmark',target,skus])).result;
 assert.equal(receipt.target_count,2000);assert.equal(receipt.add_count,2000);assert.equal(receipt.remove_count,0);assert.equal(receipt.rule_assignment_count,0);
 assert.deepEqual((await image())['public.sellpia_stock_snapshot_rows'],beforeImage['public.sellpia_stock_snapshot_rows']);
}));

test('inactive rules with a residual assignment still execute the original cleanup branch',async()=>isolated(async()=>{
 const rule=await createRule({active:false});await db.query("insert into operations_private.hub_product_price_assignments(product_code,rule_id,updated_by) values('PRODUCT1',$1,'fixture')",[rule]);await sync(['SKU00001']);
 assert.equal((await scalar('select count(*)::int n from operations_private.hub_product_price_assignments')).n,0);assert.equal((await scalar('select is_active from operations_private.hub_product_price_rules where id=$1',[rule])).is_active,false);
}));

test('inactive rules with no stored assignments return without altering definitions or unrelated state',async()=>isolated(async()=>{
 await createRule({active:false});const before=await image();await sync(['SKU00001','SKU00002']);assert.deepEqual(await image(),before);
}));

test('active representative owners still synchronize and direct selection still rejects a missing explicit option',async()=>{
 for(const selection of ['lowest','direct'])await isolated(async()=>{
  const rule=await createRule({tag:'00000000-0000-4000-8000-000000000001',selection});
  if(selection==='direct'){const before=await image();await expectedFailure(()=>sync(['SKU00001']),/직접지정 대표 옵션/);assert.deepEqual(await image(),before);}
  else{await sync(['SKU00001']);assert.equal((await scalar("select rule_id from operations_private.hub_product_price_assignments where product_code='PRODUCT1'")).rule_id,rule);}
 });
});

test('the committed rollback restores the exact old body without changing data; reapply is safe',async()=>isolated(async()=>{
 const before=await image();await db.exec(rollback);assert.deepEqual(await metadata(),beforeMetadata);assert.equal(normalize((await scalar('select prosrc from pg_proc where oid=$1::regprocedure',[signature])).prosrc),normalize(beforeBody));assert.deepEqual(await image(),before);
 await db.exec(migration);assert.deepEqual(await metadata(),beforeMetadata);assert.deepEqual(await image(),before);
}));
