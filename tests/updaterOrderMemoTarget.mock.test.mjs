import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../tools/sellpia_memo_updater_0707_stockmatch.html", import.meta.url),
  "utf8",
);

const helperStart = source.indexOf("function normalizeItemKeyForMatch");
const helperEnd = source.indexOf("\n    function managementTargetKey", helperStart);
assert.notEqual(helperStart, -1);
assert.notEqual(helperEnd, -1);

const helperSource = source.slice(helperStart, helperEnd);
const normal = (value) => String(value ?? "").trim();
const rowItemNo = (row, index) => normal(
  row.sellpia_order_item_no
  || row.c_order_item_no
  || row.c_ord_item_no
  || row.c_item_no
  || row.item_no
  || row.c_prv_item_no
  || (index + 1),
);
const rowItemNoStrict = (row) => normal(
  row.sellpia_order_item_no
  || row.c_order_item_no
  || row.c_ord_item_no
  || row.c_item_no
  || row.item_no,
);

const { addOrderMemoTarget, orderMemoTargetForGridRow } = new Function(
  "normal",
  "rowItemNo",
  "rowItemNoStrict",
  `${helperSource}; return { addOrderMemoTarget, orderMemoTargetForGridRow };`,
)(normal, rowItemNo, rowItemNoStrict);

function makeTask(ordNo) {
  return {
    ordNo,
    writeOrderMemo: true,
    orderMemoMap: new Map(),
    orderMemoAmbiguousKeys: new Set(),
    orderMemoNormalizedMap: new Map(),
    orderMemoNormalizedAmbiguousKeys: new Set(),
    orderMemoRequestedCount: 0,
  };
}

function addRows(task, rows) {
  rows.forEach((row) => addOrderMemoTarget(task, row));
  return task;
}

const smartstoreOrder = "2026082193052701";
const smartstoreTask = addRows(makeTask(smartstoreOrder), [{
  ord_no: smartstoreOrder,
  item_no: "525_2026082185840321",
  sellpia_order_item_no: "2026082185840321",
  order_memo: "합배송 확인",
}]);

assert.deepEqual(
  orderMemoTargetForGridRow(smartstoreTask, { c_item_no: "525_2026082185840321" }, 0),
  {
    found: true,
    known: true,
    value: "합배송 확인",
    matchMethod: "item_no_exact",
    matchedItemNo: "525_2026082185840321",
    warning: "",
  },
);

const makeshopOrder = "20260826122344-91185772668";
const makeshopTask = addRows(makeTask(makeshopOrder), [{
  ord_no: makeshopOrder,
  item_no: `1_${makeshopOrder}_[1]`,
  sellpia_order_item_no: `${makeshopOrder}_[1]`,
  order_memo: "분리배송 확인",
}]);

assert.equal(
  orderMemoTargetForGridRow(makeshopTask, { c_item_no: `1_${makeshopOrder}_[1]` }, 0).value,
  "분리배송 확인",
);
assert.equal(
  orderMemoTargetForGridRow(makeshopTask, { c_item_no: `9_${makeshopOrder}_[1]` }, 0).matchMethod,
  "prefix_stripped_unique",
);

const sameItemDifferentOrdersA = addRows(makeTask("order-A"), [{
  ord_no: "order-A",
  item_no: "525_shared-item",
  sellpia_order_item_no: "shared-item",
  order_memo: "A 메모",
}]);
const sameItemDifferentOrdersB = addRows(makeTask("order-B"), [{
  ord_no: "order-B",
  item_no: "525_shared-item",
  sellpia_order_item_no: "shared-item",
  order_memo: "B 메모",
}]);
assert.equal(orderMemoTargetForGridRow(sameItemDifferentOrdersA, { c_item_no: "525_shared-item" }, 0).value, "A 메모");
assert.equal(orderMemoTargetForGridRow(sameItemDifferentOrdersB, { c_item_no: "525_shared-item" }, 0).value, "B 메모");

const ambiguousTask = addRows(makeTask("order-C"), [
  { ord_no: "order-C", item_no: "525_dup", sellpia_order_item_no: "dup", order_memo: "첫 메모" },
  { ord_no: "order-C", item_no: "1_dup", sellpia_order_item_no: "dup", order_memo: "둘째 메모" },
]);
assert.deepEqual(
  orderMemoTargetForGridRow(ambiguousTask, { c_item_no: "9_dup" }, 0),
  {
    found: false,
    known: false,
    value: "",
    matchMethod: "none",
    matchedItemNo: "",
    warning: "order_memo_target_ambiguous",
  },
);

assert.equal(
  orderMemoTargetForGridRow(makeshopTask, { c_item_no: "1_missing" }, 0).warning,
  "order_memo_target_missing",
);

const blankTask = addRows(makeTask("order-D"), [{
  ord_no: "order-D",
  item_no: "525_blank",
  sellpia_order_item_no: "blank",
  order_memo: "",
  order_memo_updated_at: "2026-08-27T00:00:00Z",
}]);
const blankTarget = orderMemoTargetForGridRow(blankTask, { c_item_no: "525_blank" }, 0);
assert.equal(blankTarget.found, true);
assert.equal(blankTarget.value, "");
assert.equal(blankTask.orderMemoRequestedCount, 1);

const unsetTask = addRows(makeTask("order-E"), [{
  ord_no: "order-E",
  item_no: "525_unset",
  sellpia_order_item_no: "unset",
  order_memo: "",
  order_memo_updated_at: "",
}]);
assert.deepEqual(
  orderMemoTargetForGridRow(unsetTask, { c_item_no: "525_unset" }, 0),
  {
    found: false,
    known: true,
    value: "",
    matchMethod: "item_no_exact",
    matchedItemNo: "525_unset",
    warning: "",
  },
);
assert.equal(unsetTask.orderMemoRequestedCount, 0);

assert.match(source, /order_memo,order_memo_updated_at/);

console.log("Updater order-memo target matching: passed");
