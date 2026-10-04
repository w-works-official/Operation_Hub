import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('retired survey has no page, menu, upload choice, or callable frontend module',()=>{
 const html=read('mockups/operations-hub/index.html'),app=read('mockups/operations-hub/app.js'),service=read('mockups/operations-hub/data-service.js');
 assert.doesNotMatch(html,/\sid="inventory"|data-page="inventory"|value="survey"/);
 assert.doesNotMatch(app,/loadInventorySurvey|inventoryState|uploadInventorySurvey/);
 assert.doesNotMatch(service,/async function (uploadInventorySurvey|loadInventorySurveyData)/);
});

test('picking cache keeps completed picking and drawer quantities separate', () => {
  const migration = read('supabase/pr_system_migrations/20260820133000_create_system_v3_inventory_activity_cache.sql');
  assert.match(migration, /event_type in \('picked', 'pick_unchecked'\)/);
  assert.match(migration, /where event_type = 'picked'/);
  assert.match(migration, /status = '서랍입력'/);
  assert.match(migration, /coalesce\(short_qty, 0\) = 0/);
  assert.match(migration, /refresh materialized view concurrently/);
  assert.doesNotMatch(migration, /security\s+definer/i);
  const privateMigration = read('supabase/pr_system_migrations/20260820140000_privatize_system_v3_inventory_activity_cache.sql');
  assert.match(privateMigration, /set schema operations_private/);
  assert.match(privateMigration, /security invoker/);
  assert.doesNotMatch(privateMigration, /security\s+definer/i);
});
