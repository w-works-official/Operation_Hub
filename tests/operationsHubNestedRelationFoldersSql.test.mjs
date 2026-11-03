import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';

const read=name=>fs.readFileSync(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8');
const organization=read('20260827130000_operations_hub_relation_organization.sql');
const original=read('20260831143000_nested_relation_folders_and_node_archive.sql');
const migration=read('20261103050236_fix_relation_folder_save_ambiguity_v2.sql');
const signature='public.save_operations_hub_relation_folder_v2(bigint,text,text,integer,bigint)';
let db,buggy,ids,originalIds,originalMetadata,originalBody,originalState;

// Use the real folder/event DDL, parent trigger, policies, grants and complete
// original hierarchy migration. Only unrelated predecessor tables are fixtures.
async function createFixture(){
 const connection=new PGlite();
 await connection.exec(`create role anon;create role authenticated;
  create table public.operations_hub_seller_listings(listing_id bigint generated always as identity primary key,source_channel text,product_code text,option_code text,is_active boolean default true,updated_by text default 'operations_hub_frontend',updated_at timestamptz default now());
  create table public.operations_hub_listing_components(component_id bigint generated always as identity primary key,listing_id bigint references public.operations_hub_seller_listings,sellpia_sku_code text,component_qty numeric default 1,component_role text default 'primary',is_active boolean default true);
 `);
 const schemaEnd=organization.indexOf('insert into public.operations_hub_relation_folders');assert(schemaEnd>0);
 await connection.exec(organization.slice(0,schemaEnd));
 await connection.exec(`
  create table public.operations_hub_relation_nodes(node_id bigint generated always as identity primary key,folder_id bigint references public.operations_hub_relation_folders,is_active boolean default true,updated_by text default 'operations_hub_frontend',updated_at timestamptz default now());
  create table public.operations_hub_relation_edges(edge_id bigint generated always as identity primary key,parent_node_id bigint references public.operations_hub_relation_nodes,child_node_id bigint references public.operations_hub_relation_nodes,is_active boolean default true);
 `);
 await connection.exec(original);
 const rootA=(await connection.query("insert into public.operations_hub_relation_folders(folder_name,folder_kind) values('모음전 관리','collection') returning folder_id")).rows[0].folder_id;
 const rootB=(await connection.query("insert into public.operations_hub_relation_folders(folder_name,folder_kind) values('별도 관리','custom') returning folder_id")).rows[0].folder_id;
 const child=(await connection.query("insert into public.operations_hub_relation_folders(folder_name,folder_kind,parent_folder_id) values('기존 하위','set',$1) returning folder_id",[rootA])).rows[0].folder_id;
 const leaf=(await connection.query("insert into public.operations_hub_relation_folders(folder_name,folder_kind,parent_folder_id) values('손자 폴더','one_plus_one',$1) returning folder_id",[child])).rows[0].folder_id;
 const archived=(await connection.query("insert into public.operations_hub_relation_folders(folder_name,is_active) values('보관 폴더',false) returning folder_id")).rows[0].folder_id;
 await connection.query('insert into public.operations_hub_relation_nodes(folder_id) values($1),($2)',[rootA,child]);
 await connection.exec("insert into public.operations_hub_relation_edges(parent_node_id,child_node_id) values(1,2);insert into public.operations_hub_seller_listings(source_channel,product_code,option_code) values('smartstore','P','O');insert into public.operations_hub_listing_components(listing_id,sellpia_sku_code,component_qty) values(1,'S-1',2)");
 return {connection,keys:{rootA,rootB,child,leaf,archived}};
}
test.before(async()=>{
 ({connection:buggy,keys:originalIds}=await createFixture());
 ({connection:db,keys:ids}=await createFixture());
 originalMetadata=await metadata(db);originalState=await snapshot(db);
 originalBody=(await db.query('select prosrc from pg_proc where oid=$1::regprocedure',[signature])).rows[0].prosrc;
 await db.exec(migration);
});
test.after(async()=>{await Promise.all([db?.close(),buggy?.close()]);});

async function snapshot(connection=db){
 const {rows}=await connection.query(`select
  (select coalesce(jsonb_agg(to_jsonb(f) order by folder_id),'[]') from public.operations_hub_relation_folders f) as folders,
  (select coalesce(jsonb_agg(to_jsonb(e) order by event_id),'[]') from public.operations_hub_relation_events e) as events,
  (select coalesce(jsonb_agg(to_jsonb(n) order by node_id),'[]') from public.operations_hub_relation_nodes n) as nodes,
  (select coalesce(jsonb_agg(to_jsonb(e) order by edge_id),'[]') from public.operations_hub_relation_edges e) as edges,
  (select coalesce(jsonb_agg(to_jsonb(l) order by listing_id),'[]') from public.operations_hub_seller_listings l) as listings,
  (select coalesce(jsonb_agg(to_jsonb(c) order by component_id),'[]') from public.operations_hub_listing_components c) as components`);
 return rows[0];
}
async function metadata(connection=db){return (await connection.query(`select p.oid::text as oid,p.proname,p.proargtypes::text,p.proallargtypes::text,p.proargmodes,p.proargnames,p.prosecdef,p.provolatile,p.proconfig,p.proacl::text,l.lanname from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=$1::regprocedure`,[signature])).rows[0];}
const save=(connection,{id=null,name='100위',kind='custom',sort=100,parent=null}={})=>connection.query(`select * from ${signature.split('(')[0]}($1::bigint,$2::text,$3::text,$4::integer,$5::bigint)`,[id,name,kind,sort,parent]);
const branches=keys=>[
 ['root create',{name:'새 최상위',kind:'collection'}],
 ['child create',{name:'100위',parent:keys.rootA}],
 ['root rename',{id:keys.rootB,name:'최상위 이름 변경'}],
 ['child rename',{id:keys.child,name:'하위 이름 변경',parent:keys.rootA}],
 ['move child to another parent',{id:keys.child,name:'기존 하위',parent:keys.rootB}],
 ['move child to root',{id:keys.child,name:'기존 하위'}]
];

test('the unmodified deployed SQL reproduces 42702 for all six folder save branches without leaving partial changes',async()=>{
 for(const [label,args] of branches(originalIds)){
  const before=await snapshot(buggy);
  await assert.rejects(save(buggy,args),error=>error.code==='42702'&&/folder_id.*ambiguous/.test(error.message),label);
  assert.deepEqual(await snapshot(buggy),before,`${label} rolls back folders and audit events`);
 }
});

test('the whole guarded migration changes only the qualified reference and preserves function identity, invoker mode, configuration and ACL',async()=>{
 const before=originalMetadata,state=originalState,oldBody=originalBody;
 assert.deepEqual(await metadata(),before);assert.equal(before.prosecdef,false);assert.equal(before.lanname,'plpgsql');
 const newBody=(await db.query('select prosrc from pg_proc where oid=$1::regprocedure',[signature])).rows[0].prosrc;
 assert.equal(newBody.replace(/\r/g,''),oldBody.replace(/\r/g,'').replace('select 1 from descendants where folder_id = p_parent_folder_id','select 1 from descendants descendant where descendant.folder_id = p_parent_folder_id'));
 assert.deepEqual(await snapshot(),state,'DDL does not mutate folders, relations, mappings or events');
 await db.exec(migration);assert.deepEqual(await metadata(),before,'already-patched guard permits an idempotent replay');
});

test('all six real save branches succeed with one accurate before/after audit and no relation or mapping changes',async()=>{
 for(const [label,args] of branches(ids)){
  await db.exec('begin');
  try{
   const before=await snapshot(),result=await save(db,args),after=await snapshot(),saved=result.rows[0];
   assert.equal(result.rows.length,1,label);assert.deepEqual(result.fields.map(field=>field.name),['folder_id','folder_name','folder_kind','parent_folder_id','sort_order','updated_at']);
   assert.equal(saved.folder_name,args.name);assert.equal(String(saved.parent_folder_id??''),String(args.parent??''));assert.equal(saved.folder_kind,args.kind||'custom');
   assert.equal(after.events.length,before.events.length+1,label);const event=after.events.at(-1),stored=after.folders.find(row=>String(row.folder_id)===String(saved.folder_id));
   assert.equal(event.event_type,'FOLDER_SAVE');assert.equal(String(event.folder_id),String(saved.folder_id));assert.equal(event.changed_by,'operations_hub_frontend');assert.deepEqual(event.after_value,stored);
   assert.deepEqual(event.before_value,args.id?before.folders.find(row=>String(row.folder_id)===String(args.id)):null);
   for(const table of ['nodes','edges','listings','components'])assert.deepEqual(after[table],before[table],`${label} cannot change ${table}`);
   assert.equal(after.folders.length,before.folders.length+(args.id?0:1));
  }finally{await db.exec('rollback');}
 }
});

test('nonexistent and archived parents, self-parent, descendant cycles and missing edit targets fail without changing rows or history',async()=>{
 const cases=[
  [{parent:999999},/상위 폴더를 찾을 수 없습니다/],
  [{parent:ids.archived},/상위 폴더를 찾을 수 없습니다/],
  [{id:ids.child,parent:ids.child},/자신을 상위/],
  [{id:ids.rootA,parent:ids.leaf},/순환 구조/],
  [{id:999999},/수정할 폴더/],
  [{id:ids.archived},/수정할 폴더/]
 ];
 for(const [args,message] of cases){const before=await snapshot();await assert.rejects(save(db,args),message);assert.deepEqual(await snapshot(),before);}
});

test('trimmed case-insensitive sibling names are rejected while the same child name under different parents is valid',async()=>{
 await db.exec('begin');
 try{
  const a=(await save(db,{name:'  Shared Name  ',parent:ids.rootA})).rows[0];assert.equal(a.folder_name,'Shared Name');
  const b=(await save(db,{name:'shared name',parent:ids.rootB})).rows[0];assert.notEqual(String(a.folder_id),String(b.folder_id));
  await db.exec('savepoint duplicate_attempt');const before=await snapshot();
  await assert.rejects(save(db,{name:' SHARED NAME ',parent:ids.rootA}),/동일한 이름/);await db.exec('rollback to savepoint duplicate_attempt');assert.deepEqual(await snapshot(),before);
  const own=(await save(db,{id:a.folder_id,name:'shared name',parent:ids.rootA})).rows[0];assert.equal(String(own.folder_id),String(a.folder_id),'renaming the same folder excludes itself from duplicate detection');
 }finally{await db.exec('rollback');}
});

test('all four folder kinds and bounded sort values retain the public return contract',async()=>{
 await db.exec('begin');
 try{
  for(const [index,kind] of ['collection','one_plus_one','set','custom'].entries()){
   const result=await save(db,{name:`유형-${kind}`,kind,sort:index===0?-5:index===1?20000:100,parent:ids.rootA}),row=result.rows[0];
   assert.equal(row.folder_kind,kind);assert.equal(row.sort_order,index===0?0:index===1?10000:100);assert.equal(String(row.parent_folder_id),String(ids.rootA));assert.ok(row.updated_at);
  }
 }finally{await db.exec('rollback');}
});

test('an audit insert failure atomically rolls back both a new folder and an existing folder update',async()=>{
 await db.exec(`create function public.qa_reject_folder_audit() returns trigger language plpgsql as $$begin if new.after_value->>'folder_name'='QA AUDIT FAIL' then raise exception 'qa audit rejected';end if;return new;end$$;
  create trigger qa_folder_audit_failure before insert on public.operations_hub_relation_events for each row execute function public.qa_reject_folder_audit()`);
 try{
  for(const args of [{name:'QA AUDIT FAIL',parent:ids.rootA},{id:ids.child,name:'QA AUDIT FAIL',parent:ids.rootB}]){
   const before=await snapshot();await assert.rejects(save(db,args),/qa audit rejected/);assert.deepEqual(await snapshot(),before,'folder DML preceding the failed event cannot survive the RPC transaction');
  }
 }finally{await db.exec('drop trigger qa_folder_audit_failure on public.operations_hub_relation_events;drop function public.qa_reject_folder_audit()');}
});

test('anon retains the original invoker grants and row policies after the patch',async()=>{
 await db.exec('begin;set local role anon');
 try{const result=await save(db,{name:'권한 유지',parent:ids.rootA});assert.equal(result.rows[0].folder_name,'권한 유지');}
 finally{await db.exec('rollback');}
});

test('rolling back the migration restores the original failure, and reapplying it repairs the function again',async()=>{
 const before=await snapshot(buggy);await buggy.exec('begin');
 try{await buggy.exec(migration);assert.equal((await save(buggy,{name:'트랜잭션 수정 확인'})).rows.length,1);}
 finally{await buggy.exec('rollback');}
 assert.deepEqual(await snapshot(buggy),before);await assert.rejects(save(buggy,{name:'트랜잭션 복원 확인'}),error=>error.code==='42702');assert.deepEqual(await snapshot(buggy),before);
 await buggy.exec(migration);assert.equal((await save(buggy,{name:'재적용 확인',parent:originalIds.rootA})).rows.length,1);
});
