import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/app/pickingApp.mjs", import.meta.url), "utf8");
const shortageRowSource = source.match(/function renderShortageRow\([\s\S]*?\n\}/)?.[0] || "";

assert.match(
  shortageRowSource,
  /const drawerNo = drawerMemoForShortageRow\(\{ invoice, item, state: itemState \}\)/,
  "shortage rows must use their invoice-wide drawer memo",
);
assert.match(shortageRowSource, /const drawerOrderLabel = `\$\{drawerNo \|\| "미입력"\}-\$\{orderNo\}`/);
assert.match(shortageRowSource, /title="서랍번호-상품순서">\$\{escapeHtml\(drawerOrderLabel\)\}/);
assert.doesNotMatch(shortageRowSource, /상품순서 \$\{orderNo\}번/);

console.log("Shortage badge displays drawer number and numeric item order: passed");
