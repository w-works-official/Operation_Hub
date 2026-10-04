import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../tools/sellpia_scraper.html',import.meta.url),'utf8');
assert.ok(!html.includes('sellpia_received_at'),'Withdrawn timestamp collection must not return');
assert.ok(html.includes('0812-접수일 재동기화 오류 수정'),'Original scraper restored');
assert.ok(html.includes('applyExistingOrderReceiptBaselines'));
console.log('PASS: original date-only scraper restored; no timestamp collection');
