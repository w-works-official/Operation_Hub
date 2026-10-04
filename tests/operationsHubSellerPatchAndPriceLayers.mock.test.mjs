import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../mockups/operations-hub/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../mockups/operations-hub/app.js', import.meta.url), 'utf8');
const data = fs.readFileSync(new URL('../mockups/operations-hub/data-service.js', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../supabase/migrations/20260820054207_seller_patch_upload_and_price_layers.sql', import.meta.url), 'utf8');

assert.match(html, /id="seller-upload-mode"[\s\S]*?value="patch"[\s\S]*?부분 갱신[\s\S]*?value="full"[\s\S]*?전체 교체/, 'upload mode must clearly expose patch and full replacement');
assert.match(app, /querySelector\(`input\[value="patch"\]`\)\.checked = true/, 'all sources default to selective patch; full remains explicit');
assert.match(app, /function requiredUploadFileCount[\s\S]*?currentUploadMode\(\) === 'patch' \? 1 : config\.files/, 'patch uploads must accept one edited file while full uploads keep the complete file requirement');
assert.match(data, /const uploadMode = fields\.mode === 'full' \? 'full' : 'patch'[\s\S]*?upload_mode:uploadMode/, 'seller snapshots must persist the chosen upload mode');
assert.match(migration, /upload_mode in \('full', 'patch'\)[\s\S]*?if v_upload_mode = 'patch'[\s\S]*?insert into public\.seller_inventory_snapshot_rows[\s\S]*?_patch_preserved/, 'patch finalization must carry forward seller rows omitted from the edited upload');
assert.match(migration, /selected_fields[\s\S]*?previous_row\.stock[\s\S]*?previous_row\.price/, 'field selection must still preserve unselected values by seller key');
assert.match(migration, /smartstore_policy_price[\s\S]*?makeshop_policy_price[\s\S]*?ably_policy_price/, 'the cached matrix must expose an independent calculated price for every seller');
assert.match(data, /smartstore_price,smartstore_policy_price,smartstore_policy_active,smartstore_policy_name[\s\S]*?ably_price,ably_policy_price,ably_policy_active,ably_policy_name/, 'frontend matrix reads must request source and calculated prices separately');
assert.match(app, /price-layer original[\s\S]*?>원본<[\s\S]*?price-layer policy[\s\S]*?>수식<[\s\S]*?price-layer draft[\s\S]*?>반영</, 'the matrix price cell must show original, formula, and staged values as distinct layers');
assert.match(app, /수식 계산가는 원본을 덮어쓰지 않습니다[\s\S]*?반영 예정가로 저장/, 'price help must state that calculation does not mutate the source price');
assert.match(app, /const rulePrice = priceManaged \? product\.__hubRulePrices/, 'matrix must mask historical calculated prices after Rule removal');
assert.match(app, /const policyActive = priceManaged && Boolean/, 'matrix must not revive a removed Rule through the cached policy layer');
assert.match(app, /const priceRuleAssignment = priceManaged \?/, 'matrix must not show a removed Rule as active through a legacy assignment badge');

console.log('operationsHubSellerPatchAndPriceLayers.mock.test: OK');
