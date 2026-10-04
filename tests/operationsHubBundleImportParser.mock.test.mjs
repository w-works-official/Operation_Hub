import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const parser = require('../mockups/operations-hub/bundle-import-parser.js');

const parsed = parser.parseBundleCompositionRows([
  ['\uFEFF  구성품   상품코드-옵션코드 ', '역할', ' 세트 상품코드-옵션코드 ', '구성수량'],
  [' 0010-02 ', '구성품', ' 0099-01 ', '2'],
  ['0011-01', '', '0099-01', 1],
  ['0010-02', '', '0099-01', '2'],
  ['', '', '', '']
]);
assert.equal(parsed.valid, true);
assert.deepEqual(parsed.codes, ['0099-01', '0010-02', '0011-01'], '코드는 숫자로 변환하지 않고 문자열과 선행 0을 보존해야 한다');
assert.deepEqual(parsed.rows.map(row => [row.bundleCode, row.componentCode, row.quantity, row.role]), [
  ['0099-01', '0010-02', 2, 'component'],
  ['0099-01', '0011-01', 1, 'component']
]);
assert.deepEqual(parsed.rows[0], {bundleCode:'0099-01', componentCode:'0010-02', quantity:2, role:'component', rowNo:2});
assert.equal(parsed.duplicateCount, 1);
assert.deepEqual(parsed.summary, {
  inputRowCount: 3,
  validRowCount: 2,
  bundleCount: 1,
  componentCount: 2,
  uniqueCodeCount: 3,
  duplicateCount: 1,
  errorCount: 0,
  cycleValidation: 'file-only',
  requiresServerCycleValidation: true
});

const missingValue = parser.parseBundleCompositionRows([
  parser.REQUIRED_HEADERS,
  ['100-1', '', 1]
]);
assert.equal(missingValue.valid, false);
assert.match(missingValue.errors.join('\n'), /2행.*구성품 상품코드-옵션코드/);

for (const invalidQuantity of ['', '0', '-1', '1.5', 'abc', '2147483648', '9007199254740992']) {
  const quantity = parser.parseBundleCompositionRows([
    parser.REQUIRED_HEADERS,
    ['100-1', '200-1', invalidQuantity]
  ]);
  assert.equal(quantity.valid, false, `invalid quantity must be blocked: ${invalidQuantity}`);
  assert.match(quantity.errors.join('\n'), /2행/);
}

const selfReference = parser.parseBundleCompositionRows([
  parser.REQUIRED_HEADERS,
  ['100-1', '100-1', 1]
]);
assert.equal(selfReference.valid, false);
assert.match(selfReference.errors.join('\n'), /2행.*같은 코드/);

const conflictingDuplicate = parser.parseBundleCompositionRows([
  parser.REQUIRED_HEADERS,
  ['100-1', '200-1', 1],
  ['100-1', '200-1', 2]
]);
assert.equal(conflictingDuplicate.valid, false);
assert.equal(conflictingDuplicate.duplicateCount, 0);
assert.match(conflictingDuplicate.errors.join('\n'), /3행.*2행/);

const legacyRoles = parser.parseBundleCompositionRows([
  ['세트 상품코드-옵션코드', '구성품 상품코드-옵션코드', '구성수량', '역할'],
  ['100-1', '200-1', 1, '구성품'],
  ['100-1', '300-1', 1, 'packaging']
]);
assert.equal(legacyRoles.valid, true, '예전 역할 열이 있는 파일도 계속 읽어야 한다');
assert.deepEqual(legacyRoles.rows.map(row => row.role), ['component', 'component'], '예전 역할 값도 새 저장에서는 모두 구성품으로 정규화한다');

const arbitraryLegacyRole = parser.parseBundleCompositionRows([
  ['세트 상품코드-옵션코드', '구성품 상품코드-옵션코드', '구성수량', '역할'],
  ['100-1', '200-1', 1, '사은품']
]);
assert.equal(arbitraryLegacyRole.valid, true, '폐기된 역할 값은 검증 실패 원인이 아니어야 한다');
assert.equal(arbitraryLegacyRole.rows[0].role, 'component');
assert.deepEqual(parser.LEGACY_HEADERS, ['역할']);

const nested = parser.parseBundleCompositionRows([
  parser.REQUIRED_HEADERS,
  ['100-1', '200-1', 1],
  ['200-1', '300-1', 1]
]);
assert.equal(nested.valid, true, '중첩 세트는 파일 안에 순환이 없으면 허용해야 한다');
assert.equal(nested.summary.requiresServerCycleValidation, true, '기존 DB 관계와의 순환은 서버가 최종 검증한다');

const cycle = parser.parseBundleCompositionRows([
  parser.REQUIRED_HEADERS,
  ['100-1', '200-1', 1],
  ['200-1', '300-1', 1],
  ['300-1', '100-1', 1]
]);
assert.equal(cycle.valid, false);
assert.match(cycle.errors.join('\n'), /파일 안에 순환 세트 구성/);

const missingHeader = parser.parseBundleCompositionRows([
  ['세트 상품코드-옵션코드', '구성수량'],
  ['100-1', 1]
]);
assert.equal(missingHeader.valid, false);
assert.match(missingHeader.errors.join('\n'), /1행.*구성품 상품코드-옵션코드/);

const maxRows = parser.parseBundleCompositionRows([
  parser.REQUIRED_HEADERS,
  ['100-1', '200-1', 1],
  ['100-2', '200-2', 1]
], {maxRows:1});
assert.equal(maxRows.valid, false);
assert.match(maxRows.errors.join('\n'), /최대 1행.*현재 2행/);

const maxCodes = parser.parseBundleCompositionRows([
  parser.REQUIRED_HEADERS,
  ['100-1', '200-1', 1],
  ['100-1', '300-1', 1]
], {maxCodes:2});
assert.equal(maxCodes.valid, false);
assert.match(maxCodes.errors.join('\n'), /최대 2개.*현재 3개/);

console.log('operations hub bundle import parser tests passed');
