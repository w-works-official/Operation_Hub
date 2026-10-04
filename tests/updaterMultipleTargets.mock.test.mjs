import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../tools/sellpia_memo_updater_0707_stockmatch.html", import.meta.url),
  "utf8",
);

const helperStart = source.indexOf("const normal =");
const helperEnd = source.indexOf("\n    const today", helperStart);
assert.notEqual(helperStart, -1);
assert.notEqual(helperEnd, -1);
const helperSource = source.slice(helperStart, helperEnd);
const { targetToken, targetTokens, targetRangeLabel } = new Function(
  `${helperSource}; return { targetToken, targetTokens, targetRangeLabel };`,
)();

const orderNo = "20260810101631-28611767105";
assert.equal(targetToken(orderNo), orderNo);
assert.deepEqual(
  targetTokens(`6890162126199\n${orderNo}, 6890162126199;7777777777777`),
  ["6890162126199", orderNo, "7777777777777"],
);
assert.equal(targetRangeLabel("6890162126199"), "개별 대상 1건");
assert.equal(targetRangeLabel("6890162126199\n7777777777777"), "입력 대상 2건");

const gridHelperStart = source.indexOf("function rowOrdNo");
const gridHelperEnd = source.indexOf("\n    function rowsForTask", gridHelperStart);
const normal = (value) => String(value ?? "").trim();
const { collectGridTargetsForInputs } = new Function(
  "normal",
  `${source.slice(gridHelperStart, gridHelperEnd)}; return { collectGridTargetsForInputs };`,
)(normal);
const firstOrder = "20260810130138-33350310459";
const secondOrder = "20260810101631-28611767105";
const sharedInvoice = "6890162126199";
const gridRows = [
  { item: { c_ord_no: firstOrder, c_delinum: sharedInvoice, sellpia_order_item_no: `${firstOrder}_[1]` } },
  { item: { c_ord_no: firstOrder, c_delinum: sharedInvoice, sellpia_order_item_no: `${secondOrder}_[1]` } },
];
const selection = collectGridTargetsForInputs([sharedInvoice, secondOrder, "7777777777777"], gridRows);
assert.deepEqual([...selection.matchedInputs], [sharedInvoice, secondOrder]);
assert.deepEqual([...new Set(selection.targets.map((row) => row.ordNo))], [firstOrder, secondOrder]);
assert.equal(selection.missingOrdRows, 0);

assert.match(source, /if \(requestedTargets\.length > 1\)/);
assert.match(source, /safeDbRequestIn\('orders', 'inv_no', unresolvedTargets/);
assert.match(source, /return \[\.\.\.tasks, \.\.\.skipped\];/);
assert.match(source, /<textarea id="smu0707-inv"/);
assert.match(source, /줄바꿈·쉼표·공백으로 여러 건 입력/);

console.log("Updater multiple target input and UI contract: passed");
