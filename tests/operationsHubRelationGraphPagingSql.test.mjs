import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';

const read=name=>fs.readFileSync(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8');
const organization=read('20260827130000_operations_hub_relation_organization.sql');
const nodeSchema=read('20260827080008_generalize_relation_node_graph.sql');
const board=read('20260827085604_operations_hub_relation_drag_board.sql');
const migration=read('20261103053043_relation_graph_paging_and_archive_reference_guards_v1.sql');
const rollback=fs.readFileSync(new URL('../supabase/rollback/20261103053043_relation_graph_paging_and_archive_reference_guards_v1.rollback.sql',import.meta.url),'utf8');
const rpc='public.list_operations_hub_relation_graph_page_v1';
const archiveSignatures=['public.archive_operations_hub_relation_folder_v2(bigint)','public.archive_operations_hub_relation_node(bigint)'];
let db,baselineMetadata,baselineLegacy,baselineState;

async function fixture(){
 const connection=new PGlite();
 await connection.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create schema operations_private;
 create function auth.uid() returns uuid language sql stable as $$select '00000000-0000-4000-8000-000000000001'::uuid$$;
 create function auth.jwt() returns jsonb language sql stable as $$select '{"app_metadata":{"operations_hub_role":"operator"}}'::jsonb$$;
 create table public.operations_hub_seller_listings(listing_id bigint generated always as identity primary key,source_channel text,product_code text,option_code text,product_name text,option_name text,is_active boolean default true,updated_by text default 'operations_hub_frontend',updated_at timestamptz default now());
 create table public.operations_hub_listing_components(component_id bigint generated always as identity primary key,listing_id bigint references public.operations_hub_seller_listings,sellpia_sku_code text,component_qty numeric default 1,component_role text default 'primary',is_active boolean default true);
 create table public.sellpia_stock_latest(sellpia_sku_code text primary key,sellpia_product_code text,sellpia_product_name text,sellpia_option_name text,stock numeric,sale_price numeric);
 create table public.qa_price_rules(rule_id bigint primary key,formula jsonb);
 create table public.qa_price_decisions(id bigint primary key,tuple jsonb);
 grant select,update on public.operations_hub_seller_listings to anon,authenticated;
 `);
 await connection.exec(organization.slice(0,organization.indexOf('insert into public.operations_hub_relation_folders')));
 await connection.exec(nodeSchema.slice(nodeSchema.indexOf('create table public.operations_hub_relation_nodes'),nodeSchema.indexOf('create or replace function public.ensure_operations_hub_sellpia_relation_node')));
 await connection.exec(board.slice(0,board.indexOf('create or replace function public.ensure_operations_hub_sellpia_sku_relation_node')));
 const legacyStart=board.indexOf('create or replace function public.list_operations_hub_relation_nodes(');
 await connection.exec(board.slice(legacyStart,board.indexOf('\n$$;',legacyStart)+4));
 await connection.exec(read('20260831143000_nested_relation_folders_and_node_archive.sql'));
 await connection.exec(read('20261103050236_fix_relation_folder_save_ambiguity_v2.sql'));
 await connection.exec(read('20260901043312_operations_hub_relation_groups_v1.sql'));
 await connection.exec(`insert into public.operations_hub_relation_folders(folder_name) values('Folder A'),('Folder B');
 insert into public.sellpia_stock_latest values('1-1','1','Source','A',3,59000),('1-2','1','Source','B',9,66000);
 insert into public.qa_price_rules values(1,'{"multiplier":2.2}');insert into public.qa_price_decisions values(1,'{"final":59000}');
 insert into public.operations_hub_seller_listings(source_channel,product_code,option_code,product_name,option_name,folder_id) values('smartstore','SELLER-P','SELLER-O','Seller name','Option',1);
 insert into public.operations_hub_listing_components(listing_id,sellpia_sku_code,component_qty) values(1,'1-1',3),(1,'1-2',2);
 insert into public.operations_hub_relation_nodes(node_type,display_name,sellpia_product_code,sellpia_sku_code,folder_id,relation_kind)
 select 'sellpia_sku','Node-'||lpad((3000-n)::text,5,'0'),'P-'||n,'SKU-'||n,case when n%2=0 then 2 else 1 end,'individual' from generate_series(1,2205) n;
 insert into public.operations_hub_relation_nodes(node_type,display_name,listing_id,folder_id) values('seller_listing','Seller relation node',1,1);
 insert into public.operations_hub_relation_nodes(node_type,display_name,is_active) values('custom','Archived node',false);
 insert into public.operations_hub_relation_edges(parent_node_id,child_node_id,sort_order)
 select n,n+1,n%100 from generate_series(1,2204) n;
 insert into public.operations_hub_relation_edges(parent_node_id,child_node_id,sort_order) values(1,2205,17),(3,2206,9),(2206,2207,2);
 `);
 return connection;
}
async function metadata(signature,connection=db){return (await connection.query(`select oid::text,prosrc,proargtypes::text,proargnames,prosecdef,provolatile,proconfig,proacl::text from pg_proc where oid=$1::regprocedure`,[signature])).rows[0];}
async function state(connection=db){return (await connection.query(`select jsonb_build_object(
 'folders',(select coalesce(jsonb_agg(to_jsonb(t) order by folder_id),'[]') from public.operations_hub_relation_folders t),
 'nodes',(select coalesce(jsonb_agg(to_jsonb(t) order by node_id),'[]') from public.operations_hub_relation_nodes t),
 'edges',(select coalesce(jsonb_agg(to_jsonb(t) order by edge_id),'[]') from public.operations_hub_relation_edges t),
 'groups',(select coalesce(jsonb_agg(to_jsonb(t) order by group_id),'[]') from public.operations_hub_relation_groups t),
 'members',(select coalesce(jsonb_agg(to_jsonb(t) order by membership_id),'[]') from public.operations_hub_relation_group_memberships t),
 'typedEdges',(select coalesce(jsonb_agg(to_jsonb(t) order by group_edge_id),'[]') from public.operations_hub_relation_group_edges t),
 'events',(select coalesce(jsonb_agg(to_jsonb(t) order by event_id),'[]') from public.operations_hub_relation_events t),
 'listings',(select coalesce(jsonb_agg(to_jsonb(t) order by listing_id),'[]') from public.operations_hub_seller_listings t),
 'components',(select coalesce(jsonb_agg(to_jsonb(t) order by component_id),'[]') from public.operations_hub_listing_components t),
 'source',(select coalesce(jsonb_agg(to_jsonb(t) order by sellpia_sku_code),'[]') from public.sellpia_stock_latest t),
 'rules',(select coalesce(jsonb_agg(to_jsonb(t) order by rule_id),'[]') from public.qa_price_rules t),
 'decisions',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.qa_price_decisions t)) result`)).rows[0].result;}
const page=async({search='',folderId=null,afterNode=0,afterEdge=0,size=500,version=null}={},connection=db)=>(await connection.query(`select ${rpc}($1,$2,$3,$4,$5,$6) result`,[search,folderId,afterNode,afterEdge,size,version])).rows[0].result;
async function allPages(args={},connection=db){
 const first=await page(args,connection),nodes=[...first.nodes],edges=[...first.edges],pages=[first];let current=first;
 while(current.hasMoreNodes||current.hasMoreEdges){current=await page({...args,afterNode:current.nextNodeId,afterEdge:current.nextEdgeId,version:first.version},connection);pages.push(current);nodes.push(...current.nodes);edges.push(...current.edges);assert.ok(pages.length<100);}
 const confirmation=await page({...args,afterNode:current.nextNodeId,afterEdge:current.nextEdgeId,version:first.version},connection);
 assert.deepEqual(confirmation.nodes,[]);assert.deepEqual(confirmation.edges,[]);assert.equal(confirmation.hasMoreNodes,false);assert.equal(confirmation.hasMoreEdges,false);
 for(const p of [...pages,confirmation]){assert.equal(p.version,first.version);assert.equal(p.nodeCount,first.nodeCount);assert.equal(p.edgeCount,first.edgeCount);}
 return {...first,nodes,edges,pages,confirmation};
}
async function isolated(fn){await db.exec('begin');try{return await fn();}finally{await db.exec('rollback');}}
async function expectedFailure(fn,check){await db.exec('savepoint expected_failure');try{await assert.rejects(fn,check);}finally{await db.exec('rollback to savepoint expected_failure;release savepoint expected_failure');}}
async function group({folderId=1,anchor=null,active=true,name='Group'}={}){return (await db.query('insert into public.operations_hub_relation_groups(folder_id,group_name,group_type,anchor_node_id,is_active) values($1,$2,\'collection\',$3,$4) returning group_id',[folderId,name,anchor,active])).rows[0].group_id;}

test.before(async()=>{db=await fixture();baselineMetadata=await Promise.all(archiveSignatures.map(s=>metadata(s)));baselineLegacy=await metadata('public.list_operations_hub_relation_nodes(text,bigint,integer)');baselineState=await state();await db.exec(migration);});
test.after(async()=>{await db?.close();});

test('the complete migration changes no operator rows and preserves the legacy RPC and archive identity/security contracts',async()=>{
 assert.deepEqual(await state(),baselineState);
 assert.deepEqual(await metadata('public.list_operations_hub_relation_nodes(text,bigint,integer)'),baselineLegacy);
 for(const [i,signature] of archiveSignatures.entries()){
  const current=await metadata(signature);
  assert.deepEqual(current,baselineMetadata[i]);assert.equal(current.prosecdef,false);
 }
 await db.exec(migration);assert.deepEqual(await state(),baselineState,'idempotent DDL cannot change rows');
});

test('independent keyset cursors return every node and edge beyond 1000 with cross-page edges and legacy JSON fields intact',async()=>{
 const before=await state(),result=await allPages({size:311});
 assert.equal(result.nodeCount,2206);assert.equal(result.edgeCount,2206);assert.equal(result.nodes.length,2206);assert.equal(result.edges.length,2206);assert.ok(result.pages.length>7);
 assert.equal(new Set(result.nodes.map(n=>n.nodeId)).size,2206);assert.equal(new Set(result.edges.map(e=>e.edgeId)).size,2206);
 assert.ok(result.edges.some(e=>e.parentNodeId===1&&e.childNodeId===2205));assert.ok(!result.edges.some(e=>e.childNodeId===2207));
 const ids=new Set(result.nodes.map(n=>n.nodeId));for(const e of result.edges){assert.ok(ids.has(e.parentNodeId));assert.ok(ids.has(e.childNodeId));}
 assert.deepEqual(result.nodes.map(n=>n.nodeId),[...ids].sort((a,b)=>a-b));
 const old=(await db.query("select public.list_operations_hub_relation_nodes('',null,1000) result")).rows[0].result;
 const byId=new Map(result.nodes.map(n=>[n.nodeId,n]));for(const n of old.nodes)assert.deepEqual(byId.get(n.nodeId),n);
 assert.equal(old.nodes.length,1000,'legacy caller remains compatible while the new reader is complete');
 assert.deepEqual(await state(),before);
});

test('search and exact folder scopes preserve induced edges and are bound into the version',async()=>{
 const whole=await page(),folder=await allPages({folderId:1,size:97});
 assert.equal(folder.nodeCount,1104);assert.equal(folder.nodes.length,1104);assert.equal(folder.edgeCount,2);
 const ids=new Set(folder.nodes.map(n=>n.nodeId));for(const e of folder.edges)assert.ok(ids.has(e.parentNodeId)&&ids.has(e.childNodeId));
 const seller=await allPages({search:'SELLER-P',size:1});assert.equal(seller.nodes.length,1);assert.equal(seller.nodes[0].source,'smartstore');assert.equal(seller.nodes[0].sellerOptionCode,'SELLER-O');
 const empty=await allPages({search:'definitely missing',size:1});assert.equal(empty.nodeCount,0);assert.equal(empty.edgeCount,0);
 assert.notEqual(whole.version,folder.version);assert.notEqual(empty.version,(await page({search:'another missing'})).version);
 await assert.rejects(page({folderId:1,version:whole.version}),e=>e.code==='40001');
});

test('renames, folder labels, seller identity, active changes and edge reorder invalidate both later pages and head confirmation',async()=>{
 for(const sql of [
  "update public.operations_hub_relation_nodes set display_name='Changed' where node_id=2205",
  "update public.operations_hub_relation_folders set folder_name='Renamed' where folder_id=1",
  "update public.operations_hub_seller_listings set option_code='Changed seller option' where listing_id=1",
  "update public.operations_hub_relation_nodes set is_active=false where node_id=2205",
  "update public.operations_hub_relation_edges set sort_order=999 where edge_id=2205",
  "update public.operations_hub_relation_edges set is_active=false where edge_id=2205"
 ])await isolated(async()=>{
  const first=await page({size:10});await db.exec(sql);
  await expectedFailure(()=>page({afterNode:first.nextNodeId,afterEdge:first.nextEdgeId,size:10,version:first.version}),e=>e.code==='40001');
  await expectedFailure(()=>page({version:first.version}),e=>e.code==='40001');
 });
});

test('invalid cursors, page sizes and unpinned continuations fail closed without data changes',async()=>{
 const before=await state();for(const args of [{afterNode:-1},{afterEdge:-1},{size:0},{size:1001},{size:null},{afterNode:1},{afterEdge:1},{version:''},{version:'garbage'}])await assert.rejects(page(args),e=>e.code==='22023');
 assert.deepEqual(await state(),before);
});

test('the read-only invoker RPC keeps anon/auth access, honors RLS and introduces no PUBLIC execution grant',async()=>{
 const meta=await metadata(`${rpc}(text,bigint,bigint,bigint,integer,text)`);assert.equal(meta.prosecdef,false);assert.equal(meta.provolatile,'s');assert.deepEqual(meta.proconfig,['search_path=pg_catalog, public','statement_timeout=4s']);
 assert.ok(!/(?:\{|,)=X\//.test(meta.proacl),'PUBLIC execute is revoked');
 for(const role of ['anon','authenticated'])await isolated(async()=>{
  await db.exec(`set local role ${role};set transaction read only`);const result=await page({size:17});assert.equal(result.nodeCount,2206);assert.equal(result.nodes.length,17);
 });
 await isolated(async()=>{
  await db.exec(`alter policy "operations hub relation nodes readable" on public.operations_hub_relation_nodes using(node_id<3);set local role anon`);
  const result=await allPages({size:1});assert.equal(result.nodeCount,2);assert.equal(result.edgeCount,1);
 });
});

test('private trigger guards enforce references for anon without granting group reads or callable definer helpers',async()=>{
 for(const name of ['guard_relation_folder_archive_v1','guard_relation_node_archive_v1']){
  const signature=`operations_private.${name}()`,meta=await metadata(signature);assert.equal(meta.prosecdef,true);assert.equal(meta.provolatile,'s');assert.deepEqual(meta.proconfig,['search_path=pg_catalog']);
  for(const role of ['anon','authenticated','service_role'])assert.equal((await db.query('select has_function_privilege($1,$2,\'execute\') allowed',[role,signature])).rows[0].allowed,false);
 }
 assert.equal((await db.query("select has_table_privilege('anon','public.operations_hub_relation_groups','select') allowed")).rows[0].allowed,false);
 await isolated(async()=>{
  await group({anchor:2206});await db.exec('update public.operations_hub_relation_edges set is_active=false where parent_node_id=2206 or child_node_id=2206');
  const before=await state();await db.exec('set local role anon');
  await expectedFailure(()=>db.query('select public.archive_operations_hub_relation_folder_v2(1)'),e=>e.code==='23503');
  await expectedFailure(()=>db.query('select public.archive_operations_hub_relation_node(2206)'),e=>e.code==='23503');
  await expectedFailure(()=>db.query('select * from public.operations_hub_relation_groups'),e=>e.code==='42501');
  await expectedFailure(()=>db.query('select operations_private.guard_relation_folder_archive_v1()'),e=>e.code==='42501');
  await db.exec('reset role');assert.deepEqual(await state(),before);
 });
 await isolated(async()=>{
  await db.exec('set local role anon');const result=(await db.query('select public.archive_operations_hub_relation_folder_v2(2) result')).rows[0].result;assert.equal(result.folderId,2);assert.equal(result.unassignedNodes,1102);
 });
});

test('folder archive rejects active group references atomically and permits archival after the group is archived',async()=>isolated(async()=>{
 const groupId=await group(),before=await state();
 await expectedFailure(()=>db.query('select public.archive_operations_hub_relation_folder_v2(1)'),e=>e.code==='23503'&&/그룹.*폴더/.test(e.message));assert.deepEqual(await state(),before);
 await db.query('update public.operations_hub_relation_groups set is_active=false where group_id=$1',[groupId]);
 const protectedBefore=await state();const result=(await db.query('select public.archive_operations_hub_relation_folder_v2(1) result')).rows[0].result;
 assert.equal(result.unassignedListings,1);assert.equal(result.unassignedNodes,1104);
 const after=await state();for(const name of ['edges','components','source','rules','decisions','groups','members','typedEdges'])assert.deepEqual(after[name],protectedBefore[name],name);
}));

test('each independent active group anchor/member/typed-edge reference rejects node archive without cascading any rows',async()=>{
 for(const kind of ['anchor','membership','typed-edge'])await isolated(async()=>{
  const groupId=await group({anchor:kind==='anchor'?2206:null});
  if(kind==='membership')await db.query('insert into public.operations_hub_relation_group_memberships(group_id,node_id) values($1,2206)',[groupId]);
  if(kind==='typed-edge'){
   await db.query('insert into public.operations_hub_relation_group_memberships(group_id,node_id) values($1,2206),($1,2205)',[groupId]);
   await db.query("insert into public.operations_hub_relation_group_edges(group_id,from_node_id,to_node_id,edge_kind) values($1,2206,2205,'collection_member')",[groupId]);
   await db.query('update public.operations_hub_relation_group_memberships set is_active=false where group_id=$1',[groupId]);
  }
  // Isolate the group guard from the existing generic-edge guard.
  await db.exec('update public.operations_hub_relation_edges set is_active=false where parent_node_id=2206 or child_node_id=2206');
  const before=await state();await expectedFailure(()=>db.query('select public.archive_operations_hub_relation_node(2206)'),e=>e.code==='23503'&&/활성 관계 그룹/.test(e.message));assert.deepEqual(await state(),before,kind);
 });
});

test('existing generic-edge guards remain and inactive group history never blocks ordinary archive',async()=>isolated(async()=>{
 await expectedFailure(()=>db.query('select public.archive_operations_hub_relation_node(1)'),/관계를 먼저 해제/);
 const groupId=await group({anchor:2206});await db.query('insert into public.operations_hub_relation_group_memberships(group_id,node_id,member_role) values($1,2206,\'anchor\')',[groupId]);await db.query('update public.operations_hub_relation_groups set is_active=false where group_id=$1',[groupId]);
 await db.exec('update public.operations_hub_relation_edges set is_active=false where parent_node_id=2206 or child_node_id=2206');
 const before=await state();assert.equal((await db.query('select public.archive_operations_hub_relation_node(2206) result')).rows[0].result.archived,true);
 const after=await state();for(const name of ['edges','components','source','rules','decisions','groups','members','typedEdges'])assert.deepEqual(after[name],before[name],name);
}));

test('the committed rollback restores the old API behavior and removes only the new reader; reapply is safe',async()=>isolated(async()=>{
 const before=await state();await db.exec(rollback);assert.deepEqual(await state(),before);for(const [i,signature] of archiveSignatures.entries())assert.deepEqual(await metadata(signature),baselineMetadata[i]);
 assert.equal((await db.query("select to_regprocedure('public.list_operations_hub_relation_graph_page_v1(text,bigint,bigint,bigint,integer,text)') f")).rows[0].f,null);
 await db.exec(migration);assert.deepEqual(await state(),before);assert.equal((await page()).nodeCount,2206);
}));
