import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/app/pickingApp.mjs", import.meta.url), "utf8");

function sourceSlice(startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, `${startText} source must exist`);
  return source.slice(start, end);
}

const groupedCsRowsSource = sourceSlice(
  "function groupedCsRows",
  "\nfunction manualCsRowsForMatchedOrders",
);
const csRowInvoiceNoSource = sourceSlice(
  "function csRowInvoiceNo",
  "\nfunction csSellerMeta",
);

{
  const state = { csSort: "receipt_desc" };
  const csRowOrderNo = (row) => row.order?.ord_no || "";
  const csRowInvoiceNo = new Function(`${csRowInvoiceNoSource}; return csRowInvoiceNo;`)();
  const groupedCsRows = new Function(
    "state",
    "csRowOrderNo",
    "csRowInvoiceNo",
    `${groupedCsRowsSource}; return groupedCsRows;`,
  )(state, csRowOrderNo, csRowInvoiceNo);
  const groups = groupedCsRows([
    { key: "item-a", order: { ord_no: "order-a", inv_no: "" } },
    { key: "item-b", order: { ord_no: "order-b", inv_no: "" } },
  ]);
  assert.equal(groups.length, 2, "송장번호가 없는 서로 다른 주문은 합배송으로 묶이지 않아야 한다");
  assert.ok(groups.every((group) => group.invoiceNo === ""));
}

const shipmentScopeSource = sourceSlice(
  "function shipmentScopeForInvoice",
  "\nasync function ensureShippingHoldOnForShipment",
);

{
  const first = { orderGroupNo: "order-a", invoiceNo: "invoice-1", items: [] };
  const second = { orderGroupNo: "order-b", invoiceNo: "invoice-1", items: [] };
  const combined = { orderGroupNo: "invoice:invoice-1", invoiceNo: "invoice-1", shipmentGroup: {}, sourceInvoices: [first, second] };
  const shipmentScopeForInvoice = new Function(
    "allWorkflowInvoices",
    "combineInvoicesBySharedInvoice",
    `${shipmentScopeSource}; return shipmentScopeForInvoice;`,
  )(
    () => [first, first, second],
    (invoices) => {
      assert.deepEqual(invoices, [first, second]);
      return [combined];
    },
  );
  assert.equal(shipmentScopeForInvoice(first), combined);
}

const toggleSource = sourceSlice(
  "async function toggleCsShippingHold",
  "\nfunction cancellationWarning",
);

{
  const first = { orderGroupNo: "order-a" };
  const second = { orderGroupNo: "order-b" };
  const combined = { orderGroupNo: "invoice:invoice-1", shipmentGroup: {}, sourceInvoices: [first, second] };
  const calls = [];
  const toasts = [];
  const toggleCsShippingHold = new Function(
    "allWorkflowInvoices",
    "selectedCsWorkflowInvoice",
    "shipmentScopeForInvoice",
    "toast",
    "workflowInvoiceState",
    "sourceInvoicesForShipment",
    "saveShippingHoldCurrentThenEvent",
    "renderWorkflowSurfaces",
    `${toggleSource}; return toggleCsShippingHold;`,
  )(
    () => [first, second],
    () => combined,
    (invoice) => invoice,
    (message) => toasts.push(message),
    () => ({ systemShippingHold: true }),
    (invoice) => invoice.sourceInvoices,
    async (invoice, status, sourceName, eventType, payload) => {
      calls.push({ invoice, status, sourceName, eventType, payload });
      return true;
    },
    () => calls.push({ type: "render" }),
  );

  await toggleCsShippingHold("order-a");
  assert.deepEqual(calls.slice(0, 2).map(({ invoice, status, eventType }) => ({ order: invoice.orderGroupNo, status, eventType })), [
    { order: "order-a", status: "OFF", eventType: "hold_released" },
    { order: "order-b", status: "OFF", eventType: "hold_released" },
  ]);
  assert.match(toasts.at(-1), /합배송 2주문 전체 배송보류/);
}

const csSaveSource = sourceSlice(
  "async function saveCsManagementFields",
  "\nasync function saveCsCaseOrderMemo",
);

{
  const item = { item_no: "item-1", o_shop_memo2: "", sellpiaItemNo: "item-1" };
  const row = { item };
  const invoice = { orderGroupNo: "order-a", invoiceNo: "invoice-1" };
  const combined = { orderGroupNo: "invoice:invoice-1", shipmentGroup: {}, sourceInvoices: [invoice] };
  const calls = [];
  const memo2Field = { value: "2" };
  const scope = {
    querySelector(selector) {
      return selector.includes("memo2") ? memo2Field : null;
    },
  };
  const saveCsManagementFields = new Function(
    "els",
    "allowWrites",
    "toast",
    "csItemIdentity",
    "findCsWorkflowItem",
    "shipmentScopeForInvoice",
    "saveDrawerForInvoice",
    "setShortageQty",
    "patchLocalItemManagementMemos",
    "renderCsPanels",
    `${csSaveSource}; return saveCsManagementFields;`,
  )(
    { csDetail: scope },
    true,
    () => undefined,
    () => ({ ordNo: "order-a", itemNo: "item-1", sellpiaOrderItemNo: "" }),
    () => ({ invoice, item }),
    () => combined,
    async () => undefined,
    async (orderGroupNo, sellpiaItemNo, memo2, options) => {
      calls.push({ orderGroupNo, sellpiaItemNo, memo2, options });
      return true;
    },
    () => undefined,
    () => undefined,
  );

  await saveCsManagementFields(row, scope);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    orderGroupNo: "order-a",
    sellpiaItemNo: "item-1",
    memo2: "2",
    options: { shippingHoldInvoice: combined, throwOnError: true },
  });
}

assert.match(source, /await ensureShippingHoldOnForShipment\(shippingHoldInvoice \|\| invoice, nextText\)/);
assert.match(source, /shortageEventType\(prev, next\)/);
assert.match(source, /saveWorkflowItemEvent\(invoice, item, eventType/);

console.log("CS shipment-wide hold and memo2 shortage workflow: passed");
