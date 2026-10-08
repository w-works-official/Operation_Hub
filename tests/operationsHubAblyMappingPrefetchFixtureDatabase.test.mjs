import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { PGlite } from '@electric-sql/pglite';

const baseline=await readFile(new URL('../supabase/migrations/20261008150000_ably_inventory_mapping_contract.sql',import.meta.url),'utf8');
const codeOptimized=await readFile(new URL('../supabase/migrations/20261008151000_ably_mapping_import_scale.sql',import.meta.url),'utf8');
const prefetched=await readFile(new URL('../supabase/migrations/20261008152000_ably_mapping_import_prefetch.sql',import.meta.url),'utf8');

async function runBatch(rows,manualRows,matrixRows,suppression,migrations,sha){
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
    const result=(await db.query(`select operations_private.import_ably_inventory_mappings_admin_v1($1,$2,$3,$4::jsonb) as result`,['fixture-batch-0000001','ably.xlsx',sha,JSON.stringify(rows)])).rows[0].result;
    const elapsedMs=Math.round(performance.now()-started);
    const stored=(await db.query(`select product_code,option_code,solution_code,candidate_sku_code,sellpia_sku_code,mapping_state,review_reasons,stock_policy,individual_stock,is_active,source_stock,safety_stock,source_row_no from public.operations_hub_ably_inventory_mappings order by product_code,option_code`)).rows;
    return {result,elapsedMs,stored};
  }finally{await db.close();}
}

test('prefetch import matches prior classifications for a deterministic 7,314-row fixture and edge cases',{timeout:180_000},async()=>{
  const rows=[];
  for(let i=0;i<7314;i++){
    let solution=`sellpia_CI-${String(i+1).padStart(5,'0')}`;
    if(i===2||i===3)solution='sellpia_DUP-CODE';
    if(i===10)solution='sellpia_';
    if(i===11)solution='literal-code-with-suffix-01';
    if(i===12)solution='';
    const sourceStock=i===20?null:5;
    rows.push({product_code:`CI-${String(i+1).padStart(5,'0')}`,option_code:'1',solution_code:solution,source_stock:sourceStock,safety_stock:0,source_row_no:i+2});
  }
  const candidates=rows.filter(r=>r.solution_code.startsWith('sellpia_')&&r.solution_code.length>8);
  const manualRows=candidates.map(r=>({source_channel:'ably',product_code:r.product_code,option_code:r.option_code,sellpia_sku_code:r.solution_code.slice(8)}));
  manualRows.push({...manualRows.find(r=>r.product_code==='CI-00030'),sellpia_sku_code:'CI-OTHER-OWNER'});
  const stockBySku=new Map(candidates.map(r=>[r.solution_code.slice(8),5]));
  stockBySku.set('CI-00041',null);
  const matrixRows=[...stockBySku].filter(([sku])=>sku!=='CI-00041').map(([sellpia_sku_code,sellpia_current_stock])=>({sellpia_sku_code,sellpia_current_stock}));
  const suppression=manualRows.find(r=>r.product_code==='CI-00032');
  const prior=await runBatch(rows,manualRows,matrixRows,suppression,[baseline,codeOptimized],'e'.repeat(64));
  const next=await runBatch(rows,manualRows,matrixRows,suppression,[baseline,codeOptimized,prefetched],'e'.repeat(64));
  assert.deepEqual(next.result,prior.result);
  assert.deepEqual(next.stored,prior.stored);
  assert.equal(next.result.source_row_count,7314);
  const byProduct=new Map(next.stored.map(row=>[row.product_code,row]));
  assert.equal(byProduct.get('CI-00003').mapping_state,'review');
  assert.ok(byProduct.get('CI-00003').review_reasons.includes('duplicate_solution_code'));
  assert.equal(byProduct.get('CI-00004').mapping_state,'review');
  assert.equal(byProduct.get('CI-00030').mapping_state,'conflict');
  assert.equal(byProduct.get('CI-00032').review_reasons[0],'legacy_suppression_active');
  assert.equal(byProduct.get('CI-00011').candidate_sku_code,null,'empty sellpia_ suffix must not generate a candidate');
  assert.equal(byProduct.get('CI-00012').solution_code,'literal-code-with-suffix-01','non-prefixed literal J text remains unchanged');
  assert.ok(byProduct.get('CI-00021').review_reasons.includes('source_stock_differs'),'source null stock remains review');
  assert.ok(byProduct.get('CI-00041').review_reasons.includes('source_stock_differs'),'missing Matrix candidate stock remains review');
  assert.ok(next.elapsedMs<60_000,`prefetched import must fit the function timeout (${next.elapsedMs}ms)`);
  console.log(JSON.stringify({prior_ms:prior.elapsedMs,prefetched_ms:next.elapsedMs,...next.result}));
});
