import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
let PGlite;
try { ({PGlite}=await import('@electric-sql/pglite')); }
catch { try { ({PGlite}=await import('../work/rule-registry-db-test/node_modules/@electric-sql/pglite/dist/index.js')); } catch {} }
const migration=await readFile(new URL('../supabase/migrations/20260910031047_hub_field_dependencies.sql',import.meta.url),'utf8');
test('registry migration and RPCs execute in isolated PostgreSQL', {skip:!PGlite&&'Install @electric-sql/pglite to run isolated DB regression'}, async t=>{
 const db=new PGlite();
 try {
 await db.exec(`create role anon; create role authenticated; create schema operations_private;
 create table public.product_tags(tag_id uuid primary key);
 create table public.operations_hub_product_profiles(sellpia_sku_code text primary key);
 insert into public.operations_hub_product_profiles values('A'),('B'),('C');
 create table public.operations_hub_relation_nodes(node_id bigint primary key,sellpia_sku_code text,is_active boolean);
 create table public.operations_hub_relation_edges(edge_id bigint primary key,parent_node_id bigint,child_node_id bigint,is_active boolean);
 create function operations_private.require_operations_hub_operator_session(token text) returns jsonb language plpgsql as $$ begin if token is distinct from 'operator' then raise exception 'unauthorized'; end if; return '{"username":"test-operator"}'::jsonb; end $$;
 `);
 await db.exec(migration);
 await db.exec(await readFile(new URL('../supabase/migrations/20260910031709_hub_platform_stage_inputs.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/migrations/20260910113000_hub_rule_destination_reassignment.sql',import.meta.url),'utf8'));
 const call=async(fn,args)=>{const placeholders=args.map((_,i)=>'$'+(i+1)).join(',');const x=await db.query(`select public.${fn}(${placeholders}) as result`,args);return x.rows[0].result;};
 const save=rule=>call('hub_rule_registry_v1',['operator','save',JSON.stringify(rule)]);
 let request=0;
 const assign=(action,items,id)=>call('hub_rule_assign_v1',['operator',action,JSON.stringify(items),id||`00000000-0000-4000-8000-${String(++request).padStart(12,'0')}`]);
 const rule=(name,target='calculated_base_price',source='purchase_price',origin='self',scope='')=>({name,target_field:target,source_field:source,input_origin:origin,scope,config:{steps:[{op:'multiply',value:3}]}});
 let base,parent,other,inbound;
 await t.test('custom operator auth blocks anonymous calls',async()=>{
  await assert.rejects(call('hub_rule_registry_v1',['invalid','list',null]),/unauthorized/);
  const grants=await db.query("select has_table_privilege('anon','operations_private.hub_rules','SELECT') as exposed");assert.equal(grants.rows[0].exposed,false);
 });
 await t.test('null and malformed JSON cannot save partial rules',async()=>{
  for(const bad of [null,{}, {...rule('missing'),config:null},{...rule('bad'),config:{steps:[{}]}},{...rule('bad-round'),config:{steps:[{op:'round',unit:0,rounding:'up'}]}},{...rule('bad-range'),config:{steps:[],min:500,max:100}}])await assert.rejects(save(bad));
  await assert.rejects(call('hub_rule_assign_v1',['operator','apply',null,'00000000-0000-4000-8000-999999999999']));
 });
 await t.test('virtual platform inputs save as sources but cannot be assignment targets',async()=>{
  const option=await save(rule('virtual-option','platform_option_price','platform_option_input','self','ably'));
  assert.equal(option.source_field,'platform_option_input');
  const final=await save(rule('virtual-final','platform_final_price','platform_final_input','self','makeshop'));
  assert.equal(final.source_field,'platform_final_input');
  await assert.rejects(save(rule('bad-target','platform_option_input','purchase_price','self','ably')),error=>error.code==='23514');
  await assert.rejects(save(rule('bad-input-scope','calculated_base_price','platform_final_input')));
 });
 await t.test('ordered rounding and distinct stage definitions persist centrally',async()=>{
  base=await save(rule('base'));other=await save(rule('other'));inbound=await save(rule('inbound','actual_inbound_cost'));
  parent=await save(rule('parent','calculated_base_price','calculated_base_price','parent'));
  const rounded=await save({...rule('round'),config:{steps:[{op:'round',unit:100,rounding:'up'},{op:'add',value:33}]}});assert.equal(rounded.config.steps[0].op,'round');
  const reg=await save(rule('registration','platform_registration_price','calculated_base_price','self','ably'));
  const discount=await save(rule('discount','platform_discount_price','platform_registration_price','self','ably'));
  await assign('apply',[{sku:'A',rule_id:base.id},{sku:'A',rule_id:inbound.id},{sku:'A',rule_id:reg.id},{sku:'A',rule_id:discount.id}]);
  const list=await call('hub_rule_registry_v1',['operator','list',null]);assert.equal(list.assignments.length,4);
 });
 await t.test('same slot conflicting rule fails atomically; duplicate request replays',async()=>{
  await assert.rejects(assign('apply',[{sku:'A',rule_id:other.id}]),/다른 규칙/);
  const items=[{sku:'C',rule_id:base.id}],id='00000000-0000-4000-8000-999999999998';
  const first=await assign('apply',items,id);assert.deepEqual(await assign('apply',items,id),first);
  await assert.rejects(assign('remove',items,id),/재사용/);
 });
 await t.test('parent links reject missing SKU, self and multiple parents',async()=>{
  await assert.rejects(assign('apply',[{sku:'missing',rule_id:base.id}]),/원본 없음/);
  await assert.rejects(assign('apply',[{sku:'B',rule_id:parent.id,reference:{parent_sku:'missing'}}]),/원본 없음/);
  await assert.rejects(assign('apply',[{sku:'B',rule_id:parent.id,reference:{parent_sku:'B'}}]),/상위\/하위/);
  await assign('apply',[{sku:'B',rule_id:parent.id,reference:{parent_sku:'A'}}]);
  await assert.rejects(assign('apply',[{sku:'B',rule_id:parent.id,reference:{parent_sku:'C'}}]),/여러 개/);
  const list=await call('hub_rule_registry_v1',['operator','list',null]);assert.equal(list.dependencies[0].parent_sku,'A');
 });
 await t.test('assigned destination moves atomically, rejects collisions and still prevents implicit parent conversion',async()=>{
  base=await save({...base,target_field:'basis_sku_price'});
  let moved=await call('hub_rule_registry_v1',['operator','list',null]);let assignment=moved.assignments.find(a=>a.sku==='A'&&a.rule_id===base.id);assert.equal(assignment.target_field,'basis_sku_price');assert.equal(assignment.version,2);
  base=await save({...base,target_field:'calculated_base_price'});moved=await call('hub_rule_registry_v1',['operator','list',null]);assignment=moved.assignments.find(a=>a.sku==='A'&&a.rule_id===base.id);assert.equal(assignment.target_field,'calculated_base_price');assert.equal(assignment.version,3);
  await db.exec("insert into public.operations_hub_product_profiles values('F')");const moving=await save(rule('moving','basis_sku_price'));const occupied=await save(rule('occupied'));await assign('apply',[{sku:'F',rule_id:moving.id},{sku:'F',rule_id:occupied.id}]);await assert.rejects(save({...moving,target_field:'calculated_base_price'}),/적용점 변경 충돌.*전체 저장을 취소/);
  await assert.rejects(save({...base,input_origin:'parent'}),/종속관계/);
  await assert.rejects(save({...base,source_field:'calculated_base_price'}),/순환/);
  const list=await call('hub_rule_registry_v1',['operator','list',null]);assert.equal(list.rules.find(r=>r.id===base.id).source_field,'purchase_price');
  const edit=await save({...base,config:{steps:[{op:'add',value:500}]}});assert.equal(edit.version,base.version+1);
 });
 await t.test('reference source override survives rule edits; explicit and implicit cycles reject',async()=>{
  await assign('apply',[{sku:'B',rule_id:parent.id,reference:{parent_sku:'A',source_field:'actual_inbound_cost'}}]);
  await save({...parent,source_field:'system_stock'});
  let list=await call('hub_rule_registry_v1',['operator','list',null]);assert.equal(list.dependencies[0].source_field,'actual_inbound_cost');
  await db.exec("insert into public.operations_hub_product_profiles values('D'),('E');");
  const loop=await save(rule('loop','calculated_base_price','calculated_base_price','parent'));
  await assert.rejects(assign('apply',[{sku:'D',rule_id:loop.id,reference:{parent_sku:'E'}},{sku:'E',rule_id:loop.id,reference:{parent_sku:'D'}}]),/순환/);
  const implicit=await save(rule('implicit','actual_inbound_cost','calculated_base_price'));
  await assert.rejects(assign('apply',[{sku:'D',rule_id:implicit.id}]),/순환/);
  list=await call('hub_rule_registry_v1',['operator','list',null]);assert.equal(list.assignments.filter(a=>['D','E'].includes(a.sku)).length,0);
 });
 await t.test('selected rule removal preserves other stages and generic relationships',async()=>{
  await db.exec("insert into public.operations_hub_relation_nodes values(1,'A',true),(2,'B',true); insert into public.operations_hub_relation_edges values(1,1,2,true);");
  const noOp=await assign('remove',[{sku:'A',rule_id:other.id}]);assert.equal(noOp.count,0);
  await assign('remove',[{sku:'B',rule_id:parent.id}]);
  const list=await call('hub_rule_registry_v1',['operator','list',null]);assert.equal(list.dependencies.length,0);assert.equal(list.assignments.filter(a=>a.sku==='A').length,4);
  assert.equal((await db.query('select count(*)::int n from public.operations_hub_relation_edges')).rows[0].n,1);
 });
 } finally { await db.close(); }
});
