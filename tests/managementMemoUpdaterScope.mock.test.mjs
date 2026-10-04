import assert from "node:assert/strict";
import fs from "node:fs";

const updaterSource = fs.readFileSync(
  new URL("../tools/sellpia_memo_updater_0707_stockmatch.html", import.meta.url),
  "utf8",
);
const updaterStart = updaterSource.indexOf("    function buildManagementMemoTargets");
const updaterEnd = updaterSource.indexOf("    function managementTargetForGridRow", updaterStart);
assert.ok(updaterStart >= 0 && updaterEnd > updaterStart, "updater management target builder must exist");

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
const buildManagementMemoTargets = new Function(
  "normal",
  "managementTargetKey",
  "addUniqueManagementTarget",
  `${updaterSource.slice(updaterStart, updaterEnd)}\nreturn buildManagementMemoTargets;`,
)(normal, managementTargetKey, addUniqueManagementTarget);

const consistent = buildManagementMemoTargets(
  "order-1",
  [
    { item_no: "item-1", sellpia_order_item_no: "regular-1", o_shop_memo: "273", o_shop_memo2: "" },
    { item_no: "item-2", sellpia_order_item_no: "regular-2", o_shop_memo: "273", o_shop_memo2: "1" },
  ],
  [],
);
assert.equal(consistent.memo1Conflict, false);
assert.equal(consistent.targets.get("order-1::item-1")?.memo1, "273");
assert.equal(consistent.targets.get("order-1::item-2")?.memo1, "273");
assert.equal(consistent.targets.get("order-1::item-2")?.memo2, "1");

const conflict = buildManagementMemoTargets(
  "order-1",
  [
    { item_no: "item-1", o_shop_memo: "273", o_shop_memo2: "" },
    { item_no: "item-2", o_shop_memo: "271", o_shop_memo2: "" },
  ],
  [],
);
assert.equal(conflict.memo1Conflict, true);
assert.deepEqual(conflict.memo1Values.sort(), ["271", "273"]);

console.log("Updater invoice-wide management memo regression: passed");
