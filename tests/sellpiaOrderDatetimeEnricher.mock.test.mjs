import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const root = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const [scraper, adapter, app] = await Promise.all([
  read("tools/sellpia_scraper.html"),
  read("src/adapters/currentDbPickingAdapter.mjs"),
  read("src/app/pickingApp.mjs"),
]);

assert.match(scraper, /id="sp-order-datetime"/);
assert.match(scraper, /주문일시만 보강/);
assert.match(scraper, /0923 주문일 보강 패치/);
assert.match(scraper, /function enrichOrderDateTimes/);
assert.doesNotMatch(scraper, /loadCurrentSellpiaRowsForOrderDateTime/);
assert.match(scraper, /rows=await loadCurrentSellpiaRows\(targetDate,session,invFilter\)/);
assert.match(scraper, /c_ord_date/);
assert.match(scraper, /sellpia_ordered_at/);
assert.match(scraper, /await dbPatch\('orders'/);
assert.match(scraper, /await dbPatch\('order_items'/);
assert.match(scraper, /주문\/상품 수집·삭제, 배송보류, 피킹\/미송 상태/);
assert.match(scraper, /document\.getElementById\("sp-order-datetime"\)\.onclick/);

const scripts = [...scraper.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
const elements = new Map();
const getElementById = (id) => {
  if (!elements.has(id)) elements.set(id, { href: "", textContent: "" });
  return elements.get(id);
};
const context = vm.createContext({
  console: { error() {}, warn() {}, log() {} },
  document: { getElementById },
});
scripts.forEach((script) => vm.runInContext(script, context));
const generated = decodeURIComponent(getElementById("bookmarklet-link").href.replace(/^javascript:/, ""));
new Function(generated);
assert.match(generated, /id="sp-order-datetime"/);
assert.equal([...generated.matchAll(/function enrichOrderDateTimes\(/g)].length, 1);
assert.doesNotMatch(generated, /loadCurrentSellpiaRowsForOrderDateTime/);
assert.match(generated, /rows=await loadCurrentSellpiaRows\(targetDate,session,invFilter,endDate\)/);
assert.match(generated, /조회 접수기간: '\+targetDate/);
assert.match(generated, /var ed=document\.getElementById\("sp-date-end"\)\.value\|\|d/);
assert.match(generated, /await enrichOrderDateTimes\(d,session,invFilter,ed\)/);
assert.match(generated, /s\.value=targetDate;e\.value=endDate/);
assert.match(generated, /setSellpiaDateTypeToReceipt\(\)/);
assert.match(generated, /btn\.click\(\);await sleep\(1500\)/);
assert.match(generated, /currentRows\.every\(function\(row\)/);
assert.match(generated, /assertSellpiaReceiptDateInRange\(rows,targetDate,endDate\)/);
assert.match(generated, /document\.getElementById\("sp-order-datetime"\)\.onclick/);
assert.match(generated, /0923 주문일 보강 패치/);

const loaderStart = generated.indexOf("async function loadCurrentSellpiaRows(");
const loaderEnd = generated.indexOf("async function runInvoiceRefresh(", loaderStart);
assert.ok(loaderStart >= 0 && loaderEnd > loaderStart);
const pageInputs = new Map([
  ["search_date_s", { value: "", dispatchEvent() {} }],
  ["search_date_e", { value: "", dispatchEvent() {} }],
  ["btn_search", { click() { searchClicks++; } }],
]);
let searchClicks = 0;
let checkedRange;
const sellpiaRows = [
  { c_ord_no: "old", receipt: "2026-08-26", num: 1 },
  { c_ord_no: "recent", receipt: "2026-09-23", num: 2 },
];
const loaderContext = vm.createContext({
  GRID_WAIT_MS: 8000,
  document: {
    getElementById: (id) => pageInputs.get(id),
    querySelectorAll: () => [],
  },
  window: { grid: { getData: () => ({ getItems: () => sellpiaRows }) } },
  Event: class {},
  sleep: async () => {},
  setSellpiaDateTypeToReceipt: () => {},
  normalizeSellpiaDate: (value) => value,
  getSellpiaReceiptRaw: (row) => row.receipt,
  assertSellpiaReceiptDateInRange: (rows, start, end) => {
    checkedRange = [start, end];
    assert.ok(rows.every((row) => row.receipt >= start && row.receipt <= end));
  },
});
vm.runInContext(generated.slice(loaderStart, loaderEnd) + "\nglobalThis.loadRows=loadCurrentSellpiaRows;", loaderContext);
const rangeRows = await loaderContext.loadRows("2026-06-23", "ALL", "", "2026-09-23");
assert.equal(searchClicks, 1);
assert.equal(pageInputs.get("search_date_s").value, "2026-06-23");
assert.equal(pageInputs.get("search_date_e").value, "2026-09-23");
assert.deepEqual(checkedRange, ["2026-06-23", "2026-09-23"]);
assert.deepEqual(Array.from(rangeRows, (row) => row.c_ord_no), ["old", "recent"]);
sellpiaRows.splice(0, sellpiaRows.length, { c_ord_no: "recent", receipt: "2026-09-23", num: 1 });
await loaderContext.loadRows("2026-09-23", "ALL", "");
assert.equal(pageInputs.get("search_date_e").value, "2026-09-23");
assert.deepEqual(checkedRange, ["2026-09-23", "2026-09-23"]);

assert.match(adapter, /orderDateTime:\s*firstText\(order\.sellpia_ordered_at\)/);
assert.match(app, /function invoiceOrderDateTimeLabel/);
assert.match(app, /workflow-row-order-date/);
assert.match(app, /주문 \$\{escapeHtml\(selectedOrderDateTime\)\}/);

console.log("sellpiaOrderDatetimeEnricher.mock.test: OK");
