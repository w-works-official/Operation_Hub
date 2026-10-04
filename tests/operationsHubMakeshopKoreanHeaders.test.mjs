import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import {createRequire} from 'node:module';

const context = {console, Blob, Uint8Array, ArrayBuffer};
vm.createContext(context);
const scripts = new URL('../mockups/operations-hub/', import.meta.url);
vm.runInContext(fs.readFileSync(new URL('seller-source-parsers.js', scripts), 'utf8'), context);
vm.runInContext(fs.readFileSync(new URL('seller-export-adapter.js', scripts), 'utf8'), context);
const parser = context.SystemV3SellerParsers;
const fields = {inventory:true, price:true, basic:true, status:true};

function header(labels) {
  const row = Array(124).fill('');
  [row[4], row[32], row[44]] = labels;
  return row;
}

test('Makeshop semantic headers accept official Korean guides and existing English anchors', () => {
  const korean = header(['상품 고유번호\n- 변경금지\n- 최초등록시 공란', '옵션별 재고', '판매가격\n(필수입력)']);
  const english = header(['product_uid', 'sto_stock', 'sell_price']);
  assert.ok(parser.isMakeshopHeaderRow(korean));
  assert.ok(parser.isMakeshopHeaderRow(english));
  assert.ok(parser.isMakeshopHeaderRow(header([' 상품 고유번호 ', '옵션별 재고', '판매가격 (필수입력)'])));
  assert.equal(parser.isMakeshopHeaderRow(header(['상품번호', '옵션별 재고', '판매가격'])), false);
  const reordered = [...korean];
  [reordered[4], reordered[5]] = [reordered[5], reordered[4]];
  assert.equal(parser.isMakeshopHeaderRow(reordered), false, 'unknown layouts must not bypass recognition');
  const product = Array(124).fill('');
  product[4]='38323'; product[43]='option-1'; product[29]='첫 옵션';
  product[44]=4700; product[31]=200; product[32]=0;
  const continuation = Array(124).fill('');
  continuation[43]='option-2'; continuation[29]='둘째 옵션'; continuation[31]=300; continuation[32]=7;
  const a=parser.parseMakeshopRows([korean,product,continuation], 'korean.xlsx', fields);
  const b=parser.parseMakeshopRows([english,product,continuation], 'english.xlsx', fields);
  assert.equal(a.length,2);
  assert.deepEqual(a.map(row=>[row.product_code,row.option_code,row.source_row_no,row.stock,row.price]),
    b.map(row=>[row.product_code,row.option_code,row.source_row_no,row.stock,row.price]));
  assert.throws(()=>parser.parseMakeshopRows([reordered,product], 'unknown.xlsx', fields), /메이크샵 원본 헤더/);
});

const sample=process.env.MAKESHOP_MEDIUM_SAMPLE;
test('actual Korean Makeshop selected workbook retains 31 continuation options and writes stock only',
  {skip:!sample?'Set MAKESHOP_MEDIUM_SAMPLE to the authorized 메1181.xlsx sample':false}, async () => {
    const modules=process.env.CODEX_NODE_MODULES;
    assert.ok(modules,'CODEX_NODE_MODULES must point to bundled dependencies');
    const require=createRequire(path.join(modules,'makeshop-korean-test.cjs'));
    const JSZip=require('jszip');
    context.JSZip=JSZip;
    // Compact XLSX parsing uses the original ZIP XML; no SheetJS reserialization.
    context.XLSX={};
    const bytes=fs.readFileSync(sample);
    const file={name:path.basename(sample),arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};
    const parsed=await parser.parseSellerFiles('makeshop',[file],fields);
    const rows=parsed.normalizedRows;
    assert.equal(rows.length,31);
    assert.equal(new Set(rows.map(row=>row.product_code)).size,1);
    assert.ok(rows.every(row=>row.product_code==='38323'));
    assert.equal(new Set(rows.map(row=>row.option_code)).size,31);
    assert.equal(new Set(rows.map(row=>row.source_row_no)).size,31);
    assert.ok(rows.every(row=>row.stock!==null));

    // Reverse operation order to ensure writes follow row/option identity, not list order.
    const operations=rows.map((row,index)=>({source_channel:'makeshop',seller_product_code:row.product_code,
      seller_option_code:row.option_code,sellpia_sku_code:`1181-${index+1}`,source_row_no:row.source_row_no,
      field_key:'sellpia_current_stock',expected_source_value:row.stock,after_value:index===0?0:index+5})).reverse();
    const output=await context.SystemV3SellerExport.transformSellerFile(file,operations);
    assert.equal(output.skippedItems.length,0);
    assert.equal(output.appliedItems.length,31);
    const afterBytes=new Uint8Array(await output.blob.arrayBuffer());
    const afterFile={name:file.name,arrayBuffer:async()=>afterBytes.buffer};
    const reparsed=await parser.parseSellerFiles('makeshop',[afterFile],fields);
    assert.equal(reparsed.normalizedRows.length,31);
    for(const operation of operations) {
      const row=reparsed.normalizedRows.find(row=>row.option_code===operation.seller_option_code);
      assert.equal(row.stock,operation.after_value);
    }
    const beforeZip=await JSZip.loadAsync(bytes), afterZip=await JSZip.loadAsync(afterBytes);
    const sheetPath='xl/worksheets/sheet1.xml';
    const beforeXml=await beforeZip.file(sheetPath).async('string');
    const afterXml=await afterZip.file(sheetPath).async('string');
    const cells=xml=>new Map([...xml.matchAll(/<c\b([^>]*?\br="([A-Z]+\d+)"[^>]*?)(?:\/>|>[\s\S]*?<\/c>)/g)].map(match=>[match[2],match[0]]));
    const before=cells(beforeXml), after=cells(afterXml), allowed=new Set(operations.map(operation=>`AG${operation.source_row_no}`));
    for(const [reference,cell] of before)if(!allowed.has(reference))assert.equal(after.get(reference),cell,`${reference}: non-target cell changed`);
    for(const reference of after.keys())if(!before.has(reference))assert.ok(allowed.has(reference),`${reference}: unexpected new cell`);
    assert.equal((afterXml.match(/<row\b/g)||[]).length,(beforeXml.match(/<row\b/g)||[]).length);
    assert.deepEqual([...after.keys()], [...before.keys()], 'row and cell order retained');
    for(const entry of Object.values(beforeZip.files))if(!entry.dir&&!['xl/styles.xml',sheetPath].includes(entry.name))
      assert.deepEqual(Buffer.from(await afterZip.file(entry.name).async('uint8array')),Buffer.from(await entry.async('uint8array')),`${entry.name}: workbook structure changed`);
    console.log('Makeshop Korean medium: product 1 / options 31 / writes 31 / skipped 0 / non-target cells unchanged');
  });
