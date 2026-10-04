import assert from "node:assert/strict";
import fs from "node:fs";

const appSource = fs.readFileSync(new URL("../src/app/pickingApp.mjs", import.meta.url), "utf8");
const cssSource = fs.readFileSync(new URL("../src/styles/picking.css", import.meta.url), "utf8");
const indexSource = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

function sourceBetween(startMarker, endMarker) {
  const start = appSource.indexOf(startMarker);
  const end = appSource.indexOf(endMarker, start + startMarker.length);
  return start >= 0 && end > start ? appSource.slice(start, end) : "";
}

assert.match(appSource, /selectedInspectionItemKey: ""/);
assert.match(appSource, /data-inspection-item-key="\$\{escapeHtml\(itemKey\)\}"/);
assert.match(appSource, /itemSelectable && itemKey === state\.selectedInspectionItemKey \? "is-selected" : ""/);

const selectableSource = sourceBetween("function inspectionItemIsSelectable", "function inspectionSelectableItems");
assert.match(selectableSource, /!invoiceState\?\.inspected/);
assert.match(selectableSource, /!invoiceState\?\.cancelled/);
assert.match(selectableSource, /!itemState\?\.inspected/);
assert.match(selectableSource, /!itemIsEffectivelyCancelled\(invoice, item\)/);

const bindingSource = sourceBetween("els.inspectionDetail?.addEventListener(\"click\"", "document.querySelectorAll(\"[data-completed-date-mode]\")");
assert.match(bindingSource, /event\.target\.closest\("\[data-inspection-item-key\]\.is-selectable"\)/);
assert.match(bindingSource, /selectInspectionItem\(itemRow\.dataset\.inspectionItemKey\)/);

const keyboardSource = sourceBetween("function onGlobalKeydown", "function bindEvents");
assert.match(keyboardSource, /ArrowLeft[\s\S]*?ArrowRight[\s\S]*?state\.activeTab === "inspection"[\s\S]*?moveInspectionItemSelection/);
assert.match(keyboardSource, /event\.key === "Tab" \|\| event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"/);
assert.match(keyboardSource, /\["shortage", "inspection", "cs", "completed"\]\.includes\(state\.activeTab\)\) moveWorkflowSelection\(delta\)/);
assert.match(keyboardSource, /event\.key === "Tab"/);

assert.match(cssSource, /\.inspection-item-table \.workflow-item-row\.is-selected[\s\S]*?outline: 3px solid rgba\(37, 99, 235, 0\.58\)/);
assert.match(indexSource, /상품행 클릭 · ←→ 상품 이동 · ↑↓ 송장 이동/);

console.log("Inspection work rows support blue selection and arrow-key navigation: passed");
