import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(
  new URL("../tools/sellpia_scraper.html", import.meta.url),
  "utf8",
);

assert.match(
  html,
  /function loadExistingOrderReceiptBaselines\(ordNos\)/,
  "the scraper must load the stored order receipt baseline before overwriting an existing order",
);
assert.match(
  html,
  /order_items\?select=ord_no,ord_date,receipt_date/,
  "the baseline must also inspect older item rows when the order row was already overwritten by a resync",
);
assert.match(
  html,
  /itemDate<baselineDate/,
  "an older item receipt date must repair an already overwritten order receipt date",
);
assert.match(
  html,
  /previousDate<currentDate\|\|\(previousDate===currentDate&&orderReceiptSessionRank\(previousSession\)<=orderReceiptSessionRank\(currentSession\)\)/,
  "the earliest stored receipt date and session must win",
);
assert.match(
  html,
  /row\.receipt_date=previousDate;row\.ord_date=previousDate;row\.am_pm=previousSession/,
  "order-level receipt date and session must be restored together",
);
assert.match(
  html,
  /if\(Number\.isFinite\(previousSort\)\)row\.sort_order=previousSort/,
  "an existing order must keep its established sort order",
);
assert.match(
  html,
  /var scrapedOrdNosByDate=ordNosByReceiptDate\(itemRows\)/,
  "cleanup must stay based on the actually scraped item dates, not the restored order baseline",
);
assert.doesNotMatch(
  html,
  /itemRows\.forEach\([^)]*receipt_date=previousDate/,
  "item receipt dates must remain as Sellpia reported them for auditability",
);

console.log("scraper original receipt baseline regression test passed");
