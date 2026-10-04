import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('supabase/migrations/20260825052000_sellpia_procurement_and_actual_inbound_cost.sql');
const dataService = read('mockups/operations-hub/data-service.js');
const sellpiaParser = read('mockups/operations-hub/sellpia-source-parser.js');
const app = read('mockups/operations-hub/app.js');
const html = read('mockups/operations-hub/index.html');
const csv = read('mockups/operations-hub/matrix-csv-export.js');

assert.match(migration, /add column if not exists purchase_price numeric/);
assert.match(migration, /add column if not exists order_unit numeric/);
assert.match(migration, /add column if not exists minimum_order_unit numeric/);
assert.match(migration, /create table if not exists public\.operations_hub_inbound_cost_formula_tags/);
assert.match(migration, /create table if not exists public\.operations_hub_inbound_cost_settings/);
assert.match(migration, /create or replace function public\.save_operations_hub_inbound_cost/);
assert.match(migration, /create or replace view public\.operations_hub_inbound_cost_live/);
assert.match(migration, /p_purchase_price \* coalesce\(p_multiply_value, 1\)/);
assert.match(migration, /nullif\(coalesce\(p_divide_value, 1\), 0\)/);

assert.match(sellpiaParser, /REQUIRED_HEADERS[\s\S]*?purchasePrice:\['매입가'\][\s\S]*?orderUnit:\['발주단위'\][\s\S]*?minimumOrderUnit:\['최소발주수량', '최소발주단위'\]/);
assert.match(sellpiaParser, /buildSellpiaColumnMap[\s\S]*?normalizeHeader/, 'procurement fields must resolve by normalized header name instead of fixed positions');
assert.match(sellpiaParser, /purchase_price:number\(cell\(source, columns, 'purchasePrice'\)\)/);
assert.match(sellpiaParser, /order_unit:number\(cell\(source, columns, 'orderUnit'\)\)/);
assert.match(sellpiaParser, /minimum_order_unit:number\(cell\(source, columns, 'minimumOrderUnit'\)\)/);
assert.match(dataService, /attachInboundCostDetails/);
assert.match(dataService, /saveInboundCostFormulaTag/);
assert.match(dataService, /saveInboundCost/);

assert.match(html, /<th>매입가<\/th><th>발주단위<\/th><th>최소발주단위<\/th><th>실입고가<\/th>/);
assert.match(html, /id="inbound-cost-tag-form"/);
assert.match(html, /id="inbound-cost-modal"/);
assert.match(app, /data-inbound-cost-edit/);
assert.match(app, /실입고가를 DB에 바로 저장했습니다/);
assert.match(app, /calculateInboundCostPreview\(product\.sellpia_source_purchase_price, tag\)/, 'formula preview must use the immutable Sellpia raw purchase source');
assert.match(app, /parts\.push\(`÷ \$\{divide\.toLocaleString\('ko-KR'\)\}`\)/);
assert.match(csv, /label:'셀피아 매입가'/);
assert.match(csv, /label:'실입고가 수식태그'/);

console.log('Operations hub Sellpia procurement and actual inbound cost contract: passed');
