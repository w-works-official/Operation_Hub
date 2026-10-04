import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/app/pickingApp.mjs", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../src/styles/picking.css", import.meta.url), "utf8");

assert.match(
  source,
  /const orderMemoReadonly = allowWrites \? "" : "readonly";/,
  "CS order memo must remain editable for cancelled and automatic/virtual CS rows in write mode",
);
assert.match(
  styles,
  /\.is-cancelled input:not\(\[readonly\]\):not\(:disabled\)/,
  "editable fields on cancelled rows must retain an obvious input appearance",
);
assert.match(source, /const readonly = allowWrites && !virtualCase \? "" : "readonly";/);
assert.match(source, /const managementReadonly = allowWrites \? "" : "readonly";/);
assert.match(source, /const disabled = allowWrites \? "" : "disabled";/);
assert.doesNotMatch(
  source,
  /const (?:orderMemoReadonly|managementReadonly|disabled) = [^;]*cancellation\.cancelled/,
  "cancelled CS rows must not lock editable fields or save actions",
);
assert.match(source, /<span>주문메모<\/span>/, "CS item editor must label the field as 주문메모");
assert.doesNotMatch(source, /주문메모 \/ CS메모/, "legacy combined order/CS memo label must be removed");
assert.match(
  source,
  /return `\$\{year\.slice\(-2\)\}\/\$\{month\}\/\$\{day\}\/\$\{weekday\} \(영업일 기준 \$\{businessDay\}일차\)`;/,
  "basis date text must include YY/MM/DD, weekday, and the calculated business-day number",
);
assert.match(
  source,
  /<label><span>기준일<\/span><output class="cs-basis-date-display" data-cs-basis-date-text>/,
  "basis date text must preserve the existing label-and-field layout",
);
assert.doesNotMatch(source, /data-cs-case-field="basis_date" type="date"/, "basis date must no longer render as a date input");
assert.match(
  source,
  /current\.basis_date\s*\|\| current\.receipt_date\s*\|\| row\?\.order\?\.receipt_date/,
  "saving a CS case must preserve the stored basis date after removing the input",
);
assert.doesNotMatch(source, /CSV 발송확정/, "manual CSV send-confirm UI must be removed");
assert.match(
  source,
  /const syncedOrders = await recordAlimtalkSendScheduledDate\(batch\.id\);\s*await alimtalkSends\.confirmExportBatch\(batch\.id\);\s*downloadBlob/,
  "CSV export must record the send log and close the batch before download",
);
assert.doesNotMatch(
  source,
  /alimtalkTemplateFromSendLog|csOrderAlimtalkSendLog/,
  "obsolete send-log helper names must not be reintroduced",
);
assert.match(source, /function effectiveAlimtalkElapsedDays/, "template classification must support a dated send-log anchor");
assert.match(source, /anchor\.day - 1 \+ elapsedSinceAnchor/, "the next template day must continue from the logged day and date");
assert.match(source, /elapsedSinceAnchor === 0 \? anchor\.templateKey : ""/, "the exact logged template variant must be restored on its input date");
assert.match(source, /effective\.anchor\.hasAnchor \? effective\.selectedTemplate : caseRow\?\.alimtalk_template/, "a dated log must replace the previously stored template override");
assert.match(source, /normalizeAlimtalkSendLog\(value, todayDateString\(\)\)/, "manual log saves must stamp the final input date");
assert.match(source, /appendAlimtalkSendLog\(data\[0\]\.sellpia_outbound_scheduled_date, entry, todayDateString\(\)\)/, "CSV exports must stamp the final input date");
assert.match(source, /invoice\.raw\.sellpia_outbound_scheduled_date = nextValue/, "saved logs must update the live invoice model before the next CSV export");

console.log("CS quick fixes 1-3: passed");
