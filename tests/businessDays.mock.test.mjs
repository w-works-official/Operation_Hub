import assert from "node:assert/strict";
import { businessDayDateKey, receiptBusinessDayKeys, receiptBusinessDaysSince } from "../src/domain/businessDays.mjs";

const receiptDates = receiptBusinessDayKeys([
  { receipt_date: "2026-07-24" },
  { receipt_date: "2026-07-27" },
  { receipt_date: "2026-07-28" },
  { receipt_date: "2026-07-28" },
]);

// 7/24 is day zero. The weekend has no receipts, so 7/27 and 7/28 are days 1 and 2.
assert.equal(receiptBusinessDaysSince("2026-07-24", receiptDates, "2026-07-28"), 2);
assert.equal(receiptBusinessDaysSince("2026-07-27", receiptDates, "2026-07-28"), 1);
assert.equal(receiptBusinessDaysSince("2026-07-28", receiptDates, "2026-07-28"), 0);
assert.equal(receiptBusinessDaysSince("2026-07-23", receiptDates, "2026-07-28"), 3);
assert.equal(receiptBusinessDaysSince("2026-07-24", new Set(["2026-07-27"]), "2026-07-28"), 1);
assert.equal(businessDayDateKey("2026-07-28T11:12:13+09:00"), "2026-07-28");
assert.equal(businessDayDateKey("not-a-date"), "");

console.log("Receipt-date business-day calendar: passed");
