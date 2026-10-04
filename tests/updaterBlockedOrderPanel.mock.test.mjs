import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../tools/sellpia_memo_updater_0707_stockmatch.html", import.meta.url),
  "utf8",
);

const helperStart = source.indexOf("const BLOCK_REASON_KO");
const helperEnd = source.indexOf("\n    function renderBlockedOrderPanel", helperStart);
assert.notEqual(helperStart, -1);
assert.notEqual(helperEnd, -1);

const normal = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const { koreanBlockReason, isBlockedResultForPanel, blockedOrderGroups } = new Function(
  "normal",
  "results",
  `${source.slice(helperStart, helperEnd)}; return { koreanBlockReason, isBlockedResultForPanel, blockedOrderGroups };`,
)(normal, []);

assert.equal(koreanBlockReason("item_key_match_failed"), "상품 식별키를 DB 상품과 매칭하지 못함");
assert.equal(
  koreanBlockReason("live_write_allowed=N / item_key_match_failed"),
  "실행 안전조건 미충족 / 상품 식별키를 DB 상품과 매칭하지 못함",
);
assert.equal(isBlockedResultForPanel({ needsChange: "SNAPSHOT", status: "DETAIL_FAIL" }), false);
assert.equal(isBlockedResultForPanel({ liveWriteAllowed: "Y", status: "OK" }), false);
assert.equal(isBlockedResultForPanel({ liveWriteAllowed: "N", status: "OK" }), true);

const groups = blockedOrderGroups([
  {
    invNo: "6890162126199",
    ordNo: "20260810101631-28611767105",
    liveWriteAllowed: "N",
    status: "OK",
    currentStateWarning: "item_key_match_failed",
  },
  {
    invNo: "6890162126199",
    ordNo: "20260810101631-28611767105",
    liveWriteAllowed: "N",
    status: "DETAIL_FAIL",
    currentStateWarning: "item_key_match_failed",
    reason: "detail_open_failed",
  },
  {
    invNo: "7777777777777",
    ordNo: "20260811123456-12345678901",
    liveWriteAllowed: "REVIEW",
    status: "REVIEW_SKIP",
    currentStateWarning: "shipping_hold_unknown",
  },
  {
    invNo: "8888888888888",
    ordNo: "20260811111111-11111111111",
    liveWriteAllowed: "Y",
    status: "OK",
  },
]);

assert.equal(groups.length, 2);
assert.equal(groups[0].rowCount, 2);
assert.deepEqual(groups[0].reasons, [
  "상품 식별키를 DB 상품과 매칭하지 못함",
  "상세 팝업 열기 실패",
  "셀피아 상세 팝업을 열지 못함",
]);
assert.deepEqual(groups[1].reasons, [
  "배송보류 변경 방향을 확정할 수 없음",
  "수동 확인이 필요하여 실행 보류",
]);

assert.match(source, /id="smu0707-blocked-panel"/);
assert.match(source, /차단 주문 ' \+ groups\.length \+ '건/);
assert.match(source, /renderBlockedOrderPanel\(\);/);
assert.match(source, /grid-template-columns:minmax\(0,1\.35fr\) minmax\(270px,\.65fr\)/);

console.log("Updater blocked-order Korean side panel contract: passed");
