import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const html=fs.readFileSync(path.join(root,'mockups/operations-hub/index.html'),'utf8');
const ui=fs.readFileSync(path.join(root,'mockups/operations-hub/inventory-batch-ui.js'),'utf8');
const workflow=fs.readFileSync(path.join(root,'mockups/operations-hub/seller-file-workflow-v2.js'),'utf8');

test('inventory keeps Jobs exporter in place and exposes only the batch inputs',()=>{
  assert.match(html,/<div id="jobs" class="page queue-page">/,'Jobs page remains present');
  assert.match(html,/<div id="inventory" class="page inventory-page">/,'Inventory page remains present');
  assert.match(workflow,/section\.id='export-workflow-v2'/,'Jobs workflow remains mounted by the existing exporter');
  assert.doesNotMatch(workflow,/inventory-export-host|transferExportWorkspace|bindInventoryControls/,'legacy workflow transfer is removed');
  assert.match(html,/id="inventory-ably-file" type="file" accept="\.xlsx"/);
  assert.match(html,/id="inventory-batch-run"/);
  assert.match(html,/id="inventory-batch-status"/);
  assert.match(html,/id="inventory-batch-result"/);
  assert.deepEqual([...html.matchAll(/data-inventory-target=/g)],[],'inventory has no seller target checkboxes');
  assert.doesNotMatch(html,/data-standard-(?:preview|run|full-run)|data-ably-(?:preview|run)/,'inventory contains no per-seller export actions');
  assert.match(ui,/output\.files\?\.length!==4/,'one ZIP requires all four expected seller files');
});
