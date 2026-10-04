
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const data=fs.readFileSync('mockups/operations-hub/data-service.js','utf8');
const workflow=fs.readFileSync('mockups/operations-hub/seller-file-workflow-v2.js','utf8');
const migration=fs.readFileSync('supabase/migrations/20260912231500_seller_inventory_blank_stock_policy_v2.sql','utf8');

test('blank seller stock is preserved and carrier export never invents an overwrite',()=>{
  assert.match(data,/stage_operations_hub_seller_inventory_match_batch_v2/);
  assert.match(data,/p_overwrite_blank:!!overwriteBlank/);
  assert.doesNotMatch(workflow,/data-standard-overwrite-blank/);
  assert.doesNotMatch(workflow,/data-ably-overwrite-blank/);
  assert.match(workflow,/item\.sales_quantity==null/);
  assert.match(workflow,/out\._blankStockPreserved=true/);
  const priceExport=fs.readFileSync('mockups/operations-hub/current-price-export.js','utf8');
  const context={window:{}};vm.createContext(context);vm.runInContext(priceExport,context);
  const stockTarget=context.window.HubCurrentPriceExport.matrixStockTarget;
  assert.equal(stockTarget({source_stock:null,seller_stock:null,stock_draft:{after_value:''}}),null);
  assert.equal(stockTarget({source_stock:5,stock_draft:{after_value:0}}),0);
  assert.match(workflow,/빈셀 유지/);
  assert.match(workflow,/X \*판매수량\(실재고\)[\s\S]*?W 판매가능재고와 나머지 셀은 보존/);
  assert.match(migration,/target_safety_state='preserved_blank'/);
  assert.match(migration,/blank_seller_stock_overwrite_enabled/);
  assert.match(migration,/sellerStock'='null'::jsonb/);
});
