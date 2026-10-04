import assert from "node:assert/strict";
import { preferredPickingRow } from "../src/domain/pickingPersistence.mjs";
import { buildPickingViewModel } from "../src/workflows/picking/buildPickingViewModel.mjs";

const blankInvoiceRow = {
  id: 149890,
  inv_no: "",
  ord_no: "order-1",
  item_no: "item-6",
  drawer_no: "273",
  is_checked: false,
};
const currentInvoiceRow = {
  id: 150060,
  inv_no: "invoice-1",
  ord_no: "order-1",
  item_no: "item-6",
  drawer_no: "271",
  is_checked: true,
};

assert.equal(
  preferredPickingRow([blankInvoiceRow, currentInvoiceRow], "invoice-1")?.id,
  150060,
  "saving must reuse the exact current-invoice row",
);
assert.equal(
  preferredPickingRow([blankInvoiceRow], "invoice-1")?.id,
  149890,
  "saving must reuse a legacy blank-invoice row instead of inserting a duplicate",
);
assert.equal(
  preferredPickingRow([blankInvoiceRow, currentInvoiceRow])?.id,
  150060,
  "loading must prefer an invoiced row over a stale blank-invoice duplicate",
);

const model = buildPickingViewModel({
  orders: [{ ord_no: "order-1", inv_no: "invoice-1" }],
  orderItems: [{ ord_no: "order-1", inv_no: "invoice-1", item_no: "item-6" }],
  pickingRows: [currentInvoiceRow, blankInvoiceRow],
});
assert.equal(model.invoices[0].items[0].pickingState.raw.id, 150060);
assert.equal(model.invoices[0].items[0].pickingState.drawerMemo, "271");
assert.equal(model.invoices[0].items[0].pickingState.isPicked, true);

console.log("Picking persistence duplicate-row regression: passed");
