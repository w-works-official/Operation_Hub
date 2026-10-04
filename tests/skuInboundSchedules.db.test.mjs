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

test("SKU inbound schedule migration enforces one additive schedule per Sellpia SKU", { skip: !PGlite }, async () => {
  const db = new PGlite();
  try {
    await db.exec("create role anon; create role authenticated;");
    const migration = await readFile(
      new URL("../supabase/pr_system_migrations/20261001140506_sku_inbound_schedules.sql", import.meta.url),
      "utf8",
    );
    await db.exec(migration);

    await db.exec(`
      insert into public.sku_inbound_schedules(sellpia_sku, inbound_expected_date, own_code)
      values ('SKU-A', '2026-10-08', 'OWN-A');
    `);
    await assert.rejects(
      db.exec("insert into public.sku_inbound_schedules(sellpia_sku, inbound_expected_date) values ('SKU-A','2026-10-09')"),
      /unique|duplicate/i,
    );
    await assert.rejects(
      db.exec("insert into public.sku_inbound_schedules(sellpia_sku, inbound_expected_date) values (' SKU-B ','2026-10-09')"),
      /check/i,
    );

    await db.exec(`
      update public.sku_inbound_schedules
      set inbound_expected_date = '2026-10-10',
          updated_at = timestamptz '2000-01-01 00:00:00+00'
      where sellpia_sku = 'SKU-A';
    `);
    const updated = await db.query(`
      select inbound_expected_date::text as inbound_expected_date,
             updated_at > timestamptz '2020-01-01 00:00:00+00' as trigger_applied
      from public.sku_inbound_schedules where sellpia_sku = 'SKU-A'
    `);
    assert.equal(updated.rows[0].inbound_expected_date, "2026-10-10");
    assert.equal(updated.rows[0].trigger_applied, true);

    const functionState = await db.query(`
      select prosecdef, proconfig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'set_sku_inbound_schedules_updated_at'
    `);
    assert.equal(functionState.rows[0].prosecdef, false);
    assert.deepEqual(functionState.rows[0].proconfig, ['search_path=""']);

    const policies = await db.query(`
      select cmd from pg_policies
      where schemaname='public' and tablename='sku_inbound_schedules'
      order by cmd
    `);
    assert.deepEqual(policies.rows.map((row) => row.cmd), ["INSERT", "SELECT", "UPDATE"]);

    const privileges = await db.query(`
      select privilege_type
      from information_schema.role_table_grants
      where table_schema='public'
        and table_name='sku_inbound_schedules'
        and grantee='anon'
      order by privilege_type
    `);
    assert.deepEqual(privileges.rows.map((row) => row.privilege_type), ["INSERT", "SELECT"]);
    const updateColumns = await db.query(`
      select column_name
      from information_schema.column_privileges
      where table_schema='public'
        and table_name='sku_inbound_schedules'
        and grantee='anon'
        and privilege_type='UPDATE'
      order by column_name
    `);
    assert.deepEqual(updateColumns.rows.map((row) => row.column_name), [
      "inbound_expected_date",
      "own_code",
      "updated_at",
    ]);
  } finally {
    await db.close();
  }
});
