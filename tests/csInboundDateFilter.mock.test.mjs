import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/app/pickingApp.mjs", import.meta.url), "utf8");

assert.match(
  source,
  /csInboundDateFilter:\s*"all"/,
  "the CS screen must keep an independent inbound-date filter state",
);
assert.match(
  source,
  /data-cs-inbound-date-filter/,
  "the CS header must render the inbound-date collection filter",
);
assert.match(
  source,
  /if \(filter === "missing"\) return !date;[\s\S]*if \(filter === "overdue"\)[\s\S]*if \(filter === "today"\)[\s\S]*if \(filter === "tomorrow"\)[\s\S]*if \(filter === "week"\)/,
  "the filter must support missing, overdue, today, tomorrow, and this-week views",
);
assert.match(
  source,
  /if \(filter\.startsWith\("date:"\)\) return date === filter\.slice\(5\);/,
  "the filter must support an exact inbound date",
);
assert.match(
  source,
  /const matchedCaseRows = filteredCsCaseRows\(\{ includeInboundDate: false \}\);[\s\S]*expandedRows\.filter\(\(row\) => csInboundDateMatches\(row\)\)/,
  "the inbound-date filter must run after matched orders expand to all of their product rows",
);
assert.match(
  source,
  /caseRowsForMatchedOrders\(\{ includeInboundDate: false \}\)/,
  "header date counts must include non-CS sibling product rows shown in the order detail",
);
assert.match(
  source,
  /findOperationForCurrentItem\(item, state\.orderItemOperations\)[\s\S]*resolveEffectiveInboundExpectedDate/,
  "the CS date resolver must use the shared operation matcher and source-aware fallback resolver",
);
assert.match(
  source,
  /upsertOperationForCurrentOrderItem\(row\.item,[\s\S]*inbound_expected_date: confirmedDate,[\s\S]*inbound_expected_source: "manual"/,
  "a date entered or cleared in CS must persist as an authoritative manual operation override",
);
assert.match(
  source,
  /return normalizedCsInboundExpectedDate\(item\);/,
  "Alimtalk output must use the same inbound-date value as the CS filter",
);

console.log("CS inbound-date filter source: passed");
