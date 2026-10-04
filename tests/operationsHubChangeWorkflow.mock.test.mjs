import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../mockups/operations-hub/index.html", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../mockups/operations-hub/app.js", import.meta.url), "utf8");
const data = fs.readFileSync(new URL("../mockups/operations-hub/data-service.js", import.meta.url), "utf8");
const migration = fs.readFileSync(
  new URL("../supabase/migrations/20260814043000_operations_hub_change_workflow.sql", import.meta.url),
  "utf8",
);
const lifecycleMigration = fs.readFileSync(
  new URL("../supabase/migrations/20260827023043_separate_change_state_from_export_history.sql", import.meta.url),
  "utf8",
);

assert.match(migration, /change_batch_id uuid[\s\S]*?validation_errors jsonb[\s\S]*?retry_count integer[\s\S]*?max_retry_count integer/, "queue rows must carry idempotency, validation, and retry state");
assert.match(lifecycleMigration, /status in \('pending', 'validated', 'applied', 'failed', 'saved', 'cancelled'\)/, "the current workflow must expose only durable change states");
assert.match(migration, /operations_hub_change_queue_batch_item_uidx[\s\S]*?coalesce\(source_channel, ''\)/, "one batch cannot duplicate the same seller field");
assert.match(migration, /create table if not exists public\.operations_hub_change_events[\s\S]*?create trigger operations_hub_change_queue_event_trigger/, "every queue transition must be audited by a trigger");
for (const rpc of ["validate_operations_hub_changes", "cancel_operations_hub_changes", "retry_operations_hub_changes", "claim_operations_hub_changes", "complete_operations_hub_change"]) {
  assert.match(migration, new RegExp(`create or replace function public\\.${rpc}`), `${rpc} must exist`);
}
assert.doesNotMatch(migration, /security definer/i, "public queue functions must not bypass RLS");
assert.match(migration, /v_field in \('sellpia_current_stock', 'sellpia_sale_price'\)[\s\S]*?then 'pending'[\s\S]*?else 'saved'/, "only Sellpia stock and price changes propagate to connected sellers");
assert.match(migration, /status_message = '더 최신 변경으로 대체됨'/, "a newer edit must supersede older active work");

for (const id of ["queue-status-filter", "queue-source-filter", "queue-refresh", "queue-retry", "queue-cancel", "queue-validate", "queue-body", "queue-event-panel"]) {
  assert.match(html, new RegExp(`id="${id}"`), `queue UI must include ${id}`);
}
const localAssets = [...html.matchAll(/(?:href|src)="(\.\/[^\"]+)"/g)].map(match => match[1]);
assert.ok(localAssets.length >= 18, "the operations hub must retain its local asset bundle");
assert.ok(localAssets.every(asset => /\?v=[^&\"]+$/.test(asset)), "all deployed local assets must be versioned");
assert.match(html,/discount-price-math\.js\?v=[^"]+[\s\S]*?data-service\.js\?v=[^"]+[\s\S]*?app\.js\?v=[^"]+/,"the matrix resolver, data adapter and app must all be cache-versioned");
assert.match(data, /loadChangeQueue[\s\S]*?loadChangeQueueStats[\s\S]*?loadChangeEvents[\s\S]*?validateChangeQueue[\s\S]*?cancelChangeQueue[\s\S]*?retryChangeQueue/, "the frontend data adapter must expose the complete queue workflow");
assert.match(data, /p_batch_id:batchId/, "writes must send their stable request batch ID to the database");
assert.match(app, /const batchId = pendingChangeBatchId \|\| createRequestId\(\)[\s\S]*?saveSellpiaChanges\(snapshot, batchId\)[\s\S]*?pendingChangeBatchId = batchId/, "Sellpia automatic-save retries must reuse the same batch ID after failure");
assert.match(app, /SELLPIA_AUTOSAVE_DELAY_MS = 450[\s\S]*?scheduleSellpiaAutosave[\s\S]*?flushPendingSellpiaChanges\(\{automatic:true\}\)/, "Sellpia cell edits must automatically persist after a short batching delay");
assert.match(app, /pendingChanges\.splice\(0, pendingChanges\.length\)[\s\S]*?restoreFailedChanges\(snapshot\)/, "new edits must remain separate while an automatic save is in flight and failed snapshots must be restored");
assert.match(app, /function renderChangeQueue[\s\S]*?function runQueueAction/, "the live queue must render and execute state actions");
assert.match(app, /if \(pageId === 'jobs'\) loadChangeQueue\(\)/, "opening the queue page must load live DB rows");

console.log("Operations hub durable change workflow: passed");
