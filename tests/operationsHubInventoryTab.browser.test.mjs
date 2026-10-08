import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const html=fs.readFileSync(path.join(root,'mockups/operations-hub/index.html'),'utf8');
const ui=fs.readFileSync(path.join(root,'mockups/operations-hub/inventory-batch-ui.js'),'utf8');
const workflow=fs.readFileSync(path.join(root,'mockups/operations-hub/seller-file-workflow-v2.js'),'utf8');

test('inventory keeps Jobs exporter in place and exposes the combined DB-update workflow',()=>{
  assert.match(html,/<div id="jobs" class="page queue-page">/,'Jobs page remains present');
  assert.match(html,/<div id="inventory" class="page inventory-page">/,'Inventory page remains present');
  assert.match(workflow,/section\.id='export-workflow-v2'/,'Jobs workflow remains mounted by the existing exporter');
  assert.doesNotMatch(workflow,/inventory-export-host|transferExportWorkspace|bindInventoryControls/,'legacy workflow transfer is removed');
  assert.doesNotMatch(html,/id="inventory-ably-file"/,'combined inventory batch has no PlayAuto upload prerequisite');
  assert.match(html,/id="inventory-ably-mapping-status"/,'DB mapping and packaged official template readiness are displayed');
  assert.match(html,/id="inventory-sellpia-files" type="file" accept="\.xlsx" multiple/);
  assert.match(html,/id="inventory-preview-summary"/);
  assert.match(html,/id="inventory-preview-unconfirmed"/);
  assert.match(html,/id="inventory-preview-duplicate-conflict"/);
  assert.match(html,/value="available_stock" checked/,'available stock remains the default export source');
  assert.match(html,/재고 반영 후 판매처 파일 4개 생성/);
  assert.match(html,/id="inventory-batch-run"/);
  assert.match(html,/id="inventory-batch-status"/);
  assert.match(html,/id="inventory-batch-result"/);
  assert.deepEqual([...html.matchAll(/data-inventory-target=/g)],[],'inventory has no seller target checkboxes');
  assert.doesNotMatch(html,/data-standard-(?:preview|run|full-run)|data-ably-(?:preview|run)/,'inventory contains no per-seller export actions');
  assert.match(ui,/output\.files\.length!==4/,'saving requires all four expected seller files');
  assert.match(ui,/runInventoryUpdateBatch/,'the final action uses the dedicated DB-update orchestration bridge');
  assert.match(ui,/preflightInventoryMappings/,'DB option mapping and official AB template are checked before enabling the batch');
  assert.match(ui,/retryInventoryBatchExport/,'post-update save failures can retry export alone');
  assert.match(ui,/error\?\.uploaded===true&&error\?\.retryAvailable===true/,'only a confirmed DB update exposes export-only retry');
});
