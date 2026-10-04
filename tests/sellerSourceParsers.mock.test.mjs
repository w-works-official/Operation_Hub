import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const parserSource = fs.readFileSync(new URL('../mockups/operations-hub/seller-source-parsers.js', import.meta.url), 'utf8');
const dataSource = fs.readFileSync(new URL('../mockups/operations-hub/data-service.js', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('../mockups/operations-hub/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../mockups/operations-hub/index.html', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../supabase/migrations/20260812093000_operations_hub_seller_inventory.sql', import.meta.url), 'utf8');

const context = {console};
vm.createContext(context);
vm.runInContext(parserSource, context);
const parsers = context.SystemV3SellerParsers;
const fields = {inventory:true, price:true, basic:true, status:true};

assert.equal(parsers.validateSelectedFileCount('smartstore', [{name:'part-1.xlsx'}], {mode:'patch'}).length, 1);
assert.equal(parsers.validateSelectedFileCount('smartstore', [{name:'part-1.xlsx'}, {name:'part-2.xlsx'}], {mode:'patch'}).length, 2);
assert.throws(() => parsers.validateSelectedFileCount('smartstore', [{name:'part-1.xlsx'}], {mode:'full'}), /2개가 모두 필요/);
assert.throws(() => parsers.validateSelectedFileCount('smartstore', [], {mode:'patch'}), /1개 이상/);

const smartHeader = Array(20).fill(null);
smartHeader[0] = '상품번호'; smartHeader[1] = '판매자 상품코드'; smartHeader[18] = '옵션 재고수량';
const smartRow = Array(20).fill(null);
smartRow[0] = '4680371525'; smartRow[1] = 'sellpia_1014'; smartRow[3] = '컬러 큐빅볼'; smartRow[4] = '신상품'; smartRow[5] = '5200';
smartRow[15] = '50094640701\n50094640703'; smartRow[16] = '크리스탈\n크리스탈AB'; smartRow[17] = '0\n200'; smartRow[18] = '2\n3'; smartRow[19] = 'Y\nY';
const smart = parsers.parseSmartstoreRows([[], smartHeader, smartRow], 'smart.xlsx', fields);
assert.equal(smart.length, 2);
assert.deepEqual([smart[0].product_code, smart[0].option_code, smart[0].stock, smart[0].price], ['4680371525', '50094640701', 2, 5200]);
assert.equal(smart[1].price, 5400);

const makeHeader = Array(48).fill(null);
makeHeader[4] = 'product_uid'; makeHeader[32] = 'sto_stock'; makeHeader[44] = 'sell_price';
const makeProduct = Array(48).fill(null);
makeProduct[4] = '2085501'; makeProduct[12] = '큐빅볼 모음'; makeProduct[29] = '크리스탈'; makeProduct[31] = '0'; makeProduct[32] = '2'; makeProduct[41] = '판매'; makeProduct[43] = '425'; makeProduct[44] = '5200';
const makeContinuation = Array(48).fill(null);
makeContinuation[29] = '크리스탈AB'; makeContinuation[31] = '200'; makeContinuation[32] = '3'; makeContinuation[41] = '판매'; makeContinuation[43] = '424';
const makeshop = parsers.parseMakeshopRows([[], makeHeader, makeProduct, makeContinuation], 'make.xlsx', fields);
assert.equal(makeshop.length, 2);
assert.deepEqual([makeshop[1].product_code, makeshop[1].option_code, makeshop[1].stock, makeshop[1].price], ['2085501', '424', 3, 5400]);

const ablyHeader = Array(29).fill(null);
ablyHeader[0] = '상품 번호'; ablyHeader[10] = '옵션 번호'; ablyHeader[15] = '재고수량';
const ablyRow = Array(29).fill(null);
ablyRow[0] = '73910822'; ablyRow[1] = '11501'; ablyRow[2] = '에이블리 상품'; ablyRow[6] = '14300'; ablyRow[10] = '529336777'; ablyRow[14] = '실버'; ablyRow[15] = '7'; ablyRow[18] = '품절아님'; ablyRow[19] = '진열';
const ably = parsers.parseAblyRows([ablyHeader, ablyRow], 'ably.csv', fields);
assert.deepEqual([ably[0].product_code, ably[0].option_code, ably[0].stock, ably[0].price], ['73910822', '529336777', 7, 14300]);

const inventoryOnly = parsers.parseSmartstoreRows([smartHeader, smartRow], 'smart.xlsx', {inventory:true, price:false, basic:false, status:false});
assert.equal(inventoryOnly[0].stock, 2);
assert.equal(inventoryOnly[0].price, null);
assert.equal(inventoryOnly[0].product_name, null);
const consolidated = parsers.validateNormalizedRows('smartstore', [
  {...smart[0], stock:1, raw_payload:{source_file_name:'first.xlsx'}},
  {...smart[0], stock:2, raw_payload:{source_file_name:'second.xlsx'}}
]);
assert.equal(consolidated.length, 1);
assert.equal(consolidated[0].stock, 2);
assert.equal(consolidated[0].raw_payload.duplicate_source_rows, 2);

const compactSharedStrings = Array.from({length:131}, (_, index) => index === 130 ? '작성 안내' : `shared-${index}`);
compactSharedStrings[0] = '상품번호';
compactSharedStrings[1] = '판매자 상품코드';
compactSharedStrings[2] = '옵션 재고수량';
const compactXml = {
  'xl/workbook.xml':'<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="일괄수정" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/sharedStrings.xml':`<sst>${compactSharedStrings.map(value => `<si><t>${value}</t></si>`).join('')}</sst>`,
  'xl/worksheets/sheet1.xml':`<worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="S1" t="s"><v>2</v></c></row>
    <row r="2"><c r="A2"/><c r="B2"/><c r="G2" t="s"><v>130</v></c><c r="P2"/><c r="R2" t="s"><v>130</v></c></row>
    <row r="3"><c r="A3"><v>8097562125</v></c><c r="B3"><v>10000</v></c><c r="F3"><v>2800</v></c><c r="P3" t="inlineStr"><is><t>50906377246\n50906377247\n50906377248</t></is></c><c r="Q3" t="inlineStr"><is><t>별\n나비\n볼</t></is></c><c r="R3" t="inlineStr"><is><t>0\n0\n0</t></is></c><c r="S3" t="inlineStr"><is><t>3\n2\n1</t></is></c></row>
  </sheetData></worksheet>`
};
const compactContext = {
  console,
  XLSX:{},
  JSZip:{
    loadAsync:async () => ({
      file:name => compactXml[name] === undefined ? null : {async:async () => compactXml[name]}
    })
  }
};
vm.createContext(compactContext);
vm.runInContext(parserSource, compactContext);
const compactFile = {name:'smartstore-official.xlsx', arrayBuffer:async () => new ArrayBuffer(0)};
const compactParsed = await compactContext.SystemV3SellerParsers.parseSellerFiles('smartstore', [compactFile], fields);
const compactRows = JSON.parse(JSON.stringify(compactParsed.normalizedRows));
assert.equal(compactRows.length, 3, 'self-closing guide cells must not create a synthetic Smartstore product row');
assert.deepEqual(compactRows.map(row => [row.product_code, row.option_code, row.stock]), [
  ['8097562125', '50906377246', 3],
  ['8097562125', '50906377247', 2],
  ['8097562125', '50906377248', 1]
]);
assert.equal(compactRows.some(row => row.product_code === '130' && row.option_code === ''), false);

assert.match(html, /seller-source-parsers\.js[\s\S]*?data-service\.js/, 'seller parsers must load before the data service');
assert.match(appSource, /\['sellpia','smartstore','makeshop','ably'\]\.includes/, 'all four operational source uploads must be enabled');
assert.match(dataSource, /seller_inventory_snapshots[\s\S]*?finalize_seller_inventory_snapshot/, 'seller uploads must finalize an atomic database snapshot');
assert.match(migration, /with \(security_invoker = true\)[\s\S]*?seller_inventory_latest/, 'seller latest reads must honor underlying RLS');
assert.match(migration, /selected_fields[\s\S]*?previous_row\.stock/, 'partial refresh must preserve unselected fields by product and option key');

console.log('Seller source parsers and snapshot upload contract: passed');
