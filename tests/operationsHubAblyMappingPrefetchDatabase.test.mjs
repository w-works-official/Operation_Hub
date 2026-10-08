import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { PGlite } from '@electric-sql/pglite';

const sourceUrl=new URL('../work/ably-source-rows.json',import.meta.url);
let sourceRows=null;
try { sourceRows=JSON.parse(await readFile(sourceUrl,'utf8')); } catch {}
const baseline=await readFile(new URL('../supabase/migrations/20261008150000_ably_inventory_mapping_contract.sql',import.meta.url),'utf8');
const codeOptimized=await readFile(new URL('../supabase/migrations/20261008151000_ably_mapping_import_scale.sql',import.meta.url),'utf8');
const prefetched=await readFile(new URL('../supabase/migrations/20261008152000_ably_mapping_import_prefetch.sql',import.meta.url),'utf8');

test('optional local actual-source comparison preserves classifications for the 7,314-row payload', {skip:!sourceRows?'local ignored work/ably-source-rows.json is unavailable':false,timeout:180_000}, async()=>{
  assert.equal(sourceRows.length,7314);
  const candidates=sourceRows.filter(r=>typeof r.solution_code==='string'&&r.solution_code.startsWith('sellpia_')&&r.solution_code.length>8);
  assert.ok(candidates.length>7000);
  const manualRows=candidates.map(r=>({source_channel:'ably',product_code:r.product_code,option_code:r.option_code??'',sellpia_sku_code:r.solution_code.slice(8)}));
  const stockBySku=new Map();
  for(const row of candidates)if(!stockBySku.has(row.solution_code.slice(8)))stockBySku.set(row.solution_code.slice(8),row.source_stock===null||row.source_stock===''?null:Number(row.source_stock));
  const matrixRows=[...stockBySku].map(([sellpia_sku_code,sellpia_current_stock])=>({sellpia_sku_code,sellpia_current_stock}));
  const extraOwner=manualRows.find(r=>r.product_code!==candidates[0].product_code);
  if(extraOwner)manualRows.push({...extraOwner,sellpia_sku_code:`${extraOwner.sellpia_sku_code}-ALT`});
  if(manualRows[0])manualRows.splice(0,1);
  const suppression=manualRows[1];
  const payload=JSON.stringify(sourceRows),sha='d'.repeat(64);

  async function importWith(migrations){
    const db=new PGlite();
    try{
      await db.exec(`
        create role anon; create role authenticated; create schema operations_private;
        grant usage on schema operations_private to anon,authenticated;
        create function operations_private.require_operations_hub_operator_session(p_session_token text) returns jsonb
          language plpgsql security definer as $$ begin if p_session_token<>'test-session' then raise exception using errcode='42501'; end if; return jsonb_build_object('username','qa-operator'); end $$;
        create table public.operations_hub_link_suppressions(source_channel text,product_code text,option_code text,sellpia_sku_code text);
        create table public.operations_hub_manual_links(source_channel text,product_code text,option_code text,sellpia_sku_code text);
        create table public.operations_hub_matrix_live(sellpia_sku_code text,sellpia_current_stock integer);
      `);
      for(const migration of migrations)await db.exec(migration);
      await db.query(`insert into public.operations_hub_manual_links select * from jsonb_to_recordset($1::jsonb) as x(source_channel text,product_code text,option_code text,sellpia_sku_code text)`,[JSON.stringify(manualRows)]);
      await db.query(`insert into public.operations_hub_matrix_live select * from jsonb_to_recordset($1::jsonb) as x(sellpia_sku_code text,sellpia_current_stock integer)`,[JSON.stringify(matrixRows)]);
      if(suppression)await db.query(`insert into public.operations_hub_link_suppressions values ('ably',$1,$2,$3)`,[suppression.product_code,suppression.option_code,suppression.sellpia_sku_code]);
      const started=performance.now();
      const result=(await db.query(`select operations_private.import_ably_inventory_mappings_admin_v1($1,$2,$3,$4::jsonb) as result`,['source-batch-0000001','ably.xlsx',sha,payload])).rows[0].result;
      const elapsedMs=Math.round(performance.now()-started);
      const rows=(await db.query(`select product_code,option_code,solution_code,candidate_sku_code,sellpia_sku_code,mapping_state,review_reasons,stock_policy,individual_stock,is_active,source_stock,safety_stock,source_row_no from public.operations_hub_ably_inventory_mappings order by product_code,option_code`)).rows;
      return {result,elapsedMs,rows};
    }finally{await db.close();}
  }
  const prior=await importWith([baseline,codeOptimized]);
  const optimized=await importWith([baseline,codeOptimized,prefetched]);
  assert.deepEqual(optimized.result,prior.result,'batch totals and import contract remain identical');
  assert.deepEqual(optimized.rows,prior.rows,'per-identity classification, policy, and source observations remain identical');
  assert.ok(prior.elapsedMs<60_000,`prior core exceeded the 60s function timeout in this test runtime: ${prior.elapsedMs}ms`);
  assert.equal(optimized.result.source_row_count,7314);
  assert.ok(optimized.result.verified>0);
  assert.ok(optimized.result.review>0);
  assert.ok(optimized.result.conflict>0,'the fixture deliberately includes an inverse-ambiguous manual owner');
  assert.ok(optimized.elapsedMs<60_000,`optimized import must fit the server function timeout (${optimized.elapsedMs}ms)`);
  console.log(JSON.stringify({prior_ms:prior.elapsedMs,prefetched_ms:optimized.elapsedMs,rows:optimized.result.source_row_count,verified:optimized.result.verified,review:optimized.result.review,conflict:optimized.result.conflict}));
});
