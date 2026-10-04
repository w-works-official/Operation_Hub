import assert from "node:assert/strict";
import { createAlimtalkSendAdapter } from "../src/adapters/alimtalkSendAdapter.mjs";

function createMemoryDb() {
  const tables = { alimtalk_send_batches: [], alimtalk_send_items: [] };
  let nextBatchId = 1;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  function query(table) {
    const state = { table, mode: "select", filters: [], payload: null };
    const api = {
      select() { return api; },
      eq(column, value) { state.filters.push((row) => row[column] === value); return api; },
      order() { return api; },
      insert(payload) { state.mode = "insert"; state.payload = payload; return api; },
      update(payload) { state.mode = "update"; state.payload = payload; return api; },
      then(resolve, reject) {
        try {
          let rows = tables[state.table].filter((row) => state.filters.every((filter) => filter(row)));
          if (state.mode === "insert") {
            const sources = Array.isArray(state.payload) ? state.payload : [state.payload];
            rows = sources.map((source) => ({
              id: state.table === "alimtalk_send_batches" ? nextBatchId++ : tables[state.table].length + 1,
              created_at: "2026-07-28T00:00:00.000Z",
              ...source,
            }));
            tables[state.table].push(...rows);
          }
          if (state.mode === "update") rows.forEach((row) => Object.assign(row, state.payload));
          resolve({ data: clone(rows), error: null });
        } catch (error) { reject(error); }
      },
    };
    return api;
  }
  return { from: query, tables };
}

const db = createMemoryDb();
const adapter = createAlimtalkSendAdapter(db);
const batch = await adapter.createExportBatch({ items: [
  { ord_no: "order-1", template_key: "d1", inv_no: "invoice-1" },
  { ord_no: "order-1", template_key: "d1", inv_no: "invoice-1" },
  { ord_no: "order-1", template_key: "d3_pf", inv_no: "invoice-1" },
] });

assert.equal(batch.status, "exported");
assert.equal(batch.target_count, 2);
assert.equal((await adapter.loadUnconfirmedBatches()).length, 1);

await adapter.confirmExportBatch(batch.id);
assert.equal((await adapter.loadUnconfirmedBatches()).length, 0);
assert.equal(db.tables.alimtalk_send_items.every((row) => row.status === "sent" && row.sent_at), true);

const repeatedBatch = await adapter.createExportBatch({ items: [
  { ord_no: "order-1", template_key: "d1", inv_no: "invoice-1" },
] });
await adapter.confirmExportBatch(repeatedBatch.id);
assert.equal(
  db.tables.alimtalk_send_items.filter((row) => row.ord_no === "order-1" && row.template_key === "d1" && row.status === "sent").length,
  2,
  "the same order and template can be confirmed again in another export batch",
);

console.log("Alimtalk send history adapter: passed");
