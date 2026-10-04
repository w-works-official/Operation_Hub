import assert from "node:assert/strict";
import fs from "node:fs";

const appSource = fs.readFileSync(new URL("../src/app/pickingApp.mjs", import.meta.url), "utf8");
const cssSource = fs.readFileSync(new URL("../src/styles/picking.css", import.meta.url), "utf8");

assert.match(
  appSource,
  /function openShortageRowForInvoiceItem[\s\S]*?state\.workflowQueues\?\.shortageItems[\s\S]*?workflowItemKey\(row\.invoice, row\.item\) === targetKey/,
  "invoice detail actions must use the same open shortage queue and exact order/item key",
);
assert.match(
  appSource,
  /data-action="shortage-repicked" data-shortage-inline-complete data-shortage-key="\$\{escapeHtml\(openShortageKey\)\}"/,
  "each actionable invoice item must render an exact-key inline completion button",
);
assert.match(
  appSource,
  /keepSameOrder: button\.hasAttribute\("data-shortage-inline-complete"\)/,
  "only invoice-row completion should keep the operator in the same order",
);
assert.match(
  appSource,
  /function nextOpenShortageKeyInSameOrder[\s\S]*?sourceOrderGroupNo\(row\.invoice, row\.item\) === sourceOrderNo/,
  "inline completion must select another open shortage only from the same source order",
);
assert.match(
  cssSource,
  /\.shortage-invoice-table \.workflow-item-row[\s\S]*?grid-template-columns:[^;]*132px/,
  "the order detail table must reserve a dedicated action column",
);

const openRowSource = appSource.slice(
  appSource.indexOf("function openShortageRowForInvoiceItem"),
  appSource.indexOf("\nfunction renderShortageInvoiceItems"),
);
const workflowItemKey = (invoice, item) => `${item.sourceOrderGroupNo || invoice.orderGroupNo}::${item.sellpiaItemNo}`;
const invoice = { orderGroupNo: "order-a" };
const item = { sellpiaItemNo: "item-1" };
const exactOpenRow = { invoice, item };
const state = {
  workflowQueues: {
    shortageItems: [
      { invoice: { orderGroupNo: "order-b" }, item: { sellpiaItemNo: "item-1" } },
      exactOpenRow,
    ],
  },
};
const openShortageRowForInvoiceItem = new Function(
  "workflowItemKey",
  "state",
  "itemIsEffectivelyCancelled",
  `${openRowSource}; return openShortageRowForInvoiceItem;`,
)(workflowItemKey, state, (_invoice, candidate) => candidate.cancelled === true);

assert.equal(openShortageRowForInvoiceItem(invoice, item), exactOpenRow, "exact order/item row should be actionable");
exactOpenRow.completed = true;
assert.equal(openShortageRowForInvoiceItem(invoice, item), null, "completed rows must not remain actionable");
delete exactOpenRow.completed;
exactOpenRow.item.cancelled = true;
assert.equal(openShortageRowForInvoiceItem(invoice, item), null, "cancelled rows must not remain actionable");

console.log("Shortage order detail exposes exact-row completion actions and keeps same-order context: passed");
