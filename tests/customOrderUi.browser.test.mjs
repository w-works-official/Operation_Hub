import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (match) => match.slice(1)));
const playwrightPath = pathToFileURL("C:/Users/hihi0/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const { chromium } = await import(playwrightPath.href);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://local.test").pathname);
    const requested = pathname === "/" ? "/index.html" : pathname;
    const file = path.resolve(root, `.${requested}`);
    if (!file.startsWith(root)) throw new Error("outside root");
    response.writeHead(200, { "content-type": contentTypes[path.extname(file)] || "application/octet-stream" });
    response.end(await readFile(file));
  } catch {
    response.writeHead(404);
    response.end("not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

const browser = await chromium.launch({
  headless: true,
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
await page.addInitScript(() => {
  window.__xlsxUploadMatrix = [
    ["셀피아 SKU", "입고예정일", "자사코드"],
    ["UPLOADED-SKU", "2026-10-18", "UPLOADED-OWN"],
  ];
  window.XLSX = {
    read() {
      return { SheetNames: ["입고예정일"], Sheets: { 입고예정일: {} } };
    },
    utils: {
      sheet_to_json() { return window.__xlsxUploadMatrix; },
      book_new() { return { SheetNames: [], Sheets: {} }; },
      aoa_to_sheet(values) { return { __values: values }; },
      book_append_sheet(workbook, worksheet, name) {
        workbook.SheetNames.push(name);
        workbook.Sheets[name] = worksheet;
      },
    },
    writeFile(workbook, filename) {
      window.__xlsxDownload = { workbook, filename };
    },
  };
});
await page.route("https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js", async (route) => {
  await route.fulfill({ contentType: "text/javascript", body: "/* test uses the init-script XLSX stub */" });
});
await page.route("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2", async (route) => {
  await route.fulfill({
    contentType: "text/javascript",
    body: `
      window.__supabaseCalls = [];
      const base = { custom_required_at: "2026-09-28T03:00:00Z", custom_ordered_on: null, custom_received_on: null, custom_cancelled_at: null, inbound_expected_date: null, inbound_expected_source: null, internal_memo: null };
      window.__tables = {
        orders: [{ ord_no: "O-P", receipt_date: "2026-10-01", sort_order: 1, receiver: "테스트", seller: "스마트스토어" }],
        order_item_operations: [
          { ...base, operation_id: "op-before", ord_no: "O-1", sellpia_order_item_no: "R-1", item_no: "1_R-1", sellpia_product_code_snapshot: "OLD", product_name_snapshot: "예전 상품", supplier_cell_raw_snapshot: "예전 매입처" },
          { ...base, operation_id: "op-missing", ord_no: "O-M", sellpia_order_item_no: "R-M", item_no: "1_R-M", custom_ordered_on: "2026-09-29", inbound_expected_date: "2026-10-05", inbound_expected_source: "sku_schedule", sellpia_product_code_snapshot: "SNAP", own_code_snapshot: "SNAP-OWN", product_name_snapshot: "스냅 상품", product_option_snapshot: "스냅 옵션", supplier_cell_raw_snapshot: "0-스냅매입처 [ 9 ]" },
          { ...base, operation_id: "op-manual-clear", ord_no: "O-2", sellpia_order_item_no: "R-2", item_no: "1_R-2", custom_ordered_on: "2026-09-30", inbound_expected_source: "manual", inbound_expected_date: null },
          { ...base, operation_id: "op-legacy", ord_no: "O-3", sellpia_order_item_no: "R-3", item_no: "1_R-3", custom_ordered_on: "2026-09-30" },
          { ...base, operation_id: "op-received", ord_no: "O-4", sellpia_order_item_no: "R-4", item_no: "1_R-4", custom_received_on: "2026-10-01" },
          { ...base, operation_id: "op-cancelled", ord_no: "O-5", sellpia_order_item_no: "R-5", item_no: "1_R-5", custom_cancelled_at: "2026-10-01T04:00:00Z" }
        ],
        order_items: [
          { ord_no: "O-P", sellpia_order_item_no: "R-P", item_no: "1_R-P", sort_order: 1, p_code: "PICK-SKU", p_dpcode: "PICK-OWN", p_name: "피킹 주문제작 상품", p_option: "테스트 옵션", p_location: "A-1", qty: 1 },
          { ord_no: "O-1", sellpia_order_item_no: "R-1", item_no: "9_R-1", p_code: "SAME-SKU", p_dpcode: "OWN-1", p_name: "현재 상품 1", p_option: "실버", sellpia_supplier_cell_raw: "0-베니스톤 [ 28 ]" },
          { ord_no: "O-2", sellpia_order_item_no: "R-2", item_no: "1_R-2", p_code: "SAME-SKU", p_dpcode: "OWN-2", p_name: "현재 상품 2", p_option: "골드", sellpia_supplier_cell_raw: "0-세븐피어싱 [ 1 ]", sellpia_outbound_confirmed_date: "2026-10-08" },
          { ord_no: "O-3", sellpia_order_item_no: "R-3", item_no: "1_R-3", p_code: "LEGACY", p_dpcode: "OWN-3", p_name: "레거시 상품", sellpia_supplier_cell_raw: "0-베니스톤 [ 28 ]", sellpia_outbound_confirmed_date: "2026-10-09" },
          { ord_no: "O-LONLY", sellpia_order_item_no: "R-LONLY", item_no: "1_R-LONLY", p_code: "LEGACY-ONLY", p_dpcode: "OWN-LONLY", p_name: "operation 없는 셀피아 일정", sellpia_supplier_cell_raw: "0-신규매입처 [ 7 ]", sellpia_outbound_confirmed_date: "2026-10-11" }
        ],
        sku_inbound_schedules: [
          { sellpia_sku: "LEGACY-ONLY", inbound_expected_date: "2026-10-07", own_code: "OWN-LONLY", created_at: "2026-10-01T01:00:00Z", updated_at: "2026-10-01T01:00:00Z" }
        ]
      };
      function query(table) {
        const state = { table, mode: "select", payload: null, filters: [], notNull: "" };
        let proxy;
        proxy = new Proxy({}, {
          get(_target, prop) {
            if (prop === "then") return (resolve) => {
              let rows = [...(window.__tables[table] || [])];
              for (const [kind, column, value] of state.filters) {
                if (kind === "eq") rows = rows.filter((row) => row[column] === value);
                if (kind === "in") rows = rows.filter((row) => value.includes(row[column]));
              }
              if (state.notNull) rows = rows.filter((row) => row[state.notNull] !== null && row[state.notNull] !== undefined);
              if (state.mode === "update") {
                rows.forEach((row) => Object.assign(row, state.payload));
              }
              if (state.mode === "insert") {
                const inserted = { operation_id: "generated-" + Date.now(), ...state.payload };
                (window.__tables[table] ||= []).push(inserted);
                rows = [inserted];
              }
              if (state.mode === "upsert") {
                const payload = Array.isArray(state.payload) ? state.payload : [state.payload];
                rows = payload.map((value) => {
                  const existing = (window.__tables[table] ||= []).find((row) => row.sellpia_sku === value.sellpia_sku);
                  if (existing) return Object.assign(existing, value, { updated_at: new Date().toISOString() });
                  const inserted = { created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...value };
                  window.__tables[table].push(inserted);
                  return inserted;
                });
              }
              resolve({ data: structuredClone(rows), error: null });
            };
            return (...args) => {
              window.__supabaseCalls.push({ table, method: String(prop), args });
              if (prop === "eq") state.filters.push(["eq", args[0], args[1]]);
              if (prop === "in") state.filters.push(["in", args[0], args[1]]);
              if (prop === "not" && args[1] === "is" && args[2] === null) state.notNull = args[0];
              if (prop === "update") { state.mode = "update"; state.payload = args[0]; }
              if (prop === "insert") { state.mode = "insert"; state.payload = args[0]; }
              if (prop === "upsert") { state.mode = "upsert"; state.payload = structuredClone(args[0]); }
              return proxy;
            };
          }
        });
        return proxy;
      }
      window.supabase = { createClient() {
        return {
          from: (table) => query(table),
          rpc: () => Promise.resolve({ data: [], error: null }),
          storage: { from: () => ({ download: () => Promise.resolve({ data: null, error: new Error("mock empty") }), list: () => Promise.resolve({ data: [], error: null }) }) }
        };
      }};
    `,
  });
});

try {
  await page.goto(`http://127.0.0.1:${port}/index.html?write=1`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-app-tab="custom-orders"]');
  await page.waitForSelector('.picking-item-card[data-order-group="O-P"]');
  const before = await page.evaluate(() => window.__supabaseCalls.filter((entry) => entry.table === "order_item_operations" && entry.method === "not").length);
  assert.equal(before, 0, "custom-order workspace query must not run before the tab opens");

  let pickingCard = page.locator('.picking-item-card[data-order-group="O-P"]');
  assert.match(await pickingCard.textContent(), /스마트스토어/);
  assert.match(await pickingCard.textContent(), /A-1/);
  await pickingCard.locator('[data-action="custom-order-toggle"]').check();
  await page.waitForFunction(() => window.__tables.order_item_operations.some((row) => row.ord_no === "O-P" && row.custom_required_at));
  pickingCard = page.locator('.picking-item-card[data-order-group="O-P"]');
  assert.equal(await pickingCard.locator('[data-action="custom-order-toggle"]').isChecked(), true);
  await pickingCard.locator('[data-action="custom-order-toggle"]').click();
  await page.waitForFunction(() => window.__tables.order_item_operations.some((row) => row.ord_no === "O-P" && row.custom_required_at === null));
  pickingCard = page.locator('.picking-item-card[data-order-group="O-P"]');
  await pickingCard.locator('[data-action="custom-order-memo-input"]').fill("내부 제작 메모");
  await pickingCard.locator('[data-action="custom-order-memo-save"]').click();
  await page.waitForFunction(() => window.__tables.order_item_operations.some((row) => row.ord_no === "O-P" && row.internal_memo === "내부 제작 메모"));
  pickingCard = page.locator('.picking-item-card[data-order-group="O-P"]');
  await pickingCard.locator('[data-action="custom-order-toggle"]').check();
  assert.deepEqual(await pickingCard.locator(".picking-custom-order").evaluate((node) => [...node.children].map((child) => child.className)), [
    "custom-order-check",
    "custom-order-memo-inline",
    "custom-order-status status-before_order",
  ], "picking controls must be ordered as checkbox, memo, then status badge");
  pickingCard = page.locator('.picking-item-card[data-order-group="O-P"]');
  await pickingCard.locator('[data-action="custom-order-toggle"]').click();
  await page.waitForFunction(() => document.getElementById("toast")?.textContent.includes("주문제작 탭에서 취소"));
  pickingCard = page.locator('.picking-item-card[data-order-group="O-P"]');
  assert.equal(await pickingCard.locator('[data-action="custom-order-toggle"]').isChecked(), true, "memo-bearing workflow must refuse direct uncheck");

  await page.click('[data-app-tab="custom-orders"]');
  await page.waitForFunction(() => document.getElementById("custom-orders-count")?.textContent.includes("전체 7건"));
  assert.equal(await page.locator("#custom-orders-panel").isVisible(), true);
  assert.equal(await page.locator("#picking-panel").isVisible(), false);
  assert.equal(await page.locator("#custom-orders-status").inputValue(), "active");
  const layout = await page.evaluate(() => {
    const panel = document.getElementById("custom-orders-panel");
    const toolbar = document.querySelector(".custom-orders-toolbar");
    const status = document.getElementById("custom-orders-status");
    const firstRow = document.querySelector(".custom-order-row");
    return {
      panelRows: getComputedStyle(panel).gridTemplateRows.split(" ").length,
      toolbarHeight: toolbar.getBoundingClientRect().height,
      statusHeight: status.getBoundingClientRect().height,
      gapToFirstRow: firstRow.getBoundingClientRect().top - toolbar.getBoundingClientRect().bottom,
    };
  });
  assert.equal(layout.panelRows, 6, "custom-order panel must allocate header/tabs/filters/SKU-manager/summary/list rows");
  assert.ok(layout.toolbarHeight >= 48 && layout.toolbarHeight <= 60, `toolbar must match existing panel density (${layout.toolbarHeight}px)`);
  assert.equal(layout.statusHeight, 32, `filter controls must match the existing 32px form-control height (${layout.statusHeight}px)`);
  assert.ok(layout.gapToFirstRow < 70, `list must start directly below its summary (${layout.gapToFirstRow}px)`);
  assert.match(await page.locator("#custom-orders-count").textContent(), /^5건 \/ 전체 7건$/);
  assert.equal(await page.locator(".custom-order-row").count(), 5);
  assert.equal(await page.locator(".custom-order-row .workflow-row-badge.danger").count(), 1);
  assert.match(await page.locator('[data-operation-id="op-missing"]').textContent(), /스냅 상품/);
  assert.match(await page.locator('[data-operation-id="op-manual-clear"]').textContent(), /수동 · 삭제됨/);
  assert.match(await page.locator('[data-operation-id="op-legacy"]').textContent(), /셀피아/);
  assert.equal(await page.locator('[data-operation-id="op-before"] .custom-order-product-photo img').count(), 1, "custom-order workflow must show the product photo");

  const statusColors = {};
  for (const [filter, key] of [["before_order", "before"], ["received", "received"]]) {
    await page.selectOption("#custom-orders-status", filter);
    const row = page.locator(".custom-order-row").first();
    statusColors[key] = await row.evaluate((node) => getComputedStyle(node).borderLeftColor);
  }
  assert.notEqual(statusColors.before, statusColors.received, "before-order and received rows must have distinct status colors");

  await page.selectOption("#custom-orders-status", "received");
  assert.equal(await page.locator('.custom-order-row[data-operation-id="op-received"]').count(), 1);
  assert.match(await page.locator('[data-operation-id="op-received"] .custom-order-status').textContent(), /입고 완료/);
  await page.selectOption("#custom-orders-status", "active");
  await page.selectOption("#custom-orders-supplier", "0-스냅매입처 [ 9 ]");
  assert.equal(await page.locator(".custom-order-row").count(), 1);
  await page.selectOption("#custom-orders-supplier", "");
  await page.fill("#custom-orders-search", "OWN-2");
  assert.equal(await page.locator('.custom-order-row[data-operation-id="op-manual-clear"]').count(), 1);
  await page.fill("#custom-orders-search", "");

  await page.locator('[data-operation-id="op-before"] [data-custom-order-action="ordered-today"]').click();
  await page.waitForFunction(() => {
    const row = window.__tables.order_item_operations.find((entry) => entry.operation_id === "op-before");
    return row?.custom_ordered_on === "2026-10-01"
      && row?.inbound_expected_date === "2026-10-15"
      && row?.inbound_expected_source === "manual";
  });
  assert.match(await page.locator('[data-operation-id="op-before"] .custom-order-status').textContent(), /주문완/);
  const orderedColor = await page.locator('[data-operation-id="op-before"]').evaluate((node) => getComputedStyle(node).borderLeftColor);
  assert.notEqual(orderedColor, statusColors.before, "ordered rows must be visually distinct from before-order rows");
  assert.notEqual(orderedColor, statusColors.received, "ordered rows must be visually distinct from received rows");

  await page.locator('[data-operation-id="op-missing"] [data-custom-order-field="inbound_expected_date"]').fill("2026-10-06");
  await page.locator('[data-operation-id="op-missing"] [data-custom-order-field="inbound_expected_date"]').press("Tab");
  await page.waitForFunction(() => {
    const row = window.__tables.order_item_operations.find((entry) => entry.operation_id === "op-missing");
    return row?.inbound_expected_date === "2026-10-06" && row?.inbound_expected_source === "manual";
  });
  await page.locator('[data-operation-id="op-missing"] [data-custom-order-action="received-today"]').click();
  await page.waitForFunction(() => window.__tables.order_item_operations.find((row) => row.operation_id === "op-missing")?.custom_received_on);
  assert.equal(await page.locator('[data-operation-id="op-missing"]').count(), 0, "received rows must leave the default active list");
  await page.selectOption("#custom-orders-status", "received");
  assert.equal(await page.locator('[data-operation-id="op-missing"]').count(), 1);
  await page.selectOption("#custom-orders-status", "active");

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator('[data-operation-id="op-legacy"] [data-custom-order-action="cancel"]').click();
  await page.waitForFunction(() => window.__tables.order_item_operations.find((row) => row.operation_id === "op-legacy")?.custom_cancelled_at);
  assert.equal(await page.locator('[data-operation-id="op-legacy"]').count(), 0, "cancelled rows must leave the default active list");
  await page.selectOption("#custom-orders-status", "cancelled");
  assert.equal(await page.locator('[data-operation-id="op-legacy"]').count(), 1);

  await page.click('[data-custom-orders-view="inbound"]');
  await page.waitForFunction(() => document.getElementById("custom-orders-count")?.textContent === "5건 / 전체 5건");
  assert.equal(await page.locator('[data-custom-orders-toolbar="workflow"]').isVisible(), false);
  assert.equal(await page.locator('[data-custom-orders-toolbar="inbound"]').isVisible(), true);
  assert.equal(await page.locator("#custom-orders-sku-schedule-panel").isVisible(), true);
  assert.match(await page.locator("#custom-orders-sku-count").textContent(), /1개 SKU/);
  assert.equal(await page.locator(".inbound-expected-row").count(), 5);
  assert.match(await page.locator('[data-inbound-row-key="O-2::R-2"]').textContent(), /명시적 삭제/);
  assert.match(await page.locator('[data-inbound-row-key="O-M::R-M"]').textContent(), /원천 주문행 없음/);
  assert.match(await page.locator('[data-inbound-row-key="O-LONLY::R-LONLY"]').textContent(), /SKU 일정/);
  await page.selectOption("#custom-orders-inbound-sort", "desc");
  assert.equal(await page.locator('.inbound-expected-row [data-inbound-expected-field="inbound_expected_date"]').first().inputValue(), "2026-10-15");
  await page.selectOption("#custom-orders-inbound-sort", "asc");
  assert.equal(await page.locator('.inbound-expected-row [data-inbound-expected-field="inbound_expected_date"]').first().inputValue(), "2026-10-06");
  await page.selectOption("#custom-orders-inbound-source", "legacy_sellpia");
  assert.equal(await page.locator(".inbound-expected-row").count(), 1);
  await page.selectOption("#custom-orders-inbound-source", "all");

  await page.fill("#custom-orders-sku-input", "DIRECT-SKU");
  await page.fill("#custom-orders-sku-date", "2026-10-17");
  await page.fill("#custom-orders-sku-own-code", "DIRECT-OWN");
  await page.click("#custom-orders-sku-save");
  await page.waitForFunction(() => window.__tables.sku_inbound_schedules.some((row) => row.sellpia_sku === "DIRECT-SKU" && row.inbound_expected_date === "2026-10-17"));
  assert.match(await page.locator("#custom-orders-sku-count").textContent(), /2개 SKU/);

  await page.click("#custom-orders-sku-download");
  await page.waitForFunction(() => window.__xlsxDownload);
  const download = await page.evaluate(() => window.__xlsxDownload);
  assert.match(download.filename, /^SKU_입고예정일_\d{4}-\d{2}-\d{2}\.xlsx$/);
  assert.deepEqual(download.workbook.Sheets["입고예정일"].__values[0], ["셀피아 SKU", "입고예정일", "자사코드"]);

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#custom-orders-sku-file").setInputFiles({
    name: "schedule.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from("mock xlsx"),
  });
  await page.waitForFunction(() => window.__tables.sku_inbound_schedules.some((row) => row.sellpia_sku === "UPLOADED-SKU" && row.own_code === "UPLOADED-OWN"));
  assert.match(await page.locator("#custom-orders-sku-import-status").textContent(), /1개 SKU 일정을 업로드/);

  await page.fill("#custom-orders-inbound-search", "O-LONLY");
  assert.equal(await page.locator(".inbound-expected-row").count(), 1, "legacy-only rows must be searchable by order identity");
  const legacyOnly = page.locator('[data-inbound-row-key="O-LONLY::R-LONLY"]');
  await legacyOnly.locator('[data-inbound-expected-field="inbound_expected_date"]').fill("2026-10-12");
  await legacyOnly.locator('[data-inbound-expected-field="inbound_expected_date"]').press("Tab");
  await page.waitForFunction(() => window.__tables.order_item_operations.some((row) => row.ord_no === "O-LONLY" && row.inbound_expected_source === "manual" && row.inbound_expected_date === "2026-10-12"));
  assert.match(await page.locator('[data-inbound-row-key="O-LONLY::R-LONLY"]').textContent(), /수동/);
  await page.fill("#custom-orders-inbound-search", "");
  await page.click('[data-custom-orders-view="workflow"]');

  const after = await page.evaluate(() => window.__supabaseCalls.filter((entry) => entry.table === "order_item_operations" && entry.method === "not").length);
  assert.equal(after, 2, "custom-order and inbound operation queries must each lazy-load once on first tab entry");

  for (const tab of ["dashboard", "picking", "shortage", "inspection", "cs", "completed", "custom-orders"]) {
    await page.click(`[data-app-tab="${tab}"]`);
    assert.equal(await page.locator(`[data-app-tab="${tab}"]`).evaluate((node) => node.classList.contains("active")), true);
  }
  assert.deepEqual(pageErrors, []);
  console.log("customOrderUi.browser.test: OK");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
