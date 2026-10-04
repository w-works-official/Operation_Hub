import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync('mockups/operations-hub/index.html', 'utf8');
const dataService = fs.readFileSync('mockups/operations-hub/data-service.js', 'utf8');
const lab = fs.readFileSync('mockups/operations-hub/price-rule-lab.js', 'utf8');
const qaRemoval = fs.readFileSync('supabase/migrations/20260821045000_drop_price_rule_virtual_qa.sql', 'utf8');
test('price rule lab exposes atomic and composite tag management without virtual QA', () => {
  assert.match(html, /id="price-rule-lab-open"/);
  assert.match(html, /data-page="price-rules"/);
  assert.match(html, /id="price-rules" class="page price-rule-page"/);
  assert.match(html, /id="price-rule-tag-form"/);
  assert.match(html, /id="price-rule-set-form"/);
  assert.doesNotMatch(html, /price-rule-qa/);
  assert.doesNotMatch(html, /가상 옵션 QA/);
  assert.match(html, /price-rule-lab\.js\?v=[^"']+/);
  assert.doesNotMatch(html, /id="price-rule-lab-modal"/);
  assert.match(lab, /showPage\?\.\('price-rules'\)/);
  assert.match(lab, /SystemV3PriceRuleLab = \{refresh\}/);
  assert.match(html, /id="price-rule-tag-delete"/);
  assert.match(html, /id="price-rule-set-delete"/);
  assert.match(dataService, /deletePriceRuleTag/);
  assert.match(dataService, /deletePriceRuleSet/);
});

test('data service keeps tag saves behind dedicated RPCs', () => {
  assert.doesNotMatch(dataService, /loadPriceRuleQaCases/);
  assert.match(qaRemoval, /drop view if exists public\.operations_hub_price_rule_qa_live[\s\S]*?drop table if exists public\.operations_hub_price_rule_qa_components[\s\S]*?drop table if exists public\.operations_hub_price_rule_qa_cases/);
  assert.match(dataService, /save_operations_hub_price_rule_tag/);
  assert.match(dataService, /save_operations_hub_price_rule_set/);
  assert.match(lab, /state\.selectedTagIds/);
  assert.match(lab, /data-move="up"/);
});
