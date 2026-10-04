import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const sql=fs.readFileSync('supabase/migrations/20260921064352_hub_product_tag_retire_cascade_v2.sql','utf8');
const ui=fs.readFileSync('mockups/operations-hub/tag-management-v2.js','utf8');
const service=fs.readFileSync('mockups/operations-hub/data-service.js','utf8');

test('tag retirement previews links, validates session, and detaches all active connections',()=>{
  assert.match(ui,/id="tag-delete-unused"[^>]*>태그 삭제/);
  assert.match(ui,/deleteButton\.disabled=!tag;/);
  assert.match(ui,/retireProductTagCascade\([\s\S]*?preview:true/);
  assert.match(ui,/global\.confirm\(prompt\)/);
  assert.match(ui,/retireProductTagCascade\([\s\S]*?preview:false/);
  assert.match(service,/async function retireProductTagCascade[\s\S]*?hub_product_tag_retire_cascade_v2/);
  assert.match(sql,/require_operations_hub_operator_session\(p_session_token\)/);
  assert.match(sql,/p_expected_option_count is distinct from option_count/);
  assert.match(sql,/update public\.sellpia_tag_assignments[\s\S]*?is_active=false/);
  assert.match(sql,/update public\.product_tag_assignments[\s\S]*?is_active=false/);
  assert.match(sql,/delete from operations_private\.hub_rule_assignments/);
  assert.match(sql,/update operations_private\.hub_rules[\s\S]*?is_active=false/);
  assert.match(sql,/update public\.product_tags set is_active=false/);
  assert.doesNotMatch(sql,/delete from public\.(sellpia_tag_assignments|product_tag_assignments|product_tags)/i);
});
