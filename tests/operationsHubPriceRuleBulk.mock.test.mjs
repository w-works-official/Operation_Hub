import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync('mockups/operations-hub/index.html', 'utf8');
const app = fs.readFileSync('mockups/operations-hub/app.js', 'utf8');
const dataService = fs.readFileSync('mockups/operations-hub/data-service.js', 'utf8');
const migration = fs.readFileSync('supabase/migrations/20260821040000_bulk_price_rule_assignment.sql', 'utf8');

test('matrix exposes a scoped seller-channel price rule assignment flow', () => {
  const modal = html.match(/<div id="price-rule-bulk-modal"[\s\S]*?<div id="inbound-cost-modal"/)?.[0] || '';
  assert.match(html, /id="price-rule-bulk-modal"/);
  assert.match(modal, /선택 SKU 가격 조합 배정[\s\S]*?value="selected" checked[\s\S]*?선택한 셀이 속한 행/);
  assert.doesNotMatch(modal, /value="code_list"|value="filtered"|현재 검색·필터 결과/, 'price assignment must never fall back to code-list or filtered-catalog scope');
  assert.match(html, /id="price-rule-bulk-set"/);
  assert.match(html, /id="price-rule-bulk-composer-name"[\s\S]*?id="price-rule-bulk-composer-add"[\s\S]*?id="price-rule-bulk-composer-steps"[\s\S]*?id="price-rule-bulk-composer-save"/);
  assert.match(app, /savePriceRuleAssignmentsBulk/);
  assert.match(app, /priceRuleBulkState\.composerTagIds[\s\S]*?savePriceRuleSet\([\s\S]*?fillPriceRuleBulkSetSelect\(savedSet\.price_rule_set_id\)/);
  assert.match(app, /const selectedTargets = selectedMatrixTargets\(\);[\s\S]*?selectedSkus = selectedTargets\.skus[\s\S]*?if \(!priceRuleBulkState\.selectedSkus\.length\)/, 'the modal must require matrix-selected SKU rows before opening');
  assert.match(app, /resolvePriceRuleBulkTargetGroups\(sources\)[\s\S]*?resolvePriceRuleBulkSkus\(\)[\s\S]*?\{sources, skus\}/, 'selected row SKUs must be paired with the separately checked seller sources');
  assert.doesNotMatch(app, /priceRuleBulkState\.(selectedSourceSkus|codeListSkus|filter)/, 'selected-row pricing must not derive scope from the selected column or filtered catalog');
  assert.match(dataService, /save_operations_hub_price_rule_assignments_bulk/);
});

test('bulk assignment RPC persists rules without creating seller change drafts', () => {
  assert.match(migration, /save_operations_hub_price_rule_assignments_bulk/);
  assert.match(migration, /operations_hub_price_rule_assignments/);
  assert.match(migration, /p_rule_set_id/);
  assert.match(migration, /p_sources text\[\]/);
  assert.doesNotMatch(migration, /operations_hub_change_queue/);
  assert.match(migration, /grant execute .* to anon, authenticated/);
});
