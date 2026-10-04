import assert from 'node:assert/strict';
import test from 'node:test';
import '../mockups/operations-hub/seller-export-adapter.js';

test('Smartstore changed-only export highlights compacted price cells, not their source row numbers', async () => {
  const parts = new Map([
    ['xl/workbook.xml', '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="수정" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/styles.xml', '<styleSheet><fonts count="1"><font><sz val="11"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>'],
    ['xl/worksheets/sheet1.xml', '<worksheet><dimension ref="A1:R10"/><sheetData>'+
      '<row r="1"><c r="A1" t="inlineStr"><is><t>상품번호</t></is></c></row>'+
      '<row r="2"><c r="A2"><v>11</v></c><c r="F2"><v>1000</v></c></row>'+
      '<row r="3"><c r="A3"><v>22</v></c><c r="F3"><v>2000</v></c></row>'+
      '<row r="10"><c r="A10"><v>33</v></c><c r="F10"><v>1000</v></c><c r="P10" t="inlineStr"><is><t>A\nB</t></is></c><c r="R10" t="inlineStr"><is><t>0\n500</t></is></c></row>'+
      '</sheetData></worksheet>'],
  ]);
  const zip = {
    file(name, value) {
      if (value !== undefined) { parts.set(name, value); return this; }
      return parts.has(name) ? {async: async () => parts.get(name)} : null;
    },
    async generateAsync() { return new Blob([JSON.stringify([...parts])]); },
  };
  const previousZip = globalThis.JSZip;
  globalThis.JSZip = {loadAsync: async () => zip};
  try {
    const item = {
      source_channel: 'smartstore', source_row_no: 10, source_file_name: 'smartstore.xlsx',
      sellpia_sku_code: '33-2', seller_product_code: '33', seller_option_code: 'B',
      field_key: 'sellpia_sale_price', expected_source_value: 1500, after_value: 1600,
      target_base_price: 1200, target_discounted_base_price: 1200,
      target_option_price: 400, target_final_price: 1600,
      source_discount_terms: [], target_discount_terms: [],
    };
    const result = await globalThis.SystemV3SellerExport.transformSellerFile(
      {name: 'smartstore.xlsx', arrayBuffer: async () => new ArrayBuffer(0)}, [item],
      {dataRowNumbers: new Set([2, 3, 10]), keepOnlyRows: new Set([2, 10])},
    );
    assert.equal(result.skippedItems.length, 0);
    assert.equal(result.appliedItems.length, 1);
    const sheet = parts.get('xl/worksheets/sheet1.xml');
    const styles = parts.get('xl/styles.xml');
    assert.match(sheet, /<row r="2"><c r="A2"><v>11<\/v><\/c><c r="F2"><v>1000<\/v><\/c><\/row>/, 'unchanged row remains unmarked');
    assert.match(sheet, /<row r="3"><c r="A3"><v>33<\/v><\/c>/, 'source row 10 is compacted to output row 3');
    assert.equal(globalThis.SystemV3SellerExport.cellValue(sheet, 'F3', []), '1200');
    assert.equal(globalThis.SystemV3SellerExport.cellValue(sheet, 'R3', []), '0\n400');
    assert.match(sheet, /<c r="F3"[^>]*\bs="[1-9]\d*"/, 'changed registration price has a review style after row compaction');
    assert.match(sheet, /<c r="R3"[^>]*\bs="[1-9]\d*"/, 'changed option price has a review style after row compaction');
    assert.match(styles, /fgColor rgb="FFFFFF00"/, 'review style is yellow');
    assert.match(styles, /<b\b/, 'review style includes bold');
  } finally {
    globalThis.JSZip = previousZip;
  }
});
