import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, app, css] = await Promise.all([
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../src/app/pickingApp.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/styles/picking.css", import.meta.url), "utf8"),
]);

assert.doesNotMatch(html, /id="shipment-create-btn"/);
assert.doesNotMatch(html, /id="shipment-selection-count"/);
assert.match(app, /combineInvoicesBySharedInvoice\(inspectionBaseInvoices\(\)\)/);
assert.doesNotMatch(app, /data-shipment-select=/);
assert.doesNotMatch(app, /data-shipment-representative=/);
assert.doesNotMatch(app, /data-shipment-release=/);
assert.doesNotMatch(app, /createShipmentGroupAdapter|shipmentGroups\.(?:load|create|change|release|save)/);
assert.match(app, /셀피아 동일 송장 자동 인식/);
assert.match(app, /검품에서는 실제 포장 송장 1건으로 표시합니다/);
assert.match(app, /sourceInvoicesForShipment\(invoice\)/);
assert.match(app, /cs-source-order-section/);
assert.match(app, /합배송 \$\{group\.sourceOrderNos\.length\}주문 · 관리메모1·배송보류 송장 전체/);
assert.match(app, /selectedInspectionInvoice\(input\.dataset\.orderGroup\)/);
assert.match(app, /selectedCsWorkflowInvoice\(input\.dataset\.orderGroup\)/);
assert.match(app, /for \(const memberInvoice of sourceInvoices\)/);
assert.doesNotMatch(app, /invoice\?\.shipmentGroup \|\| itemIsEffectivelyCancelled/);
assert.match(css, /\.shipment-group-notice/);
assert.match(css, /\.cs-source-order-section/);
assert.doesNotMatch(app, /combined-preview-park-junghyun|COMBINED_PREVIEW|combinedPreview=1/);

console.log("Automatic shared-invoice shipment front contract: passed");
