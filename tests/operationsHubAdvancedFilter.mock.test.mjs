import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../mockups/operations-hub/index.html", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../mockups/operations-hub/app.js", import.meta.url), "utf8");
const data = fs.readFileSync(new URL("../mockups/operations-hub/data-service.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../mockups/operations-hub/style.css", import.meta.url), "utf8");
const migration = fs.readFileSync(
  new URL("../supabase/migrations/20260818082659_operations_hub_advanced_matrix_filters.sql", import.meta.url),
  "utf8",
);
const optimizationMigration = fs.readFileSync(
  new URL("../supabase/migrations/20260818084516_optimize_operations_hub_advanced_filters.sql", import.meta.url),
  "utf8",
);

assert.match(html, /id="advanced-filter-btn"[\s\S]*?id="advanced-filter-count"/, "the matrix toolbar must expose the advanced filter count");
assert.match(html, /id="advanced-filter-modal"[\s\S]*?id="advanced-filter-logic"[\s\S]*?id="advanced-filter-rows"[\s\S]*?id="advanced-filter-apply"/, "the filter modal must expose logic, condition rows, and apply controls");
assert.match(html, /id="advanced-filter-bar"[\s\S]*?id="advanced-filter-chips"[\s\S]*?id="advanced-filter-clear"/, "applied filters must remain visible and individually removable");
assert.match(app, /advancedFilter:\{logic:'and', conditions:\[\]\}/, "matrix state and presets must start with an empty advanced filter");
assert.match(app, /function cloneAdvancedFilter\([\s\S]*?conditions:Array\.isArray[\s\S]*?map\(condition => \(\{[\s\S]*?\.\.\.condition[\s\S]*?\}\)\)/, "preset cloning must deep-copy and normalize condition rows");
assert.match(app, /const options = \[\['connected','연결 완료'\],\['unmatched','미매칭'\]\]/, "advanced connection filters must expose only the two operational states");
assert.match(data, /function normalizeConnectionConditions\([\s\S]*?field !== 'overall_status'[\s\S]*?operator:condition\.operator === 'neq' \? 'eq' : 'neq'[\s\S]*?value:'unmatched'/, "advanced connected filters must include legacy review rows without exposing review as a third state");
assert.match(app, /readViewSettingsForm\([\s\S]*?advancedFilter:cloneAdvancedFilter\(activeView\.advancedFilter\)/, "saved view presets must retain advanced filters");
assert.match(app, /ADVANCED_FILTER_FIELDS[\s\S]*?sellpia_product_name[\s\S]*?smartstore_stock[\s\S]*?makeshop_price[\s\S]*?ably_sale_status[\s\S]*?tag_summary/, "field choices must cover names, stock, prices, seller status, and tags");
assert.match(app, /ADVANCED_FILTER_OPERATORS[\s\S]*?contains[\s\S]*?gte[\s\S]*?lte/, "text and numeric comparison operators must be explicit");
assert.match(app, /escapeHtml\(`\$\{group\} · \$\{item\.label\}`\)/, "the collapsed field selector must retain its platform group");
assert.match(app, /text:\[\['contains','포함'\],\['not_contains','제외'\],\['not_empty','있음'\],\['empty','없음'\],\['eq','같음'\],\['neq','다름'\]\]/, "text operators must use concise operator names familiar to operators");
assert.match(app, /function validateAdvancedFilter\([\s\S]*?Number\.isFinite\(Number\(condition\.value\)\)/, "numeric values must be rejected before the server call");
assert.match(app, /button\.disabled = matrixState\.codeListRows\.length > 0/, "ordered Excel-list mode must not silently combine with advanced filters");
assert.match(data, /filterPayload\.conditions\.length[\s\S]*?load_operations_hub_matrix_filtered[\s\S]*?p_filter:filterPayload/, "advanced conditions must use the server-side paging RPC");
assert.match(migration, /jsonb_array_length\(v_conditions\) > 12/, "the database must bound condition count");
assert.match(migration, /허용되지 않은 상세 필터 필드/, "the database must reject unknown fields");
assert.match(migration, /v_logic = 'and'[\s\S]*?v_logic = 'or'/, "the database must evaluate AND and OR semantics");
assert.match(migration, /operations_hub_product_profiles profile/, "attributes and tags must join the persisted profile view");
assert.match(migration, /'count', \(select count\(\*\) from filtered\)/, "the RPC must return the exact filtered total before paging");
assert.doesNotMatch(migration, /execute\s+format/i, "filter input must never be interpolated into dynamic SQL");
assert.match(migration, /grant execute on function public\.load_operations_hub_matrix_filtered[\s\S]*?to anon, authenticated/, "the public frontend roles must receive only function execution access");
assert.match(optimizationMigration, /v_needs_profile[\s\S]*?load_operations_hub_matrix_filtered_with_profiles[\s\S]*?load_operations_hub_matrix_filtered_fast/, "common filters must avoid the expensive profile join while attribute and tag filters retain it");
assert.match(optimizationMigration, /security invoker/g, "optimized filter routes must preserve invoker security");
assert.match(css, /\.advanced-filter-chip[\s\S]*?\.advanced-filter-modal[\s\S]*?\.advanced-filter-row/, "the filter editor and applied chips must have dedicated layout styles");
assert.match(css, /\.matrix-page\.active-page \.matrix-toolbar\{[^}]*overflow-x:auto/, "the permanent action panel must not cover trailing matrix filters");

const assetVersions = [...html.matchAll(/(?:style\.css|seller-source-parsers\.js|seller-export-adapter\.js|data-service\.js|app\.js)\?v=([^"']+)/g)].map(match => match[1]);
assert.equal(assetVersions.length,5,"all critical local assets must remain cache-busted");
assert.match(html,/data-service\.js\?v=[^"]+[\s\S]*?app\.js\?v=[^"]+/,"the data service and current app bundle must both be cache-versioned");

console.log("Operations hub advanced server-side matrix filter contract: passed");
