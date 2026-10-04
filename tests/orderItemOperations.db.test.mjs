import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let PGlite;
try {
  const moduleUrl = process.env.CODEX_NODE_MODULES
    ? pathToFileURL(join(process.env.CODEX_NODE_MODULES, "@electric-sql", "pglite", "dist", "index.js")).href
    : "@electric-sql/pglite";
  ({ PGlite } = await import(moduleUrl));
} catch {}

test("order item operations migration preserves state across source cleanup and enforces its contract", { skip: !PGlite }, async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create table public.order_items (
        item_no text primary key,
        ord_no text not null,
        sellpia_order_item_no text,
        sellpia_outbound_confirmed_date date
      );
    `);
    const migration = await readFile(
      new URL("../supabase/pr_system_migrations/20261001093000_order_item_operations_foundation.sql", import.meta.url),
      "utf8",
    );
    await db.exec(migration);

    const supplierColumn = await db.query(`
      select data_type, is_nullable
      from information_schema.columns
      where table_schema='public' and table_name='order_items' and column_name='sellpia_supplier_cell_raw'
    `);
    assert.deepEqual(supplierColumn.rows, [{ data_type: "text", is_nullable: "YES" }]);

    await db.exec(`
      insert into public.order_items(item_no,ord_no,sellpia_order_item_no) values ('9_R1','O1','R1');
      insert into public.order_item_operations(
        ord_no,sellpia_order_item_no,item_no,inbound_expected_source,inbound_expected_date,
        sellpia_product_code_snapshot,supplier_cell_raw_snapshot
      ) values ('O1','R1','9_R1','manual','2026-10-10','SKU1','0-세븐피어싱 [ 1 ]');
    `);
    await assert.rejects(
      db.exec("insert into public.order_item_operations(ord_no,sellpia_order_item_no,item_no) values ('O1','R1','changed_R1')"),
      /unique|duplicate/i,
    );
    await db.exec("insert into public.order_item_operations(ord_no,item_no) values ('O2','legacy_1')");
    await assert.rejects(
      db.exec("insert into public.order_item_operations(ord_no,item_no) values ('O2','legacy_1')"),
      /unique|duplicate/i,
    );
    await assert.rejects(
      db.exec("insert into public.order_item_operations(ord_no,item_no,inbound_expected_source) values ('O3','I3','sku_schedule')"),
      /check/i,
    );
    await db.exec("insert into public.order_item_operations(ord_no,item_no,inbound_expected_source,inbound_expected_date) values ('O4','I4','manual',null)");

    await db.exec("delete from public.order_items where item_no='9_R1'");
    const surviving = await db.query("select count(*)::int as count from public.order_item_operations where ord_no='O1'");
    assert.equal(surviving.rows[0].count, 1, "source cleanup must not cascade into persistent operations");

    const policies = await db.query(`
      select policyname, cmd from pg_policies
      where schemaname='public' and tablename='order_item_operations'
      order by policyname
    `);
    assert.deepEqual(policies.rows.map((row) => row.cmd).sort(), ["INSERT", "SELECT", "UPDATE"]);
  } finally {
    await db.close();
  }
});
