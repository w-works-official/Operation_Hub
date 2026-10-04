import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('topbar health and refresh controls are backed by live state', () => {
  const html = read('mockups/operations-hub/index.html');
  const app = read('mockups/operations-hub/app.js');
  assert.match(html, /id="system-health-pill"[^>]+data-state="loading"/);
  assert.match(html, /id="top-refresh-btn"/);
  assert.doesNotMatch(html, /data-toast="새로운 데이터를 확인했습니다\."/);
  assert.match(app, /components:\{matrix:'idle', source:'idle', metrics:'idle', mapping:'idle'\}/);
  assert.match(app, /label = '일부 조회 지연'/);
  assert.match(app, /label = 'DB 조회 실패'/);
  assert.match(app, /topRefreshButton\?\.addEventListener\('click'/);
  assert.match(app, /if \(systemHealthState\.refreshing \|\| topRefreshButton\.disabled\) return/);
});

test('global refresh reports each real read contract and preserves disconnected picking', () => {
  const html = read('mockups/operations-hub/index.html');
  const app = read('mockups/operations-hub/app.js');
  assert.match(app, /const matrix = shouldLoadMatrix[\s\S]*?await loadLiveMatrix\(\{\.\.\.options,fullReload:Boolean\(options\.fullReload\|\|matrixSourceReloadNeeded\)\}\)[\s\S]*?const \[source, metrics, mapping\] = await Promise\.all\(\[[\s\S]*?loadLiveSourceStatus\(\),\s*loadLiveDashboardMetrics\(\),\s*loadMappingSyncStatus\(\{markDisplayed:true\}\)/s);
  assert.match(app, /picking == null\s*\? '주문 DB 연결 대기'/s);
  assert.match(app, /document\.getElementById\('live-today-picked'\)\.textContent = '-'/);
  assert.match(html, /판매처 상태 확인[\s\S]*?원본·내보내기 준비 현황 조회/);
  assert.doesNotMatch(html, /판매처 재고 갱신[\s\S]*?재고·가격 선택 동기화/);
  assert.match(app, /function sidebarChannelStatus[\s\S]*?최근 정상[\s\S]*?최근 오류/);
});
