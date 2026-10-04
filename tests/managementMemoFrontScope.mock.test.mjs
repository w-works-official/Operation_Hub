import assert from "node:assert/strict";
import fs from "node:fs";

const appSource = fs.readFileSync(new URL("../src/app/pickingApp.mjs", import.meta.url), "utf8");

function functionSlice(name, nextName) {
  const start = appSource.indexOf(`async function ${name}`);
  const end = appSource.indexOf(`\n${nextName}`, start);
  assert.ok(start >= 0 && end > start, `${name} source must exist`);
  return appSource.slice(start, end);
}

const shortageSave = functionSlice("saveSelectedShortageMemo", "function findInspectionInvoiceItem");
assert.match(shortageSave, /await saveDrawerForInvoice\(row\.invoice, drawerMemo\)/);
assert.match(shortageSave, /updateOrderItemMemoFields\([^;]+\{ o_shop_memo2: memo \}/s);
assert.doesNotMatch(shortageSave, /\{ o_shop_memo: drawerMemo, o_shop_memo2: memo \}/);

const csSave = functionSlice("saveCsManagementFields", "async function saveCsCaseOrderMemo");
assert.match(csSave, /const shipmentInvoice = shipmentScopeForInvoice\(invoice\)/);
assert.match(csSave, /await saveDrawerForInvoice\(shipmentInvoice, memo1\)/);
assert.match(csSave, /setShortageQty\(invoice\.orderGroupNo, item\.sellpiaItemNo, memo2/);
assert.match(csSave, /shippingHoldInvoice: shipmentInvoice/);
assert.doesNotMatch(csSave, /patch: \{ o_shop_memo2: memo2 \}/);
assert.doesNotMatch(csSave, /patch: \{ o_shop_memo: memo1 \}/);

console.log("Front invoice-wide management memo regression: passed");
