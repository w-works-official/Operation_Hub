import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(
  new URL('../supabase/migrations/20260825060001_representative_price_and_inbound_tags.sql', import.meta.url),
  'utf8'
);
const correctionMigration = fs.readFileSync(
  new URL('../supabase/migrations/20260825060002_correct_14k_nobol_tag_name.sql', import.meta.url),
  'utf8'
);
const html = fs.readFileSync(new URL('../mockups/operations-hub/index.html', import.meta.url), 'utf8');
const lab = fs.readFileSync(new URL('../mockups/operations-hub/price-rule-lab.js', import.meta.url), 'utf8');

for (const value of [2000, 3000, 4000, 5000]) {
  assert.match(migration, new RegExp(`REP_PRICE_ADD_${value}[\\s\\S]*?${value}::numeric`), `the representative catalog must include the +${value} sale-price tag`);
  assert.match(migration, new RegExp(`REP_SMART_DISCOUNT_${value}[\\s\\S]*?-${value}::numeric`), `the representative catalog must include the Smartstore -${value} discount tag`);
  assert.match(migration, new RegExp(`REP_SMART_${value}[\\s\\S]*?스스_${value}`), `the representative keyword 스스_${value} must be a named price combination`);
}

assert.match(migration, /REP_ABLY_DISCOUNT_1000[\s\S]*?-1000::numeric[\s\S]*?REP_ABLY_DISCOUNT_2000[\s\S]*?-2000::numeric/, 'Ably immediate-discount tags must match the representative sheet');
assert.match(migration, /REP_ABLY_1000[\s\S]*?REP_PRICE_ADD_4000[\s\S]*?REP_ABLY_DISCOUNT_1000/, '에이블리_1000 must combine +4000 sale price with -1000 immediate discount');
assert.match(migration, /REP_ABLY_2000[\s\S]*?REP_PRICE_ADD_5000[\s\S]*?REP_ABLY_DISCOUNT_2000/, '에이블리_2000 must combine +5000 sale price with -2000 immediate discount');
assert.match(migration, /v_source not in \('smartstore', 'makeshop', 'ably'\)[\s\S]*?v_source = 'ably'[\s\S]*?'term_key', 'immediate'[\s\S]*?'title', '즉시할인'/, 'Ably discount tags must be valid and calculate an immediate-discount term');

assert.match(migration, /'14K_기본'[\s\S]*?1::numeric, 1::numeric, 0::numeric/, '14K 기본 must preserve supplier cost');
assert.match(migration, /'14K_노블'[\s\S]*?1::numeric, 1::numeric, -7500::numeric/, 'the historical seed keeps the original formula values');
assert.match(correctionMigration, /set tag_name = '14K_노볼'[\s\S]*?where tag_name = '14K_노블'/, 'the representative tag name must be corrected to 14K_노볼 without changing its formula');
assert.match(migration, /'14K_1\/2'[\s\S]*?1::numeric, 2::numeric, 0::numeric/, '14K 1/2 must divide supplier cost by two');
assert.doesNotMatch(migration, /operations_hub_price_rule_assignments/, 'representative tags must not be assigned to products yet');

assert.match(html, /id="price-rule-tag-source"[\s\S]*?<option value="ably">에이블리<\/option>/, 'the tag editor must allow an Ably discount tag');
assert.match(lab, /channelLabels = \{smartstore:'스마트스토어', makeshop:'메이크샵', ably:'에이블리'\}/, 'the tag catalog must label Ably discount tags correctly');

console.log('Operations hub representative price and inbound tags contract: passed');
