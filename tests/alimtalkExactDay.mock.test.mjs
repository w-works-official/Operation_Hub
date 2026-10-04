import assert from "node:assert/strict";
import { alimtalkElapsedLabel, alimtalkSendLogAnchor, alimtalkSendLogCode, alimtalkSendNaturalKey, appendAlimtalkSendLog, formatAlimtalkInboundExpectedDate, hasTomorrowShippingManagementMemo, normalizeAlimtalkSendLog, parseAlimtalkSendLog, resolveAlimtalkTemplate } from "../src/domain/alimtalk.mjs";

const normal = (elapsedDays, selectedTemplate = "") => resolveAlimtalkTemplate({ elapsedDays, selectedTemplate });
const gold = (elapsedDays) => resolveAlimtalkTemplate({ elapsedDays, isGold: true });

assert.equal(normal(0).templateKey, "d1");
assert.equal(resolveAlimtalkTemplate({ elapsedDays: 0, isTomorrowShipping: true }).templateKey, "d0");
assert.equal(resolveAlimtalkTemplate({ elapsedDays: 7, isTomorrowShipping: true }).templateKey, "d0");
assert.equal(resolveAlimtalkTemplate({ elapsedDays: 0, isReady: true }).templateKey, "d1");
assert.equal(hasTomorrowShippingManagementMemo("내일 출고"), false);
assert.equal(hasTomorrowShippingManagementMemo(".."), true);
assert.equal(hasTomorrowShippingManagementMemo("  ..  "), true);
assert.equal(hasTomorrowShippingManagementMemo("  !!  "), true);
assert.equal(hasTomorrowShippingManagementMemo("메모 .."), false);
assert.equal(hasTomorrowShippingManagementMemo("!! 확인"), false);
assert.equal(hasTomorrowShippingManagementMemo("!"), false);
assert.equal(hasTomorrowShippingManagementMemo("   "), false);
assert.equal(hasTomorrowShippingManagementMemo(null), false);
assert.equal(normal(2).templateKey, "d3_pf");
assert.equal(resolveAlimtalkTemplate({ elapsedDays: 2, isMakeshop: true }).templateKey, "d3_ms");
assert.equal(normal(4).templateKey, "");
assert.deepEqual(normal(4).allowedTemplateKeys, ["d5_hi", "d5_lo"]);
assert.equal(normal(4).selectionRequired, true);
assert.equal(normal(4).label, "5일차 · 템플릿 선택 필요");
assert.equal(normal(4, "d5_hi").templateKey, "d5_hi");
assert.equal(normal(4, "d5_lo").templateKey, "d5_lo");
assert.equal(normal(4, "d1").templateKey, "d1");
assert.equal(normal(9).templateKey, "d10");

for (const days of [1, 3, 5, 6, 7, 8, 10, 11, 24]) {
  assert.equal(normal(days).templateKey, "", `${days}일차 must not inherit another day template`);
}
assert.equal(normal(10).label, "11일차 이후 · 템플릿 없음");
assert.equal(alimtalkElapsedLabel(11), "11일차 이후");
assert.equal(gold(0).templateKey, "14k_1");
assert.equal(gold(4).templateKey, "14k_5");
assert.equal(gold(3).templateKey, "");
assert.equal(alimtalkSendNaturalKey("order-1", "d1"), alimtalkSendNaturalKey(" order-1 ", "d1"));
assert.notEqual(alimtalkSendNaturalKey("order-1", "d1"), alimtalkSendNaturalKey("order-1", "d3_pf"));

assert.equal(alimtalkSendLogCode("d0"), "0");
assert.equal(alimtalkSendLogCode("d1"), "1");
assert.equal(alimtalkSendLogCode("14k_1"), "1_14");
assert.equal(alimtalkSendLogCode("d3_pf"), "3");
assert.equal(alimtalkSendLogCode("d3_ms"), "3ㅁ");
assert.equal(alimtalkSendLogCode("d5_hi"), "5ㅂ");
assert.equal(alimtalkSendLogCode("d5_lo"), "5ㅊ");
assert.equal(alimtalkSendLogCode("14k_5"), "5_14k");
assert.equal(alimtalkSendLogCode("d10"), "10");
assert.equal(alimtalkSendLogCode("manual"), "ㅂㅂ");
assert.equal(appendAlimtalkSendLog("1\n3", "5ㅂ"), "1,3,5ㅂ");
assert.equal(appendAlimtalkSendLog("1, 3, 5ㅂ", "10"), "1,3,5ㅂ,10");
assert.equal(appendAlimtalkSendLog("1", "1"), "1,1");
assert.equal(appendAlimtalkSendLog("1,3\n08/01", "5ㅂ", "2026-08-04"), "1,3,5ㅂ\n08/04");
assert.equal(normalizeAlimtalkSendLog("1, 3\n08/01", "2026-08-04"), "1,3\n08/04");
assert.deepEqual(parseAlimtalkSendLog("1,3\n12/31", { referenceDate: "2027-01-02" }), {
  codes: ["1", "3"],
  dateText: "12/31",
  dateKey: "2026-12-31",
});
assert.deepEqual(alimtalkSendLogAnchor("1,3ㅁ\n08/04", { referenceDate: "2026-08-06" }), {
  codes: ["1", "3ㅁ"],
  dateText: "08/04",
  dateKey: "2026-08-04",
  code: "3ㅁ",
  day: 3,
  templateKey: "d3_ms",
  hasAnchor: true,
});
assert.equal(alimtalkSendLogAnchor("1_14\n08/04", { isGold: true, referenceDate: "2026-08-04" }).day, 1);
assert.equal(alimtalkSendLogAnchor("5ㅂ\n08/04", { referenceDate: "2026-08-04" }).templateKey, "d5_hi");
assert.equal(alimtalkSendLogAnchor("5ㅊ\n08/04", { referenceDate: "2026-08-04" }).templateKey, "d5_lo");
assert.equal(alimtalkSendLogAnchor("1\n08/04", { isGold: true, referenceDate: "2026-08-04" }).hasAnchor, false);
assert.equal(alimtalkSendLogAnchor("1,3", { referenceDate: "2026-08-04" }).hasAnchor, false);
assert.equal(formatAlimtalkInboundExpectedDate("2026-08-03"), "(입고예정일 : 08-03)");
assert.equal(formatAlimtalkInboundExpectedDate("2026. 8. 3."), "(입고예정일 : 08-03)");
assert.equal(formatAlimtalkInboundExpectedDate(""), "");

console.log("Alimtalk exact-day rules: passed");
