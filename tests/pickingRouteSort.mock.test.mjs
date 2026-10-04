import assert from "node:assert/strict";
import { comparePickingRowsByRoute } from "../src/domain/pickingRowSort.mjs";

const routeOrder = ["CA", "PT", "PP", "PF", "PA", "EE"];
const routeRank = (value) => routeOrder.indexOf(value);
const compareRouteCode = (a, b) => routeRank(a) - routeRank(b);
const invoiceSequenceNo = (invoice) => invoice.sequence;
const compareInvoiceItems = (a, b) => a.row - b.row;

const rows = [
  { invoice: { orderGroupNo: "21", sequence: 21 }, item: { ownCode: "EE", row: 1 } },
  { invoice: { orderGroupNo: "21", sequence: 21 }, item: { ownCode: "CA", row: 2 } },
  { invoice: { orderGroupNo: "22", sequence: 22 }, item: { ownCode: "PA", row: 1 } },
  { invoice: { orderGroupNo: "22", sequence: 22 }, item: { ownCode: "PT", row: 2 } },
  { invoice: { orderGroupNo: "23", sequence: 23 }, item: { ownCode: "PP", row: 1 } },
  { invoice: { orderGroupNo: "24", sequence: 24 }, item: { ownCode: "PF", row: 1 } },
];

const sorted = [...rows].sort((a, b) => comparePickingRowsByRoute(a, b, {
  compareRouteCode,
  invoiceSequenceNo,
  compareInvoiceItems,
}));

assert.deepEqual(sorted.map((row) => row.item.ownCode), routeOrder);
assert.equal(sorted[0].invoice.orderGroupNo, "21");
assert.equal(sorted[5].invoice.orderGroupNo, "21");

console.log("Picking rows use route order even within the same invoice: passed");
