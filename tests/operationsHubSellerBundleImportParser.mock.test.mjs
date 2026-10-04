import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const parser = require('../mockups/operations-hub/seller-bundle-import-parser.js');

const headers = ['판매처', '판매처 상품코드', '판매처 옵션코드', '구성품 상품코드-옵션코드', '구성수량', '구성유형'];
const parsed = parser.parseSellerBundleRows([
  headers,
  ['스마트스토어', '001234', '0001', '0100-01', 1, '1+1'],
  ['smart store', '001234', '0001', '0100-02', '2', 'one_plus_one'],
  ['스마트스토어', '001234', '0001', '0100-01', 1, '1＋1'],
  ['', '', '', '', '', '']
]);
assert.equal(parsed.valid, true);
assert.deepEqual(parsed.rows, [
  {seller:'smartstore', sellerProductCode:'001234', sellerOptionCode:'0001', componentCode:'0100-01', quantity:1, compositionType:'one_plus_one', rowNo:2},
  {seller:'smartstore', sellerProductCode:'001234', sellerOptionCode:'0001', componentCode:'0100-02', quantity:2, compositionType:'one_plus_one', rowNo:3}
]);
assert.deepEqual(parsed.codes, ['0100-01', '0100-02']);
assert.equal(parsed.targets.length, 1);
assert.equal(parsed.duplicateCount, 1);
assert.deepEqual(parsed.summary, {inputRowCount:3, validRowCount:2, targetCount:1, componentCodeCount:2, duplicateCount:1, errorCount:0});

const aliases = parser.parseSellerBundleRows([
  ['\uFEFF채널', '상품코드', '옵션코드', '구성품SKU', '수량', '유형'],
  ['make shop', 'P-1', 'O-1', '200-1', 1, 'bundle'],
  ['에이블리', 'P-2', 'O-2', '300-1', 1, '세트']
]);
assert.equal(aliases.valid, true);
assert.deepEqual(aliases.rows.map(row => [row.seller, row.compositionType]), [['makeshop', 'set'], ['ably', 'set']]);

const duplicateAliasHeaders = parser.parseSellerBundleRows([
  ['판매처', '채널', '판매처 상품코드', '판매처 옵션코드', '구성품 상품코드-옵션코드', '구성수량', '구성유형']
]);
assert.equal(duplicateAliasHeaders.valid, false);
assert.match(duplicateAliasHeaders.errors.join('\n'), /1행.*판매처.*두 개 이상/);

const blankOption = parser.parseSellerBundleRows([
  headers,
  ['smartstore', 'P-1', '', '100-1', 1, 'set']
]);
assert.equal(blankOption.valid, false);
assert.match(blankOption.errors.join('\n'), /2행 판매처 옵션코드가 비어/);

for (const invalidQuantity of ['0', '-1', '1.5', 'abc']) {
  const result = parser.parseSellerBundleRows([headers, ['smartstore', 'P-1', 'O-1', '100-1', invalidQuantity, 'set']]);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /2행 구성수량/);
}

for (const invalidType of ['collection', '모음전', '1:N']) {
  const result = parser.parseSellerBundleRows([headers, ['smartstore', 'P-1', 'O-1', '100-1', 1, invalidType]]);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /2행 구성유형/);
}

const ambiguousType = parser.parseSellerBundleRows([
  headers,
  ['smartstore', 'P-1', 'O-1', '100-1', 1, 'set'],
  ['smartstore', 'P-1', 'O-1', '200-1', 1, '1+1']
]);
assert.equal(ambiguousType.valid, false);
assert.match(ambiguousType.errors.join('\n'), /3행.*2행.*모호/);

const conflictingDuplicate = parser.parseSellerBundleRows([
  headers,
  ['makeshop', 'P-1', 'O-1', '100-1', 1, 'set'],
  ['makeshop', 'P-1', 'O-1', '100-1', 2, 'set']
]);
assert.equal(conflictingDuplicate.valid, false);
assert.match(conflictingDuplicate.errors.join('\n'), /3행.*2행.*모호/);

const unsupportedSeller = parser.parseSellerBundleRows([
  headers,
  ['zigzag', 'P-1', 'O-1', '100-1', 1, 'set']
]);
assert.equal(unsupportedSeller.valid, false);
assert.match(unsupportedSeller.errors.join('\n'), /2행 판매처/);

const fuzzyHeader = parser.parseSellerBundleRows([
  ['판매처명', '판매처 상품코드', '판매처 옵션코드', '구성품 상품코드-옵션코드', '구성수량', '구성유형']
]);
assert.equal(fuzzyHeader.valid, false, '헤더는 명시된 정확 표제나 alias만 허용해야 한다');
assert.match(fuzzyHeader.errors.join('\n'), /필수 헤더 '판매처'/);

const maxRows = parser.parseSellerBundleRows([
  headers,
  ['smartstore', 'P-1', 'O-1', '100-1', 1, 'set'],
  ['smartstore', 'P-1', 'O-1', '200-1', 1, 'set']
], {maxRows:1});
assert.equal(maxRows.valid, false);
assert.match(maxRows.errors.join('\n'), /최대 1행.*현재 2행/);

const maxCodes = parser.parseSellerBundleRows([
  headers,
  ['smartstore', 'P-1', 'O-1', '100-1', 1, 'set'],
  ['smartstore', 'P-1', 'O-1', '200-1', 1, 'set']
], {maxCodes:1});
assert.equal(maxCodes.valid, false);
assert.match(maxCodes.errors.join('\n'), /최대 1개.*현재 2개/);

console.log('operations hub seller bundle import parser tests passed');
