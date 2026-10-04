import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../work/rule-registry-db-test/node_modules/@electric-sql/pglite/dist/index.js';

test('three-platform group save and assignment limits execute atomically in isolated PostgreSQL',async t=>{
 const db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create schema operations_private;
   create table public.product_tags(tag_id uuid primary key);
   create table public.operations_hub_product_profiles(sellpia_sku_code text primary key);
   insert into public.operations_hub_product_profiles select 'catalog-'||n from generate_series(1,1001)n;
   create table public.operations_hub_relation_nodes(node_id bigint primary key,sellpia_sku_code text,is_active boolean);
   create table public.operations_hub_relation_edges(edge_id bigint primary key,parent_node_id bigint,child_node_id bigint,is_active boolean);
   create function operations_private.require_operations_hub_operator_session(token text) returns jsonb language plpgsql as $$begin if token is distinct from 'operator' then raise exception 'unauthorized';end if;return '{"username":"fixture"}'::jsonb;end$$;`);
  for(const file of ['../supabase/migrations/20260910031047_hub_field_dependencies.sql','../supabase/migrations/20260910031709_hub_platform_stage_inputs.sql','../supabase/migrations/20260910041347_hub_platform_rule_group_save.sql'])await db.exec(await readFile(new URL(file,import.meta.url),'utf8'));
  const group=async (rule,token='operator')=>(await db.query('select public.hub_platform_rule_group_save_v1($1,$2::jsonb) result',[token,JSON.stringify(rule)])).rows[0].result;
  const spec=name=>({name,target_field:'platform_final_price',source_field:'platform_final_input',input_origin:'self',scope:'',config:{steps:[{op:'add',value:0}]}});
  let saved;
  await t.test('successful request creates all three scopes with matching ordered config',async()=>{
   saved=await group(spec('all-platforms'));
   assert.deepEqual(saved.map(r=>r.scope),['smartstore','makeshop','ably']);
   assert.equal(new Set(saved.map(r=>r.id)).size,3);
   assert.ok(saved.every(r=>r.config.steps[0].op==='add'&&r.config.steps[0].value===0));
  });
  await t.test('failure on second platform rolls back first platform rule and audit event',async()=>{
   const before=(await db.query('select (select count(*)::int from operations_private.hub_rules) rules,(select count(*)::int from operations_private.hub_rule_events) events')).rows[0];
   await db.exec(`create function operations_private.qa_fail_second_platform() returns trigger language plpgsql as $$begin if new.name='atomic-failure' and new.scope='makeshop' then raise exception 'fixture second-platform failure';end if;return new;end$$;
   create trigger qa_fail_second_platform before insert on operations_private.hub_rules for each row execute function operations_private.qa_fail_second_platform();`);
   await assert.rejects(()=>group(spec('atomic-failure')),/fixture second-platform failure/);
   const after=(await db.query('select (select count(*)::int from operations_private.hub_rules) rules,(select count(*)::int from operations_private.hub_rule_events) events')).rows[0];
   assert.deepEqual(after,before,'neither a partial rule nor its audit event may remain');
  });
  await t.test('auth and existing/scoped rule misuse cannot create partial group',async()=>{
   await assert.rejects(()=>group(spec('unauthorized'),'wrong'),/unauthorized/);
   await assert.rejects(()=>group({...spec('has-id'),id:saved[0].id}),/새 공통 수식/);
   await assert.rejects(()=>group({...spec('scoped'),scope:'ably'}),/새 공통 수식/);
   assert.equal((await db.query('select count(*)::int count from operations_private.hub_rules')).rows[0].count,3);
  });
  await t.test('1000 assignment boundary succeeds and 1001 rejects without partial changes',async()=>{
   const entries=Array.from({length:1000},(_,i)=>({sku:'catalog-'+(i+1),rule_id:saved[0].id}));
   await db.query('select public.hub_rule_assign_v1($1,$2,$3::jsonb,$4::uuid)',['operator','apply',JSON.stringify(entries),'00000000-0000-4000-8000-000000000001']);
   assert.equal((await db.query('select count(*)::int count from operations_private.hub_rule_assignments')).rows[0].count,1000);
   await assert.rejects(()=>db.query('select public.hub_rule_assign_v1($1,$2,$3::jsonb,$4::uuid)',['operator','apply',JSON.stringify([...entries,{sku:'catalog-1001',rule_id:saved[0].id}]),'00000000-0000-4000-8000-000000000002']),/1~1,000/);
   assert.equal((await db.query('select count(*)::int count from operations_private.hub_rule_assignments')).rows[0].count,1000);
  });
 }finally{await db.close();}
});
