import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
const migration=fs.readFileSync(new URL('../supabase/migrations/20261022023412_hub_export_sku_dependencies_read_v1.sql',import.meta.url),'utf8');
const rollback=fs.readFileSync(new URL('../supabase/rollback/20261022023412_hub_export_sku_dependencies_read_v1.rollback.sql',import.meta.url),'utf8');
const db=new PGlite();
test.after(()=>db.close());
const snapshot='00000000-0000-4000-8000-000000000001';
await db.exec(`
create role anon;create role authenticated;create role service_role;
create schema operations_private;
grant usage on schema operations_private to anon,authenticated,service_role;
create function operations_private.require_operations_hub_operator_session(token text)
returns jsonb language plpgsql stable as $$begin
 if token is distinct from 'test-session'then raise exception using errcode='42501',message='operator session required';end if;
 return '{"username":"isolated-test"}'::jsonb;end$$;
create table public.sellpia_stock_snapshots(snapshot_id uuid primary key,upload_status text,created_at timestamptz);
create table public.sellpia_stock_snapshot_rows(snapshot_id uuid,sellpia_sku_code text,primary key(snapshot_id,sellpia_sku_code));
create view public.sellpia_stock_latest as select r.*from public.sellpia_stock_snapshot_rows r
where r.snapshot_id=(select snapshot_id from public.sellpia_stock_snapshots where upload_status='ready'order by created_at desc limit 1);
create table public.operations_hub_relation_nodes(node_id bigint primary key,node_type text,sellpia_sku_code text,is_active boolean,updated_at timestamptz);
create table public.operations_hub_relation_edges(edge_id bigint primary key,parent_node_id bigint,child_node_id bigint,is_active boolean,sort_order integer,updated_at timestamptz);
create table public.fixture_price_history(id integer primary key,price integer);
insert into public.fixture_price_history values(1,3100),(2,5000);
insert into public.sellpia_stock_snapshots values('00000000-0000-4000-8000-000000000001','ready','2026-10-22T00:00Z');
insert into public.sellpia_stock_snapshot_rows select '00000000-0000-4000-8000-000000000001',s from unnest(array['P','C','G','S','Q','U','FREE'])r(s);
insert into public.operations_hub_relation_nodes
select id,'sellpia_sku',sku,true,'2026-10-22T00:00Z'::timestamptz
from(values(1,'P'),(2,'C'),(3,'G'),(4,'S'),(5,'Q'),(6,'U'),(7,'FREE'))r(id,sku);
insert into public.operations_hub_relation_edges values
 (1,1,2,true,100,'2026-10-22T00:00Z'),
 (2,2,3,true,100,'2026-10-22T00:00Z'),
 (3,1,4,true,200,'2026-10-22T00:00Z');
`);
await db.exec(migration);
async function read(skus,version=null){
 return(await db.query('select operations_private.hub_export_sku_dependencies_payload_v1($1::text[],$2::text)v',[skus,version])).rows[0].v;
}
async function rpc(token,skus,version=null){
 return(await db.query('select public.hub_export_sku_dependencies_read_v1($1::text,$2::text[],$3::text)v',[token,skus,version])).rows[0].v;
}
async function changed(fn){await db.exec('begin');try{return await fn();}finally{await db.exec('rollback');}}
async function rejectInTx(skus,pattern,version=null){
 await db.exec('savepoint expected_error');
 try{await assert.rejects(()=>read(skus,version),pattern);}
 finally{await db.exec('rollback to savepoint expected_error;release savepoint expected_error');}
}
async function digest(){
 return(await db.query(`select md5(jsonb_build_array(
 (select jsonb_agg(to_jsonb(s)order by snapshot_id)from public.sellpia_stock_snapshots s),
 (select jsonb_agg(to_jsonb(s)order by snapshot_id,sellpia_sku_code)from public.sellpia_stock_snapshot_rows s),
 (select jsonb_agg(to_jsonb(s)order by node_id)from public.operations_hub_relation_nodes s),
 (select jsonb_agg(to_jsonb(s)order by edge_id)from public.operations_hub_relation_edges s),
 (select jsonb_agg(to_jsonb(s)order by id)from public.fixture_price_history s))::text)d`)).rows[0].d;
}
test('parent expands every descendant and returns deterministic exact SKU edges',async()=>{
 const result=await read([' P ','P']);
 assert.equal(result.contract_version,1);assert.equal(result.snapshot_id,snapshot);
 assert.deepEqual(result.requested_skus,['P']);
 assert.deepEqual(result.selected_skus,['C','G','P','S']);assert.deepEqual(result.reference_skus,[]);
 assert.deepEqual(result.edges.map(e=>[e.parent_sku,e.child_sku]),[['C','G'],['P','C'],['P','S']]);
 assert.deepEqual(result.edges[0],{edge_id:2,parent_node_id:2,child_node_id:3,parent_sku:'C',child_sku:'G'});
 assert.deepEqual(await read(['P'],result.version),result);
});
test('child receives ancestor inputs without outputting that ancestor or its other descendants',async()=>{
 const result=await read(['C']);assert.deepEqual(result.selected_skus,['C','G']);assert.deepEqual(result.reference_skus,['P']);
 assert.deepEqual(result.edges.map(e=>[e.parent_sku,e.child_sku]),[['C','G'],['P','C']]);
 const leaf=await read(['G']);assert.deepEqual(leaf.selected_skus,['G']);assert.deepEqual(leaf.reference_skus,['C','P']);
});
test('null selects all current SKUs; unconnected SKU and inactive graph filtering remain correct',async()=>{
 assert.deepEqual((await read(null)).selected_skus,['C','FREE','G','P','Q','S','U']);
 assert.deepEqual((await read(['FREE'])).edges,[]);
 await changed(async()=>{
  await db.exec('update public.operations_hub_relation_edges set is_active=false where edge_id=1');
  assert.deepEqual((await read(['P'])).selected_skus,['P','S']);
  await db.exec('update public.operations_hub_relation_nodes set is_active=false where node_id=4');
  assert.deepEqual((await read(['P'])).selected_skus,['P']);
 });
});
test('rejects relevant product/listing/custom paths without contaminating unrelated scoped reads',async()=>{
 for(const kind of ['sellpia_product','seller_listing','custom'])await changed(async()=>{
  await db.query("insert into public.operations_hub_relation_nodes values(90,$1,null,true,'2026-10-22T00:00Z')",[kind]);
  await db.exec("insert into public.operations_hub_relation_edges values(90,6,90,true,100,'2026-10-22T00:00Z')");
  assert.deepEqual((await read(['P'])).selected_skus,['C','G','P','S']);await rejectInTx(['U'],/SKU 노드만 지원/);
  await db.exec("delete from public.operations_hub_relation_edges where edge_id=90;insert into public.operations_hub_relation_edges values(90,90,6,true,100,'2026-10-22T00:00Z')");
  await rejectInTx(['U'],/SKU 노드만 지원/);
 });
});
test('missing requested/current reference SKU and empty/null entries fail closed',async()=>{
 await assert.rejects(()=>read(['MISSING']),/최신 셀피아 원본에 없습니다/);
 await assert.rejects(()=>read([]),/1~50,000/);
 await assert.rejects(()=>read(['']),/유효한 SKU/);await assert.rejects(()=>read([null]),/유효한 SKU/);
 await changed(async()=>{await db.exec("delete from public.sellpia_stock_snapshot_rows where sellpia_sku_code='G'");await rejectInTx(['P'],/종속관계 SKU G가 최신 셀피아/);});
 await changed(async()=>{await db.exec("delete from public.sellpia_stock_snapshot_rows where sellpia_sku_code='P'");await rejectInTx(['C'],/종속관계 SKU P가 최신 셀피아/);});
});
test('self identity, distinct multiple parents and cycles reject safely',async()=>{
 await changed(async()=>{
  await db.exec("insert into public.operations_hub_relation_nodes values(91,'sellpia_sku','P',true,'2026-10-22T00:00Z');insert into public.operations_hub_relation_edges values(91,1,91,true,100,'2026-10-22T00:00Z')");
  await rejectInTx(['P'],/자기 참조/);
 });
 await changed(async()=>{await db.exec("insert into public.operations_hub_relation_edges values(92,5,2,true,100,'2026-10-22T00:00Z')");await rejectInTx(['C'],/상위 SKU가 여러 개/);});
 await changed(async()=>{await db.exec("insert into public.operations_hub_relation_edges values(93,3,1,true,100,'2026-10-22T00:00Z')");await rejectInTx(['P'],/순환 종속관계/);});
});
test('version covers relevant metadata/source snapshot and excludes unrelated graph or price state',async()=>{
 const before=await read(['P']);
 await changed(async()=>{
  await db.exec('update public.operations_hub_relation_edges set sort_order=sort_order+1 where edge_id=1');
  assert.notEqual((await read(['P'])).version,before.version);
  await rejectInTx(['P'],/종속관계 또는 셀피아 원본이 변경/,before.version);
 });
 await changed(async()=>{
  await db.exec("insert into public.operations_hub_relation_edges values(94,6,7,true,100,'2026-10-22T00:00Z')");
  assert.equal((await read(['P'])).version,before.version);
  await db.exec('update public.fixture_price_history set price=price+1');assert.equal((await read(['P'])).version,before.version);
 });
 await changed(async()=>{
  const newer='00000000-0000-4000-8000-000000000002';
  await db.query("insert into public.sellpia_stock_snapshots values($1,'ready','2026-10-23T00:00Z')",[newer]);
  await db.query('insert into public.sellpia_stock_snapshot_rows select $1::uuid,sellpia_sku_code from public.sellpia_stock_snapshot_rows where snapshot_id=$2::uuid',[newer,snapshot]);
  assert.notEqual((await read(['P'])).version,before.version);await rejectInTx(['P'],/변경/,before.version);
 });
 await db.exec("set timezone='Asia/Seoul'");try{assert.equal((await read(['P'])).version,before.version);}finally{await db.exec("set timezone='UTC'");}
});
test('supports 26,844 current SKUs and enforces 50,000 request/expanded bounds',async()=>{
 await assert.rejects(()=>read(Array(50001).fill('P')),/50,000/);
 await changed(async()=>{
  await db.query("insert into public.sellpia_stock_snapshot_rows select $1::uuid,'BULK-'||lpad(i::text,5,'0')from generate_series(1,26837)i",[snapshot]);
  const full=await read(null);assert.equal(full.requested_skus.length,26844);assert.equal(full.selected_skus.length,26844);assert.equal(full.edges.length,3);
  await db.query("insert into public.sellpia_stock_snapshot_rows select $1::uuid,'MORE-'||lpad(i::text,5,'0')from generate_series(1,23157)i",[snapshot]);
  await rejectInTx(null,/50,000/);
 });
});
test('descendant and ancestor expansion are bounded independently of the original one-SKU selection',async()=>{
 await changed(async()=>{
  await db.query("insert into public.sellpia_stock_snapshot_rows select $1::uuid,'WIDE-'||i::text from generate_series(1,50000)i",[snapshot]);
  await db.exec("insert into public.operations_hub_relation_nodes select 100000+i,'sellpia_sku','WIDE-'||i::text,true,'2026-10-22T00:00Z'::timestamptz from generate_series(1,50000)i");
  await db.exec("insert into public.operations_hub_relation_edges select 100000+i,1,100000+i,true,100,'2026-10-22T00:00Z'::timestamptz from generate_series(1,50000)i");
  await rejectInTx(['P'],/하위 종속관계를 포함한 범위가 50,000/);
  await db.exec('update public.operations_hub_relation_edges set parent_node_id=child_node_id,child_node_id=2 where edge_id>100000');
  await rejectInTx(['C'],/상위 참조를 포함한 종속관계 범위가 50,000/);
 });
});
test('anon/auth session guard works and pure helpers are inaccessible',async()=>{
 const before=await digest();
 for(const role of ['anon','authenticated']){
  await db.exec('set role '+role);
  try{
   await assert.rejects(()=>rpc(null,['P']),/operator session required/);
   await assert.rejects(()=>rpc('revoked-session',['P']),/operator session required/);
   assert.equal((await rpc('test-session',['P'])).selected_skus.length,4);
   await assert.rejects(()=>read(['P']),/permission denied for function/);
  }finally{await db.exec('reset role');}
 }
 assert.equal(await digest(),before);
 assert.deepEqual((await db.query(`select
 has_function_privilege('anon','operations_private.hub_export_sku_graph_edges_v1()','execute')raw,
 has_function_privilege('authenticated','operations_private.hub_export_sku_dependencies_payload_v1(text[],text)','execute')payload,
 has_function_privilege('service_role','operations_private.hub_export_sku_dependencies_payload_v1(text[],text)','execute')service`)).rows[0],{raw:false,payload:false,service:false});
});
test('read-only transaction and actual rollback/reapply preserve all operator/source/price rows',async()=>{
 const before=await digest();await db.exec('begin read only');
 try{const a=await read(['P']);assert.equal((await rpc('test-session',['P'],a.version)).version,a.version);}finally{await db.exec('rollback');}
 assert.equal(await digest(),before);await db.exec(rollback);
 assert.equal((await db.query("select to_regprocedure('public.hub_export_sku_dependencies_read_v1(text,text[],text)')p")).rows[0].p,null);
 assert.equal(await digest(),before);await db.exec(migration);
 assert.deepEqual((await read(['P'])).selected_skus,['C','G','P','S']);assert.equal(await digest(),before);
});

