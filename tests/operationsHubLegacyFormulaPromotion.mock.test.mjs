import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const sql=fs.readFileSync('supabase/migrations/20260914150000_promote_legacy_saved_formulas_to_tags.sql','utf8');
const makeshopConstraintSql=fs.readFileSync('supabase/migrations/20260914153000_strengthen_makeshop_discount_rule_constraint.sql','utf8');

test('legacy saved formulas are promoted atomically with exact drift guards',()=>{
 assert.match(sql,/^begin;[\s\S]*commit;\s*$/);
 assert.match(sql,/preview\(10\/6\/12\/3\)/);
 assert.match(sql,/price_rule_assignments where is_active/);
 assert.match(sql,/inbound_cost_settings where formula_tag_id is not null/);
 assert.match(sql,/get diagnostics v_inserted = row_count;[\s\S]*v_inserted <> 19/);
 assert.match(sql,/v_inserted <> 12[\s\S]*v_inserted <> 6[\s\S]*v_inserted <> 12[\s\S]*v_inserted <> 3/);
 assert.match(sql,/tag_id is null/);
 assert.match(sql,/group by tag_id, scope, target_field having count\(\*\) > 1/);
});

test('all approved legacy names become formula tags and price means Sellpia source base price',()=>{
 for(const name of ['판매가 +2,000원','판매가 +5,000원','스마트스토어 즉시할인 -2,000원','에이블리 즉시할인 -2,000원','스스_2000','스스_5000','에이블리_1000','에이블리_2000','14K_기본','14K_노볼','14K_1/2'])assert.ok(sql.includes(name),name);
 assert.match(sql,/12 then raise exception '판매가 수식 생성/);
 assert.match(sql,/'platform_registration_price', s\.scope, 'self', 'source_base_price'/);
 assert.match(sql,/'actual_inbound_cost', '', 'self', 'purchase_price'/);
 assert.match(sql,/update public\.operations_hub_price_rule_sets set is_active=false/);
 assert.match(sql,/update public\.operations_hub_price_rule_tags set is_active=false/);
 assert.match(sql,/update public\.operations_hub_inbound_cost_formula_tags set is_active=false/);
});

test('discount tags are seller-scoped and Makeshop uses an explicit discount code',()=>{
 assert.match(sql,/target_field <> 'platform_discount_price'[\s\S]*scope in \('smartstore','makeshop','ably'\)/);
 assert.match(sql,/scope='makeshop'[\s\S]*discount_mode'='makeshop_code'[\s\S]*'NONE','M10','M15','M20'/);
 assert.match(sql,/scope in \('smartstore','ably'\)[\s\S]*discount_mode','numeric'/);
 assert.match(sql,/할인 수식 태그는 스마트스토어, 메이크샵, 에이블리 중 한 판매처를 선택/);
});

test('follow-up constraint keeps Makeshop discount tags code-only',()=>{
 assert.match(makeshopConstraintSql,/drop constraint hub_rules_discount_scope_and_mode_check/i);
 assert.match(makeshopConstraintSql,/discount_mode'\s*=\s*'makeshop_code'/);
 for(const code of ['NONE','M10','M15','M20'])assert.ok(makeshopConstraintSql.includes(`'${code}'`),code);
 assert.match(makeshopConstraintSql,/when 'M15' then '\[\{"op":"multiply","value":0\.85\},\{"op":"round","unit":10,"rounding":"down"\}\]'::jsonb/);
});
