import assert from "node:assert/strict";
import {
  CUSTOM_ORDER_STATUS,
  addCalendarDays,
  buildCustomOrderRows,
  buildInboundExpectedRows,
  canClearCustomRequired,
  customOrderDate,
  customOrderStatus,
  customOrderSuppliers,
  filterCustomOrderRows,
  filterInboundExpectedRows,
  sortInboundExpectedRows,
} from "../src/domain/customOrder.mjs";

const base = {
  custom_required_at: "2026-09-28T03:00:00Z",
  custom_ordered_on: null,
  custom_received_on: null,
  custom_cancelled_at: null,
  inbound_expected_date: null,
  inbound_expected_source: null,
  internal_memo: null,
};

assert.equal(customOrderStatus(base), CUSTOM_ORDER_STATUS.BEFORE_ORDER);
assert.equal(customOrderStatus({ ...base, custom_ordered_on: "2026-09-29" }), CUSTOM_ORDER_STATUS.ORDERED);
assert.equal(customOrderStatus({ ...base, custom_ordered_on: "2026-09-29", inbound_expected_date: "2026-10-03" }), CUSTOM_ORDER_STATUS.WAITING);
assert.equal(customOrderStatus({ ...base, custom_received_on: "2026-10-03" }), CUSTOM_ORDER_STATUS.RECEIVED);
assert.equal(customOrderStatus({ ...base, custom_received_on: "2026-10-03", custom_cancelled_at: "2026-10-01T01:00:00Z" }), CUSTOM_ORDER_STATUS.CANCELLED);
assert.equal(canClearCustomRequired(base), true);
assert.equal(addCalendarDays("2026-10-01", 14), "2026-10-15");
assert.equal(addCalendarDays("2026-12-25", 14), "2027-01-08");
for (const patch of [
  { custom_ordered_on: "2026-09-29" },
  { custom_received_on: "2026-10-03" },
  { custom_cancelled_at: "2026-10-01T01:00:00Z" },
  { internal_memo: "진행 메모" },
  { inbound_expected_source: "manual" },
]) assert.equal(canClearCustomRequired({ ...base, ...patch }), false);

const currentItems = [
  {
    ord_no: "O-1", sellpia_order_item_no: "R-1", item_no: "1_R-1",
    p_code: "SAME-SKU", p_dpcode: "OWN-1", p_name: "현재 상품 1", p_option: "실버",
    sellpia_supplier_cell_raw: "0-베니스톤 [ 28 ]", sellpia_outbound_confirmed_date: "2026-10-04",
  },
  {
    ord_no: "O-1", sellpia_order_item_no: "R-2", item_no: "2_R-2",
    p_code: "SAME-SKU", p_dpcode: "OWN-2", p_name: "현재 상품 2", p_option: "골드",
    sellpia_supplier_cell_raw: "0-세븐피어싱 [ 1 ]",
  },
];

const operations = [
  {
    ...base, operation_id: "before", ord_no: "O-1", sellpia_order_item_no: "R-1", item_no: "9_R-1",
    sellpia_product_code_snapshot: "OLD-1", product_name_snapshot: "예전 이름", supplier_cell_raw_snapshot: "예전 매입처",
    internal_memo: "급한 제작",
  },
  {
    ...base, operation_id: "sibling", ord_no: "O-1", sellpia_order_item_no: "R-2", item_no: "2_R-2",
    custom_ordered_on: "2026-09-29",
  },
  {
    ...base, operation_id: "missing", ord_no: "O-MISSING", sellpia_order_item_no: "R-M", item_no: "1_R-M",
    sellpia_product_code_snapshot: "SNAP-SKU", own_code_snapshot: "SNAP-OWN", product_name_snapshot: "스냅 상품",
    product_option_snapshot: "스냅 옵션", supplier_cell_raw_snapshot: "0-스냅매입처 [ 9 ]",
    custom_ordered_on: "2026-09-30", inbound_expected_date: "2026-10-05", inbound_expected_source: "sku_schedule",
  },
  {
    ...base, operation_id: "manual-clear", ord_no: "O-1", sellpia_order_item_no: "R-1", item_no: "1_R-1",
    custom_required_at: "2026-09-30T03:00:00Z", inbound_expected_source: "manual", inbound_expected_date: null,
  },
];

const rows = buildCustomOrderRows({ operations, currentItems });
assert.equal(rows.length, 4);
const first = rows.find((row) => row.operation.operation_id === "before");
assert.equal(first.display.productName, "현재 상품 1", "current source must beat snapshots");
assert.equal(first.display.supplierCellRaw, "0-베니스톤 [ 28 ]");
assert.equal(first.match.matchMethod, "regular", "item_no prefix changes must not break the primary key");
const sibling = rows.find((row) => row.operation.operation_id === "sibling");
assert.equal(sibling.display.ownCode, "OWN-2", "same-SKU sibling rows must remain independent");
const missing = rows.find((row) => row.operation.operation_id === "missing");
assert.equal(missing.sourceMissing, true);
assert.equal(missing.display.productName, "스냅 상품");
assert.equal(missing.display.supplierCellRaw, "0-스냅매입처 [ 9 ]");
const manualClear = rows.find((row) => row.operation.operation_id === "manual-clear");
assert.equal(manualClear.inbound.date, "", "manual + NULL must suppress the current Sellpia legacy date");
assert.equal(manualClear.inbound.explicitlyCleared, true);

const legacyRows = buildCustomOrderRows({ operations: [{ ...base, operation_id: "legacy", ord_no: "O-1", sellpia_order_item_no: "R-1", item_no: "1_R-1" }], currentItems });
assert.equal(legacyRows[0].inbound.date, "2026-10-04");
assert.equal(legacyRows[0].inbound.source, "legacy_sellpia");

const scheduledRows = buildCustomOrderRows({
  operations: [
    { ...base, operation_id: "scheduled", ord_no: "O-1", sellpia_order_item_no: "R-1", item_no: "1_R-1", custom_ordered_on: "2026-09-29" },
    { ...base, operation_id: "scheduled-clear", ord_no: "O-1", sellpia_order_item_no: "R-2", item_no: "2_R-2", custom_ordered_on: "2026-09-29", inbound_expected_source: "manual", inbound_expected_date: null },
  ],
  currentItems,
  skuSchedules: [{ sellpia_sku: "SAME-SKU", inbound_expected_date: "2026-10-07", own_code: "OWN-SCHEDULE" }],
});
assert.equal(scheduledRows[0].inbound.source, "sku_schedule");
assert.equal(scheduledRows[0].inbound.date, "2026-10-07");
assert.equal(scheduledRows[0].status, CUSTOM_ORDER_STATUS.WAITING, "SKU date must move an ordered row into the waiting detail status");
assert.equal(scheduledRows[1].inbound.date, "", "manual clear must suppress the shared SKU schedule");
assert.equal(scheduledRows[1].status, CUSTOM_ORDER_STATUS.ORDERED);

assert.deepEqual(filterCustomOrderRows(rows, { status: "active" }).map((row) => row.operation.operation_id).sort(), ["before", "manual-clear", "missing", "sibling"]);
assert.deepEqual(filterCustomOrderRows(rows, { status: "waiting" }).map((row) => row.operation.operation_id), ["missing"]);
assert.deepEqual(filterCustomOrderRows(rows, { supplier: "0-스냅매입처 [ 9 ]" }).map((row) => row.operation.operation_id), ["missing"]);
assert.deepEqual(filterCustomOrderRows(rows, { search: "SNAP-OWN" }).map((row) => row.operation.operation_id), ["missing"]);
assert.deepEqual(filterCustomOrderRows(rows, { search: "R-2" }).map((row) => row.operation.operation_id), ["sibling"]);
assert.deepEqual(filterCustomOrderRows(rows, { search: "급한 제작" }).map((row) => row.operation.operation_id), ["before"]);
assert.deepEqual(filterCustomOrderRows(rows, { dateCriterion: "ordered", dateFrom: "2026-09-30", dateTo: "2026-09-30" }).map((row) => row.operation.operation_id), ["missing"]);
assert.equal(customOrderDate(missing, "inbound"), "2026-10-05");
assert.equal(customOrderDate({ operation: { custom_required_at: "2026-10-01T16:00:00Z" } }, "required"), "2026-10-02", "registration filters must use the local business date");
assert.deepEqual(customOrderSuppliers(rows), ["0-베니스톤 [ 28 ]", "0-세븐피어싱 [ 1 ]", "0-스냅매입처 [ 9 ]"]);

const restored = buildCustomOrderRows({
  operations: [operations.find((row) => row.operation_id === "missing")],
  currentItems: [{
    ord_no: "O-MISSING", sellpia_order_item_no: "R-M", item_no: "1_R-M",
    p_code: "RETURNED", p_name: "돌아온 원천 상품", sellpia_supplier_cell_raw: "현재 매입처",
  }],
})[0];
assert.equal(restored.sourceMissing, false);
assert.equal(restored.display.productName, "돌아온 원천 상품");
assert.equal(restored.display.supplierCellRaw, "현재 매입처");

const inboundOperations = [
  {
    ...base, operation_id: "inbound-auto", ord_no: "O-MISSING", sellpia_order_item_no: "R-M", item_no: "1_R-M",
    inbound_expected_date: "2026-10-05", inbound_expected_source: "sku_schedule", internal_memo: "자동 일정 메모",
    product_name_snapshot: "스냅 상품", supplier_cell_raw_snapshot: "0-스냅매입처 [ 9 ]",
  },
  {
    ...base, operation_id: "inbound-clear", ord_no: "O-1", sellpia_order_item_no: "R-2", item_no: "2_R-2",
    inbound_expected_date: null, inbound_expected_source: "manual",
  },
];
const inboundRows = buildInboundExpectedRows({ operations: inboundOperations, currentItems });
assert.equal(inboundRows.length, 3, "legacy, automatic, and explicit-clear rows must share the inbound workspace");
assert.equal(inboundRows.find((row) => row.key === "O-1::R-1").inbound.source, "legacy_sellpia");
assert.equal(inboundRows.find((row) => row.operation?.operation_id === "inbound-auto").sourceMissing, true);
assert.equal(inboundRows.find((row) => row.operation?.operation_id === "inbound-clear").inbound.explicitlyCleared, true);
assert.deepEqual(filterInboundExpectedRows(inboundRows, { source: "legacy_sellpia" }).map((row) => row.key), ["O-1::R-1"]);
assert.deepEqual(filterInboundExpectedRows(inboundRows, { source: "cleared" }).map((row) => row.operation?.operation_id), ["inbound-clear"]);
assert.deepEqual(filterInboundExpectedRows(inboundRows, { search: "O-1" }).map((row) => row.key).sort(), ["O-1::R-1", "O-1::R-2"]);
assert.deepEqual(filterInboundExpectedRows(inboundRows, { dateFrom: "2026-10-05", dateTo: "2026-10-05" }).map((row) => row.operation?.operation_id), ["inbound-auto"]);
assert.deepEqual(sortInboundExpectedRows(inboundRows, "asc").map((row) => row.inbound.date), ["2026-10-04", "2026-10-05", ""]);
assert.deepEqual(sortInboundExpectedRows(inboundRows, "desc").map((row) => row.inbound.date), ["2026-10-05", "2026-10-04", ""]);

console.log("customOrderDomain.mock.test: OK");
