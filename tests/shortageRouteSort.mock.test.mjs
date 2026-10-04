import assert from "node:assert/strict";
import fs from "node:fs";
import { comparePickingRowsByRoute } from "../src/domain/pickingRowSort.mjs";

const source = fs.readFileSync(new URL("../src/app/pickingApp.mjs", import.meta.url), "utf8");
const shortageComparatorStart = source.indexOf("function compareShortageRowsByPickingRoute");
const shortageComparatorEnd = source.indexOf("function sortPickingRows", shortageComparatorStart);
const shortageComparatorSource = source.slice(shortageComparatorStart, shortageComparatorEnd);
const routeOrderMatch = source.match(/const EXPORT_ROUTE_ORDER = \[([\s\S]*?)\];/);
assert.ok(routeOrderMatch, "the picking route order must remain available");
const routeOrder = [...routeOrderMatch[1].matchAll(/"([A-Z]+)"/g)].map((match) => match[1]);
const routeByCode = new Map([
  ["[CA-10-01]", "CA"],
  ["[P] T-14-02 ]", "PT"],
  ["[P] T-02-01 ]", "PT"],
  ["[P] S-01-01 ]", "PS"],
  ["[P] A-01-01 ]", "PA"],
  ["[EA-01-01]", "EA"],
  ["[BA-01-01]", "BA"],
]);
const compareRouteCode = (a, b) => {
  const routeCompare = routeOrder.indexOf(routeByCode.get(a)) - routeOrder.indexOf(routeByCode.get(b));
  return routeCompare || String(a).localeCompare(String(b), "en", { numeric: true, sensitivity: "base" });
};
const invoiceSequenceNo = (invoice) => invoice.sequence;
const compareInvoiceItems = () => 0;
const rows = [...routeByCode.keys()].map((ownCode, index) => ({
  invoice: { orderGroupNo: String(index + 1), sequence: routeByCode.size - index },
  item: { ownCode },
}));

const sorted = rows.sort((a, b) =>
  comparePickingRowsByRoute(a, b, { compareRouteCode, invoiceSequenceNo, compareInvoiceItems }),
);

assert.deepEqual(
  sorted.map((row) => row.item.ownCode),
  ["[CA-10-01]", "[P] T-02-01 ]", "[P] T-14-02 ]", "[P] S-01-01 ]", "[P] A-01-01 ]", "[EA-01-01]", "[BA-01-01]"],
);
assert.match(
  shortageComparatorSource,
  /function compareShortageRowsByPickingRoute\(a, b\) \{[\s\S]*?const routeCompare = compareShortageRouteCode\(aCode, bCode\);[\s\S]*?if \(routeCompare\) return routeCompare;[\s\S]*?return compareShortageRowsByReceiptDate\(a, b\);/,
  "shortage code sorting must use the picking route first and oldest receipt date within the same own code",
);

const compareShortageRowsByPickingRoute = Function(
  "compareShortageRouteCode",
  "compareShortageRowsByReceiptDate",
  `"use strict"; ${shortageComparatorSource}; return compareShortageRowsByPickingRoute;`,
)(
  (a, b) => ["[CA-10-01]", "[EA-01-01]"].indexOf(a) - ["[CA-10-01]", "[EA-01-01]"].indexOf(b),
  (a, b) => String(a.invoice.receiptDate).localeCompare(String(b.invoice.receiptDate)),
);
const sameCodeRows = [
  { invoice: { receiptDate: "2026-08-10" }, item: { ownCode: "[CA-10-01]" } },
  { invoice: { receiptDate: "2026-08-07" }, item: { ownCode: "[CA-10-01]" } },
  { invoice: { receiptDate: "2026-08-06" }, item: { ownCode: "[EA-01-01]" } },
];
assert.deepEqual(
  sameCodeRows.sort(compareShortageRowsByPickingRoute).map((row) => `${row.item.ownCode}:${row.invoice.receiptDate}`),
  ["[CA-10-01]:2026-08-07", "[CA-10-01]:2026-08-10", "[EA-01-01]:2026-08-06"],
  "route order stays primary while the oldest receipt date wins within one own code",
);
assert.match(
  source,
  /state\.shortageFilter === "code"[\s\S]*?rows = \[\.\.\.rows\]\.sort\(compareShortageRowsByPickingRoute\)/,
  "the own-code shortage view must use the shared picking route flow",
);

console.log("Shortage own-code groups follow the picking route and oldest-delay order: passed");
