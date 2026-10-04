import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/app/pickingApp.mjs", import.meta.url), "utf8");

assert.match(source, /shortageBulkSelectedKeys:\s*new Set\(\)/, "bulk selections must be explicit keys");
assert.match(
  source,
  /const selectedKeys = new Set\(state\.shortageBulkSelectedKeys\);[\s\S]*?shortageItems \|\| \[\]\)\.filter\(\(\{ invoice, item \}\) =>[\s\S]*?selectedKeys\.has\(workflowItemKey\(invoice, item\)\)/,
  "bulk completion must target only checked shortage rows",
);
assert.match(
  source,
  /window\.confirm\(`미송피킹 체크 내역 \$\{targets\.length\}건을 일괄 완료처리 하시겠습니까\?`\)/,
  "bulk completion must require a count-bearing confirmation",
);
assert.match(
  source,
  /for \(const row of targets\)[\s\S]*?await completeShortagePickingRow\(row, \{ render: false \}\)/,
  "checked rows must reuse the protected single-row completion transaction sequentially",
);
assert.match(
  source,
  /if \(!failedKeys\.length\)[\s\S]*?미송피킹 일괄완료:[\s\S]*?실패 항목은 체크 유지/,
  "the final result must distinguish success from retryable failures",
);

console.log("Checked-only shortage bulk completion requires confirmation and preserves failures: passed");
