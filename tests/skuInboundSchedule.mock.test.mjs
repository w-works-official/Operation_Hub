import assert from "node:assert/strict";
import {
  SKU_INBOUND_SCHEDULE_HEADERS,
  buildSkuInboundScheduleMap,
  findSkuInboundSchedule,
  normalizeInboundExpectedDate,
  parseSkuInboundScheduleRows,
  skuInboundScheduleWorkbookRows,
} from "../src/domain/skuInboundSchedule.mjs";

assert.equal(normalizeInboundExpectedDate("2026-10-07"), "2026-10-07");
assert.equal(normalizeInboundExpectedDate("2026.10.7"), "2026-10-07");
assert.equal(normalizeInboundExpectedDate("2026-02-30"), "");
assert.equal(normalizeInboundExpectedDate(new Date("2026-10-07T12:00:00Z")), "2026-10-07");
assert.equal(normalizeInboundExpectedDate(46302), "2026-10-07", "Excel serial dates must be accepted");

const parsed = parseSkuInboundScheduleRows([
  ["셀피아 SKU", "입고예정일", "자사코드"],
  ["SKU-A", "2026/10/08", "OWN-A"],
  ["SKU-B", new Date("2026-10-09T12:00:00Z"), ""],
]);
assert.deepEqual(parsed.errors, []);
assert.deepEqual(parsed.rows, [
  { sellpia_sku: "SKU-A", inbound_expected_date: "2026-10-08", own_code: "OWN-A" },
  { sellpia_sku: "SKU-B", inbound_expected_date: "2026-10-09", own_code: null },
]);

const duplicate = parseSkuInboundScheduleRows([
  SKU_INBOUND_SCHEDULE_HEADERS,
  ["SKU-A", "2026-10-08", "OWN-A"],
  ["SKU-A", "2026-10-09", "OWN-B"],
  ["SKU-B", "not-a-date", "OWN-B"],
]);
assert.equal(duplicate.rows.length, 0);
assert.equal(duplicate.errors.length, 3);
assert.match(duplicate.errors.map((error) => error.message).join(" "), /중복/);
assert.match(duplicate.errors.map((error) => error.message).join(" "), /실제 날짜/);

const wrongHeader = parseSkuInboundScheduleRows([["SKU", "날짜", "자사코드"]]);
assert.equal(wrongHeader.rows.length, 0);
assert.equal(wrongHeader.errors.length, 1);

const exported = skuInboundScheduleWorkbookRows(parsed.rows);
assert.deepEqual(Object.keys(exported[0]), SKU_INBOUND_SCHEDULE_HEADERS);
assert.deepEqual(exported[0], {
  "셀피아 SKU": "SKU-A",
  "입고예정일": "2026-10-08",
  "자사코드": "OWN-A",
});

const map = buildSkuInboundScheduleMap(parsed.rows);
assert.equal(findSkuInboundSchedule("SKU-B", map)?.inbound_expected_date, "2026-10-09");
assert.equal(findSkuInboundSchedule({ p_code: "SKU-A" }, map)?.own_code, "OWN-A");
assert.equal(findSkuInboundSchedule("MISSING", map), null);

console.log("skuInboundSchedule.mock.test: OK");
