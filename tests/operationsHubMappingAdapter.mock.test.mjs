import assert from "node:assert/strict";
import fs from "node:fs";
import {chunkOperationsHubMappings, saveOperationsHubMappingRun} from "../src/adapters/operationsHubMappingAdapter.mjs";

const migration = fs.readFileSync(
  new URL("../supabase/migrations/20260818015705_operations_hub_mapping_workflow_adapter.sql", import.meta.url),
  "utf8",
);

assert.match(migration, /request_id uuid[\s\S]*?operations_hub_mapping_batches_request_id_idx/, "mapping batches must have a stable idempotency key");
assert.match(migration, /apply_operations_hub_mapping_workflow[\s\S]*?pg_advisory_xact_lock[\s\S]*?idempotent_replay/, "the service adapter must serialize and replay duplicate requests safely");
assert.match(migration, /refresh_operations_hub_matrix_core_if_stale[\s\S]*?core_is_current/, "legacy core refreshes must be skipped when no legacy mapping changed");
assert.match(migration, /create extension if not exists pg_cron[\s\S]*?operations-hub-legacy-mapping-refresh[\s\S]*?\* \* \* \* \*/, "legacy writers must be bridged by a one-minute stale-only cron job");
assert.match(migration, /revoke all on function public\.apply_operations_hub_mapping_workflow[\s\S]*?grant execute[\s\S]*?service_role/, "the workflow RPC must never be exposed to the public frontend roles");

const items = Array.from({length: 620}, (_, index) => ({
  source_channel: "makeshop",
  sellpia_sku_code: `SKU-${index + 1}`,
  product_code: String(1000 + index),
  option_code: "1",
  match_score: 98,
}));

assert.deepEqual(chunkOperationsHubMappings(items).map((batch) => batch.length), [500, 120]);

const calls = [];
let transientFailure = true;
const db = {
  async rpc(name, args) {
    calls.push({name, args});
    if (transientFailure) {
      transientFailure = false;
      return {data:null, error:new Error("temporary network error")};
    }
    return {
      error:null,
      data:{
        batch:{
          batch_id:`batch-${calls.length}`,
          request_id:args.p_request_id,
          status:"completed",
          saved_count:args.p_items.length,
          failed_count:0,
        },
        core:{status:args.p_finalize ? "skipped" : "deferred"},
        sync:{official_mapping_count:116 + args.p_items.length},
      },
    };
  },
};

const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
const result = await saveOperationsHubMappingRun(db, items, {
  actor:"codex_mapping_test",
  requestIdFactory:(index) => ids[index],
  retryDelayMs:0,
});

assert.equal(calls.length, 3, "one transient failure must retry the same first batch once");
assert.equal(calls[0].args.p_request_id, calls[1].args.p_request_id, "a retry must reuse its stable request ID");
assert.equal(calls[1].args.p_finalize, false);
assert.equal(calls[2].args.p_finalize, true);
assert.equal(result.status, "completed");
assert.equal(result.savedCount, 620);
assert.equal(result.failedCount, 0);

await assert.rejects(
  () => saveOperationsHubMappingRun(db, [{source_channel:'unknown', sellpia_sku:'1', product_code:'2'}]),
  /지원하지 않는 판매처/,
  'invalid mappings must fail before any database write',
);

console.log("Operations hub mapping workflow adapter: passed");
