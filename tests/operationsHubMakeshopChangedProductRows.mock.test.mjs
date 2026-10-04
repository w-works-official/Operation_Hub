import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import '../mockups/operations-hub/seller-export-adapter.js';

const require=createRequire(import.meta.url),JSZip=require('jszip'),adapter=globalThis.SystemV3SellerExport;
globalThis.JSZip=JSZip;
const cell=(reference,value)=>`<c r="${reference}" t="inlineStr"><is><t>${value}</t></is></c>`;
const row=(number,cells)=>`<row r="${number}">${cells}</row>`;
const sheet=rows=>`<worksheet><dimension ref="A1:EF${rows.length}"/><sheetData>${rows.join('')}</sheetData></worksheet>`;
const sourceRows=[
  row(1,cell('E1','상품 고유번호')),
  row(2,cell('E2','product_uid')),
  row(3,cell('E3','111')+cell('U3','옐로우골드,로즈골드')+cell('V3','0,3500')+cell('AD3','옐로우골드')+cell('AF3','0')+cell('AR3','1')+cell('AS3','30000')),
  row(4,cell('AD4','로즈골드')+cell('AF4','3500')+cell('AR4','2')),
  row(5,cell('R5','필수')+cell('U5','no-ball,잠금볼')+cell('V5','0,15000')),
  row(6,cell('R6','선택')+cell('U6','4mm바,8mm바')+cell('V6','0,3500')),
  row(7,cell('E7','222')+cell('U7','기본')+cell('V7','0')+cell('AD7','기본')+cell('AF7','0')+cell('AR7','1')+cell('AS7','40000')),
  row(8,cell('R8','선택')+cell('U8','추가옵션')+cell('V8','2000'))
];

async function workbook(rows=sourceRows){
  const zip=new JSZip();
  zip.file('xl/workbook.xml','<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="일괄수정" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
  zip.file('xl/styles.xml','<styleSheet><fonts count="1"><font><sz val="11"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>');
  zip.file('xl/worksheets/sheet1.xml',sheet(rows));
  const bytes=await zip.generateAsync({type:'uint8array'});
  return {name:'makeshop.xlsx',arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};
}
const priceItem={source_channel:'makeshop',source_row_no:4,seller_product_code:'111',seller_option_code:'2',sellpia_sku_code:'sku-2',field_key:'sellpia_sale_price',expected_source_value:33500,after_value:35000,base_price:30000,option_price:3500,target_base_price:30000,target_discounted_base_price:30000,target_option_price:5000,target_final_price:35000,source_discount_terms:[],target_discount_terms:[]};

test('MakeShop changed-only keeps the changed product full original block and updates V with AF',async()=>{
  const file=await workbook(),physical=await adapter.readMakeshopPhysicalProductRows(file);
  assert.deepEqual(physical.rowsByProduct['111'],[3,4,5,6]);
  assert.deepEqual(physical.rowsByProduct['222'],[7,8]);
  const keep=new Set([2,...physical.rowsByProduct['111']]);
  const output=await adapter.transformSellerFile(file,[{...priceItem}],{dataRowNumbers:new Set(physical.dataRowNumbers),keepOnlyRows:keep});
  assert.equal(output.skippedItems.length,0);
  assert.equal(output.appliedItems.length,1);
  const zip=await JSZip.loadAsync(await output.blob.arrayBuffer()),xml=await zip.file('xl/worksheets/sheet1.xml').async('string');
  const rows=[...xml.matchAll(/<row r="(\d+)"/g)].map(match=>Number(match[1]));
  assert.deepEqual(rows,[1,2,3,4,5,6]);
  assert.equal(adapter.cellValue(xml,'V3',[]),'0,5000');
  assert.equal(adapter.cellValue(xml,'AF4',[]),'5000');
  assert.equal(adapter.cellValue(xml,'V5',[]),'0,15000','separate mandatory add-on prices stay original');
  assert.equal(adapter.cellValue(xml,'V6',[]),'0,3500','separate selectable option prices stay original');
  assert.match(xml,/선택/);
  assert.doesNotMatch(xml,/222|추가옵션/);
  assert.match(xml,/<dimension ref="A1:EF6"\/>/);
  assert.match(xml,/<c r="V3"[^>]* s="\d+"/);
  assert.match(xml,/<c r="AF4"[^>]* s="\d+"/);
});

test('MakeShop refuses an ambiguous U/V-to-AD/AF option list before writing prices',async()=>{
  const invalid=[...sourceRows];
  invalid[2]=invalid[2].replace('0,3500','0');
  const file=await workbook(invalid),conflicts=[];
  const output=await adapter.transformSellerFile(file,[{...priceItem}],{dataRowNumbers:new Set([2,3,4,5,6,7,8]),keepOnlyRows:new Set([2,3,4,5,6])});
  conflicts.push(...output.skippedItems);
  assert.equal(output.appliedItems.length,0);
  assert.equal(conflicts.length,1);
  assert.match(conflicts[0].reason,/순서 또는 개수/);
  const zip=await JSZip.loadAsync(await output.blob.arrayBuffer()),xml=await zip.file('xl/worksheets/sheet1.xml').async('string');
  assert.equal(adapter.cellValue(xml,'AF4',[]),'3500');
  assert.equal(adapter.cellValue(xml,'V3',[]),'0');
});

test('MakeShop refuses to overwrite a changed option when original V and AF disagree',async()=>{
  const invalid=[...sourceRows];
  invalid[2]=invalid[2].replace('0,3500','0,4000');
  const file=await workbook(invalid);
  const output=await adapter.transformSellerFile(file,[{...priceItem}],{dataRowNumbers:new Set([2,3,4,5,6,7,8]),keepOnlyRows:new Set([2,3,4,5,6])});
  assert.equal(output.appliedItems.length,0);
  assert.equal(output.skippedItems.length,1);
  assert.match(output.skippedItems[0].reason,/옵션가\(V\)와 옵션조합가\(AF\)/);
  const zip=await JSZip.loadAsync(await output.blob.arrayBuffer()),xml=await zip.file('xl/worksheets/sheet1.xml').async('string');
  assert.equal(adapter.cellValue(xml,'AF4',[]),'3500');
  assert.equal(adapter.cellValue(xml,'V3',[]),'0,4000');
});

test('MakeShop applies shared and listed option prices for multiple products in one file pass',async()=>{
  const second={...priceItem,source_row_no:7,seller_product_code:'222',seller_option_code:'1',sellpia_sku_code:'sku-3',expected_source_value:40000,after_value:42500,base_price:40000,option_price:0,target_base_price:40000,target_discounted_base_price:40000,target_option_price:2500,target_final_price:42500};
  const result=await adapter.transformSellerFile(await workbook(),[{...priceItem},second]);
  assert.equal(result.appliedItems.length,2);
  assert.equal(result.skippedItems.length,0);
  const zip=await JSZip.loadAsync(await result.blob.arrayBuffer()),xml=await zip.file('xl/worksheets/sheet1.xml').async('string');
  assert.equal(adapter.cellValue(xml,'V3',[]),'0,5000');
  assert.equal(adapter.cellValue(xml,'AF4',[]),'5000');
  assert.equal(adapter.cellValue(xml,'V7',[]),'2500');
  assert.equal(adapter.cellValue(xml,'AF7',[]),'2500');
});
