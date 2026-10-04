import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../mockups/operations-hub/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../mockups/operations-hub/app.js', import.meta.url), 'utf8');
const data = fs.readFileSync(new URL('../mockups/operations-hub/data-service.js', import.meta.url), 'utf8');

for (const id of [
  'bundle-management-panel',
  'bundle-graph-list',
  'bundle-search-form',
  'bundle-import-panel',
  'bundle-import-template',
  'bundle-import-file',
  'bundle-import-result',
  'bundle-import-save',
  'bundle-component-form',
  'bundle-target-canonical',
  'bundle-target-seller',
  'seller-bundle-target-form',
  'seller-bundle-option-code',
  'seller-bundle-target-result',
  'seller-bundle-import-panel',
  'seller-bundle-import-template',
  'seller-bundle-import-file',
  'seller-bundle-import-result',
  'seller-bundle-import-save'
]) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `${id} UI가 필요하다`);
}

assert.match(html, /bundle-import-parser\.js/, '세트 구성 전용 파서를 app.js보다 먼저 로드해야 한다');
assert.ok(html.indexOf('bundle-import-parser.js') < html.indexOf('app.js'), '세트 파서는 앱보다 먼저 로드되어야 한다');
assert.match(html, /seller-bundle-import-parser\.js/, '판매처 전용 구성 파서를 app.js보다 먼저 로드해야 한다');
assert.ok(html.indexOf('seller-bundle-import-parser.js') < html.indexOf('app.js'), '판매처 전용 구성 파서는 앱보다 먼저 로드되어야 한다');
assert.match(html, /엑셀로 종속관계 일괄 등록/, '기존 종속관계 엑셀 업로드를 유지해야 한다');
assert.match(html, /엑셀로 세트 구성 일괄 등록/, '세트 구성은 별도 업로드 패널이어야 한다');
assert.match(html, /세트 상품코드-옵션코드/, '세트 템플릿 헤더를 안내해야 한다');
assert.match(html, /구성품 상품코드-옵션코드/, '구성품 템플릿 헤더를 안내해야 한다');
assert.doesNotMatch(html, /id="bundle-form-role"/, '세트 수동 등록에서 역할을 선택하게 하면 안 된다');
assert.doesNotMatch(html, /구성수량 · 역할/, '세트 업로드 안내에 폐기된 역할 열을 노출하면 안 된다');
assert.match(html, /엑셀로 판매처 전용 구성 일괄 등록/, '판매처 전용 구성은 canonical 세트와 별도 업로드 패널이어야 한다');
assert.match(html, /셀피아 SKU를 새로 만들지 않으며/, '판매처 전용 구성은 가짜 셀피아 SKU를 만들지 않는다고 안내해야 한다');
assert.match(html, /id="seller-bundle-option-code"[^>]*required/, '판매처 전용 구성은 정확한 옵션코드를 필수로 받아야 한다');

for (const rpc of [
  'list_operations_hub_bundle_graph_v1',
  'resolve_operations_hub_bundle_import_codes_v1',
  'apply_operations_hub_bundle_import_v1',
  'save_operations_hub_bundle_component_v1',
  'deactivate_operations_hub_bundle_component_v1'
]) {
  assert.match(data, new RegExp(rpc), `${rpc} 어댑터가 필요하다`);
}

for (const rpc of [
  'list_operations_hub_seller_bundle_graph_v1',
  'resolve_operations_hub_seller_bundle_import_rows_v1',
  'apply_operations_hub_seller_bundle_import_v1'
]) {
  assert.match(data, new RegExp(rpc), `${rpc} 판매처 전용 어댑터가 필요하다`);
}

assert.match(data, /p_rows:normalized/, '일괄 저장은 검증·정규화된 행만 p_rows로 전달해야 한다');
assert.match(data, /row\?\.bundleCode/, '파서의 bundleCode 키를 지원해야 한다');
assert.match(data, /row\?\.componentCode/, '파서의 componentCode 키를 지원해야 한다');
assert.match(data, /data\?\.applied === false[\s\S]*?throw new Error/, '서버 검증 거부를 성공으로 표시하면 안 된다');
assert.match(data, /Number\.isSafeInteger\(row\.component_qty\)/, '일괄 구성수량은 DB integer 범위에서만 허용해야 한다');
assert.match(html, /id="bundle-form-qty"[^>]*min="1"[^>]*max="2147483647"[^>]*step="1"/, '직접 추가 구성수량도 정수 정책을 사용해야 한다');
assert.match(app, /parseBundleCompositionRows/, '세트 구성 전용 파서를 사용해야 한다');
assert.doesNotMatch(app, /errors\.length \+ unresolvedCount/, '미해결 코드 오류 건수를 두 번 더하면 안 된다');
assert.match(app, /관계 그래프·판매처 연결·가격·재고는 변경하지 않습니다/, '세트 저장 범위의 안전 경계를 사용자에게 알려야 한다');
assert.match(app, /XLSX\.utils\.book_append_sheet\(workbook, worksheet, '세트구성'\)/, '세트구성 시트 템플릿을 브라우저에서 생성해야 한다');
assert.match(app, /\['세트 상품코드-옵션코드', '구성품 상품코드-옵션코드', '구성수량'\]/, '새 세트 템플릿은 역할 열 없이 세 개의 열만 제공해야 한다');
assert.doesNotMatch(app, /\['세트 상품코드-옵션코드', '구성품 상품코드-옵션코드', '구성수량', '역할'\]/, '폐기된 역할 열을 새 템플릿에 다시 넣으면 안 된다');
assert.match(app, /data-bundle-component-remove/, '활성 세트 구성 연결 해제를 제공해야 한다');
assert.match(app, /data-bundle-component-qty/, '구성수량 수정 입력을 제공해야 한다');
assert.doesNotMatch(app, /data-bundle-component-role/, '세트 구성표에서 역할을 다시 편집하게 하면 안 된다');
assert.match(app, /component_role:'component'/, '엑셀 저장 행은 항상 component 기본값을 사용해야 한다');
assert.match(app, /role:'component'/, '직접 추가와 수량 수정도 항상 component 기본값을 사용해야 한다');
assert.match(app, /parseSellerBundleRows/, '판매처 전용 구성 파서를 사용해야 한다');
assert.match(app, /sellerBundleRowsWithChange/, '수량 수정 시 대상의 전체 구성표를 보존해야 한다');
assert.match(app, /셀피아 SKU 생성 및 판매처 쓰기는 실행하지 않습니다/, '판매처 전용 구성의 외부 쓰기 금지를 사용자에게 알려야 한다');
assert.match(app, /book_append_sheet\(workbook, worksheet, '판매처전용구성'\)/, '판매처 전용 템플릿을 브라우저에서 별도로 생성해야 한다');
assert.match(app, /data-seller-component-remove/, '판매처 전용 구성 연결 해제를 제공해야 한다');
assert.match(app, /data-seller-component-qty/, '판매처 전용 구성수량 수정 입력을 제공해야 한다');

console.log('operations hub canonical bundle UI contract tests passed');
