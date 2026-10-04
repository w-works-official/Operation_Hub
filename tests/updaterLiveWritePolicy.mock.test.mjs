import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../tools/sellpia_memo_updater_0707_stockmatch.html", import.meta.url),
  "utf8",
);

const helperStart = source.indexOf("function decideLiveWriteAllowed");
const helperEnd = source.indexOf("\n    function buildRowPolicyMeta", helperStart);
assert.notEqual(helperStart, -1);
assert.notEqual(helperEnd, -1);
const helperSource = source.slice(helperStart, helperEnd);
const { decideLiveWriteAllowed } = new Function(
  `${helperSource}; return { decideLiveWriteAllowed };`,
)();

const hardBlocks = [
  "item_key_match_failed",
  "item_key_prefix_collision",
  "memo2_event_conflict",
  "completed_but_memo2_exists",
  "inspection_completed_with_shortage_open",
  "missing_current_source",
  "pre_inspection_order_memo_clear",
  "order_memo_clear_without_item_target",
  "invoice_level_order_memo_clear",
  "order_memo_target_missing",
  "order_memo_target_ambiguous",
];

const reviewBlocks = [
  "order_memo_fallback_invoice_level",
  "memo1_conflict",
  "completed_then_reopened",
  "shipping_hold_unknown",
];

for (const warning of hardBlocks) {
  assert.equal(decideLiveWriteAllowed([warning]), "N", warning);
}
for (const warning of reviewBlocks) {
  assert.equal(decideLiveWriteAllowed([warning]), "REVIEW", warning);
}
assert.equal(decideLiveWriteAllowed([]), "Y");
assert.equal(decideLiveWriteAllowed(["informational_only"]), "Y");
assert.equal(decideLiveWriteAllowed([reviewBlocks[0], hardBlocks[0]]), "N");

const holdHelperStart = source.indexOf("function shippingHoldNeedsReview");
const holdHelperEnd = source.indexOf("\n    function currentWarningsForGridRow", holdHelperStart);
assert.notEqual(holdHelperStart, -1);
assert.notEqual(holdHelperEnd, -1);
const holdHelperSource = source.slice(holdHelperStart, holdHelperEnd);
const { shippingHoldNeedsReview } = new Function(
  `${holdHelperSource}; return { shippingHoldNeedsReview };`,
)();
assert.equal(shippingHoldNeedsReview({ holdWriteRequested: false, holdSyncAction: "UNKNOWN" }), false);
assert.equal(shippingHoldNeedsReview({ holdWriteRequested: true, holdSyncAction: "UNKNOWN" }), true);
assert.equal(shippingHoldNeedsReview({ holdWriteRequested: true, holdSyncAction: "REVIEW_SKIP" }), true);
assert.equal(shippingHoldNeedsReview({ holdWriteRequested: true, holdSyncAction: "SET_ON" }), false);

console.log("Updater live-write policy catalog: passed");
