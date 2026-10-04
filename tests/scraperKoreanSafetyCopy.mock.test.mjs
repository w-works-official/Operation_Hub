import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(
  new URL("../tools/sellpia_scraper.html", import.meta.url),
  "utf8",
);
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
  (match) => match[1],
);
const elements = {
  "bookmarklet-link": { href: "" },
  "code-display": { textContent: "" },
};
const context = vm.createContext({
  document: { getElementById: (id) => elements[id] },
  console,
  encodeURIComponent,
});

for (const script of scripts) new vm.Script(script).runInContext(context);
const bookmarklet = elements["code-display"].textContent;

assert.doesNotThrow(
  () => new vm.Script(bookmarklet),
  "the assembled bookmarklet must remain valid JavaScript",
);
assert.match(bookmarklet, /0923 주문일 보강 패치/);
assert.match(
  bookmarklet,
  /전체 모드에서는 선택 기간의 기존 주문·상품 스크랩 데이터가/,
);
assert.match(bookmarklet, /특정 송장만 테스트\(선택\)/);
assert.match(
  bookmarklet,
  /if\(session==="ALL"&&!invFilter\)\{[\s\S]*?window\.confirm\("전체 수집을 실행하시겠습니까\?/,
  "only an unfiltered full scrape should enter the destructive confirmation branch",
);
assert.equal(
  (bookmarklet.match(/window\.confirm\(/g) || []).length,
  2,
  "full scrape and order-datetime enrichment must each confirm their own writes",
);
assert.match(
  bookmarklet,
  /특정 송장 입력: 해당 송장만 테스트\(다른 주문 정리 없음\)/,
);
assert.doesNotMatch(bookmarklet, /\?\?: \?\?\?\?\?/);
assert.doesNotMatch(bookmarklet, /\?\?\?\? cleanup/);
assert.doesNotMatch(bookmarklet, /\[SCRAPER\] \?\?/);
assert.match(
  bookmarklet,
  /if\(!totalRows\)\{setStatus\([\s\S]*?return;\}/,
  "an empty Sellpia grid must still stop before database writes and cleanup",
);
assert.match(
  bookmarklet,
  /applyExistingOrderReceiptBaselines/,
  "the safety-copy changes must retain the original receipt-date repair",
);

console.log("scraper Korean safety copy regression test passed");
