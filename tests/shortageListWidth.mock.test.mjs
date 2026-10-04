import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../src/styles/picking.css", import.meta.url), "utf8");

assert.match(html, /id="shortage-panel"[\s\S]*?<div class="workflow-layout shortage-layout">/);
assert.match(css, /\.shortage-layout\s*\{\s*grid-template-columns:\s*424px minmax\(0, 1fr\);\s*\}/);
assert.match(
  css,
  /@media \(max-width: 720px\)[\s\S]*?\.shortage-layout,[\s\S]*?grid-template-columns:\s*1fr;/,
  "the wider shortage list must still collapse on narrow screens",
);

console.log("Shortage target list includes 40 pixels for the bulk-selection checkbox column: passed");
