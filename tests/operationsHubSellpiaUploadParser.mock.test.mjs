import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const dataServiceSource = fs.readFileSync(new URL('../mockups/operations-hub/data-service.js', import.meta.url), 'utf8');

// Artificial official-schema data only. No operating CSV, supplier, or customer
// fixture is copied into this test.
const REQUIRED_HEADERS = [
  '#', '상품코드', '자사코드', '상품명', '옵션명', '재고', '가용재고', '품절', '단종',
  '매입처코드', '매입처', '매입처그룹', '매입처주소', '상가명', '매입처전화',
  '매입상품명', '매입옵션명', '판매가', '매입가', '수수료', '매입처부가세',
  '안전재고', '발주단위', '최소발주수량'
];
const CP949_FULL_FIXTURE = Uint8Array.from(Buffer.from(
  'Iyy788ewxNq15SzA2rvnxNq15Sy788ewuO0sv8m8x7jtLMDnsO0ssKG/68DnsO0sx7DA/Sy03MG+LLjFwNTDs8TateUsuMXA1MOzLLjFwNTDs7HXt+wsuMXA1MOzwda80iy787ChuO0suMXA1MOzwPzIrSy4xcDUu/PHsLjtLLjFwNS/ybzHuO0sxse4xbChLLjFwNSwoSy89rz2t+EsuMXA1MOzus6woby8LL7IwPzA57DtLLnfwda03MCnLMPWvNK538HWvPa3rg0KMSwwMDEyMy0wNCxPV04tMDAwMDcsxde9usauIMfHvu69zCy9x7n2LDksNywsLFNVUC0wMDAxLMXXvbrGriC4xcDUw7Msxde9usauILHXt+wsxde9usauIMHWvNIsxde9usauILvzsKEsMDAwLTAwMDAtMDAwMCzF1726xq4guMXA1CC788ewLL3HufYsMzAwMCwxNTAwLDEwLFksMiwyLDMNCg==',
  'base64',
));

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function parseCsv(text) {
  return text.replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/).map(line => line.split(',').map(cell => cell.replace(/^"|"$/g, '').replaceAll('""', '"')));
}

function makeFixtureCsv(rows, {headers = REQUIRED_HEADERS, bom = false} = {}) {
  const valueForHeader = (values, header) => values[header] ?? values[String(header).trim()] ?? '';
  const text = `${headers.map(csvCell).join(',')}\r\n${rows.map(values => headers.map(header => csvCell(valueForHeader(values, header))).join(',')).join('\r\n')}\r\n`;
  const bytes = new TextEncoder().encode(text);
  return bom ? new Uint8Array([0xef, 0xbb, 0xbf, ...bytes]) : bytes;
}

function sourceValues(rowNo, sku, overrides = {}) {
  return {
    '#':String(rowNo), '상품코드':sku, '자사코드':'OWN-00007', '상품명':'테스트 피어싱', '옵션명':'실버',
    '재고':'9', '가용재고':'7', '품절':'', '단종':'', '매입처코드':'SUP-0001', '매입처':'테스트 매입처',
    '매입처그룹':'테스트 그룹', '매입처주소':'테스트 주소', '상가명':'테스트 상가', '매입처전화':'000-0000-0000',
    '매입상품명':'테스트 매입 상품', '매입옵션명':'실버', '판매가':'3000', '매입가':'1500', '수수료':'10',
    '매입처부가세':'Y', '안전재고':'2', '발주단위':'2', '최소발주수량':'3', ...overrides,
  };
}

function fakeFile(name, bytes) {
  const copied = new Uint8Array(bytes);
  return {name, size:copied.byteLength, async arrayBuffer() {
    return copied.buffer.slice(copied.byteOffset, copied.byteOffset + copied.byteLength);
  }};
}

function binaryStringToBytes(value) {
  return Uint8Array.from(String(value), char => char.charCodeAt(0) & 0xff);
}

function createSheetJsMock(readCalls) {
  return {
    read(input, options) {
      readCalls.push({input, options});
      const text = options.type === 'binary'
        ? new TextDecoder('euc-kr').decode(binaryStringToBytes(input))
        : String(input);
      const rows = parseCsv(text);
      return {SheetNames:['셀피아'], Sheets:{셀피아:{'!ref':'A1:Z2', __rows:rows}}};
    },
    utils:{
      decode_range() { return {s:{r:0, c:0}, e:{r:1, c:61}}; },
      sheet_to_json(worksheet) { return worksheet.__rows; }
    }
  };
}

function loadDataService({XLSX, dbCalls = []} = {}) {
  const throwingClient = new Proxy({}, {
    get(_target, property) {
      dbCalls.push(String(property));
      throw new Error(`preflight must not call db.${String(property)}`);
    }
  });
  const context = {
    console, TextDecoder, TextEncoder, Uint8Array, ArrayBuffer, Buffer,
    XLSX,
    supabase:{createClient:() => throwingClient},
    fetch:() => { throw new Error('preflight must not call fetch'); },
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(dataServiceSource, context, {filename:'data-service.js'});
  return {api:context.SystemV3Data, context};
}

async function preflightOutcome(api, files, mode, onProgress) {
  try {
    return {result:await api.preflightSellpiaFiles(files, {mode}, onProgress), error:null};
  } catch (error) {
    return {result:null, error};
  }
}

test('data-service exposes a pure Sellpia preflight and keeps parsing helpers private', () => {
  const readCalls = [];
  const {api} = loadDataService({XLSX:createSheetJsMock(readCalls)});
  assert.equal(typeof api.preflightSellpiaFiles, 'function');
  assert.match(dataServiceSource, /const SELLPIA_REQUIRED_HEADERS[\s\S]*?최소발주수량[\s\S]*?최소발주단위/);
  assert.match(dataServiceSource, /normalizeSellpiaHeader[\s\S]*?createSellpiaColumnMap/);
  assert.match(dataServiceSource, /decodeSellpiaBytes[\s\S]*?fatal:true[\s\S]*?codepage:949/s);
  assert.match(dataServiceSource, /async function preflightSellpiaFiles[\s\S]*?parseSellpiaUploadFiles/s);
});

test('preflight autodetects UTF-8 BOM, UTF-8, and CP949 through SheetJS binary codepage 949', async () => {
  const readCalls = [];
  const {api} = loadDataService({XLSX:createSheetJsMock(readCalls)});
  const bomFile = fakeFile('utf8-bom.csv', makeFixtureCsv([sourceValues(1, '00123-04')], {bom:true}));
  const utf8File = fakeFile('utf8.csv', makeFixtureCsv([sourceValues(1, '00123-04')]));
  const cp949File = fakeFile('cp949.csv', CP949_FULL_FIXTURE);

  for (const [file, encoding] of [[bomFile, 'utf-8-bom'], [utf8File, 'utf-8'], [cp949File, 'cp949']]) {
    const {result, error} = await preflightOutcome(api, [file], 'patch');
    assert.equal(error, null, error?.message);
    assert.equal(result.valid, true);
    assert.equal(result.files[0].encoding, encoding);
    assert.equal(result.rows[0].sellpia_sku_code, '00123-04');
    assert.equal(result.rows[0].sellpia_product_name, '테스트 피어싱');
  }
  const cp949Call = readCalls.find(call => call.options.type === 'binary');
  assert.ok(cp949Call, 'CP949 must use the SheetJS binary-string input path');
  assert.equal(cp949Call.options.codepage, 949);
  assert.equal(cp949Call.options.raw, true);
});

test('name-based header mapping accepts the only verified minimum-order alias and fails closed on missing or duplicate required headers', async () => {
  const {api} = loadDataService({XLSX:createSheetJsMock([])});
  const shuffled = [...REQUIRED_HEADERS].reverse().map((header, index) => index % 2 ? ` ${header} ` : header);
  const accepted = await preflightOutcome(api, [fakeFile('shuffled.csv', makeFixtureCsv([sourceValues(15, '00123-04')], {headers:shuffled}))], 'patch');
  assert.equal(accepted.error, null, accepted.error?.message);
  assert.equal(accepted.result.rows[0].sellpia_sku_code, '00123-04');
  assert.equal(accepted.result.rows[0].minimum_order_unit, 3);

  const minimumAliasHeaders = REQUIRED_HEADERS.map(header => header === '최소발주수량' ? '최소발주단위' : header);
  const alias = await preflightOutcome(api, [fakeFile('minimum-alias.csv', makeFixtureCsv([sourceValues(16, '00123-05')], {headers:minimumAliasHeaders}))], 'patch');
  assert.equal(alias.error, null, alias.error?.message);

  const missing = await preflightOutcome(api, [fakeFile('missing.csv', makeFixtureCsv([sourceValues(17, '00123-06')], {headers:REQUIRED_HEADERS.filter(header => header !== '매입가')}))], 'patch');
  assert.match(missing.error?.message || '', /매입가/);

  const duplicate = await preflightOutcome(api, [fakeFile('duplicate.csv', makeFixtureCsv([sourceValues(18, '00123-07')], {headers:[...REQUIRED_HEADERS, ' 상품코드 ']}))], 'patch');
  assert.match(duplicate.error?.message || '', /상품코드[\s\S]*(중복|2개)/);

  const forbiddenSkuAliasHeaders = REQUIRED_HEADERS.map(header => header === '상품코드' ? 'SKU' : header);
  const forbiddenSkuAlias = await preflightOutcome(api, [fakeFile('sku-alias.csv', makeFixtureCsv([sourceValues(19, '00123-08')], {headers:forbiddenSkuAliasHeaders}))], 'patch');
  assert.match(forbiddenSkuAlias.error?.message || '', /상품코드/);
});

test('full mode requires exactly three files, preserves SKU strings, and rejects discontinuous rows or duplicate SKU values', async () => {
  const {api} = loadDataService({XLSX:createSheetJsMock([])});
  const files = [
    fakeFile('sellpia-1.csv', makeFixtureCsv([sourceValues(1, '00123-04'), sourceValues(2, '00123-05')])),
    fakeFile('sellpia-2.csv', makeFixtureCsv([sourceValues(3, '00123-06')])),
    fakeFile('sellpia-3.csv', makeFixtureCsv([sourceValues(4, '00123-07')])),
  ];
  const progress = [];
  const accepted = await preflightOutcome(api, files, 'full', event => progress.push(event));
  assert.equal(accepted.error, null, accepted.error?.message);
  assert.deepEqual(Array.from(accepted.result.rows, row => row.source_row_no), [1, 2, 3, 4]);
  assert.deepEqual(Array.from(accepted.result.rows, row => row.sellpia_sku_code), ['00123-04', '00123-05', '00123-06', '00123-07']);
  assert.equal(accepted.result.rows[0].sellpia_sku_code, '00123-04');
  assert.equal(accepted.result.rowCount, 4);
  assert.equal(accepted.result.firstRowNo, 1);
  assert.equal(accepted.result.lastRowNo, 4);
  assert.equal(accepted.result.duplicateSkuCount, 0);
  assert.deepEqual(Array.from(accepted.result.files, file => [file.name, file.rowCount, file.minRowNo, file.maxRowNo, file.schemaStatus]), [
    ['sellpia-1.csv', 2, 1, 2, 'ok'], ['sellpia-2.csv', 1, 3, 3, 'ok'], ['sellpia-3.csv', 1, 4, 4, 'ok']
  ]);
  assert.ok(progress.length > 0, 'preflight may report parsing progress but must not enter DB work');

  const fewerFiles = await preflightOutcome(api, files.slice(0, 2), 'full');
  assert.match(fewerFiles.error?.message || '', /3개/);
  const rowGap = await preflightOutcome(api, [files[0], fakeFile('gap.csv', makeFixtureCsv([sourceValues(4, '00123-06')])), files[2]], 'full');
  assert.match(rowGap.error?.message || '', /행번호|이어지지|연속/);
  const duplicate = await preflightOutcome(api, [files[0], fakeFile('dupe.csv', makeFixtureCsv([sourceValues(3, '00123-04')])), files[2]], 'full');
  assert.match(duplicate.error?.message || '', /중복[\s\S]*(SKU|상품코드)|SKU[\s\S]*중복/);
});

test('patch mode accepts one to three files and preflight never touches DB or network APIs', async () => {
  const dbCalls = [];
  const {api} = loadDataService({XLSX:createSheetJsMock([]), dbCalls});
  const one = fakeFile('patch-1.csv', makeFixtureCsv([sourceValues(810, '00999-01')]));
  const three = [one, fakeFile('patch-2.csv', makeFixtureCsv([sourceValues(812, '00999-02')])), fakeFile('patch-3.csv', makeFixtureCsv([sourceValues(814, '00999-03')]))];
  for (const files of [[one], three]) {
    const {result, error} = await preflightOutcome(api, files, 'patch');
    assert.equal(error, null, error?.message);
    assert.equal(result.valid, true);
    assert.equal(result.mode || result.uploadMode, 'patch');
    assert.equal(result.duplicateSkuCount, 0);
    assert.deepEqual(Array.from(result.errors), []);
  }
  assert.deepEqual(dbCalls, [], 'preflight must be fully local; uploadSellpiaSnapshot owns the first DB write');
});

console.log('operations hub Sellpia upload parser contract tests passed');
