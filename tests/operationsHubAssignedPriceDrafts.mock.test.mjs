import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync('mockups/operations-hub/index.html', 'utf8');
const app = fs.readFileSync('mockups/operations-hub/app.js', 'utf8');
const dataService = fs.readFileSync('mockups/operations-hub/data-service.js', 'utf8');
const migration = fs.readFileSync('supabase/migrations/20260821042000_stage_assigned_price_drafts.sql', 'utf8');

test('assigned rules can create a separate reviewable price-draft step', () => {
  assert.match(html, /id="price-rule-bulk-stage"/);
  assert.match(app, /runAssignedPriceDraftsBulk/);
  assert.match(dataService, /stage_operations_hub_assigned_price_drafts_bulk/);
  assert.match(migration, /calculate_operations_hub_price_rule_set/);
  assert.match(migration, /save_operations_hub_seller_price_draft/);
  assert.match(migration, /operations_hub_active_seller_drafts/);
  assert.match(migration, /price_option_after/);
  assert.doesNotMatch(migration, /prepare_operations_hub_export/);
});
