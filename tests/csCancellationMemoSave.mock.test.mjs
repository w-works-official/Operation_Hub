import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/app/pickingApp.mjs", import.meta.url), "utf8");

function sourceSlice(startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, `${startText} source must exist`);
  return source.slice(start, end);
}

const cancellationSaveSource = sourceSlice(
  "async function saveCsOrderMemosBeforeCancellation",
  "\nasync function saveCsTemplateOverride",
);

const calls = [];
const rows = new Map([
  ["row-a", { key: "row-a" }],
  ["row-b", { key: "row-b" }],
]);
const firstScope = { dataset: { csRowKey: "row-a" } };
const secondScope = { dataset: { csRowKey: "row-b" } };
const orderRoot = {
  querySelectorAll() {
    return [firstScope, secondScope];
  },
};
const orderButton = {
  dataset: { csCancelAction: "order-cancel", csOrderGroup: "order-a" },
  disabled: false,
  isConnected: true,
  closest() {
    return orderRoot;
  },
};

const runCsCancellationAction = new Function(
  "els",
  "selectedCsItemRow",
  "saveCsCaseOrderMemo",
  "toggleCsOrderCancellation",
  "toggleCsItemCancellation",
  `${cancellationSaveSource}; return runCsCancellationAction;`,
)(
  { csDetail: orderRoot },
  (rowKey) => rows.get(rowKey),
  async (row) => calls.push(`memo:${row.key}`),
  async () => calls.push("cancel:order"),
  async () => calls.push("cancel:item"),
);

await runCsCancellationAction(orderButton);
assert.deepEqual(calls, ["memo:row-a", "memo:row-b", "cancel:order"]);
assert.equal(orderButton.disabled, false);

calls.length = 0;
const itemButton = {
  dataset: { csCancelAction: "item-cancel", csRowKey: "row-b" },
  disabled: false,
  isConnected: true,
  closest() {
    return secondScope;
  },
};
await runCsCancellationAction(itemButton);
assert.deepEqual(calls, ["memo:row-b", "cancel:item"]);

calls.length = 0;
const failingSave = new Function(
  "els",
  "selectedCsItemRow",
  "saveCsCaseOrderMemo",
  "toggleCsOrderCancellation",
  "toggleCsItemCancellation",
  `${cancellationSaveSource}; return runCsCancellationAction;`,
)(
  { csDetail: orderRoot },
  (rowKey) => rows.get(rowKey),
  async () => { throw new Error("memo save failed"); },
  async () => calls.push("cancel:order"),
  async () => calls.push("cancel:item"),
);
await assert.rejects(() => failingSave(itemButton), /memo save failed/);
assert.deepEqual(calls, [], "주문메모 저장 실패 시 취소 이벤트를 기록하면 안 된다");

console.log("CS cancellation waits for exact-row order memo saves: passed");
