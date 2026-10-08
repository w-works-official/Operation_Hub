import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const migration=await readFile(new URL('../supabase/migrations/20261008150000_ably_inventory_mapping_contract.sql',import.meta.url),'utf8');
const db=new PGlite();
const shaA='a'.repeat(64),shaB='b'.repeat(64);
test.after(()=>db.close());

try {
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema operations_private;
    grant usage on schema operations_private to anon,authenticated;
    create function operations_private.require_operations_hub_operator_session(p_session_token text)
    returns jsonb language plpgsql security definer as $$ begin
      if p_session_token <> 'test-session' then raise exception using errcode='42501',message='operator session required'; end if;
      return jsonb_build_object('username','qa-operator');
    end $$;
    create table public.operations_hub_link_suppressions(source_channel text,product_code text,option_code text,sellpia_sku_code text);
    create table public.operations_hub_manual_links(source_channel text,product_code text,option_code text,sellpia_sku_code text);
    create table public.operations_hub_matrix_live(sellpia_sku_code text,sellpia_current_stock integer);
  `);
  await db.exec(migration);
  await db.exec(`
    insert into public.operations_hub_matrix_live values ('SKU-1',10),('SKU-2',7),('SKU-3',4),('SKU-4-1',6),('SKU-5',2),('SKU-6',3),('OTHER-SKU',3),('SKU-NEW',6);
    insert into public.operations_hub_manual_links values
      ('ably','P1','1','SKU-1'),('ably','P2','1','SKU-1'),('ably','P3','1','SKU-2'),
      ('ably','P4','1','SKU-3'),('ably','P5','1','SKU-4-1'),('ably','P6','1','SKU-5'),
      ('ably','P7','1','SKU-6'),('ably','P7','1','OTHER-SKU');
    insert into public.operations_hub_link_suppressions values ('ably','P6','1','SKU-5');
  `);
} catch(error) {
  await db.close();
  throw error;
}

test('server import verifies only exact unique identity+code+current-stock rows, preserves literal suffix and is idempotent',async()=>{
  const rows=[
    {product_code:'P1',option_code:'1',solution_code:'sellpia_SKU-1',source_stock:10,safety_stock:1,source_row_no:2},
    {product_code:'P2',option_code:'1',solution_code:'sellpia_SKU-1',source_stock:10,safety_stock:1,source_row_no:3},
    {product_code:'P3',option_code:'1',solution_code:'sellpia_SKU-2',source_stock:8,safety_stock:1,source_row_no:4},
    {product_code:'P4',option_code:'1',solution_code:'sellpia_SKU-3',source_stock:4,safety_stock:0,source_row_no:5},
    {product_code:'P5',option_code:'1',solution_code:'sellpia_SKU-4-1',source_stock:6,safety_stock:0,source_row_no:6},
    {product_code:'P6',option_code:'1',solution_code:'sellpia_SKU-5',source_stock:2,safety_stock:0,source_row_no:7},
    {product_code:'P7',option_code:'1',solution_code:'sellpia_SKU-6',source_stock:3,safety_stock:0,source_row_no:8}
  ];
  const payload=JSON.stringify(rows);
  const first=(await db.query(`select operations_private.import_ably_inventory_mappings_admin_v1($1,$2,$3,$4::jsonb) as result`,['ably-seed-batch-0001','ably.xlsx',shaA,payload])).rows[0].result;
  assert.equal(first.source_row_count,7);
  assert.equal(first.verified,2,'only P4 and suffix-exact P5 meet the strict server checks');
  assert.equal(first.review,4,'duplicate J, stock mismatch, and suppression stay in review');
  assert.equal(first.conflict,1,'one seller identity with multiple distinct legacy owners is a conflict');
  const mapped=(await db.query(`select product_code,solution_code,candidate_sku_code,sellpia_sku_code,mapping_state,stock_policy,is_active from public.operations_hub_ably_inventory_mappings order by product_code`)).rows;
  assert.deepEqual(mapped.map(row=>row.mapping_state),['review','review','review','verified','verified','review','conflict']);
  assert.equal(mapped[4].solution_code,'sellpia_SKU-4-1');
  assert.equal(mapped[4].candidate_sku_code,'SKU-4-1');
  assert.equal(mapped[4].sellpia_sku_code,'SKU-4-1');
  assert.deepEqual(mapped.map(row=>row.stock_policy),['review','review','review','shared','shared','review','review']);
  assert.equal(mapped[3].is_active,true,'safe legacy shared mapping stays export-eligible');
  assert.equal(mapped[4].is_active,true,'literal suffix remains eligible only when exact seller mapping agrees');
  assert.equal(mapped[5].is_active,false,'legacy suppression blocks activation');
  const again=(await db.query(`select operations_private.import_ably_inventory_mappings_admin_v1($1,$2,$3,$4::jsonb) as result`,['retry-key-00000001','ably.xlsx',shaA,payload])).rows[0].result;
  assert.equal(again.idempotent,true);
  assert.equal((await db.query(`select count(*)::integer as count from operations_private.operations_hub_ably_mapping_history`)).rows[0].count,7);
});

test('session-gated operator update can set individual policy and activate only when no legacy suppression exists',async()=>{
  await assert.rejects(()=>db.query(`select public.update_operations_hub_ably_mapping_v1('bad-session','P4','1','SKU-3','verified','individual',2,true,'confirm unique mapping')`));
  const saved=(await db.query(`select public.update_operations_hub_ably_mapping_v1('test-session','P4','1','SKU-3','verified','individual',2,true,'confirm unique mapping') as result`)).rows[0].result;
  assert.equal(saved.is_active,true);
  assert.equal(saved.individual_stock,2);
  assert.equal(saved.stock_policy,'individual');
  const exportable=(await db.query(`select public.load_ably_verified_export_mappings_v1('test-session',null,array['SKU-3']) as result`)).rows[0].result;
  assert.deepEqual(exportable.rows,[{product_code:'P4',option_code:'1',sku:'SKU-3',solution_code:'sellpia_SKU-3'}],
    'price/matrix link read includes verified mappings regardless of stock policy');
  await assert.rejects(()=>db.query(`select public.load_ably_verified_export_mappings_v1('test-session',null,null)`));
  await db.exec(`insert into public.operations_hub_link_suppressions values ('ably','P4','1','SUPPRESSED-OTHER-SKU')`);
  await assert.rejects(()=>db.query(`select public.update_operations_hub_ably_mapping_v1('test-session','P4','1','SKU-3','verified','individual',2,true,'try suppressed activation')`));
  await assert.rejects(()=>db.query(`select public.update_operations_hub_ably_mapping_v1('test-session','P4','1','SKU-3','verified','individual',2,false,'try suppressed verification')`));
  const loaded=(await db.query(`select public.load_ably_inventory_mappings_v1('test-session') as result`)).rows[0].result;
  const p4=loaded.rows.find(row=>row.product_code==='P4');
  assert.equal(p4.suppression_active,true);
  const blocked=(await db.query(`select public.load_ably_verified_export_mappings_v1('test-session',array['P4'],null) as result`)).rows[0].result;
  assert.equal(blocked.rows.length,0);
  assert.deepEqual(blocked.blocked_identities,[{product_code:'P4',option_code:'1',reason:'legacy_suppression_active'}]);
  const before=loaded.fingerprint;
  await db.exec(`delete from public.operations_hub_link_suppressions`);
  const after=(await db.query(`select public.load_ably_inventory_mappings_v1('test-session') as result`)).rows[0].result;
  assert.notEqual(after.fingerprint,before,'fingerprint must include current suppression state');
});

test('reimporting a changed literal J value deactivates and reviews without rewriting the previously mapped SKU or stock policy',async()=>{
  const rows=[{product_code:'P4',option_code:'1',solution_code:'sellpia_SKU-NEW',source_stock:6,safety_stock:0,source_row_no:2}];
  await db.query(`select operations_private.import_ably_inventory_mappings_admin_v1($1,$2,$3,$4::jsonb)`,['ably-seed-batch-0002','ably-2.xlsx',shaB,JSON.stringify(rows)]);
  const row=(await db.query(`select solution_code,candidate_sku_code,sellpia_sku_code,mapping_state,stock_policy,individual_stock,is_active from public.operations_hub_ably_inventory_mappings where product_code='P4'`)).rows[0];
  assert.equal(row.solution_code,'sellpia_SKU-NEW');
  assert.equal(row.candidate_sku_code,'SKU-NEW');
  assert.equal(row.sellpia_sku_code,'SKU-3');
  assert.equal(row.mapping_state,'review');
  assert.equal(row.stock_policy,'individual');
  assert.equal(row.individual_stock,2);
  assert.equal(row.is_active,false);
});
