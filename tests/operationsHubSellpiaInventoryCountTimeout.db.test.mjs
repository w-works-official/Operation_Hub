import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const {PGlite}=await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const read=relative=>fs.readFileSync(new URL(relative,import.meta.url),'utf8');
const fixture=read('./fixtures/sellpiaInventoryCountTimeout.sql');
const definitions=JSON.parse(read('./fixtures/sellpiaInventoryCountBaselineFunctions.json'));
const migration=read('../supabase/migrations/20261013045421_sellpia_inventory_count_fixed_key_copy.sql');
const rollback=read('../supabase/rollback/20261013045421_sellpia_inventory_count_fixed_key_copy.sql');
const baselineDDL=(rollback.match(/CREATE OR REPLACE FUNCTION[\s\S]*?\$function\$;/gi)||[]).join('\n');
const boundarySQL=read('../supabase/migrations/20260920025225_operations_hub_original_upload_boundary_v1.sql');
const failStart=boundarySQL.indexOf('create or replace function public.hub_original_upload_intent_fail_v1(');
const failDDL=boundarySQL.slice(failStart,boundarySQL.indexOf('$$;',failStart)+3);
const base='10000000-0000-4000-8000-000000000001';
const snapshot='20000000-0000-4000-8000-000000000001';
const second='20000000-0000-4000-8000-000000000002';
const fields=`jsonb_build_object('inventory_count',true,'stock',true,'available_stock',true,'base_snapshot_id','${base}')`;
async function setup(){
  const db=new PGlite();await db.exec(fixture);
  for(const f of definitions)await db.exec(f.definition+';');
  await db.exec(failDDL);
  await db.exec(baselineDDL);await db.exec(rollback);await db.exec(migration);
  await db.exec('select operations_private.seed_inventory_timeout_fixture(100,2);');return db;
}
const call=s=>`select public.hub_sellpia_upload_complete_v2('isolated-operator','${s}') data`;
const state=s=>`select s.upload_status,i.status,(select count(*)::integer from public.sellpia_stock_snapshot_rows where snapshot_id=s.snapshot_id) row_count from public.sellpia_stock_snapshots s join operations_private.operations_hub_original_upload_intents i using(snapshot_id) where s.snapshot_id='${s}'`;

test('fixed key copy preserves all source information, nullable JSONB, negative stock and complete provenance',async()=>{
  const db=await setup();try {
    await db.exec(`update public.sellpia_stock_snapshot_rows set raw_payload=null where snapshot_id='${base}' and sellpia_sku_code='SKU00100';select operations_private.stage_inventory_timeout('${snapshot}',76);`);
    const result=(await db.query(call(snapshot))).rows[0].data;
    assert.equal(result.row_count,100);assert.equal(result.uploaded_row_count,76);assert.equal(result.preserved_row_count,24);
    assert.equal(result.affected_skus.length,76);assert.equal(result.base_snapshot_id,base);
    const source=(await db.query(`select to_jsonb(n)||jsonb_build_object('baseline',to_jsonb(b)) data from public.sellpia_stock_snapshot_rows n join public.sellpia_stock_snapshot_rows b on b.snapshot_id='${base}' and b.sellpia_sku_code=n.sellpia_sku_code where n.snapshot_id='${snapshot}' order by n.sellpia_sku_code`)).rows.map(v=>v.data);
    for(const r of source){
      for(const k of ['sellpia_product_code','sellpia_product_name','sellpia_option_name','own_sku','integrated_available_stock','safety_stock','supplier_code','supplier_name','supplier_group','supplier_address','supplier_market_name','supplier_phone','purchase_product_name','purchase_option_name','purchase_price','order_unit','minimum_order_unit'])assert.deepEqual(r[k],r.baseline[k],k);
      const changed=result.affected_skus.includes(r.sellpia_sku_code);
      assert.equal(r.stock,r.baseline.stock+(changed?1:0));assert.equal(r.available_stock,r.baseline.available_stock-(changed?1:0));
      for(const key of ['base_price','sell_price','purchase_price','commission','purchase_vat'])assert.deepEqual(r.raw_payload[key],r.baseline.raw_payload?.[key]);
      assert.equal(r.raw_payload[changed?'inventory_count_snapshot_id':'preserved_from_snapshot_id'],changed?snapshot:base);
      if(changed)assert.equal(r.raw_payload.inventory_count_base_snapshot_id,base);
    }
    assert.ok(source.some(v=>v.available_stock<0));assert.equal((await db.query('select count(*)::integer n from public.sellpia_stock_latest')).rows[0].n,100);
    assert.equal((await db.query(call(snapshot))).rows[0].data.status,'ready','completion retry is idempotent');
    await assert.rejects(db.query(`select public.hub_sellpia_upload_complete_v2('bad','${snapshot}')`),/unauthorized/);
  }finally{await db.close();}
});

test('zero, unknown, unchanged and stale-base payloads reject before snapshot promotion',async()=>{
  const db=await setup();try {
    await db.exec(`select operations_private.stage_inventory_timeout('${snapshot}',0);`);
    await assert.rejects(db.query(call(snapshot)),/실제 변경 SKU/);
    await db.exec(`update operations_private.operations_hub_original_upload_intents set expected_row_count=1 where intent_id='${snapshot}';insert into public.sellpia_stock_snapshot_rows(snapshot_id,sellpia_sku_code,stock,available_stock) values('${snapshot}','UNKNOWN',1,1);`);
    await assert.rejects(db.query(call(snapshot)),/식별되지/);
    await db.exec(`delete from public.sellpia_stock_snapshot_rows where snapshot_id='${snapshot}';insert into public.sellpia_stock_snapshot_rows(snapshot_id,sellpia_sku_code,stock,available_stock) select '${snapshot}',sellpia_sku_code,stock,available_stock from public.sellpia_stock_snapshot_rows where snapshot_id='${base}' and sellpia_sku_code='SKU00001';`);
    await assert.rejects(db.query(call(snapshot)),/변경되지 않은/);
    await db.exec(`update public.sellpia_stock_snapshot_rows set stock=stock+1 where snapshot_id='${snapshot}';insert into public.sellpia_stock_snapshots(snapshot_id,upload_status,created_at) values('${second}','ready',clock_timestamp());`);
    await assert.rejects(db.query(call(snapshot)),/최신 Sellpia snapshot이 변경/);
    assert.deepEqual((await db.query(state(snapshot))).rows[0],{upload_status:'uploading',status:'parsing',row_count:1});
    assert.equal((await db.query(`select count(*)::integer n from public.sellpia_stock_latest`)).rows[0].n,0,'latest view cannot read incomplete upload rows');
  }finally{await db.close();}
});

test('promotion failure rolls back copied rows and allows committed chunk retry; full/patch dispatch remains functional',async()=>{
  const db=await setup();try {
    await db.exec(`select operations_private.stage_inventory_timeout('${snapshot}',76);create function public.test_failure() returns trigger language plpgsql as $$ begin if new.upload_status='ready' then raise exception 'injected completion failure';end if;return new;end $$;create trigger test_failure before update on public.sellpia_stock_snapshots for each row execute function public.test_failure();`);
    await assert.rejects(db.query(call(snapshot)),/injected completion failure/);
    assert.deepEqual((await db.query(state(snapshot))).rows[0],{upload_status:'uploading',status:'parsing',row_count:76});
    await db.exec('drop trigger test_failure on public.sellpia_stock_snapshots;drop function public.test_failure();');
    assert.equal((await db.query(call(snapshot))).rows[0].data.row_count,100);
    await assert.rejects(db.query(`select public.hub_original_upload_intent_fail_v1('isolated-operator','${snapshot}','lost response',false)`),/ready snapshot/);
    await db.exec(`select operations_private.stage_inventory_timeout('${second}',1,'${snapshot}');update operations_private.operations_hub_original_upload_intents set upload_mode='patch',selected_fields='{"inventory":true}' where intent_id='${second}';`);
    const patch=(await db.query(call(second))).rows[0].data;assert.equal(patch.upload_mode,'patch');assert.equal(patch.row_count,100);
    const full='20000000-0000-4000-8000-000000000003';
    await db.exec(`select operations_private.stage_inventory_timeout('${full}',1,'${second}');update operations_private.operations_hub_original_upload_intents set upload_mode='full' where intent_id='${full}';`);
    const replacement=(await db.query(call(full))).rows[0].data;assert.equal(replacement.upload_mode,'full');assert.equal(replacement.row_count,1);assert.equal(replacement.status,'ready');
    const failed='20000000-0000-4000-8000-000000000004';
    await db.exec(`select operations_private.stage_inventory_timeout('${failed}',1,'${full}');`);
    assert.equal((await db.query(`select public.hub_original_upload_intent_fail_v1('isolated-operator','${failed}','canceling statement due to statement timeout',false) data`)).rows[0].data.status,'failed');
    assert.deepEqual((await db.query(state(failed))).rows[0],{upload_status:'failed',status:'failed',row_count:1});
    await assert.rejects(db.query(call(failed)),/완료 가능한/);
  }finally{await db.close();}
});

test('migration and rollback drift guards reject unrelated concurrent function changes',async()=>{
  const db=await setup();try {
    await db.exec(`create or replace function public.finalize_operations_hub_sellpia_inventory_count(p_snapshot_id uuid,p_selected_fields jsonb) returns jsonb language plpgsql set search_path=public,pg_temp as $$ begin return '{"parallel_change":true}'::jsonb;end $$;`);
    await assert.rejects(db.exec(migration),/drift|변경|expected|guard|정의/i);
    await assert.rejects(db.exec(rollback),/drift|변경|expected|guard|정의/i);
    await db.exec(baselineDDL);await db.exec(migration);await db.exec(rollback);await db.exec(migration);
    await db.exec(`select operations_private.stage_inventory_timeout('${snapshot}',1);`);
    assert.equal((await db.query(call(snapshot))).rows[0].data.row_count,100);
  }finally{await db.close();}
});
