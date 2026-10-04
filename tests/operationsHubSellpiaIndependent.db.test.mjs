import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
test('independent patch RPC enforces sessions, exact search, missing/stale/inactive values and bounded reads',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create schema operations_private;grant usage on schema operations_private to anon,authenticated;
 create function operations_private.require_operations_hub_operator_session(t text) returns jsonb language plpgsql as $$ begin if t is distinct from 'operator' then raise exception 'unauthorized';end if;return '{}';end $$;
 create function operations_private.hub_sku_input_fingerprint_v1(s text,c text) returns text language sql stable as $$ select 'current'::text $$;
 create table public.sellpia_stock_snapshots(snapshot_id uuid,upload_status text,completed_at timestamptz,created_at timestamptz);
 insert into public.sellpia_stock_snapshots values('00000000-0000-4000-8000-000000000001','ready',now(),now());
 create table public.sellpia_stock_snapshot_rows(snapshot_id uuid,sellpia_sku_code text,sellpia_product_code text,sellpia_product_name text,sellpia_option_name text,purchase_price numeric,stock integer,raw_payload jsonb);
 create table public.operations_hub_sku_operational_master(sellpia_sku_code text,purchase_price numeric,base_price numeric,stock_quantity integer);
 create table operations_private.operations_hub_matrix_export_cache(sellpia_sku_code text,sellpia_own_code text,own_code text,sellpia_product_name text,sellpia_option_name text,sellpia_sale_price numeric);
 create table operations_private.hub_rules(id uuid,name text,version bigint,is_active boolean);
 create table operations_private.hub_rule_assignments(sku text,rule_id uuid,scope text,target_field text,version bigint);
 create table operations_private.hub_calculated_results(sku text,scope text,field text,value numeric,error text,generation_id bigint,rule_versions jsonb,status text,result_details jsonb);
 insert into operations_private.hub_rules values('00000000-0000-4000-8000-000000000002','2.2',1,true);
 insert into public.sellpia_stock_snapshot_rows select '00000000-0000-4000-8000-000000000001',s,'5566','14K 피어싱','옵션',53500,90,'{"base_price":67500}'::jsonb from unnest(array['5566-1','5566-10','5566-4'])s;
 insert into operations_private.operations_hub_matrix_export_cache select sellpia_sku_code,'[NA-01]','[NA-01]',sellpia_product_name,sellpia_option_name,80000 from public.sellpia_stock_snapshot_rows;
 insert into public.operations_hub_sku_operational_master select sellpia_sku_code,60000,80000,100 from public.sellpia_stock_snapshot_rows;
 insert into operations_private.hub_rule_assignments values('5566-1','00000000-0000-4000-8000-000000000002','','calculated_base_price',1);
 insert into operations_private.hub_calculated_results values('5566-1','','calculated_base_price',59000,null,42,'[]','calculated','{"input_fingerprint":"current"}'),('5566-4','','calculated_base_price',48000,null,17,'[]','calculated','{"input_fingerprint":"old"}');`);
 await db.exec(fs.readFileSync('supabase/migrations/20260918073338_hub_sellpia_independent_read_mvp.sql','utf8'));
 await db.exec(fs.readFileSync('supabase/migrations/20260918075108_hub_sellpia_patch_owner_proof.sql','utf8'));
 await db.exec(fs.readFileSync('supabase/migrations/20260920083000_hub_sellpia_carrier_snapshot_read_v2.sql','utf8'));
 const call=async(token='operator',skus=null,search='5566-1',type='sku',offset=0,limit=100,proof=true)=>(await db.query('select public.hub_sellpia_patch_read_v1($1,$2,$3,$4,$5,$6,$7) data',[token,skus,search,type,offset,limit,proof])).rows[0].data;
 await db.exec('set role anon');await assert.rejects(call('bad'),/unauthorized/);await assert.rejects(db.query('select * from operations_private.hub_calculated_results'),/permission denied/);await db.exec('reset role');
 const exact=await call();assert.equal(exact.count,1);assert.equal(exact.rows[0].sellpia_source_purchase_price,53500);assert.equal(exact.rows[0].sellpia_purchase_price,60000);assert.equal(exact.rows[0].__hubInternalPrices.calculated_base_price.stale,false);
 const exactSnapshot=(await db.query("select public.hub_sellpia_patch_read_v2('operator','00000000-0000-4000-8000-000000000001',array['5566-1'],'','sku',0,100,true) data")).rows[0].data;
 assert.equal(exactSnapshot.snapshot_id,'00000000-0000-4000-8000-000000000001');assert.equal(exactSnapshot.rows[0].sellpia_source_sale_price,67500);assert.equal(exactSnapshot.rows[0].system_base_price,80000);
 assert.equal(exact.rows[0].__hubInternalPrices.calculated_base_price.provenanceMismatch,true,'current fingerprint cannot replace missing owner proof');
 await db.exec(`update operations_private.hub_calculated_results set rule_versions='[{"id":"00000000-0000-4000-8000-000000000002","version":1,"assignmentVersion":1}]' where sku='5566-1'`);assert.equal((await call()).rows[0].__hubInternalPrices.calculated_base_price.provenanceMismatch,false);
 assert.equal((await call('operator',null,'5566-')).count,3);assert.equal((await call('operator',null,'NOT-FOUND')).count,0);assert.equal((await call('operator',null,'[NA-01]','own_code')).count,3);assert.equal((await call('operator',null,'피어싱','name')).count,3);
 const subset=await call('operator',['5566-1','missing','5566-4']);assert.equal(subset.count,3);assert.equal(subset.rows.find(r=>r.sellpia_sku_code==='missing').__missing,true);assert.equal(subset.rows.find(r=>r.sellpia_sku_code==='5566-4').__activeBaseOwner,false);
 await db.exec(`update operations_private.hub_calculated_results set result_details='{"input_fingerprint":"old"}' where sku='5566-1'`);assert.equal((await call()).rows[0].__hubInternalPrices.calculated_base_price.stale,true);
 assert.equal((await call('operator',['5566-1'], '', 'sku',0,100,false)).rows[0].__hubInternalPrices.calculated_base_price,undefined);
 await assert.rejects(call('operator',null,'5566-1','sku',0,null),/유효하지/);await assert.rejects(call('operator',null,'5566-1','sku',0,501),/유효하지/);
 const cursor=await call('operator',null,'5566-','sku',1,1);assert.equal(cursor.count,3);assert.equal(cursor.rows.length,1);
 }finally{await db.close();}
});
