import assert from "node:assert/strict";
import { createSkuInboundSchedulesAdapter } from "../src/adapters/skuInboundSchedulesAdapter.mjs";

function createMemoryDb() {
  const tables = {
    sku_inbound_schedules: [
      { sellpia_sku: "SKU-A", inbound_expected_date: "2026-10-08", own_code: "OWN-A" },
    ],
    order_items: [
      { ord_no: "O-1", p_code: "SKU-A" },
      { ord_no: "O-2", p_code: "SKU-B" },
      { ord_no: "O-3", p_code: "OTHER" },
    ],
  };
  return {
    tables,
    from(table) {
      const state = { mode: "select", payload: null, inFilter: null, range: null };
      const query = {
        select() { return query; },
        order() { return query; },
        range(from, to) { state.range = [from, to]; return query; },
        in(column, values) { state.inFilter = [column, values]; return query; },
        upsert(payload) { state.mode = "upsert"; state.payload = structuredClone(payload); return query; },
        then(resolve) {
          let rows = [...(tables[table] || [])];
          if (state.inFilter) rows = rows.filter((row) => state.inFilter[1].includes(row[state.inFilter[0]]));
          if (state.mode === "upsert") {
            rows = state.payload.map((value) => {
              const existing = tables[table].find((row) => row.sellpia_sku === value.sellpia_sku);
              if (existing) return Object.assign(existing, value);
              tables[table].push(value);
              return value;
            });
          }
          if (state.range) rows = rows.slice(state.range[0], state.range[1] + 1);
          resolve({ data: structuredClone(rows), error: null });
        },
      };
      return query;
    },
  };
}

const db = createMemoryDb();
const adapter = createSkuInboundSchedulesAdapter(db);
assert.deepEqual((await adapter.loadAllSchedules()).map((row) => row.sellpia_sku), ["SKU-A"]);

const updated = await adapter.upsertSchedule({ sellpia_sku: "SKU-A", inbound_expected_date: "2026-10-09", own_code: "OWN-A2" });
assert.equal(updated.inbound_expected_date, "2026-10-09");
const inserted = await adapter.upsertSchedule({ sellpia_sku: "SKU-B", inbound_expected_date: "2026-10-10", own_code: null });
assert.equal(inserted.sellpia_sku, "SKU-B");
assert.equal(db.tables.sku_inbound_schedules.length, 2);

const currentItems = await adapter.loadCurrentItemsForSchedules([updated, inserted]);
assert.deepEqual(currentItems.map((row) => row.ord_no).sort(), ["O-1", "O-2"]);
await assert.rejects(
  adapter.upsertSchedules([
    { sellpia_sku: "SKU-X", inbound_expected_date: "2026-10-10" },
    { sellpia_sku: "SKU-X", inbound_expected_date: "2026-10-11" },
  ]),
  /중복 셀피아 SKU/,
);
assert.equal("deleteSchedule" in adapter, false, "the first version must not expose schedule deletion");

console.log("skuInboundSchedulesAdapter.mock.test: OK");
