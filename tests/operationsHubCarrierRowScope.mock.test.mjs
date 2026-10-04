import assert from 'node:assert/strict';
import test from 'node:test';
import '../mockups/operations-hub/seller-export-adapter.js';

test('changed-only row scoping removes unselected data rows and compacts retained rows',()=>{
  const xml='<worksheet><dimension ref="A1:A9"/><sheetData><row r="1"><c r="A1"/></row><row r="2"><c r="A2"/></row><row r="3"><c r="A3"/></row><row r="4"><c r="A4"/></row><row r="9"><c r="A9"/></row></sheetData></worksheet>';
  const actual=globalThis.SystemV3SellerExport.scopeWorksheetRows(xml,new Set([2,3,4]),new Set([3]));
  assert.match(actual,/<row r="1">/,'header stays');
  assert.match(actual,/<row r="2"><c r="A2"\/><\/row>/,'retained data row compacts to first data row');
  assert.equal([...actual.matchAll(/<row\b/g)].length,3,'only header, selected data, and footer remain');
  assert.doesNotMatch(actual,/<row r="4">/,'unchanged data row is removed');
  assert.match(actual,/<row r="3"><c r="A3"\/><\/row>/,'footer follows the selected data without a gap');
});

test('MakeShop changed-only keeps both import headers, selected product parent and option, and ordered row IDs',()=>{
  const rows=[
    '<row r="1"><c r="E1" t="inlineStr"><is><t>상품 고유번호</t></is></c></row>',
    '<row r="2"><c r="E2" t="inlineStr"><is><t>product_uid</t></is></c></row>',
    '<row r="3"><c r="E3"><v>111</v></c></row>',
    '<row r="4"><c r="AR4"><v>1</v></c></row>',
    '<row r="5"><c r="A5"><v>0</v></c></row>',
    '<row r="6"><c r="E6"><v>222</v></c><c r="AS6"><v>34000</v></c></row>',
    '<row r="7"><c r="AR7"><v>2</v></c><c r="AF7"><v>3500</v></c></row>',
    '<row r="8"><c r="A8"><v>0</v></c></row>',
    '<row r="9"><c r="E9"><v>333</v></c></row>',
    '<row r="10"><c r="A10" t="inlineStr"><is><t>footer</t></is></c></row>'
  ].join('');
  const scoped=globalThis.SystemV3SellerExport.scopeWorksheetRows(
    '<worksheet><dimension ref="A1:EF10"/><sheetData>'+rows+'</sheetData></worksheet>',
    new Set([2,3,4,6,7,9]),new Set([2,6,7])
  );
  const rowIds=[...scoped.matchAll(/<row r="(\d+)"/g)].map(match=>Number(match[1]));
  assert.deepEqual(rowIds,[1,2,3,4,5]);
  assert.match(scoped,/<c r="E2" t="inlineStr"><is><t>product_uid<\/t><\/is><\/c>/);
  assert.match(scoped,/<c r="E3"><v>222<\/v><\/c><c r="AS3"><v>34000<\/v><\/c>/);
  assert.match(scoped,/<c r="AR4"><v>2<\/v><\/c><c r="AF4"><v>3500<\/v><\/c>/);
  assert.match(scoped,/<dimension ref="A1:EF5"\/>/);
  assert.doesNotMatch(scoped,/<v>111<\/v>|<v>333<\/v>/);
});

test('changed-only dimension remains self-closing when 1759 source rows become 9 rows',()=>{
  const rows=Array.from({length:1759},(_,index)=>`<row r="${index+1}"><c r="A${index+1}"/></row>`).join('');
  const xml=`<worksheet><dimension ref="A1:CP1759"/><sheetData>${rows}</sheetData></worksheet>`;
  const scoped=globalThis.SystemV3SellerExport.scopeWorksheetRows(xml,new Set(Array.from({length:1758},(_,index)=>index+2)),new Set(Array.from({length:8},(_,index)=>index+2)));
  assert.match(scoped,/<dimension ref="A1:CP9"\/>/);
  assert.doesNotMatch(scoped,/\/\/>/);
  assert.equal([...scoped.matchAll(/<row\b/g)].length,9);
});
