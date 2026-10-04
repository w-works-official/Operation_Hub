import assert from "node:assert/strict";
import {
  INVOICE_EVENT,
  ITEM_EVENT,
  buildWorkflowState,
  openShortageItems,
  reduceInvoiceEvents,
  reduceItemEvents,
} from "../src/workflows/workflowEvents.mjs";

const shortageBeforeCancel = [
  { id: 1, event_at: "2026-07-31T00:00:00Z", event_type: ITEM_EVENT.SHORTAGE_CREATED, quantity: 2 },
  { id: 2, event_at: "2026-07-31T00:01:00Z", event_type: ITEM_EVENT.CANCELLED },
];
const cancelledItem = reduceItemEvents(shortageBeforeCancel);
assert.equal(cancelledItem.cancelled, true);
assert.equal(cancelledItem.shortageOpen, true);
assert.equal(cancelledItem.shortageQty, 2);

const reopenedItem = reduceItemEvents([
  ...shortageBeforeCancel,
  { id: 3, event_at: "2026-07-31T00:02:00Z", event_type: ITEM_EVENT.CANCEL_REOPENED },
]);
assert.equal(reopenedItem.cancelled, false);
assert.equal(reopenedItem.shortageOpen, true);
assert.equal(reopenedItem.shortageQty, 2);

const reopenedInvoice = reduceInvoiceEvents([
  { id: 1, event_at: "2026-07-31T00:00:00Z", event_type: INVOICE_EVENT.CANCELLED },
  { id: 2, event_at: "2026-07-31T00:01:00Z", event_type: INVOICE_EVENT.CANCEL_REOPENED },
]);
assert.equal(reopenedInvoice.cancelled, false);

const cancelledOrderModel = {
  invoices: [{
    orderGroupNo: "order-1",
    items: [{ sellpiaItemNo: "item-1" }],
  }],
};
const cancelledOrderState = buildWorkflowState({
  itemEvents: [{
    id: 1,
    order_group_no: "order-1",
    sellpia_item_no: "item-1",
    event_type: ITEM_EVENT.SHORTAGE_CREATED,
    quantity: 1,
  }],
  invoiceEvents: [{
    id: 2,
    order_group_no: "order-1",
    event_type: INVOICE_EVENT.CANCELLED,
  }],
});
assert.equal(openShortageItems(cancelledOrderModel, cancelledOrderState).length, 0);

console.log("Workflow cancellation and reopen regression: passed");
