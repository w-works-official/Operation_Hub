import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/app/pickingApp.mjs", import.meta.url), "utf8");

assert.match(app, /createOrderItemOperationsAdapter/);
assert.match(app, /orderItemOperations\.loadAllOperations\(\)/);
assert.match(app, /resolveEffectiveInboundExpectedDate/);
assert.match(app, /source === "legacy_sellpia"/);
assert.match(app, /기존 셀피아 출고확정일 값/);

const saveStart = app.indexOf("async function saveCsItemConfirmedDate");
const saveEnd = app.indexOf("async function recordAlimtalkSendScheduledDate", saveStart);
assert.ok(saveStart >= 0 && saveEnd > saveStart);
const saveSource = app.slice(saveStart, saveEnd);
assert.match(saveSource, /upsertOperationForCurrentOrderItem/);
assert.match(saveSource, /inbound_expected_source: "manual"/);
assert.match(saveSource, /inbound_expected_date: confirmedDate/);
assert.doesNotMatch(saveSource, /updateOrderItemOrderMemoExact/);
assert.doesNotMatch(saveSource, /sellpia_outbound_confirmed_date\s*=/);

console.log("csInboundOperationStorage.ui.test: OK");
