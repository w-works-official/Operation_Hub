import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const scraper = await readFile(new URL("../tools/sellpia_scraper.html", import.meta.url), "utf8");
const scripts = [...scraper.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
const elements = new Map();
const getElementById = (id) => {
  if (!elements.has(id)) elements.set(id, { href: "", textContent: "" });
  return elements.get(id);
};
const context = vm.createContext({
  console: { error() {}, warn() {}, log() {} },
  document: { getElementById },
});
scripts.forEach((script) => vm.runInContext(script, context));
const generated = decodeURIComponent(getElementById("bookmarklet-link").href.replace(/^javascript:/, ""));
new Function(generated);

assert.match(generated, /function sellpiaSupplierCellRaw/);
assert.match(generated, /\\uB9E4\\uC785\\uCC98\\uBA85/);
assert.match(generated, /\\uB9E4\\uC785\\uCC98\/\\uC140/);
assert.match(generated, /\['c_in_provider_name','in_provider_name'\]/);
assert.match(generated, /sellpia_supplier_cell_raw:sellpiaSupplierCellRaw\(it\)/);
assert.match(generated, /seller:String\(it\.c_provider_name\|\|""\)/, "sales-channel seller must stay unchanged");
assert.match(generated, /p_location:String\(it\.c_location\|\|""\)/, "product location must stay unchanged");
assert.doesNotMatch(generated, /sellpiaSupplierCellRaw[^}]*split\(/, "supplier/cell raw text must not be parsed");
assert.doesNotMatch(generated, /order_item_operations/, "the full scraper must never rewrite persistent operations or snapshots");

const fieldHelpersStart = generated.indexOf("function cleanSellpiaHeaderLabel");
const fieldHelpersEnd = generated.indexOf("function parseSellpiaMoney", fieldHelpersStart);
const supplierStart = generated.indexOf("function sellpiaSupplierCellRaw");
const supplierEnd = generated.indexOf("\n", supplierStart);
assert.ok(fieldHelpersStart >= 0 && fieldHelpersEnd > fieldHelpersStart && supplierStart >= 0 && supplierEnd > supplierStart);

const helperContext = vm.createContext({
  console: { warn() {} },
  window: { grid: { getColumns: () => [{ name: "매입처/셀", field: "supplier_display" }] } },
});
vm.runInContext(
  `${generated.slice(fieldHelpersStart, fieldHelpersEnd)}\n${generated.slice(supplierStart, supplierEnd)}\nglobalThis.readSupplier=sellpiaSupplierCellRaw;`,
  helperContext,
);
assert.equal(helperContext.readSupplier({ supplier_display: "0-그린 (쥬얼파크) [ 17 ]" }), "0-그린 (쥬얼파크) [ 17 ]");
assert.equal(helperContext.readSupplier({ c_in_provider_name: "0-베니스톤 [ 28 ]" }), "0-베니스톤 [ 28 ]");
assert.equal(helperContext.readSupplier({}), null, "missing supplier must remain nullable and must not throw");

console.log("sellpiaSupplierCellRaw.mock.test: OK");
