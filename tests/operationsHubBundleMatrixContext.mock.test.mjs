import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationDirectory = path.resolve(here, '../supabase/migrations');
const migrationFiles = fs.readdirSync(migrationDirectory)
  .filter(name => name.endsWith('.sql'))
  .sort()
  .map(name => ({name, sql:fs.readFileSync(path.join(migrationDirectory, name), 'utf8')}));
const contractFiles = migrationFiles.filter(file => /load_operations_hub_matrix_filtered_v6/i.test(file.sql));
assert.ok(contractFiles.length, '관계·세트·판매처 번들을 함께 조회하는 최신 매트릭스 RPC migration이 필요하다');
const migration = contractFiles
  .map(file => file.sql)
  .join('\n\n');
const data = fs.readFileSync(new URL('../mockups/operations-hub/data-service.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../mockups/operations-hub/app.js', import.meta.url), 'utf8');

assert.match(
  migration,
  /create or replace function public\.load_operations_hub_matrix_filtered_v\d+\([\s\S]*?p_include_related_sku_context boolean default false/i,
  '관계·번들 하위행 확장은 검색 때만 켜는 명시적 매트릭스 RPC 옵션이어야 한다',
);
assert.match(
  migration,
  /operations_hub_relation_edges[\s\S]*?operations_hub_bundle_components[\s\S]*?operations_hub_listing_components|operations_hub_bundle_components[\s\S]*?operations_hub_relation_edges[\s\S]*?operations_hub_listing_components|operations_hub_listing_components[\s\S]*?operations_hub_relation_edges[\s\S]*?operations_hub_bundle_components/i,
  '관련행 후보는 일반 관계, 셀피아 공통 세트 구성, 판매처 전용 구성 저장소를 모두 합쳐야 한다',
);
assert.match(
  migration,
  /'relation'::text\s+as\s+relationship_family/i,
  '일반 관계 하위행은 relation 출처를 공개해야 한다',
);
assert.match(
  migration,
  /'canonical_bundle'::text\s+as\s+relationship_family/i,
  '공통 세트 하위행은 canonical_bundle 출처를 공개해야 한다',
);
assert.match(
  migration,
  /'seller_bundle'::text\s+as\s+relationship_family/i,
  '판매처 전용 구성 하위행은 seller_bundle 출처를 공개해야 한다',
);
assert.match(
  migration,
  /'matrix_context'[\s\S]*?'kind'[\s\S]*?'rootSku'[\s\S]*?'direction'[\s\S]*?'depth'[\s\S]*?'pathSkus'[\s\S]*?'relationshipFamily'|'matrix_context'[\s\S]*?'relationshipFamily'[\s\S]*?'rootSku'[\s\S]*?'pathSkus'/i,
  '확장된 matrix_context는 기존 직접/하위 표시 계약과 관계 종류를 함께 유지해야 한다',
);
assert.match(
  migration,
  /row_number\(\) over \([\s\S]*?partition by[\s\S]*?root_sku[\s\S]*?related_sku/i,
  '같은 SKU가 여러 관계에 걸쳐도 root/related 쌍은 화면에서 중복되지 않아야 한다',
);
assert.match(
  migration,
  /'count',[\s\S]*?(?:v_direct_result|directCount)[\s\S]*?'directCount'[\s\S]*?(?:v_direct_result|direct_rows)/i,
  '관계·번들 하위행은 직접 검색 결과의 count와 페이지 수를 부풀리면 안 된다',
);
assert.match(
  migration,
  /security invoker[\s\S]*?revoke all on function[\s\S]*?grant execute on function[\s\S]*?to anon, authenticated/i,
  '통합 관계 조회 RPC는 invoker 권한과 명시적 실행 권한을 유지해야 한다',
);

assert.match(
  data,
  /normalizeMatrixContext[\s\S]*?relationshipFamily|relationshipFamily[\s\S]*?normalizeMatrixContext/i,
  '데이터 어댑터는 서버의 관계 종류를 버리지 않고 정규화해야 한다',
);
assert.match(
  data,
  /db\.rpc\('load_operations_hub_matrix_filtered_v6'[\s\S]*?isMissingMatrixRpc[\s\S]*?load_operations_hub_matrix_filtered_v5/i,
  '프런트는 V6 통합 관계 조회를 먼저 사용하고 미배포 환경에서만 V5로 안전하게 폴백해야 한다',
);
assert.match(
  app,
  /function matrixRelationshipFamilyLabel[\s\S]*?relation:'관계'[\s\S]*?canonical_bundle:'공통 세트'[\s\S]*?seller_bundle:'판매처 번들'/i,
  '매트릭스는 저장 관계 종류에 따라 하위행 출처를 식별 가능하게 렌더링해야 한다',
);
assert.match(
  app,
  /function matrixRelationContext\(product\)[\s\S]*?raw\.relationshipFamily[\s\S]*?return \{kind, rootSku, direction, depth, pathSkus, relationshipFamily[\s\S]*?function renderLiveMatrixRows[\s\S]*?data-relationship-family="\$\{escapeHtml\(relationContext\.relationshipFamily\)/i,
  '관련 행 렌더링은 정규화된 relationshipFamily를 실제 행 라벨과 식별 속성에 사용해야 한다',
);
assert.match(
  app,
  /matrix_context\?\.kind === 'related'[\s\S]*?matrix-related-context-row/i,
  '세트·번들 하위행도 기존 관계 하위행과 동일한 종속 시각 처리를 사용해야 한다',
);

const resultFixture = {
  count: 1,
  directCount: 1,
  relatedCount: 3,
  rows: [
    {sellpia_sku_code:'2242-1', matrix_context:{kind:'direct', rootSku:'2242-1', direction:'self', depth:0, pathSkus:['2242-1'], relationshipFamily:'direct'}},
    {sellpia_sku_code:'10322-5', matrix_context:{kind:'related', rootSku:'2242-1', direction:'descendant', depth:1, pathSkus:['2242-1','10322-5'], relationshipFamily:'relation'}},
    {sellpia_sku_code:'10957-1', matrix_context:{kind:'related', rootSku:'2242-1', direction:'bundle', depth:1, pathSkus:['2242-1','10957-1'], relationshipFamily:'canonical_bundle'}},
    {sellpia_sku_code:'5419-1', matrix_context:{kind:'related', rootSku:'2242-1', direction:'seller_bundle', depth:1, pathSkus:['2242-1','5419-1'], relationshipFamily:'seller_bundle'}},
  ],
};

assert.equal(resultFixture.count, resultFixture.directCount, '직접행만 페이지 count를 결정해야 한다');
assert.deepEqual(
  new Set(resultFixture.rows.filter(row => row.matrix_context.kind === 'related').map(row => row.matrix_context.relationshipFamily)),
  new Set(['relation', 'canonical_bundle', 'seller_bundle']),
  '세 저장 관계 종류를 모두 구분할 수 있어야 한다',
);
assert.equal(
  new Set(resultFixture.rows.map(row => `${row.matrix_context.rootSku}:${row.sellpia_sku_code}`)).size,
  resultFixture.rows.length,
  '통합 하위행은 root/SKU 단위로 중복 렌더링하지 않아야 한다',
);

console.log('operations hub relation/set/seller-bundle matrix context contract: passed');
