import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const css=fs.readFileSync('mockups/operations-hub/ui-cleanup-v1.css','utf8');
const js=fs.readFileSync('mockups/operations-hub/ui-cleanup-v1.js','utf8');
const html=fs.readFileSync('mockups/operations-hub/index.html','utf8');

test('UI cleanup groups navigation and exposes tag/export workflows',()=>{
  assert.match(css,/nav-section-label/);
  assert.match(css,/data-tab="bulk"/);
  assert.match(js,/태그 일괄 적용/);
  assert.match(js,/가격 수식 관리/);
  assert.match(js,/판매처 파일 내보내기/);
  assert.match(js,/V=옵션가, X=실제 판매수량/);
  assert.match(js,/W 판매가능재고는 메모값으로 보존/);
  assert.match(js,/if\(!panel\.hidden\)panel\.hidden=true/);
  assert.match(js,/if\(panel\.hidden\)panel\.hidden=false/);
  assert.match(js,/if\(panel\._systemV3TagImportState===importState\)return/);
  assert.match(html,/ui-cleanup-v1\.css/);
  assert.match(html,/ui-cleanup-v1\.js\?v=20260915-tag-matrix-v1/);
});
