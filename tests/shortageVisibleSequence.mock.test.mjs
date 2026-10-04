import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/app/pickingApp.mjs", import.meta.url), "utf8");

assert.match(
  source,
  /const visibleSequenceByRow = new Map\(rows\.map\(\(row, index\) => \[row, index \+ 1\]\)\)/,
  "shortage display sequence must follow the final visible row order",
);
assert.match(
  source,
  /group\.rows\.map\(renderVisibleRow\)/,
  "own-code groups must keep the global visible sequence instead of restarting at one",
);
assert.match(
  source,
  /data-visible-sequence="\$\{visibleSequenceNo\}"/,
  "each rendered shortage row must expose its current visible sequence",
);

console.log("Shortage rows display the final sorted visible sequence: passed");
