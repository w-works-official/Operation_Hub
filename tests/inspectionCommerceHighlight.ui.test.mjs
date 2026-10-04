import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/app/pickingApp.mjs", import.meta.url), "utf8");
const css = await readFile(new URL("../src/styles/picking.css", import.meta.url), "utf8");

const inspectionStart = app.indexOf("function renderInspectionPanels");
const inspectionEnd = app.indexOf("function csRowKey", inspectionStart);
const inspectionSource = app.slice(inspectionStart, inspectionEnd);

assert.match(inspectionSource, /inspection-commerce-summary/);
assert.match(inspectionSource, /inspection-seller-badge/);
assert.match(inspectionSource, /renderInspectionTotalAmountBadge\(selected\)/);
assert.equal(
  (inspectionSource.match(/renderInspectionTotalAmountBadge\(selected\)/g) || []).length,
  1,
  "the highlighted total must not remain duplicated in the drawer row",
);
assert.match(app, /invoice-badge inspection-total-amount/);
assert.match(css, /\.inspection-commerce-summary \.inspection-seller-badge/);
assert.match(css, /\.inspection-commerce-summary \.inspection-seller-badge\.seller-ably[\s\S]*?background:\s*#fff4a8/i);
assert.match(css, /\.inspection-commerce-summary \.inspection-total-amount[\s\S]*?background:\s*#e7f1ff/i);
const globalAblyRule = css.match(/(?:^|\n)\.seller-ably\s*\{([^}]*)\}/i)?.[1] || "";
assert.doesNotMatch(globalAblyRule, /#fff4a8/i, "the large pastel override must stay scoped to the inspection header");

console.log("inspectionCommerceHighlight.ui.test: OK");
