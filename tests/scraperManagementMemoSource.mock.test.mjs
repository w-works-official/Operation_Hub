import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(
  new URL("../tools/sellpia_scraper.html", import.meta.url),
  "utf8",
);

assert.match(
  html,
  /<title>0923 주문일 보강 패치<\/title>/,
  "the deployed scraper page must show the current release name",
);

assert.match(
  html,
  /o_shop_memo:cleanSellpiaManageMemo\(it\.c_shop_memo\),o_shop_memo2:cleanSellpiaManageMemo\(it\.c_shop_memo2\)/,
  "management memo1/2 must come directly from the current Sellpia row",
);
assert.doesNotMatch(
  html,
  /loadManagementMemoState|mergeManagementMemoState|management memo preserve/,
  "the scraper must not restore management memo1/2 from the previous DB rows",
);
assert.match(
  html,
  /function sellpiaOutboundScheduledHistory/,
  "outbound scheduled-date scraping must remain installed",
);
assert.match(
  html,
  /function sellpiaOutboundConfirmedDate/,
  "outbound confirmed-date scraping must remain installed",
);

console.log("scraper management memo source regression test passed");
