import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(
  new URL('../supabase/migrations/20260903055611_operations_hub_relation_history_undo_v1.sql', import.meta.url),
  'utf8'
);

assert.match(migration, /'EDGE_UNDO'/);
assert.match(migration, /operations_hub_relation_events_edge_time_idx/);
assert.match(migration, /operations_hub_relation_events_undo_event_uidx/);
assert.match(migration, /coalesce\(after_value ->> 'edge_id', before_value ->> 'edge_id'\)/);

assert.match(migration, /list_operations_hub_relation_edge_history_v1/);
assert.match(migration, /require_operations_hub_operator_session\(p_session_token\)/);
assert.match(migration, /event\.event_type in \('EDGE_SAVE', 'EDGE_REMOVE', 'EDGE_UNDO'\)/);
assert.match(migration, /as "canUndo"/);

assert.match(migration, /undo_operations_hub_relation_edge_event_v1/);
assert.match(migration, /for update/);
assert.match(migration, /이후에 저장된 관계 변경이 있어/);
assert.match(migration, /현재 관계가 선택한 이력 이후 변경되어/);
assert.match(migration, /실제 변경이 없는 이력은 되돌릴 수 없습니다/);
assert.match(migration, /같은 상위·하위 관계 이력이 이미 있어/);
assert.doesNotMatch(migration, /duplicate_edge\.child_node_id = v_child_node_id\s+and duplicate_edge\.is_active/);
assert.match(migration, /with recursive descendants/);
assert.match(migration, /undoOfEventId/);
assert.match(migration, /security definer[\s\S]*?set search_path = pg_catalog/);
assert.match(migration, /revoke all on function public\.undo_operations_hub_relation_edge_event_v1/);
assert.match(migration, /grant execute on function public\.undo_operations_hub_relation_edge_event_v1/);

console.log('Operations hub relation edge history and safe undo contract: passed');
