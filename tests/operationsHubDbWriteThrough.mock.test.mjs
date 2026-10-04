import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const app = readFileSync(new URL('../mockups/operations-hub/app.js', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/20260825023000_live_sellpia_override_matrix.sql', import.meta.url), 'utf8');

test('matrix performs one bounded retry without erasing rendered rows', () => {
  assert.match(app, /MATRIX_TRANSIENT_RETRY_DELAYS_MS = \[700\]/);
  assert.match(app, /const keepRenderedRows = matrixState\.rows\.length > 0/);
  assert.match(app, /DB 조회 지연 · 기존 화면 유지/);
  assert.match(app, /저장된 수정값은 사라지지 않습니다/);
});

test('Sellpia edits are overlaid live and do not invalidate the heavy export cache', () => {
  assert.match(migration, /left join lateral \([\s\S]*from public\.operations_hub_sellpia_overrides override_row/);
  assert.match(migration, /offset 0\s*\) sellpia_override on true/);
  assert.match(migration, /coalesce\(sellpia_override\.sale_price, matrix\.sellpia_sale_price\) as sellpia_sale_price/);
  assert.match(migration, /coalesce\(live_drafts\.payload, '\{\}'::jsonb\) as seller_drafts_json/);

  const freshnessFunction = migration.slice(migration.indexOf('create or replace function operations_private.refresh_operations_hub_matrix_export_cache_if_stale'));
  assert.doesNotMatch(freshnessFunction, /max\(updated_at\) from public\.operations_hub_sellpia_overrides/);
  assert.doesNotMatch(freshnessFunction, /max\(updated_at\) from public\.operations_hub_change_queue/);
});
