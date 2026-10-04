import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import '../mockups/operations-hub/rule-registry.js';
let PGlite;
try {({PGlite}=await import('@electric-sql/pglite'));} catch {try {({PGlite}=await import('../work/rule-registry-db-test/node_modules/@electric-sql/pglite/dist/index.js'));} catch {}}
const tagSqlPath=process.env.HUB_TAG_SQL_PATH||new URL('../supabase/migrations/20260910043254_hub_tag_rule_assignments.sql',import.meta.url);
const tagOptimizationSqlPath=process.env.HUB_TAG_OPTIMIZATION_SQL_PATH||new URL('../supabase/migrations/20260910044039_hub_tag_rule_query_optimization.sql',import.meta.url);
const tagPerformanceSqlPath=process.env.HUB_TAG_PERFORMANCE_SQL_PATH||new URL('../supabase/migrations/20260910050448_hub_tag_apply_performance.sql',import.meta.url);
const tagExcelSqlPath=process.env.HUB_TAG_EXCEL_SQL_PATH||new URL('../supabase/migrations/20260910123002_hub_tag_excel_import.sql',import.meta.url);
test('tag-linked shared rule bulk transactions execute in isolated PostgreSQL',{skip:!PGlite&&'Install @electric-sql/pglite'},async t=>{
 const db=new PGlite();
 try {
 await db.exec(`create role anon;create role authenticated;create schema operations_private;
 create table public.product_tags(tag_id uuid primary key default gen_random_uuid(),tag_name text not null,tag_color text,tag_group text,is_active boolean not null default true,created_by text,created_at timestamptz default now(),updated_at timestamptz default now());
 create table public.sellpia_stock_snapshots(snapshot_id int primary key,upload_status text,created_at timestamptz);
 create index ready_created_idx on public.sellpia_stock_snapshots(upload_status,created_at desc);
 insert into public.sellpia_stock_snapshots values(1,'ready','2026-09-01'),(2,'ready','2026-09-02'),(3,'uploading','2026-09-03');
 create table public.sellpia_stock_snapshot_rows(snapshot_id int references public.sellpia_stock_snapshots(snapshot_id),sellpia_sku_code text,sellpia_product_code text,primary key(snapshot_id,sellpia_sku_code));
 insert into public.sellpia_stock_snapshot_rows select 2,'SKU'||g,'PRODUCT'||(g/5)::int from generate_series(1,23760)g;
 insert into public.sellpia_stock_snapshot_rows values(2,'outside','OTHER'),(2,'manual','MANUAL'),(2,'conflict','CONFLICT'),(2,'excel-a','EXCEL'),(2,'excel-b','EXCEL'),(2,'excel-c','EXCEL'),(1,'retired','OLD'),(3,'pending','NEW');
 create view public.sellpia_stock_latest as select r.* from public.sellpia_stock_snapshot_rows r join public.sellpia_stock_snapshots s using(snapshot_id) where s.snapshot_id=(select snapshot_id from public.sellpia_stock_snapshots where upload_status='ready' order by created_at desc limit 1);
 create table public.sellpia_tag_assignments(assignment_id bigint generated always as identity primary key,tag_id uuid not null references public.product_tags(tag_id),tag_scope text not null,sellpia_sku_code text,sellpia_product_code text,is_active boolean not null default true,reviewer text,memo text,created_at timestamptz default now(),updated_at timestamptz default now());
 create index tag_assignment_sku_idx on public.sellpia_tag_assignments(sellpia_sku_code,is_active);
 create index tag_assignment_product_idx on public.sellpia_tag_assignments(sellpia_product_code,is_active);
 create index tag_assignment_tag_idx on public.sellpia_tag_assignments(tag_id,is_active);
 create unique index tag_assignment_active_unique on public.sellpia_tag_assignments(tag_id,tag_scope,coalesce(sellpia_product_code,''),coalesce(sellpia_sku_code,'')) where is_active;
 create view public.operations_hub_product_profiles as select sku.*,coalesce(product_tags.items,'[]') product_tags,coalesce(sku_tags.items,'[]') sku_tags from (select distinct sellpia_sku_code,sellpia_product_code from public.sellpia_stock_latest where nullif(btrim(sellpia_sku_code),'') is not null) sku
 left join lateral(select jsonb_agg(to_jsonb(t)) items from public.sellpia_tag_assignments a join public.product_tags t using(tag_id) where a.is_active and t.is_active and a.tag_scope='product' and a.sellpia_product_code=sku.sellpia_product_code) product_tags on true
 left join lateral(select jsonb_agg(to_jsonb(t)) items from public.sellpia_tag_assignments a join public.product_tags t using(tag_id) where a.is_active and t.is_active and a.tag_scope='option' and a.sellpia_sku_code=sku.sellpia_sku_code) sku_tags on true;
 create materialized view operations_private.operations_hub_matrix_export_cache as select sellpia_sku_code,'{"unchanged":true}'::jsonb profile_json from public.operations_hub_product_profiles;
 create unique index cache_sku_idx on operations_private.operations_hub_matrix_export_cache(sellpia_sku_code);
 create table public.operations_hub_relation_nodes(node_id bigint primary key,sellpia_sku_code text,is_active boolean);
 create table public.operations_hub_relation_edges(edge_id bigint primary key,parent_node_id bigint,child_node_id bigint,is_active boolean);
 create function operations_private.require_operations_hub_operator_session(token text) returns jsonb language plpgsql as $$begin if token is distinct from 'operator' then raise exception 'unauthorized';end if;return '{"username":"test"}'::jsonb;end$$;
 analyze public.sellpia_stock_snapshot_rows;
 analyze public.sellpia_stock_snapshots;
 analyze public.sellpia_tag_assignments;
 analyze operations_private.operations_hub_matrix_export_cache;
 `);
 for(const name of ['20260910031047_hub_field_dependencies.sql','20260910031709_hub_platform_stage_inputs.sql','20260910041347_hub_platform_rule_group_save.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 await db.exec(await readFile(tagSqlPath,'utf8'));
 await db.exec(await readFile(tagOptimizationSqlPath,'utf8'));
 await db.exec(await readFile(tagPerformanceSqlPath,'utf8'));
 await db.exec(await readFile(tagExcelSqlPath,'utf8'));
 await db.exec("alter function operations_private.hub_validate_rule_graph() rename to hub_validate_rule_graph_actual;create table operations_private.qa_graph_calls(n int);insert into operations_private.qa_graph_calls values(0);create function operations_private.hub_validate_rule_graph() returns void language plpgsql as $$begin update operations_private.qa_graph_calls set n=n+1;perform operations_private.hub_validate_rule_graph_actual();end$$;");
 const call=async(fn,args)=>{const out=await db.query(`select public.${fn}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args);return out.rows[0].result;};
 const rule=(name,target='calculated_base_price')=>({name,target_field:target,source_field:'source_base_price',input_origin:'self',scope:'',config:{steps:[{op:'multiply',value:1.2},{op:'round',unit:100,rounding:'up'},{op:'add',value:33}]}});
 const save=(tag,r)=>call('hub_tag_rule_save_v1',['operator',JSON.stringify(tag),JSON.stringify(r)]);
 const assign=(tag,skus,action='add')=>call('hub_tag_assign_v1',['operator',tag,skus,action]);
 const excelImport=(rows,tag=null,preview=true)=>call('hub_tag_bulk_import_v1',['operator',JSON.stringify(rows),tag,preview]);
 const scalar=async sql=>(await db.query(sql)).rows[0];
 let saved,untouched,manualRule;
 await t.test('tag plus ordered rule save is atomic and shares UUID',async()=>{
  saved=await save({name:'bulk-tag',color:'#112233'},rule('bulk-rule'));assert.equal(saved.rules.length,1);assert.equal(saved.rules[0].tag_id,saved.tag.tag_id);assert.equal(saved.rules[0].config.steps[1].op,'round');
  const count=(await scalar('select count(*)::int n from public.product_tags')).n;
  await assert.rejects(save({name:'should-rollback'},{...rule('broken'),config:{steps:[{op:'divide',value:0}]}}));assert.equal((await scalar('select count(*)::int n from public.product_tags')).n,count);
  untouched=await save({name:'untouched-tag'},rule('untouched-rule','calculated_stock'));
  await assign(untouched.tag.tag_id,['outside','SKU1']);
  const raw=await call('hub_rule_registry_v1',['operator','save',JSON.stringify(rule('manual-basis','basis_sku_price'))]);manualRule=raw;
  await call('hub_rule_assign_v1',['operator','apply',JSON.stringify([{sku:'SKU1',rule_id:raw.id}]),'00000000-0000-4000-8000-000000000001']);
 });
 await t.test('23760 option tags and shared rule links apply in one atomic RPC',async()=>{
  const graphBefore=(await scalar('select n from operations_private.qa_graph_calls')).n;
  const skus=Array.from({length:23760},(_,i)=>'SKU'+(i+1));const before=performance.now();
  const result=await assign(saved.tag.tag_id,skus);const ms=performance.now()-before;
  console.log('BULK_TAG_23760_MS='+Math.round(ms));assert.equal(result.sku_count,23760);assert.equal(result.rule_assignment_count,23760);
  assert.equal((await scalar('select n from operations_private.qa_graph_calls')).n,graphBefore+1,'first bulk link insertion validates the complete graph once');
  const counts=await db.query('select (select count(*)::int from public.sellpia_tag_assignments where tag_id=$1 and is_active) tags,(select count(*)::int from operations_private.hub_rule_assignments where assigned_tag_id=$1) links',[saved.tag.tag_id]);assert.deepEqual(counts.rows[0],{tags:23760,links:23760});
  assert.equal((await db.query("select count(*)::int n from operations_private.hub_rule_assignments where rule_id=$1 and sku='SKU1' and assigned_tag_id is null",[manualRule.id])).rows[0].n,1);
  assert.equal((await db.query('select count(*)::int n from public.sellpia_tag_assignments where tag_id=$1 and is_active',[untouched.tag.tag_id])).rows[0].n,2);
  assert.equal((await scalar("select relkind from pg_class where oid='operations_private.operations_hub_matrix_export_cache'::regclass")).relkind,'m');
  assert.equal((await scalar("select profile_json->>'unchanged' value from operations_private.operations_hub_matrix_export_cache where sellpia_sku_code='SKU23760'")).value,'true','bulk tag mutation must not UPDATE or refresh the materialized export cache');
 });
 await t.test('Excel import supports A-only selected tag and A/B per-row tag names',async()=>{
  const oneColumn=await excelImport([{sku:'SKU2'},{sku:'SKU3'}],saved.tag.tag_id,true);assert.deepEqual({mode:oneColumn.mode,rows:oneColumn.row_count,valid:oneColumn.valid_count,tags:oneColumn.tag_count},{mode:'single_tag',rows:2,valid:2,tags:1});
  const oneApplied=await excelImport([{sku:'SKU2'},{sku:'SKU3'}],saved.tag.tag_id,false);assert.equal(oneApplied.sku_count,2);assert.equal(oneApplied.inserted_tag_count,0,'the earlier full-tag test already linked these rows idempotently');
  const perRow=await excelImport([{sku:'excel-a',tag_name:'bulk-tag'},{sku:'excel-b',tag_name:'untouched-tag'},{sku:'excel-a',tag_name:'bulk-tag'}],null,true);assert.equal(perRow.mode,'per_row');assert.equal(perRow.valid_count,2);assert.equal(perRow.duplicate_count,1);assert.equal(perRow.error_count,0);
  const perApplied=await excelImport([{sku:'excel-a',tag_name:'bulk-tag'},{sku:'excel-b',tag_name:'untouched-tag'}],null,false);assert.equal(perApplied.tag_count,2);assert.equal(perApplied.sku_count,2);
  const invalid=await excelImport([{sku:'absent',tag_name:'missing-tag'},{sku:'SKU4',tag_name:''}],null,true);assert.equal(invalid.error_count,2);assert.match(invalid.preview_rows[0].error,/태그명을 찾지 못했습니다.*원본에 없는 SKU/);await assert.rejects(excelImport([{sku:'excel-c',tag_name:'missing-tag'}],null,false),/전체 저장을 취소/);
  assert.equal((await scalar("select count(*)::int n from public.sellpia_tag_assignments where sellpia_sku_code='excel-c' and is_active")).n,0,'failed import must not leave a partial tag assignment');
 });
 await t.test('same-stage conflict rolls back all added tags and assignments',async()=>{
  const existing=await call('hub_rule_registry_v1',['operator','save',JSON.stringify(rule('conflicting-manual'))]);
  await call('hub_rule_assign_v1',['operator','apply',JSON.stringify([{sku:'conflict',rule_id:existing.id}]),'00000000-0000-4000-8000-000000000002']);
  await assert.rejects(assign(saved.tag.tag_id,['manual','conflict']),/충돌/);
  assert.equal((await scalar("select count(*)::int n from public.sellpia_tag_assignments where sellpia_sku_code in ('manual','conflict') and is_active")).n,0);
  assert.equal((await scalar("select count(*)::int n from operations_private.hub_rule_assignments where sku='manual'")).n,0);
 });
 await t.test('reapplying all existing tags skips graph rebuild but repairs missing rule links',async()=>{
  const skus=Array.from({length:23760},(_,i)=>'SKU'+(i+1));
  const before=(await scalar('select n from operations_private.qa_graph_calls')).n;const started=performance.now();
  const result=await assign(saved.tag.tag_id,skus);console.log('BULK_TAG_REPEAT_23760_MS='+Math.round(performance.now()-started));
  assert.equal(result.rule_assignment_count,0);assert.equal((await scalar('select n from operations_private.qa_graph_calls')).n,before);
  await db.query("delete from operations_private.hub_rule_assignments where sku='SKU23760' and rule_id=$1",[saved.rules[0].id]);
  const repaired=await assign(saved.tag.tag_id,['SKU23760']);assert.equal(repaired.rule_assignment_count,1);assert.equal((await scalar('select n from operations_private.qa_graph_calls')).n,before+1);
 });
 await t.test('editing existing tag name and ordered formula preserves links and changes future values',async()=>{
  const beforeLinks=(await db.query('select count(*)::int n from operations_private.hub_rule_assignments where rule_id=$1',[saved.rules[0].id])).rows[0].n;
  const previous=globalThis.HubRuleRegistry.transform(1001,saved.rules[0].config);const started=performance.now();
  const updated=await save({id:saved.tag.tag_id,name:'renamed-bulk-tag'},{...saved.rules[0],config:{steps:[{op:'add',value:100}]}});console.log('BULK_TAG_FORMULA_EDIT_MS='+Math.round(performance.now()-started));
  assert.equal(updated.tag.tag_name,'renamed-bulk-tag');assert.equal(updated.rules[0].id,saved.rules[0].id);assert.equal(updated.rules[0].version,2);assert.equal(globalThis.HubRuleRegistry.transform(1001,updated.rules[0].config),1101);assert.notEqual(previous,1101);
  assert.equal((await db.query('select count(*)::int n from operations_private.hub_rule_assignments where rule_id=$1',[saved.rules[0].id])).rows[0].n,beforeLinks);
  await assert.rejects(save({id:saved.tag.tag_id,name:'bad-rename'},{...updated.rules[0],config:{steps:[{op:'divide',value:0}]}}));
  assert.equal((await db.query('select tag_name from public.product_tags where tag_id=$1',[saved.tag.tag_id])).rows[0].tag_name,'renamed-bulk-tag');
 });
 await t.test('auth and nonexistent SKU reject without partial changes',async()=>{
  await assert.rejects(call('hub_tag_assign_v1',['bad',saved.tag.tag_id,['manual'],'add']),/unauthorized/);
  await assert.rejects(call('hub_tag_rule_save_v1',['bad',JSON.stringify({name:'bad'}),JSON.stringify(rule('bad'))]),/unauthorized/);
  await assert.rejects(assign(saved.tag.tag_id,['manual','absent']),/원본 없음/);
  await assert.rejects(assign(saved.tag.tag_id,['manual','retired']),/원본 없음/);
  await assert.rejects(assign(saved.tag.tag_id,['manual','pending']),/원본 없음/);
  assert.equal((await scalar("select count(*)::int n from public.sellpia_tag_assignments where sellpia_sku_code='manual' and is_active")).n,0);
 });
 await t.test('timeout budgets are limited to atomic tag RPC and catalog validation avoids profile view',async()=>{
  const configs=(await db.query("select proconfig from pg_proc where oid='public.hub_tag_assign_v1(text,uuid,text[],text)'::regprocedure")).rows[0].proconfig;
  assert.ok(configs.includes('statement_timeout=30s'));assert.ok(configs.includes('lock_timeout=5s'));
  const definitions=await db.query("select pg_get_functiondef(p.oid) fn from pg_proc p where p.oid in ('public.hub_tag_assign_v1(text,uuid,text[],text)'::regprocedure,'operations_private.hub_sync_tag_rules(text[],text)'::regprocedure)");
  assert.ok(definitions.rows.every(r=>!r.fn.includes('operations_hub_product_profiles')));
 });
 await t.test('removing tag-origin links preserves manual assignments and nontarget tags',async()=>{
  await call('hub_rule_assign_v1',['operator','apply',JSON.stringify([{sku:'manual',rule_id:saved.rules[0].id}]),'00000000-0000-4000-8000-000000000003']);
  await assign(saved.tag.tag_id,['manual']);
  assert.equal((await scalar("select assigned_tag_id from operations_private.hub_rule_assignments where sku='manual'")).assigned_tag_id,null);
  const graphBefore=(await scalar('select n from operations_private.qa_graph_calls')).n;
  await assign(saved.tag.tag_id,['manual','SKU1'],'remove');
  assert.equal((await scalar('select n from operations_private.qa_graph_calls')).n,graphBefore+1,'link removal validates implicit fallback paths even without new links');
  assert.equal((await scalar("select count(*)::int n from operations_private.hub_rule_assignments where sku='manual'")).n,1);
  assert.equal((await db.query("select count(*)::int n from operations_private.hub_rule_assignments where sku='SKU1' and assigned_tag_id=$1",[saved.tag.tag_id])).rows[0].n,0);
  assert.equal((await db.query("select count(*)::int n from operations_private.hub_rule_assignments where sku='SKU1' and rule_id=$1",[manualRule.id])).rows[0].n,1);
  assert.equal((await db.query("select count(*)::int n from public.sellpia_tag_assignments where tag_id=$1 and sellpia_sku_code='SKU1' and is_active",[untouched.tag.tag_id])).rows[0].n,1);
 });
 await t.test('one platform tag saves all three scoped rules and product tag inheritance links them',async()=>{
  const platform=await save({name:'three-platforms'},rule('three-platform-rule','platform_registration_price'));
  assert.deepEqual(platform.rules.map(r=>r.scope),['smartstore','makeshop','ably']);assert.ok(platform.rules.every(r=>r.tag_id===platform.tag.tag_id));
  await db.query("insert into public.sellpia_tag_assignments(tag_id,tag_scope,sellpia_product_code) values($1,'product','OTHER')",[platform.tag.tag_id]);
  await db.query("select operations_private.hub_sync_tag_rules(array['outside'],'test')");
  assert.equal((await db.query("select count(*)::int n from operations_private.hub_rule_assignments where sku='outside' and assigned_tag_id=$1",[platform.tag.tag_id])).rows[0].n,3);
 });
 } finally {await db.close();}
});
