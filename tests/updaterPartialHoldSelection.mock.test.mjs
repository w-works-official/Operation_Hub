import assert from "node:assert/strict";
import fs from "node:fs";

const updaterPath = new URL("../tools/sellpia_memo_updater_0707_stockmatch.html", import.meta.url);
const source = fs.readFileSync(updaterPath, "utf8");
const start = source.indexOf("    function isPickingHoldOn");
const end = source.indexOf("    function partialHoldTargetForGridRow", start);
assert.ok(start >= 0 && end > start, "partial-hold functions must exist in updater");

const functionSource = source.slice(start, end);
const normal = (value) => String(value ?? "").trim();
const managementTargetKey = (ordNo, itemNo) => {
  const order = normal(ordNo);
  const item = normal(itemNo);
  return order && item ? `${order}::${item}` : "";
};
const addUniqueManagementTarget = (index, ambiguous, key, target) => {
  if (!key || ambiguous.has(key)) return;
  if (index.has(key)) {
    index.delete(key);
    ambiguous.add(key);
    return;
  }
  index.set(key, target);
};

const buildPartialHoldTargets = new Function(
  "normal",
  "managementTargetKey",
  "addUniqueManagementTarget",
  `${functionSource}\nreturn buildPartialHoldTargets;`,
)(normal, managementTargetKey, addUniqueManagementTarget);

const ordNo = "2026073099719531";
const invNo = "6890159330712";
const orderItemRows = [
  { item_no: "525_2026073016136791", sellpia_order_item_no: "2026073016136791" },
  { item_no: "525_2026073016136801", sellpia_order_item_no: "2026073016136801" },
  { item_no: "525_2026073016136811", sellpia_order_item_no: "2026073016136811" },
];
const pickingRows = [
  { ord_no: ordNo, inv_no: "", item_no: "525_2026073016136791", hold: false },
  { ord_no: ordNo, inv_no: invNo, item_no: "525_2026073016136791", hold: true },
  { ord_no: ordNo, inv_no: "", item_no: "525_2026073016136801", hold: false },
  { ord_no: ordNo, inv_no: "", item_no: "525_2026073016136811", hold: false },
];

const result = buildPartialHoldTargets(ordNo, invNo, orderItemRows, pickingRows);
const heldKey = managementTargetKey(ordNo, "525_2026073016136791");
assert.equal(result.targets.get(heldKey)?.hold, true);
assert.equal(result.targets.get(heldKey)?.matchMethod, "picking_item_no_exact_current_invoice");
assert.equal(result.stats.matched, 3);
assert.equal(result.stats.holdOn, 1);
assert.equal(result.stats.ambiguous, 0);
assert.equal(result.stats.exactInvoicePreferred, 1);

const genuineDuplicate = buildPartialHoldTargets(
  ordNo,
  invNo,
  [orderItemRows[0]],
  [
    { ord_no: ordNo, inv_no: invNo, item_no: orderItemRows[0].item_no, hold: true },
    { ord_no: ordNo, inv_no: invNo, item_no: orderItemRows[0].item_no, hold: false },
  ],
);
assert.equal(genuineDuplicate.targets.size, 0);
assert.equal(genuineDuplicate.stats.ambiguous, 1);

const carriedOrderItems = [
  { item_no: "1_20260717053510-29185630884_[1]", sellpia_order_item_no: "20260717053510-29185630884_[1]" },
  { item_no: "1_20260717053510-29185630884_[2]", sellpia_order_item_no: "20260717053510-29185630884_[2]" },
  { item_no: "1_20260717053510-29185630884_[3]", sellpia_order_item_no: "20260717053510-29185630884_[3]" },
];
const carriedPartialHold = buildPartialHoldTargets(
  "20260717053510-29185630884",
  "6890155667516",
  carriedOrderItems,
  [
    {
      ord_no: "20260717053510-29185630884",
      inv_no: "6890155667516",
      item_no: "1_20260717053510-29185630884_[3]",
      hold: true,
    },
  ],
);
const carriedOffKey = managementTargetKey(
  "20260717053510-29185630884",
  "1_20260717053510-29185630884_[1]",
);
const carriedOnKey = managementTargetKey(
  "20260717053510-29185630884",
  "1_20260717053510-29185630884_[3]",
);
assert.equal(carriedPartialHold.targets.get(carriedOffKey)?.hold, false);
assert.equal(
  carriedPartialHold.targets.get(carriedOffKey)?.matchMethod,
  "picking_hold_absent_order_item_exact",
);
assert.equal(carriedPartialHold.targets.get(carriedOnKey)?.hold, true);
assert.equal(carriedPartialHold.stats.holdOn, 1);
assert.equal(carriedPartialHold.stats.defaultOff, 2);

console.log("Updater partial hold handles current-invoice rows, real duplicates, and carried-order OFF siblings: passed");
