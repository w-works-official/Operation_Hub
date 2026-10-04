import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  CURRENT_SHORTAGE_EXPORT_HEADER,
  INVENTORY_SURVEY_EXPORT_HEADER,
  buildCurrentShortageExport,
  buildInventorySurveyExport,
  inventorySurveyOrderedQuantitiesBySku,
  inventorySurveyOwnCodesBySku,
} from "../src/domain/inventorySurveyExport.mjs";

const invoices = [
  {
    items: [
      { sellpiaProductCode: "1001-1", ownCode: "[BA-01]" },
      { sellpiaProductCode: "10005-1", ownCode: "[CA-02]" },
      { sellpiaProductCode: "1001-1", ownCode: "[BA-01]" },
    ],
  },
];

assert.deepEqual(inventorySurveyOwnCodesBySku(invoices), new Map([
  ["1001-1", "[BA-01]"],
  ["10005-1", "[CA-02]"],
]));

const result = buildInventorySurveyExport({
  invoices,
  currentItems: [
    { ord_no: "O-1", sellpia_order_item_no: "R-1", item_no: "1_R-1", p_code: "1001-1", prod_code: "[BA-01]", qty: 2 },
    { ord_no: "O-1", sellpia_order_item_no: "R-2", item_no: "2_R-2", p_code: "1001-1", prod_code: "[BA-01]", qty: 3 },
    { ord_no: "O-1", sellpia_order_item_no: "R-3", item_no: "3_R-3", p_code: "10005-1", prod_code: "[CA-02]", qty: 4 },
    { ord_no: "O-1", sellpia_order_item_no: "R-4", item_no: "4_R-4", p_code: "30000-1", prod_code: "[ORDER-ONLY]", qty: 5 },
    { ord_no: "O-1", sellpia_order_item_no: "R-5", item_no: "5_R-5", p_code: "40000-1", prod_code: "[CANCELLED]", qty: 6 },
  ],
  operations: [
    { operation_id: "op-1", ord_no: "O-1", sellpia_order_item_no: "R-1", item_no: "1_R-1", custom_ordered_on: "2026-10-01" },
    { operation_id: "op-2", ord_no: "O-1", sellpia_order_item_no: "R-2", item_no: "2_R-2", custom_received_on: "2026-10-01" },
    { operation_id: "op-3", ord_no: "O-1", sellpia_order_item_no: "R-3", item_no: "3_R-3", custom_required_at: "2026-10-01T01:00:00Z" },
    { operation_id: "op-4", ord_no: "O-1", sellpia_order_item_no: "R-4", item_no: "4_R-4", custom_ordered_on: "2026-10-01", inbound_expected_date: "2026-10-05" },
    { operation_id: "op-5", ord_no: "O-1", sellpia_order_item_no: "R-5", item_no: "5_R-5", custom_ordered_on: "2026-10-01", custom_cancelled_at: "2026-10-01T02:00:00Z" },
  ],
  countRows: [
    { sellpia_sku_code: "10005-1", picked_qty: 0, shortage_drawer_qty: 1, calculated_at: "2026-08-12T03:30:00Z" },
    { sellpia_sku_code: "1001-1", picked_qty: 2, shortage_drawer_qty: 0, calculated_at: "2026-08-12T03:30:00Z" },
    { sellpia_sku_code: "1001-1", picked_qty: 1, shortage_drawer_qty: 2, calculated_at: "2026-08-12T03:30:00Z" },
    { sellpia_sku_code: "9999-1", picked_qty: 0, shortage_drawer_qty: 0, calculated_at: "2026-08-12T03:30:00Z" },
    { sellpia_sku_code: "20000-1", own_code: "[SERVER-OWN]", picked_qty: 1, shortage_drawer_qty: 0, calculated_at: "2026-08-12T03:30:00Z" },
  ],
});

assert.deepEqual(result.rows[0], INVENTORY_SURVEY_EXPORT_HEADER);
assert.deepEqual(result.rows.slice(1).map((row) => [row[0], row[1], row[2], row[3], row[4], row[6]]), [
  ["1001-1", "[BA-01]", 3, 2, 5, 5],
  ["10005-1", "[CA-02]", 0, 1, 1, 0],
  ["20000-1", "[SERVER-OWN]", 1, 0, 1, 0],
  ["30000-1", "[ORDER-ONLY]", 0, 0, 0, 5],
]);
assert.equal(result.itemCount, 4);
assert.equal(result.pickedTotal, 4);
assert.equal(result.shortageDrawerTotal, 3);
assert.equal(result.orderedTotal, 10);
assert.equal(result.missingOwnCodeCount, 0);
assert.match(result.rows[1][5], /^2026-08-12 12:30:00$/);
assert.equal(result.rows.at(-1)[5], "");

const orderedBySku = inventorySurveyOrderedQuantitiesBySku({
  currentItems: [
    { ord_no: "O-2", sellpia_order_item_no: "SAME-1", item_no: "1_SAME-1", p_code: "5000-1", qty: 2 },
    { ord_no: "O-2", sellpia_order_item_no: "SAME-2", item_no: "2_SAME-2", p_code: "5000-1", qty: 7 },
  ],
  operations: [
    { operation_id: "same-1", ord_no: "O-2", sellpia_order_item_no: "SAME-1", item_no: "1_SAME-1", custom_ordered_on: "2026-10-01" },
  ],
});
assert.equal(orderedBySku.get("5000-1")?.quantity, 2, "same-SKU sibling rows must remain identity-scoped");

const shortageResult = buildCurrentShortageExport([
  { item: { sellpiaProductCode: "1001-1", ownCode: "[BA-01]" }, state: { shortageQty: 2 } },
  { item: { sellpiaProductCode: "1001-1", ownCode: "[BA-01]" }, state: { shortageQty: 1 } },
  { item: { sellpiaProductCode: "10005-1", ownCode: "[CA-02]" }, state: { shortageQty: 4 } },
  { item: { sellpiaProductCode: "", ownCode: "[NO-SKU]" }, state: { shortageQty: 1 } },
]);
assert.deepEqual(shortageResult.rows, [
  CURRENT_SHORTAGE_EXPORT_HEADER,
  ["1001-1", "[BA-01]", 3],
  ["10005-1", "[CA-02]", 4],
]);
assert.equal(shortageResult.itemCount, 2);
assert.equal(shortageResult.shortageTotal, 7);
assert.equal(shortageResult.skippedWithoutSku, 1);

const repoRoot = new URL("../", import.meta.url);
const [html, appSource] = await Promise.all([
  fs.readFile(new URL("index.html", repoRoot), "utf8"),
  fs.readFile(new URL("src/app/pickingApp.mjs", repoRoot), "utf8"),
]);
assert.match(html, /data-dashboard-action="inventory-count-export"[^>]*>재고반영 수량<\/button>/);
assert.match(appSource, /db\.rpc\("get_inventory_survey_live_counts"\)/);
assert.match(appSource, /db\.from\("orders"\)\.select\("ord_no"\)\.eq\("receipt_date", today\)/);
assert.match(appSource, /orderItemOperations\.loadOperationsForOrders\(orderNos\)/);
assert.match(appSource, /A1:G\$\{Math\.max\(1, inventoryRows\?\.length \|\| 1\)\}/);
assert.match(appSource, /재고반영_피킹미송_\$\{timestampForFilename\(\)\}\.xlsx/);
assert.match(appSource, /book_append_sheet\(workbook, shortageWorksheet, "현재 미송 상품"\)/);
assert.match(appSource, /button\.dataset\.dashboardAction === "inventory-count-export"/);

console.log("Inventory survey picking and shortage drawer export: passed");
