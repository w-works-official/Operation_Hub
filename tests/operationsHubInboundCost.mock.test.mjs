import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

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
const parser = createRequire(import.meta.url)('../mockups/operations-hub/sellpia-source-parser.js');
const procurementHeaders = ['#','상품코드','자사코드','상품명','옵션명','재고','가용재고','품절','단종','판매가','안전재고','매입처코드','매입처','매입처그룹','매입처주소','상가명','매입처전화','매입상품명','매입옵션명','매입가','수수료','매입처부가세','발주단위','최소발주수량'].reverse();
function procurementFile(rows) {
  const text = [procurementHeaders.join(','), ...rows.map((values,index) => {
    const row = {'#':index+1,상품코드:`00123-${index+1}`,상품명:'합성 매입가 검증 상품',재고:7,가용재고:5,판매가:1000,안전재고:0,...values};
    return procurementHeaders.map(header => row[header] ?? '').join(',');
  })].join('\r\n');
  return new File([text],'synthetic-procurement.csv',{type:'text/csv'});
}
const nullableProcurement = await parser.parseSellpiaFiles([procurementFile([
  {매입가:'',발주단위:' ',최소발주수량:''},
  {매입가:0,발주단위:0,최소발주수량:0},
])],{mode:'patch',strictNumeric:true});
assert.equal(nullableProcurement.valid,true,nullableProcurement.errors.join(' '));
for (const key of ['purchase_price','order_unit','minimum_order_unit']) {
  assert.equal(nullableProcurement.rows[0][key],null,`${key}: blank purchasing information stays nullable`);
  assert.equal(nullableProcurement.rows[0].raw_payload[key],null);
  assert.equal(nullableProcurement.rows[1][key],0,`${key}: an explicit zero stays zero`);
  assert.equal(nullableProcurement.rows[1].raw_payload[key],0);
}
for (const invalid of [{매입가:'NaN'},{발주단위:'Infinity'},{최소발주수량:'invalid'}]) {
  const parsed = await parser.parseSellpiaFiles([procurementFile([invalid])],{mode:'patch',strictNumeric:true});
  assert.equal(parsed.valid,false,'strict automatic import rejects malformed purchasing data');
  assert.equal(parsed.rows.length,0);
}
const manualProcurement = await parser.parseSellpiaFiles([procurementFile([{매입가:'invalid'}])],{mode:'patch'});
assert.equal(manualProcurement.valid,true,'default manual parser remains compatible');
assert.equal(manualProcurement.rows[0].purchase_price,null);
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
