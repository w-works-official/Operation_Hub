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

test("follow-up migration pins the trigger search path without breaking timestamps", { skip: !PGlite }, async () => {
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

    const foundation = await readFile(
      new URL("../supabase/pr_system_migrations/20261001093000_order_item_operations_foundation.sql", import.meta.url),
      "utf8",
    );
    const followUp = await readFile(
      new URL("../supabase/pr_system_migrations/20261001131748_fix_order_item_operations_trigger_search_path.sql", import.meta.url),
      "utf8",
    );
    await db.exec(foundation);
    await db.exec(followUp);

    const functionState = await db.query(`
      select prosecdef, proconfig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = 'set_order_item_operations_updated_at'
    `);
    assert.equal(functionState.rows.length, 1);
    assert.equal(functionState.rows[0].prosecdef, false, "function must remain SECURITY INVOKER");
    assert.deepEqual(functionState.rows[0].proconfig, ['search_path=""']);

    await db.exec(`
      insert into public.order_item_operations (
        ord_no,
        sellpia_order_item_no,
        item_no
      ) values ('QA-ORDER', 'QA-ROW', '1_QA-ROW');
    `);
    const inserted = await db.query(`
      select created_at, updated_at
      from public.order_item_operations
      where ord_no = 'QA-ORDER'
    `);
    assert.ok(inserted.rows[0].created_at);
    assert.ok(inserted.rows[0].updated_at);

    await db.exec(`
      update public.order_item_operations
      set internal_memo = 'trigger qa',
          updated_at = timestamptz '2000-01-01 00:00:00+00'
      where ord_no = 'QA-ORDER';
    `);
    const updated = await db.query(`
      select internal_memo, updated_at > timestamptz '2020-01-01 00:00:00+00' as trigger_applied
      from public.order_item_operations
      where ord_no = 'QA-ORDER'
    `);
    assert.equal(updated.rows[0].internal_memo, "trigger qa");
    assert.equal(updated.rows[0].trigger_applied, true, "trigger must replace the supplied timestamp with now()");
  } finally {
    await db.close();
  }
});
