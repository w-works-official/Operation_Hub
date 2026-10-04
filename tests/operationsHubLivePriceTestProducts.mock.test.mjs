import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const migration = fs.readFileSync('supabase/migrations/20260821044000_seed_live_price_test_products.sql', 'utf8');

test('price-rule test products seed thirty live matrix rows with three seller sources', () => {
  assert.match(migration, /generate_series\(1, 30\)/);
  assert.match(migration, /TEST-PRICE-%s/);
  assert.match(migration, /system_v3_live_test/);
  assert.match(migration, /array\['smartstore','makeshop','ably'\]/);
  assert.match(migration, /base_price, option_price, final_price/);
  assert.match(migration, /refresh materialized view operations_private\.operations_hub_matrix_core/);
  assert.doesNotMatch(migration, /operations_hub_price_rule_qa_cases/);
});
