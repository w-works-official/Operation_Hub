import assert from "node:assert/strict";
import {
  automaticShipmentKey,
  combineInvoicesBySharedInvoice,
  sourceOrderGroupNo,
} from "../src/domain/shipmentGroups.mjs";

const invoices = [
  {
    orderGroupNo: "order-a",
    invoiceNo: "6890162126199",
    displayName: "이지민",
    seller: "makeshop",
    receiptDate: "2026-08-10",
    sortOrder: 3,
    items: [
      { sellpiaItemNo: "a-1", productName: "A1", sortOrder: 1 },
      { sellpiaItemNo: "a-2", productName: "A2", sortOrder: 2 },
    ],
  },
  {
    orderGroupNo: "order-b",
    invoiceNo: "6890162126199",
    displayName: "이지민",
    seller: "makeshop",
    receiptDate: "2026-08-10",
    sortOrder: 8,
    items: [
      { sellpiaItemNo: "b-1", productName: "B1", sortOrder: 1 },
      { sellpiaItemNo: "b-2", productName: "B2", sortOrder: 2 },
      { sellpiaItemNo: "b-3", productName: "B3", sortOrder: 3 },
    ],
  },
  { orderGroupNo: "order-c", invoiceNo: "invoice-c", items: [] },
  { orderGroupNo: "order-d", invoiceNo: "", items: [] },
];

const combined = combineInvoicesBySharedInvoice(invoices);
assert.equal(combined.length, 3, "two source orders sharing one invoice must render as one physical card");
assert.equal(combined[0].orderGroupNo, automaticShipmentKey("6890162126199"));
assert.equal(combined[0].invoiceNo, "6890162126199");
assert.equal(combined[0].shipmentGroup.automatic, true);
assert.equal(combined[0].shipmentGroup.members.length, 2);
assert.equal(combined[0].items.length, 5);
assert.deepEqual(combined[0].items.map((item) => item.sourceOrderGroupNo), [
  "order-a",
  "order-a",
  "order-b",
  "order-b",
  "order-b",
]);
assert.equal(sourceOrderGroupNo(combined[0], combined[0].items[4]), "order-b");
assert.equal(combined[1], invoices[2], "an unrelated invoice must remain untouched");
assert.equal(combined[2], invoices[3], "an empty invoice number must never auto-combine");
assert.equal(invoices[0].items[0].sourceOrderGroupNo, undefined, "source view models must not be mutated");

const sameOrderDuplicate = combineInvoicesBySharedInvoice([
  { orderGroupNo: "order-a", invoiceNo: "same", items: [] },
  { orderGroupNo: "order-a", invoiceNo: "same", items: [] },
]);
assert.equal(sameOrderDuplicate.length, 2, "duplicate rows from one order are not combined shipment orders");

console.log("Automatic shared-invoice shipment domain regression: passed");
