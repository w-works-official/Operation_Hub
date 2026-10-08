import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const workflow=fs.readFileSync('mockups/operations-hub/seller-file-workflow-v2.js','utf8');
const app=fs.readFileSync('mockups/operations-hub/app.js','utf8');
const current=fs.readFileSync('mockups/operations-hub/current-price-export.js','utf8');

test('seller export UI separates target/output settings and keeps original/carrier modes advanced',()=>{
  for(const label of ['변경사항 미리보기','XLSX 생성','대상 SKU','파일에 담을 상품','선택한 SKU 모두','변경된 상품만','미리보기 표시','고급 기능','수정파일 선택','선택 파일 변환'])assert.ok(workflow.includes(label),`missing ${label}`);
  assert.doesNotMatch(workflow,/data-standard-(?:preview|run)="[^"]+">(?:변경분|전체 원본)/,'ordinary actions use the output setting rather than separate full/changed buttons');
  assert.match(workflow,/previewFullOriginal/);assert.match(workflow,/runFullOriginal/);
  assert.match(app,/mode==='full_original'/);assert.match(app,/_SystemV3전체반영/);assert.match(app,/_SystemV3변경분/);
});

test('full-original preserves all rows; changed-only scopes changed product blocks',()=>{
  assert.match(app,/keepOnlyRows:keepRowsForItems\(items\)/);
  assert.match(app,/mode==='target_all'.*keepOnlyRows:keepRowsForTargetAll\(\)/);
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
