import assert from "node:assert/strict";
import { createCsCaseAdapter, csCaseNaturalKey, openShortageItemKeys } from "../src/adapters/csCaseAdapter.mjs";
import { isBareGpaOwnCode, isGoldOwnCode } from "../src/domain/gold.mjs";

function resolveExactItem(items, { ordNo, itemNo, sellpiaOrderItemNo }) {
  if (itemNo) return items.filter((item) => item.ord_no === ordNo && item.item_no === itemNo);
  return items.filter((item) => item.ord_no === ordNo && item.sellpia_order_item_no === sellpiaOrderItemNo);
}

function transition(caseRow, status) {
  if (status === "resolved") return { ...caseRow, status, resolved_at: "2026-07-28T00:00:00.000Z", excluded_at: null };
  if (status === "excluded") return { ...caseRow, status, excluded_at: "2026-07-28T00:00:00.000Z", resolved_at: null };
  return { ...caseRow, status: "pending", resolved_at: null, excluded_at: null };
}

const items = [
  { ord_no: "order-a", item_no: "item-1", sellpia_order_item_no: "sellpia-1", order_memo: "A", prod_code: "GPA-01" },
  { ord_no: "order-a", item_no: "item-2", sellpia_order_item_no: "sellpia-2", order_memo: "", prod_code: "CA-01" },
  { ord_no: "order-a", item_no: "item-3", sellpia_order_item_no: "sellpia-3", order_memo: "", prod_code: "GPB-03" },
  { ord_no: "order-b", item_no: "item-1", sellpia_order_item_no: "sellpia-1", order_memo: "other order", prod_code: "CA-02" },
];

// A one-product CS edit must not touch same-order siblings or another order with a similar key.
const target = resolveExactItem(items, { ordNo: "order-a", itemNo: "item-2" });
assert.equal(target.length, 1);
target[0].order_memo = "CS memo";
assert.deepEqual(items.map((item) => item.order_memo), ["A", "CS memo", "", "other order"]);

// Legacy Sellpia-key matching is allowed only when internal item_no is absent.
assert.equal(resolveExactItem(items, { ordNo: "order-a", itemNo: "", sellpiaOrderItemNo: "sellpia-3" }).length, 1);
assert.equal(resolveExactItem(items, { ordNo: "order-a", itemNo: "missing", sellpiaOrderItemNo: "sellpia-3" }).length, 0);

// A case is unique per product line and type, never per invoice/order alone.
assert.notEqual(
  csCaseNaturalKey({ ordNo: "order-a", itemNo: "item-1", caseType: "shortage" }),
  csCaseNaturalKey({ ordNo: "order-a", itemNo: "item-2", caseType: "shortage" }),
);

const pending = { status: "pending", resolved_at: null, excluded_at: null };
assert.deepEqual(transition(pending, "resolved"), { status: "resolved", resolved_at: "2026-07-28T00:00:00.000Z", excluded_at: null });
assert.deepEqual(transition(pending, "excluded"), { status: "excluded", resolved_at: null, excluded_at: "2026-07-28T00:00:00.000Z" });
assert.deepEqual(transition(transition(pending, "resolved"), "pending"), { status: "pending", resolved_at: null, excluded_at: null });

assert.equal(isGoldOwnCode("GPA-12"), true);
assert.equal(isGoldOwnCode("x-gpb-03"), true);
assert.equal(isGoldOwnCode("14K 상품명만 있음"), false);
assert.equal(isGoldOwnCode("CA-01"), false);
assert.equal(isBareGpaOwnCode("[GPA]"), true);
assert.equal(isBareGpaOwnCode(" [gpa] "), true);
assert.equal(isBareGpaOwnCode("[GPA-01]"), false);

// CS automatic candidates use the full current shortage baseline, not only
// invoices loaded into the currently selected work-date tab.
const openShortageKeys = openShortageItemKeys({
  candidates: [
    { order: { ord_no: "order-a" }, item: { item_no: "item-1", sellpia_order_item_no: "sellpia-1", o_shop_memo2: "2" } },
    { order: { ord_no: "order-a" }, item: { item_no: "item-2", sellpia_order_item_no: "sellpia-2", o_shop_memo2: "" } },
  ],
  shortageRows: [{ ord_no: "order-b", item_no: "item-3", short_qty: 1 }],
});
assert.equal(openShortageKeys.has("order-a::item-1"), true);
assert.equal(openShortageKeys.has("order-a::sellpia-1"), true);
assert.equal(openShortageKeys.has("order-a::item-2"), false);
assert.equal(openShortageKeys.has("order-b::item-3"), true);

function createMemoryDb(seed) {
  const tables = {
    orders: [...seed.orders],
    order_items: [...seed.order_items],
    cs_cases: [],
  };
  const operations = [];
  let nextId = 1;
  const clone = (value) => JSON.parse(JSON.stringify(value));

  function builder(table) {
    const state = { table, filters: [], mode: "select", payload: null, range: null };
    const api = {
      select() { return api; },
      order() { return api; },
      range(from, to) { state.range = [from, to]; return api; },
      eq(column, value) { state.filters.push((row) => row[column] === value); return api; },
      in(column, values) { const allowed = new Set(values); state.filters.push((row) => allowed.has(row[column])); return api; },
      insert(payload) { state.mode = "insert"; state.payload = payload; return api; },
      update(payload) { state.mode = "update"; state.payload = payload; return api; },
      then(resolve, reject) {
        try {
          let rows = tables[state.table].filter((row) => state.filters.every((filter) => filter(row)));
          if (state.mode === "insert") {
            const row = { id: nextId++, ...state.payload, created_at: "now", updated_at: "now" };
            tables[state.table].push(row);
            rows = [row];
          }
          if (state.mode === "update") {
            operations.push({ table: state.table, payload: clone(state.payload) });
            rows = rows.map((row) => Object.assign(row, state.payload, { updated_at: "now" }));
          }
          if (state.range) rows = rows.slice(state.range[0], state.range[1] + 1);
          resolve({ data: clone(rows), error: null });
        } catch (error) {
          reject(error);
        }
      },
    };
    return api;
  }
  return { from: builder, tables, operations };
}

const memoryDb = createMemoryDb({
  orders: [{ ord_no: "order-a", inv_no: "invoice-a", receipt_date: "2026-07-28" }],
  order_items: items.slice(0, 3),
});
const adapter = createCsCaseAdapter(memoryDb);
const created = await adapter.createManualCsCase({
  ordNo: "order-a",
  itemNo: "item-2",
  sellpiaOrderItemNo: "sellpia-2",
  invNo: "invoice-a",
  receiptDate: "2026-07-28",
  caseType: "shortage",
  basisDate: "2026-07-28",
});
assert.equal(created.created, true);
const duplicate = await adapter.createManualCsCase({
  ordNo: "order-a",
  itemNo: "item-2",
  caseType: "shortage",
});
assert.equal(duplicate.created, false);
assert.equal(memoryDb.tables.cs_cases.length, 1);
assert.equal((await adapter.resolveCsCase(created.caseRow.id)).status, "resolved");
assert.equal((await adapter.excludeCsCase(created.caseRow.id)).status, "excluded");

const readded = await adapter.createManualCsCase({
  ordNo: "order-a",
  itemNo: "item-2",
  sellpiaOrderItemNo: "sellpia-2",
  invNo: "invoice-a",
  receiptDate: "2026-07-28",
  caseType: "shortage",
});
assert.equal(readded.created, false);
assert.equal(readded.reopened, true);
assert.equal(readded.caseRow.status, "pending");
assert.equal(memoryDb.tables.cs_cases.length, 1);

assert.equal((await adapter.excludeCsCase(created.caseRow.id)).status, "excluded");
assert.equal((await adapter.reopenCsCase(created.caseRow.id)).status, "pending");
const automatic = await adapter.createAutoShortageCsCase({
  ordNo: "order-a",
  itemNo: "item-3",
  sellpiaOrderItemNo: "sellpia-3",
  invNo: "invoice-a",
  receiptDate: "2026-07-28",
  basisDate: "2026-07-28",
  alimtalkTemplate: "14k_1",
});
assert.equal(automatic.caseRow.source, "auto");
assert.equal(automatic.caseRow.alimtalk_template, "14k_1");
assert.equal((await adapter.updateCsCase(automatic.caseRow.id, { alimtalk_template: "d3_pf" })).alimtalk_template, "d3_pf");
const exclusionOverride = await adapter.upsertTemplateOverride({
  ordNo: "order-a",
  itemNo: "item-3",
  sellpiaOrderItemNo: "sellpia-3",
  invNo: "invoice-a",
  receiptDate: "2026-07-28",
  alimtalkExcluded: true,
});
assert.equal(exclusionOverride.created, true);
assert.equal(exclusionOverride.caseRow.case_type, "template_override");
assert.equal(exclusionOverride.caseRow.alimtalk_template, null);
assert.equal(exclusionOverride.caseRow.alimtalk_excluded, true);
const clearedExclusion = await adapter.upsertTemplateOverride({
  ordNo: "order-a",
  itemNo: "item-3",
  sellpiaOrderItemNo: "sellpia-3",
  invNo: "invoice-a",
  receiptDate: "2026-07-28",
  alimtalkExcluded: false,
});
assert.equal(clearedExclusion.created, false);
assert.equal(clearedExclusion.caseRow.alimtalk_excluded, false);
assert.deepEqual(Object.keys(memoryDb.operations.at(-1).payload).sort(), ["alimtalk_excluded", "alimtalk_template", "updated_by"]);
assert.equal(memoryDb.tables.cs_cases.filter((row) => row.case_type === "template_override").length, 1);
const emptyOverride = await adapter.upsertTemplateOverride({
  ordNo: "order-a",
  itemNo: "item-2",
  alimtalkExcluded: false,
});
assert.equal(emptyOverride.caseRow, null);
assert.equal(emptyOverride.created, false);
const autoExcluded = await adapter.excludeAutoShortageCsCase({
  ordNo: "order-a",
  itemNo: "item-3",
  sellpiaOrderItemNo: "sellpia-3",
  invNo: "invoice-a",
  receiptDate: "2026-07-28",
  basisDate: "2026-07-28",
});
assert.equal(autoExcluded.excluded, true);
assert.equal(autoExcluded.caseRow.status, "excluded");
const autoReopened = await adapter.reopenExcludedAutoShortageCsCase({
  ordNo: "order-a",
  itemNo: "item-3",
});
assert.equal(autoReopened.reopened, true);
assert.equal(autoReopened.caseRow.status, "pending");
assert.equal((await adapter.resolveCsCase(automatic.caseRow.id)).status, "resolved");
const resolvedAutoUntouched = await adapter.reopenExcludedAutoShortageCsCase({
  ordNo: "order-a",
  itemNo: "item-3",
});
assert.equal(resolvedAutoUntouched.reopened, false);
assert.equal(resolvedAutoUntouched.caseRow.status, "resolved");
const manualShortage = await adapter.createManualCsCase({
  ordNo: "order-a",
  itemNo: "item-1",
  sellpiaOrderItemNo: "sellpia-1",
  caseType: "shortage",
});
const manualUntouched = await adapter.excludeAutoShortageCsCase({ ordNo: "order-a", itemNo: "item-1" });
assert.equal(manualUntouched.excluded, false);
assert.equal(manualUntouched.caseRow.id, manualShortage.caseRow.id);
assert.equal(manualUntouched.caseRow.status, "pending");
assert.equal((await adapter.excludeCsCase(manualShortage.caseRow.id)).status, "excluded");
const excludedManualUntouched = await adapter.reopenExcludedAutoShortageCsCase({
  ordNo: "order-a",
  itemNo: "item-1",
});
assert.equal(excludedManualUntouched.reopened, false);
assert.equal(excludedManualUntouched.caseRow.status, "excluded");
const contexts = await adapter.loadCsCaseContexts(await adapter.loadCsCases());
assert.equal(contexts.orders.get("order-a").inv_no, "invoice-a");
assert.equal(contexts.items.get("item-2").sellpia_order_item_no, "sellpia-2");

// Manual CS search must not silently lose product rows after Supabase's
// default 1,000-row response limit.
const pagedItemCount = 1127;
const pagedDb = createMemoryDb({
  orders: [{ ord_no: "paged-order", inv_no: "paged-invoice", receiver: "이소윤" }],
  order_items: Array.from({ length: pagedItemCount }, (_, index) => ({
    ord_no: "paged-order",
    item_no: `paged-item-${String(index + 1).padStart(4, "0")}`,
  })),
});
const pagedCandidates = await createCsCaseAdapter(pagedDb).loadManualCsCandidates();
assert.equal(pagedCandidates.length, pagedItemCount);
assert.equal(pagedCandidates.at(-1).item.item_no, "paged-item-1127");

console.log("CS 1-A local mock: passed");
