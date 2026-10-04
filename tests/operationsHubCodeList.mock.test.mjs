import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../mockups/operations-hub/index.html", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../mockups/operations-hub/app.js", import.meta.url), "utf8");
const data = fs.readFileSync(new URL("../mockups/operations-hub/data-service.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../mockups/operations-hub/style.css", import.meta.url), "utf8");
const migration = fs.readFileSync(
  new URL("../supabase/migrations/20260814024918_operations_hub_code_list_lookup.sql", import.meta.url),
  "utf8",
);
const sourceFilterMigration = fs.readFileSync(
  new URL("../supabase/migrations/20260814030241_operations_hub_search_source_filters.sql", import.meta.url),
  "utf8",
);
const sellpiaPrefixMigration = fs.readFileSync(
  new URL("../supabase/migrations/20260827044857_support_sellpia_prefix_code_list_lookup.sql", import.meta.url),
  "utf8",
);
const pageFirstMigration = fs.readFileSync(
  new URL("../supabase/migrations/20260831151000_operations_hub_matrix_page_v3.sql", import.meta.url),
  "utf8",
);

assert.match(html, /id="code-list-open"[^>]*>[\s\S]*?엑셀 코드목록/, "the matrix must expose the Excel code-list entry point");
for (const source of ["sellpia", "smartstore", "makeshop", "ably"]) {
  assert.match(html, new RegExp(`type="checkbox" value="${source}" checked`), `the search toolbar must expose ${source}`);
}
assert.match(app, /searchSources:\['sellpia','smartstore','makeshop','ably'\]/, "all search sources must be enabled by default");
assert.match(app, /if \(!selected\.length\)[\s\S]*?event\.target\.checked = true/, "the last search source cannot be unchecked");
assert.match(html, /class="matrix-search-group"[\s\S]*?id="matrix-search"[\s\S]*?id="matrix-search-sources"/, "search input and source filters must read as one grouped control");
assert.match(css, /\.matrix-search-sources label\{[^}]*border:0[^}]*background:transparent/, "search source labels must not use individual pill outlines");
assert.match(css, /\.matrix-action-panel-head>span:first-child\{[^}]*font-size:15px/, "the persistent work-tools heading must use the enlarged readable size");
assert.match(css, /\.matrix-search-group \.matrix-search input\{[^}]*font-size:15px/, "the matrix search input must use the enlarged readable size");
assert.match(css, /\.matrix-search-sources label\{[^}]*font-size:12px/, "search-source labels must scale with the enlarged search header");
assert.match(html, /class="matrix-action-panel"[\s\S]*?id="matrix-refresh-btn"[\s\S]*?id="matrix-bulk-btn"[\s\S]*?id="code-list-open"/, "matrix actions and saved views must live in the persistent right panel");
assert.match(app, /if \(matrixState\.search\) loadLiveMatrix/, "changing a source reloads only an active search");
assert.match(pageFirstMigration, /p_search_sources[\s\S]*?v_sources[\s\S]*?'smartstore' = any\(v_sources\)[\s\S]*?'makeshop' = any\(v_sources\)[\s\S]*?'ably' = any\(v_sources\)/, "combined-code lookup must honor selected seller sources");
assert.match(data, /load_operations_hub_matrix_page_v3[\s\S]*?p_search_sources:searchSources/, "the selected source list must be sent to the page-first search RPC");
assert.match(sourceFilterMigration, /join allowed_sources source on source\.source_channel = link\.source_channel/i, "database composite lookup must be source-limited");
assert.match(html, /필요한 코드 열만[\s\S]*?셀피아 한 열만 쓰거나/, "the upload guide must allow a one-column Sellpia review list");
assert.match(html, /셀피아[\s\S]*?스마트스토어[\s\S]*?메이크샵[\s\S]*?에이블리/, "the upload guide must still show all supported source columns");
assert.match(app, /CODE_LIST_SOURCES\.some\(source => source\.aliases\.some/, "a code list must accept any one recognized source header");
assert.match(app, /CODE_LIST_SOURCES\.filter\(source => indexes\[source\.key\] >= 0\)/, "missing optional source columns must not be read through a negative column index");
assert.match(app, /values\.length > 1[\s\S]*?한 행에 코드가 여러 개 있음/, "each input row must contain exactly one source code");
assert.match(app, /sheet_to_json\(sheet, \{header:1, raw:false, defval:''\}\)/, "formatted Excel codes must be read without numeric coercion");
assert.match(app, /matrixState\.codeListRows = codeListSession\.resultRows\.map\(item => \(\{\.\.\.item\}\)\)[\s\S]*?loadLiveMatrix\(\{resetPage:true\}\)/, "ordered Excel result rows must drive the live matrix view");
assert.match(app, /\.\.\.codeListSession\.resolved\.map[\s\S]*?\.\.\.codeListSession\.invalid\.map[\s\S]*?\.sort\(\(left, right\) => Number\(left\.input_row\) - Number\(right\.input_row\)/, "matched, missing, unmapped, and invalid inputs must share one ordered result stream");
assert.match(data, /orderedCodeRows\.slice\(from, from \+ safePageSize\)/, "Excel result rows must be paginated in client input order with the selected page size");
assert.match(data, /pageRows\.map\(codeRow =>[\s\S]*?__codeListPlaceholder:true/, "missing or unmapped Excel rows must survive as matrix placeholders");
assert.match(app, /function renderCodeListPlaceholderRow[\s\S]*?code-list-placeholder-row/, "the matrix must render an explicit placeholder for unresolved Excel rows");
assert.match(app, /<em>엑셀 \$\{inputRow\}행<\/em>/, "matched rows must expose their original Excel row number");
assert.match(app, /matrixState\.codeListRows\.length\)\}개 결과/, "the active Excel-list pill must count result rows rather than unique SKUs");
for (const rpc of ["resolve_operations_hub_code_entries", "load_operations_hub_code_list"]) {
  assert.match(data, new RegExp(rpc), `${rpc} must be called through the database client`);
}
assert.match(migration, /item\.product_code \|\| '-' \|\| item\.option_code/, "seller listing keys must be compared in the database");
assert.match(migration, /then 'option'[\s\S]*?then 'product'/, "exact listing matches must take priority over product-wide expansion");
assert.match(sellpiaPrefixMigration, /then 'sku'[\s\S]*?then 'prefix'/, "exact Sellpia SKU matches must take priority over prefix expansion");
assert.match(sellpiaPrefixMigration, /left\(matrix\.sellpia_sku_code, char_length\(input\.input_code\) \+ 1\) = input\.input_code \|\| '-'/, "Sellpia prefix matching must require a literal hyphen boundary");
assert.match(sellpiaPrefixMigration, /input\.match_scope = 'prefix'[\s\S]*?left\(matrix\.sellpia_sku_code, char_length\(input\.input_code\) \+ 1\) = input\.input_code \|\| '-'/, "a Sellpia prefix input must expand to every option SKU in the matched product");
assert.doesNotMatch(app, /split\(['"]-['"]\)/, "hyphenated seller codes must never be parsed by splitting on a hyphen");
assert.match(migration, /with ordinality[\s\S]*?input_order[\s\S]*?result_order/, "Excel row order must survive resolution and pagination");

console.log("Operations hub Excel code-list and composite seller-code contract: passed");
