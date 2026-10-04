import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../mockups/operations-hub/sellpia-inventory-count.js', import.meta.url), 'utf8');
const context = vm.createContext({console});
context.globalThis = context;
vm.runInContext(source, context, {filename:'sellpia-inventory-count.js'});
const api = context.SystemV3SellpiaInventoryCount;

function rows(headers, values) {
  return [headers, ...values.map(item => headers.map(header => item[header] ?? null))];
}

test('accepts the real 19-column shape by header text and ignores unrelated columns', () => {
  const headers = ['매입처','매입처코드','상품코드','상품명','매입옵션명','옵션명','미송수량','안전재고','배송준비수량','전달사항','당일배송','발주단위','최소발주수량','가용재고','재고','매입가','임의필드','자사코드','바코드'];
  const parsed = api.parseSheetRows(rows(headers, [{상품코드:'1000-1', 가용재고:936, 재고:939, 매입가:1234}]), {fileName:'DATA pinkrocket01.xlsx'});
  assert.equal(parsed.file.columnCount, 19);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.records[0])), {
    file_name:'DATA pinkrocket01.xlsx', file_index:0, source_row_no:2,
    sellpia_sku_code:'1000-1', available_stock:936, stock:939,
    status:'valid', reason:''
  });
});

test('accepts three columns in any order and ignores extra columns', () => {
  for (const headers of [
    ['상품코드','가용재고','재고'],
    ['재고','메모','상품코드','가용재고'],
  ]) {
    const parsed = api.parseSheetRows(rows(headers, [{상품코드:' 1172-3 ', 가용재고:'6', 재고:6, 메모:'무시'}]));
    assert.equal(parsed.records[0].sellpia_sku_code, '1172-3');
    assert.equal(parsed.records[0].available_stock, 6);
    assert.equal(parsed.records[0].stock, 6);
  }
});

test('requires all exact headers and rejects duplicate headers', () => {
  assert.throws(() => api.parseSheetRows([['상품코드','재고'], ['1000-1', 1]]), /가용재고/);
  assert.throws(() => api.parseSheetRows([['상품코드','가용재고','재고',' 재고 ']]), /재고.*중복/);
});

test('zero and negative integers are valid while blank, decimal, NaN, and missing SKU are invalid without zero coercion', () => {
  const parsed = api.parseSheetRows([
    ['상품코드','가용재고','재고'],
    ['zero', 0, '0'],
    ['blank', '', 1],
    ['negative', -1, 1],
    ['decimal', 1.5, 2],
    ['nan', 'abc', 2],
    ['', 1, 2],
  ]);
  assert.equal(parsed.records[0].status, 'valid');
  assert.equal(parsed.records[0].available_stock, 0);
  assert.equal(parsed.records[0].stock, 0);
  assert.match(parsed.records[1].reason, /필수값 누락/);
  assert.equal(parsed.records[1].available_stock, null);
  assert.equal(parsed.records[2].status, 'valid');
  assert.equal(parsed.records[2].available_stock, -1);
  assert.match(parsed.records[3].reason, /정수가 아님/);
  assert.match(parsed.records[4].reason, /잘못된 숫자/);
  assert.match(parsed.records[5].reason, /상품코드 필수값 누락/);
});

test('accepts signed PostgreSQL integer boundaries and rejects values outside the DB column range', () => {
  const parsed = api.parseSheetRows([
    ['상품코드','가용재고','재고'],
    ['min', -2147483648, -2147483648],
    ['max', 2147483647, 2147483647],
    ['too-low', -2147483649, 0],
    ['too-high', 0, '2147483648'],
  ]);
  assert.equal(parsed.records[0].status, 'valid');
  assert.equal(parsed.records[1].status, 'valid');
  assert.match(parsed.records[2].reason, /DB 정수 범위 초과/);
  assert.match(parsed.records[3].reason, /DB 정수 범위 초과/);
});

test('multi-file merge deduplicates equal values and blocks conflicting values', () => {
  const a = api.parseSheetRows([
    ['상품코드','가용재고','재고'],
    ['same', 3, 5],
    ['conflict', 7, 9],
    ['only-a', 1, 2],
  ], {fileName:'a.xlsx', fileIndex:0});
  const b = api.parseSheetRows([
    ['재고','상품코드','가용재고'],
    [5, 'same', 3],
    [10, 'conflict', 8],
    [4, 'only-b', 4],
  ], {fileName:'b.xlsx', fileIndex:1});
  const merged = api.mergeRecords([a, b]);
  assert.equal(merged.readRowCount, 6);
  assert.equal(merged.duplicateSameCount, 1);
  assert.equal(merged.duplicateConflictCount, 1);
  assert.equal(merged.rows.find(row => row.sellpia_sku_code === 'same').status, 'valid');
  assert.equal(merged.rows.find(row => row.sellpia_sku_code === 'conflict').status, 'duplicate_conflict');
});

test('preview classifies changed, unchanged, unknown, conflict, and invalid rows and uploads changes only', () => {
  const parsed = api.mergeRecords([
    api.parseSheetRows([
      ['상품코드','가용재고','재고'],
      ['changed', 8, 10],
      ['same', 4, 5],
      ['unknown', 1, 2],
      ['conflict', 2, 3],
      ['bad', '', 1],
    ], {fileName:'a.xlsx', fileIndex:0}),
    api.parseSheetRows([
      ['상품코드','가용재고','재고'],
      ['conflict', 9, 10],
    ], {fileName:'b.xlsx', fileIndex:1}),
  ]);
  const preview = api.buildPreview(parsed, [
    {sellpia_sku_code:'changed', stock:9, available_stock:8},
    {sellpia_sku_code:'same', stock:5, available_stock:4},
    {sellpia_sku_code:'conflict', stock:1, available_stock:1},
  ], {baseSnapshotId:'snapshot-1'});
  assert.deepEqual(JSON.parse(JSON.stringify(preview.summary)), {
    fileCount:2, readRowCount:6, validSkuCount:2, changedSkuCount:1,
    unchangedSkuCount:1, unknownSkuCount:1, duplicateSameCount:0,
    duplicateConflictCount:1, errorRowCount:1
  });
  assert.deepEqual(Array.from(preview.changedRows, row => row.sellpia_sku_code), ['changed']);
  assert.deepEqual(new Set(preview.rows.map(row => row.preview_status)), new Set(['changed','unchanged','unknown_sku','duplicate_conflict','invalid']));
});

test('stock export projection chooses physical or available stock and fails closed on unusable values', () => {
  const row = {sellpia_current_stock:939, sellpia_available_stock:936, stock:1, available_stock:2};
  assert.equal(api.resolveExportStock(row, 'stock'), 939);
  assert.equal(api.resolveExportStock(row, 'available_stock'), 936);
  assert.equal(api.resolveExportStock({sellpia_current_stock:-1}, 'stock'), -1);
  assert.equal(api.resolveExportStock({sellpia_available_stock:-3}, 'available_stock'), 0);
  assert.equal(api.resolveExportStock({sellpia_available_stock:''}, 'available_stock'), null);
  assert.throws(() => api.resolveExportStock(row, 'system_stock'), /기준/);
});

console.log('operations hub Sellpia inventory-count contract tests passed');
