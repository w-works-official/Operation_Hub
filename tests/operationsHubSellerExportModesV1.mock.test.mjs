import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const workflow=fs.readFileSync('mockups/operations-hub/seller-file-workflow-v2.js','utf8');
const app=fs.readFileSync('mockups/operations-hub/app.js','utf8');
const current=fs.readFileSync('mockups/operations-hub/current-price-export.js','utf8');

test('seller export UI exposes three explicit workbook modes',()=>{
  for(const label of ['전체 원본 미리보기','전체 원본 XLSX 생성','변경분 미리보기','변경분 XLSX 생성','수정파일 선택','선택 파일 변환'])assert.match(workflow,new RegExp(label));
  assert.match(workflow,/previewFullOriginal/);assert.match(workflow,/runFullOriginal/);
  assert.match(app,/mode==='full_original'/);assert.match(app,/_SystemV3전체반영/);assert.match(app,/_SystemV3변경분/);
});

test('full-original preserves all rows; changed-only scopes changed product blocks',()=>{
  assert.match(app,/mode==='changed_only'\?\{dataRowNumbers:allDataRows,keepOnlyRows:keepRowsForItems\(items\)\}:\{\}/);
  assert.match(app,/changedProducts=new Set/);
  assert.match(app,/Untouched\/unmapped original rows are not export warnings/);
});

test('shared price warning freezes only price operations and preserves independent stock',()=>{
  assert.match(current,/freeze only the shared price\/discount operations/);
  assert.match(current,/items\[index\]\.field_key==='sellpia_sale_price'/);
  assert.doesNotMatch(current,/row\.diff\.stock\.after=row\.diff\.stock\.before/);
  assert.match(current,/재고 등 독립 필드는 안전한 경우 반영합니다/);
});

test('preview distinguishes price, stock, product warnings and identity warnings',()=>{
  for(const label of ['가격 변경','재고 변경','경고 상품','경고 identity'])assert.match(workflow,new RegExp(label));
});
