import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const FULL='00000000-0000-4000-8000-000000000001';
const PATCH='00000000-0000-4000-8000-000000000002';
const OTHER='00000000-0000-4000-8000-000000000003';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');

test('bounded Sellpia v3 read separates FULL carrier before from latest PATCH and master target',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create schema operations_private;grant usage on schema operations_private to anon,authenticated;
  create function operations_private.require_operations_hub_operator_session(t text) returns jsonb language plpgsql as $$ begin if t is distinct from 'operator' then raise exception 'unauthorized';end if;return '{}'::jsonb;end $$;
  create function operations_private.hub_sku_input_fingerprint_v1(s text,c text) returns text language sql stable as $$ select 'current'::text $$;
  create table public.sellpia_stock_snapshots(snapshot_id uuid,upload_status text,completed_at timestamptz,created_at timestamptz,metadata jsonb);
  create table public.sellpia_stock_snapshot_rows(snapshot_id uuid,sellpia_sku_code text,sellpia_product_code text,sellpia_product_name text,sellpia_option_name text,purchase_price numeric,stock integer,raw_payload jsonb);
  create table public.operations_hub_sku_operational_master(sellpia_sku_code text,purchase_price numeric,base_price numeric,stock_quantity integer);
  create table operations_private.operations_hub_matrix_export_cache(sellpia_sku_code text,sellpia_own_code text,own_code text,sellpia_product_name text,sellpia_option_name text);
  create table operations_private.hub_rules(id uuid,name text,version bigint,is_active boolean);
  create table operations_private.hub_rule_assignments(sku text,rule_id uuid,scope text,target_field text,version bigint);
  create table operations_private.hub_calculated_results(sku text,scope text,field text,value numeric,error text,generation_id bigint,rule_versions jsonb,status text,result_details jsonb);
  insert into public.sellpia_stock_snapshots values
   ('${FULL}','ready','2026-09-20T00:00:00Z','2026-09-20T00:00:00Z','{"upload_mode":"full","source_storage_files":[{},{},{}]}'),
   ('${PATCH}','ready','2026-09-21T00:00:00Z','2026-09-21T00:00:00Z','{"upload_mode":"patch","base_snapshot_id":"${FULL}"}');
  insert into public.sellpia_stock_snapshot_rows values
   ('${FULL}','5566-1','5566','상품','노볼',30000,100,'{"base_price":59000}'),
   ('${PATCH}','5566-1','5566','상품','노볼',32000,100,'{"base_price":59000}');
  insert into public.operations_hub_sku_operational_master values('5566-1',null,59000,100);
  insert into operations_private.operations_hub_matrix_export_cache values('5566-1','OWN','OWN','상품','노볼');`);
  await db.exec(fs.readFileSync('supabase/migrations/20260921143034_hub_sellpia_carrier_current_read_v3.sql','utf8'));
  const call=async(state=PATCH,carrier=FULL)=>(await db.query('select public.hub_sellpia_patch_read_v3($1,$2,$3,$4,$5,$6,$7,$8,$9) data',
   ['operator',carrier,state,['5566-1'],'','sku',0,100,false])).rows[0].data;
  const fromPatch=await call();
  assert.equal(fromPatch.snapshot_id,FULL);
  assert.equal(fromPatch.state_snapshot_id,PATCH);
  assert.equal(fromPatch.rows[0].sellpia_source_purchase_price,30000);
  assert.equal(fromPatch.rows[0].sellpia_purchase_price,32000);
  await db.exec("update public.operations_hub_sku_operational_master set purchase_price=35000 where sellpia_sku_code='5566-1'");
  assert.equal((await call()).rows[0].sellpia_purchase_price,35000,'operational value wins over latest source');
  await assert.rejects(call(FULL,FULL),/상태가 변경/);
  await assert.rejects(call(PATCH,OTHER),/carrier가 아닙니다/);
  await assert.rejects(db.query("select public.hub_sellpia_patch_read_v3('bad',$1,$2,array['5566-1'],'','sku',0,100,false)",[FULL,PATCH]),/unauthorized/);
 }finally{await db.close();}
});

test('repaired v3 carrier lineage supports FULL to PATCH to INVENTORY_COUNT to PATCH and retains ready and cycle guards',async()=>{
 const COUNT='00000000-0000-4000-8000-000000000004';
 const PATCH_AFTER_COUNT='00000000-0000-4000-8000-000000000005';
 const FAILED='00000000-0000-4000-8000-000000000006';
 const db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create schema operations_private;
  grant usage on schema operations_private to anon,authenticated;
  create function operations_private.require_operations_hub_operator_session(t text) returns jsonb language plpgsql as $$ begin if t is distinct from 'operator' then raise exception 'unauthorized';end if;return '{}'::jsonb;end $$;
  create function operations_private.hub_sku_input_fingerprint_v1(s text,c text) returns text language sql stable as $$ select 'current'::text $$;
  create table public.sellpia_stock_snapshots(snapshot_id uuid,upload_status text,completed_at timestamptz,created_at timestamptz,metadata jsonb);
  create table public.sellpia_stock_snapshot_rows(snapshot_id uuid,sellpia_sku_code text,sellpia_product_code text,sellpia_product_name text,sellpia_option_name text,purchase_price numeric,stock integer,raw_payload jsonb);
  create table public.operations_hub_sku_operational_master(sellpia_sku_code text,purchase_price numeric,base_price numeric,stock_quantity integer);
  create table operations_private.operations_hub_matrix_export_cache(sellpia_sku_code text,sellpia_own_code text,own_code text,sellpia_product_name text,sellpia_option_name text);
  create table operations_private.hub_rules(id uuid,name text,version bigint,is_active boolean);
  create table operations_private.hub_rule_assignments(sku text,rule_id uuid,scope text,target_field text,version bigint);
  create table operations_private.hub_calculated_results(sku text,scope text,field text,value numeric,error text,generation_id bigint,rule_versions jsonb,status text,result_details jsonb);
  insert into public.sellpia_stock_snapshots values
   ('${FULL}','ready','2026-09-20T00:00:00Z','2026-09-20T00:00:00Z','{"upload_mode":"full","source_storage_files":[{},{},{}]}'),
   ('${PATCH}','ready','2026-09-21T00:00:00Z','2026-09-21T00:00:00Z','{"upload_mode":"patch","base_snapshot_id":"${FULL}"}'),
   ('${COUNT}','ready','2026-10-13T01:00:00Z','2026-10-13T01:00:00Z','{"upload_mode":"inventory_count","base_snapshot_id":"${PATCH}"}'),
   ('${FAILED}','failed','2026-10-14T01:00:00Z','2026-10-14T01:00:00Z','{"upload_mode":"inventory_count","base_snapshot_id":"${COUNT}"}');
  insert into public.sellpia_stock_snapshot_rows values
   ('${FULL}','5566-1','5566','상품','노볼',30000,100,'{"base_price":59000}'),
   ('${PATCH}','5566-1','5566','상품','노볼',32000,100,'{"base_price":59000}'),
   ('${COUNT}','5566-1','5566','상품','노볼',32000,76,'{"base_price":59000}'),
   ('${FAILED}','5566-1','5566','실패 상품','실패 옵션',0,0,'{"base_price":0}');
  insert into public.operations_hub_sku_operational_master values('5566-1',35000,59000,76);
  insert into operations_private.operations_hub_matrix_export_cache values('5566-1','OWN','OWN','상품','노볼');`);
  await db.exec(fs.readFileSync('supabase/migrations/20260921143034_hub_sellpia_carrier_current_read_v3.sql','utf8'));
  const call=async(state=COUNT,carrier=FULL)=>(await db.query('select public.hub_sellpia_patch_read_v3($1,$2,$3,$4,$5,$6,$7,$8,$9) data',
   ['operator',carrier,state,['5566-1'],'','sku',0,100,false])).rows[0].data;
  await assert.rejects(call(),/carrier가 아닙니다/,'baseline reproduces inventory_count carrier rejection');
  const migration=fs.readFileSync('supabase/migrations/20261013045421_sellpia_inventory_count_fixed_key_copy.sql','utf8');
  const repair=migration.match(/create or replace function operations_private\.hub_sellpia_patch_read_v3\([\s\S]*?AS (\$[A-Za-z_]*\$)[\s\S]*?\1;/i);
  assert.ok(repair,'the timeout migration includes the inventory_count carrier compatibility repair');
  await db.exec(repair[0]);
  const fromCount=await call();
  assert.equal(fromCount.snapshot_id,FULL);assert.equal(fromCount.state_snapshot_id,COUNT);
  assert.equal(fromCount.rows[0].sellpia_source_purchase_price,30000);
  assert.equal(fromCount.rows[0].sellpia_purchase_price,35000,'operational purchase price still wins');
  assert.equal(fromCount.rows[0].sellpia_source_sale_price,59000);
  assert.equal(fromCount.rows[0].sellpia_source_stock,100,'immutable FULL remains before-value carrier');
  assert.equal(fromCount.rows[0].system_stock,76);assert.equal(fromCount.rows[0].__missing,false);

  await db.exec(`insert into public.sellpia_stock_snapshots values
   ('${PATCH_AFTER_COUNT}','ready','2026-10-13T02:00:00Z','2026-10-13T02:00:00Z','{"upload_mode":"patch","base_snapshot_id":"${COUNT}"}');
  insert into public.sellpia_stock_snapshot_rows values
   ('${PATCH_AFTER_COUNT}','5566-1','5566','상품','노볼',33000,76,'{"base_price":59000}');
  update public.operations_hub_sku_operational_master set purchase_price=null where sellpia_sku_code='5566-1';`);
  const afterPatch=await call(PATCH_AFTER_COUNT);
  assert.equal(afterPatch.snapshot_id,FULL);assert.equal(afterPatch.state_snapshot_id,PATCH_AFTER_COUNT);
  assert.equal(afterPatch.rows[0].sellpia_source_purchase_price,30000);
  assert.equal(afterPatch.rows[0].sellpia_purchase_price,33000,'latest ready PATCH still provides current source price');
  await assert.rejects(call(COUNT),/상태가 변경/,'a stale requested state is not accepted');
  await assert.rejects(call(PATCH_AFTER_COUNT,OTHER),/carrier가 아닙니다/);

  await db.exec(`update public.sellpia_stock_snapshots set upload_status='failed' where snapshot_id='${COUNT}'`);
  await assert.rejects(call(PATCH_AFTER_COUNT),/carrier가 아닙니다/,'failed parent breaks proof instead of promoting incomplete source');
  await db.exec(`update public.sellpia_stock_snapshots set upload_status='ready',metadata=jsonb_set(metadata,'{base_snapshot_id}',to_jsonb('${PATCH_AFTER_COUNT}'::text)) where snapshot_id='${COUNT}'`);
  await assert.rejects(call(PATCH_AFTER_COUNT),/carrier가 아닙니다/,'cycle is rejected instead of revisiting a snapshot');
  await db.exec(`update public.sellpia_stock_snapshots set metadata=jsonb_set(metadata,'{base_snapshot_id}',to_jsonb('${PATCH}'::text)) where snapshot_id='${COUNT}';
  update public.sellpia_stock_snapshots set metadata=jsonb_set(metadata,'{source_storage_files}','[]'::jsonb) where snapshot_id='${FULL}'`);
  await assert.rejects(call(PATCH_AFTER_COUNT),/carrier가 아닙니다/,'an absent FULL three-file carrier still blocks the read');
 }finally{await db.close();}
});
