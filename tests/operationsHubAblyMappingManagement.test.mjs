import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const modulePath=path.resolve(here,'../mockups/operations-hub/ably-mapping-management.js');
const migrationPath=path.resolve(here,'../supabase/migrations/20261008150000_ably_inventory_mapping_contract.sql');

function loadModule(){
  const fakeWindow={document:null};
  vm.runInNewContext(fs.readFileSync(modulePath,'utf8'),{window:fakeWindow,Map,Number,String,Array,Object,Error,RegExp,JSON,Math});
  return fakeWindow.AblyMappingManagement;
}

test('Ably parser locates A/H/J/N/O by headers and preserves literal solution suffix',()=>{
  const api=loadModule();
  const parsed=api.parseRows([
    ['title','','','','','','','','','','','',''],
    ['상품 번호','판매자 상품코드','','','','','','옵션 번호','','(신) 솔루션사 고유코드 (셀피아코드)','','','재고수량','안전재고'],
    ['P-01','SELL','','','','','','OPT-1','','sellpia_ABC-02','','','15','2']
  ]);
  assert.equal(parsed.header_row_no,2);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.rows[0])),{
    product_code:'P-01',option_code:'OPT-1',solution_code:'sellpia_ABC-02',source_stock:15,safety_stock:2,source_row_no:3
  });
  assert.equal(api.candidateFromSolutionCode(parsed.rows[0].solution_code),'ABC-02');
  assert.equal(api.candidateFromSolutionCode('sellpia_ABC-02-9'),'ABC-02-9');
});

test('new candidates and stale-stock differences stay review; identity duplicates are conflicts',()=>{
  const api=loadModule();
  const rows=[
    {product_code:'P',option_code:'1',solution_code:'sellpia_SKU-A',source_stock:10,source_row_no:2},
    {product_code:'Q',option_code:'1',solution_code:'sellpia_SKU-A',source_stock:10,source_row_no:3},
    {product_code:'R',option_code:'1',solution_code:'sellpia_SKU-B',source_stock:7,source_row_no:4},
    {product_code:'R',option_code:'1',solution_code:'sellpia_SKU-C',source_stock:7,source_row_no:5}
  ];
  const result=api.classifyRows(rows,{
    existingMappings:[{product_code:'P',option_code:'1',solution_code:'sellpia_SKU-A',sellpia_sku_code:'SKU-A',mapping_state:'verified'}],
    matrixStock:{'SKU-A':10,'SKU-B':5,'SKU-C':7}
  });
  assert.equal(result[0].mapping_state,'review','duplicate literal J across seller identities requires human review');
  assert.ok(result[0].review_reasons.includes('duplicate_solution_code'));
  assert.equal(result[1].mapping_state,'review','same SKU/code reused across seller identities is review, not identity conflict');
  assert.equal(result[2].mapping_state,'conflict','one seller identity appearing twice is conflict');
  assert.ok(result[2].review_reasons.includes('duplicate_seller_identity'));
  assert.ok(result[0].candidate_sku_code==='SKU-A','remove only the fixed prefix; do not truncate the suffix');
  assert.equal(api.summarize(result).conflict,2);
});

test('classification marks stock mismatch and suppression as review without treating SKU as invalid',()=>{
  const api=loadModule();
  const rows=[
    {product_code:'P1',option_code:'1',solution_code:'sellpia_SKU-1',source_stock:8,source_row_no:2},
    {product_code:'P2',option_code:'1',solution_code:'sellpia_SKU-2',source_stock:4,source_row_no:3},
    {product_code:'P3',option_code:'1',solution_code:'sellpia_SKU-3',source_stock:4,source_row_no:4},
    {product_code:'P4',option_code:'1',solution_code:'sellpia_SKU-4',source_stock:4,source_row_no:5}
  ];
  const classified=api.classifyRows(rows,{
    manualMappings:[
      {product_code:'P1',option_code:'1',sellpia_sku_code:'SKU-1',mapping_origin:'manual'},
      {product_code:'P2',option_code:'1',sellpia_sku_code:'SKU-2',mapping_origin:'manual'},
      {product_code:'P3',option_code:'1',sellpia_sku_code:'SKU-3',mapping_origin:'manual'},
      {product_code:'P4',option_code:'1',sellpia_sku_code:'SKU-4',mapping_origin:'manual'},
      {product_code:'P4',option_code:'1',sellpia_sku_code:'SKU-OTHER',mapping_origin:'manual'}
    ],
    matrixStock:{'SKU-1':9,'SKU-2':4,'SKU-3':4,'SKU-4':4},
    suppressions:[{product_code:'P2',option_code:'1'}]
  });
  assert.equal(classified[0].mapping_state,'review');
  assert.ok(classified[0].review_reasons.includes('stock_differs'));
  assert.equal(classified[1].mapping_state,'review');
  assert.ok(classified[1].review_reasons.includes('legacy_suppression_active'));
  assert.equal(classified[2].mapping_state,'verified','exact current seller identity, unique literal code, and matching stock may be counted as eligible');
  assert.equal(classified[3].mapping_state,'conflict','one A+H identity with multiple distinct owners is ambiguous');
  assert.ok(classified[3].review_reasons.includes('ambiguous_manual_identity_owners'));
  assert.equal(classified[0].candidate_sku_code,'SKU-1');
});

test('migration protects raw tables, gates public RPCs with operator sessions and keeps seller identity as the only key',()=>{
  const sql=fs.readFileSync(migrationPath,'utf8');
  assert.match(sql,/primary key \(product_code, option_code\)/i);
  assert.doesNotMatch(sql,/unique\s*\(\s*sellpia_sku_code\s*\)/i);
  assert.match(sql,/alter table public\.operations_hub_ably_inventory_mappings enable row level security/i);
  assert.match(sql,/revoke all on table public\.operations_hub_ably_inventory_mappings from public, anon, authenticated/i);
  assert.match(sql,/operations_private\.require_operations_hub_operator_session\(p_session_token\)/i);
  assert.match(sql,/create or replace function public\.load_ably_inventory_mappings_v1\(p_session_token text\)/i);
  assert.match(sql,/create or replace function public\.import_operations_hub_ably_mappings_v1\(p_session_token text/i);
  assert.match(sql,/create or replace function public\.update_operations_hub_ably_mapping_v1\(p_session_token text/i);
  assert.match(sql,/source_solution_code_changed/i);
  assert.match(sql,/active suppression|v_suppressed/i);
  assert.doesNotMatch(sql,/\b(insert into|update|delete from)\s+public\.(operations_hub_manual_links|operations_hub_seller_listings|operations_hub_listing_components|operations_hub_link_suppressions)\b/i);
});
