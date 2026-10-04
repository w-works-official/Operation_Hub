import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../tools/sellpia_memo_updater_0707_stockmatch.html", import.meta.url),
  "utf8",
);

assert.match(source, /if \(task\.ordNo\) return ord === task\.ordNo;/);
assert.match(source, /const ord = rowSourceOrdNo\(item\);/);
assert.match(source, /const matchedGridRows = exactOrderRows\.length/);
assert.match(source, /return await buildTasksForOrderTargets\(gridTargets\);/);
assert.match(source, /return await buildTasksForOrderTargets\(dbTargets\);/);
assert.match(source, /testLogSummary\(rowResult\)/);

const helperStart = source.indexOf("function rowOrdNo");
const helperEnd = source.indexOf("\n    function rowsForTask", helperStart);
assert.notEqual(helperStart, -1);
assert.notEqual(helperEnd, -1);
const helperSource = source.slice(helperStart, helperEnd);
const normal = (value) => String(value ?? "").trim();
const { rowSourceOrdNo, sourceOrderNoFromItemNo } = new Function(
  "normal",
  `${helperSource}; return { rowSourceOrdNo, sourceOrderNoFromItemNo };`,
)(normal);

const representativeOrder = "20260810130138-33350310459";
const combinedSourceOrder = "20260810101631-28611767105";
const gridRows = [
  { c_ord_no: representativeOrder, c_delinum: "6890162126199", sellpia_order_item_no: `${representativeOrder}_[1]` },
  { c_ord_no: representativeOrder, c_delinum: "6890162126199", sellpia_order_item_no: `${representativeOrder}_[2]` },
  { c_ord_no: representativeOrder, c_delinum: "6890162126199", sellpia_order_item_no: `${combinedSourceOrder}_[1]` },
  { c_ord_no: representativeOrder, c_delinum: "6890162126199", sellpia_order_item_no: `${combinedSourceOrder}_[2]` },
  { c_ord_no: representativeOrder, c_delinum: "6890162126199", sellpia_order_item_no: `${combinedSourceOrder}_[3]` },
];
const orderTargets = [...new Set(gridRows.map(rowSourceOrdNo))];
assert.deepEqual(orderTargets, [representativeOrder, combinedSourceOrder]);

const rowsForTask = (task) => gridRows.filter((row) => (
  task.ordNo ? rowSourceOrdNo(row) === task.ordNo : row.c_delinum === task.invNo
));
assert.equal(rowsForTask({ ordNo: representativeOrder, invNo: "6890162126199" }).length, 2);
assert.equal(rowsForTask({ ordNo: combinedSourceOrder, invNo: "6890162126199" }).length, 3);

assert.equal(sourceOrderNoFromItemNo(`${combinedSourceOrder}_[3]`), combinedSourceOrder);
assert.equal(sourceOrderNoFromItemNo("ABC_[1]"), "");
assert.equal(rowSourceOrdNo({ c_ord_no: "ordinary-order", sellpia_order_item_no: "plain-item" }), "ordinary-order");

const logHelperStart = source.indexOf("function testLogSummary");
const logHelperEnd = source.indexOf("\n    async function setPopupValues", logHelperStart);
assert.notEqual(logHelperStart, -1);
assert.notEqual(logHelperEnd, -1);
const logHelperSource = source.slice(logHelperStart, logHelperEnd);
const { testLogSummary } = new Function(`${logHelperSource}; return { testLogSummary };`)();
assert.equal(testLogSummary({ liveWriteAllowed: "Y", actionSummary: "변경 없음" }), "변경 없음");
assert.equal(
  testLogSummary({ liveWriteAllowed: "N", currentStateWarning: "item_key_match_failed" }),
  "차단: live_write_allowed=N / item_key_match_failed",
);
assert.equal(
  testLogSummary({ liveWriteAllowed: "REVIEW", currentStateWarning: "shipping_hold_unknown" }),
  "검토 필요: live_write_allowed=REVIEW / shipping_hold_unknown",
);

console.log("Updater combined-invoice order scoping: passed");
