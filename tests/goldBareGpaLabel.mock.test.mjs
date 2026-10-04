import assert from "node:assert/strict";
import fs from "node:fs";
import { isBareGpaOwnCode } from "../src/domain/gold.mjs";

const source = fs.readFileSync(new URL("../src/app/pickingApp.mjs", import.meta.url), "utf8");

function sourceBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  return start >= 0 && end > start ? source.slice(start, end) : "";
}

assert.equal(isBareGpaOwnCode("[GPA]"), true);
assert.equal(isBareGpaOwnCode(" [gpa] "), true);
assert.equal(isBareGpaOwnCode("[GPA-01]"), false);
assert.equal(isBareGpaOwnCode("[GPB]"), false);

const itemTargetSource = sourceBetween("function itemHasLabelTarget", "function invoiceHasLabelTarget");
assert.match(itemTargetSource, /if \(isBareGpaOwnCode\(ownCode\)\) return false;/);

const targetSource = sourceBetween("function getLabelTargetResult", "function isLabelTarget");
assert.match(targetSource, /if \(isBareGpaOwnCode\(raw\)\)/);
assert.match(targetSource, /addLabelSkip\(stats, "bareGpa"\)/);

const inspectionSequenceSource = sourceBetween("function inspectionLabelNumberMap", "function formatShortDate");
assert.match(inspectionSequenceSource, /getLabelTargetResult\(\{ privateCode: item\.ownCode \|\| "" \}, null\)/);

const exportSource = sourceBetween("function buildLabelCsvRows", "function downloadLabelCsv");
assert.match(exportSource, /const target = getLabelTargetResult\(row, stats\)/);

console.log("Bare [GPA] rows are excluded from gold label output and numbering: passed");
