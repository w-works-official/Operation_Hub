import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const source = fs.readFileSync(new URL("../src/app/pickingApp.mjs", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../src/styles/picking.css", import.meta.url), "utf8");

assert.match(
  html,
  /class="workflow-list-head shortage-list-head"[\s\S]*?id="shortage-bulk-complete-btn"[\s\S]*?disabled>미송피킹 일괄완료<\/button>/,
  "the disabled bulk-complete placeholder must sit in the shortage list header",
);
assert.match(
  source,
  /<div class="shortage-row-shell">[\s\S]*?<label class="shortage-row-select"[\s\S]*?<input type="checkbox" data-shortage-select=[\s\S]*?<button class="workflow-row shortage-workflow-row/,
  "each shortage row must reserve a separate checkbox cell before the existing row button",
);
assert.match(
  css,
  /\.shortage-row-shell\s*\{[\s\S]*?grid-template-columns:\s*32px minmax\(0, 1fr\);/,
  "the checkbox cell must use the 8-pixel-based 32-pixel width",
);

console.log("Shortage bulk-selection controls keep their reserved layout: passed");
