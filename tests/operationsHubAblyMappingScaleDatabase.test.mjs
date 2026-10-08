import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { PGlite } from '@electric-sql/pglite';

const baseline=await readFile(new URL('../supabase/migrations/20261008150000_ably_inventory_mapping_contract.sql',import.meta.url),'utf8');
const optimized=await readFile(new URL('../supabase/migrations/20261008151000_ably_mapping_import_scale.sql',import.meta.url),'utf8');
const db=new PGlite();
test.after(()=>db.close());

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
await db.exec(baseline);
await db.exec(optimized);

test('scale migration replaces per-row JSON recount and imports/reimports a 7,314-row workbook-sized fixture', {timeout:120_000}, async()=>{
  const rows=[];
  for(let i=0;i<7314;i++){
    const duplicateIndex=i>=7068&&i<7249?i-7068:null;
    const skuIndex=duplicateIndex===null?i:duplicateIndex;
    const solution=i<7249?`sellpia_SKU-${String(skuIndex+1).padStart(6,'0')}`:'';
    rows.push({product_code:`P-${String(i+1).padStart(5,'0')}`,option_code:'1',solution_code:solution,source_stock:1,safety_stock:0,source_row_no:i+2});
  }
  const mappedRows=rows.filter(row=>row.solution_code);
  const identityRows=JSON.stringify(mappedRows.map(row=>({source_channel:'ably',product_code:row.product_code,option_code:row.option_code,sellpia_sku_code:row.solution_code.slice(8)})));
  const stocks=JSON.stringify([...new Map(mappedRows.map(row=>[row.solution_code.slice(8),1])).entries()].map(([sellpia_sku_code,sellpia_current_stock])=>({sellpia_sku_code,sellpia_current_stock})));
  await db.query(`insert into public.operations_hub_manual_links select * from jsonb_to_recordset($1::jsonb) as x(source_channel text,product_code text,option_code text,sellpia_sku_code text)`,[identityRows]);
  await db.query(`insert into public.operations_hub_matrix_live select * from jsonb_to_recordset($1::jsonb) as x(sellpia_sku_code text,sellpia_current_stock integer)`,[stocks]);
  const payload=JSON.stringify(rows),sha='c'.repeat(64);
  const started=performance.now();
  const first=(await db.query(`select operations_private.import_ably_inventory_mappings_admin_v1($1,$2,$3,$4::jsonb) as result`,['scale-batch-0000001','ably.xlsx',sha,payload])).rows[0].result;
  const elapsedMs=Math.round(performance.now()-started);
  assert.equal(first.source_row_count,7314);
  assert.equal(first.verified,6887,'each unique literal J with exact manual owner and matching stock verifies');
  assert.equal(first.review,427,'362 rows with duplicated literal codes and 65 blank codes stay in review');
  assert.equal(first.conflict,0);
  assert.ok(elapsedMs<60_000,`first import should fit the server's 60-second function timeout (observed ${elapsedMs} ms)`);
  const again=(await db.query(`select operations_private.import_ably_inventory_mappings_admin_v1($1,$2,$3,$4::jsonb) as result`,['scale-retry-0000001','ably.xlsx',sha,payload])).rows[0].result;
  assert.equal(again.idempotent,true);
  assert.equal(again.source_row_count,7314);
  assert.equal((await db.query(`select count(*)::integer as n from public.operations_hub_ably_inventory_mappings`)).rows[0].n,7314);
});
