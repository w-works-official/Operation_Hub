import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/app/pickingApp.mjs", import.meta.url), "utf8");

const delayLabelSource = source.match(/function shortageDelayDisplayLabel\(invoice\) \{[\s\S]*?\n\}/)?.[0] || "";
assert.match(delayLabelSource, /receiptBusinessDaysSinceDateKey\(receiptDate\)/);
assert.match(delayLabelSource, /return `지연 \$\{receiptBusinessDaysSinceDateKey\(receiptDate\)\}일차`/);

const shortageRowSource = source.match(/function renderShortageRow\([\s\S]*?\n\}/)?.[0] || "";
assert.match(shortageRowSource, /const delayLabel = shortageDelayDisplayLabel\(invoice\)/);
assert.doesNotMatch(shortageRowSource, /shortageInvoiceDisplayLabel\(invoice\)/);
assert.match(shortageRowSource, /escapeHtml\(delayLabel\)/);

const inspectionLabelSource = source.match(/function invoicePrimaryWorkflowLabel\([\s\S]*?\n\}/)?.[0] || "";
assert.match(
  inspectionLabelSource,
  /const shortageLabel = shortageInvoiceDisplayLabel\(invoice\)/,
  "inspection must keep the existing receipt-date shortage sequence label",
);

console.log("Shortage-only delay label leaves inspection receipt sequence unchanged: passed");
