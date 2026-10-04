import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const sql=fs.readFileSync('supabase/migrations/20260914060946_promote_formula_rules_to_tags.sql','utf8');

test('formula Rule promotion is atomic, guarded, assignment-safe and conflict-safe',()=>{
  assert.match(sql,/^begin;/);
  assert.match(sql,/commit;\s*$/);
  assert.match(sql,/tag_id is null[\s\S]*?<> 9/);
  assert.match(sql,/preview에 없던 tag_id 없는 활성 Rule/);
  assert.match(sql,/hub_rule_assignments[\s\S]*?sellpia_tag_assignments/);
  assert.match(sql,/v_backfilled <> 0/);
  assert.match(sql,/hub_rules_active_tag_output_target_uidx/);
  assert.match(sql,/on operations_private\.hub_rules\(tag_id, scope, target_field\)/);
  assert.match(sql,/where is_active and tag_id is not null/);
  assert.match(sql,/hub_rules_active_tag_required/);
  assert.match(sql,/check \(not is_active or tag_id is not null\)/);
});

test('promotion keeps the approved three formula-tag groups and excludes existing linked tags',()=>{
  for(const name of [
    '기준가격 그대로 상품판매가',
    '기준가격 테스트 · 할인 없음',
    '매입가 2배 + 스스 2000원 추가 + 스스 2000할인'
  ])assert.match(sql,new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.doesNotMatch(sql,/set\s+tag_id[\s\S]{0,200}셀피아 기준가격 그대로/);
  assert.doesNotMatch(sql,/set\s+tag_id[\s\S]{0,200}14k일괄2배테스트/);
});
