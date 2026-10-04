import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const parserSource = fs.readFileSync(new URL('../mockups/operations-hub/seller-source-parsers.js', import.meta.url), 'utf8');
const context = {console};
vm.createContext(context);
vm.runInContext(parserSource, context);
const parsers = context.SystemV3SellerParsers;
const fields = {inventory:true, price:true, basic:true, status:true};

test('Smartstore baseline discount affects customer price while conditional discounts stay separate', () => {
  const header = Array(68).fill(null);
  header[0] = '상품번호';
  header[1] = '판매자 상품코드';
  header[18] = '옵션 재고수량';
  const row = Array(68).fill(null);
  row[0] = '4680371525';
  row[1] = 'sellpia_1014';
  row[3] = 'discount fixture';
  row[5] = '5200';
  row[15] = '50094640701\n50094640703';
  row[16] = 'A\nB';
  row[17] = '0\n200';
  row[18] = '2\n3';
  row[19] = 'Y\nY';
  row[57] = '10';
  row[58] = '%';
  row[59] = '99';
  row[60] = '%';
  row[61] = '1000';
  row[62] = '원';
  row[63] = '2026-08-01~2026-08-31';
  row[64] = '2';
  row[65] = '개';
  row[66] = '500';
  row[67] = '원';

  const parsed = parsers.parseSmartstoreRows([header, row], 'smart.xlsx', fields);
  assert.equal(parsed[0].base_price, 5200);
  assert.equal(parsed[0].discounted_base_price, 4680);
  assert.equal(parsed[0].final_price, 4680);
  assert.equal(parsed[1].option_price, 200);
  assert.equal(parsed[1].final_price, 4880);
  assert.deepEqual(Array.from(parsed[0].discount_terms, term => [term.term_type, term.is_baseline]), [
    ['basic', true],
    ['mobile', false],
    ['reservation', false],
    ['multi_buy', false]
  ]);
  assert.equal(parsed[0].raw_payload.smartstore_mobile_discount_value, '99');
});

test('Makeshop period discount preserves its rounding rule and excludes membership from baseline', () => {
  const header = Array(124).fill(null);
  header[4] = 'product_uid';
  header[32] = 'sto_stock';
  header[44] = 'sell_price';
  const row = Array(124).fill(null);
  row[4] = '2085501';
  row[12] = 'discount fixture';
  row[29] = 'A';
  row[31] = '200';
  row[32] = '3';
  row[41] = '판매';
  row[43] = '425';
  row[44] = '5200';
  row[45] = '3';
  row[105] = 'A000104';
  row[106] = '10%할인';
  row[107] = '10% 십원단위 절사';
  row[108] = '2026-08-01 00시 00분 ~ 종료일 미정';
  row[123] = 'N';

  const [parsed] = parsers.parseMakeshopRows([header, row], 'make.xlsx', fields);
  assert.equal(parsed.base_price, 5200);
  assert.equal(parsed.discounted_base_price, 4680);
  assert.equal(parsed.option_price, 200);
  assert.equal(parsed.final_price, 4880);
  assert.equal(parsed.discount_terms[0].rounding_mode, 'down');
  assert.equal(parsed.discount_terms[0].rounding_unit, 10);
  assert.equal(parsed.discount_terms[1].term_type, 'membership');
  assert.equal(parsed.discount_terms[1].is_baseline, false);
});

test('Ably keeps the reported base, discounted price, final price, and per-row discount delta', () => {
  const header = Array(29).fill(null);
  header[0] = '상품 번호';
  header[10] = '옵션 번호';
  header[15] = '재고수량';
  const row = Array(29).fill(null);
  row[0] = '73910822';
  row[1] = '11501';
  row[2] = 'discount fixture';
  row[4] = '21500';
  row[5] = '20500';
  row[6] = '20500';
  row[10] = '529336777';
  row[14] = 'silver';
  row[15] = '7';

  const [parsed] = parsers.parseAblyRows([header, row], 'ably.csv', fields);
  assert.equal(parsed.base_price, 21500);
  assert.equal(parsed.discounted_base_price, 20500);
  assert.equal(parsed.reported_final_price, 20500);
  assert.equal(parsed.final_price, 20500);
  assert.equal(parsed.discount_terms[0].value, 1000);
  assert.equal(parsed.discount_terms[0].term_type, 'reported_result');
});

test('price-only fields are absent during inventory-only refreshes', () => {
  const header = Array(68).fill(null);
  header[0] = '상품번호';
  header[1] = '판매자 상품코드';
  header[18] = '옵션 재고수량';
  const row = Array(68).fill(null);
  row[0] = '4680371525';
  row[5] = '5200';
  row[15] = '50094640701';
  row[18] = '2';
  row[57] = '10';
  row[58] = '%';
  const [parsed] = parsers.parseSmartstoreRows([header, row], 'smart.xlsx', {
    inventory:true,
    price:false,
    basic:false,
    status:false
  });
  assert.equal(parsed.stock, 2);
  assert.equal(parsed.base_price, null);
  assert.equal(parsed.discounted_base_price, null);
  assert.equal(parsed.final_price, null);
  assert.deepEqual(Array.from(parsed.discount_terms), []);
});

test('native discounts can be refreshed without replacing seller base and option prices', () => {
  const header = Array(68).fill(null);
  header[0] = '상품번호';
  header[1] = '판매자 상품코드';
  header[18] = '옵션 재고수량';
  const row = Array(68).fill(null);
  row[0] = '4680371525';
  row[5] = '20000';
  row[15] = '50094640701';
  row[17] = '1000';
  row[18] = '2';
  row[57] = '10';
  row[58] = '%';
  const [parsed] = parsers.parseSmartstoreRows([header, row], 'smart.xlsx', {
    inventory:false,
    price:false,
    discount:true,
    basic:false,
    status:false
  });
  assert.equal(parsed.base_price, null);
  assert.equal(parsed.option_price, null);
  assert.equal(parsed.final_price, null);
  assert.equal(parsed.discounted_base_price, 18000);
  assert.equal(parsed.discount_terms[0].value, 10);
});
