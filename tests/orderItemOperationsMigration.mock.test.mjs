import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sql = await readFile(
  new URL("../supabase/pr_system_migrations/20261001093000_order_item_operations_foundation.sql", import.meta.url),
  "utf8",
);

assert.match(sql, /TARGET: picking project vgxocngpykhlkosiaeew only/);
assert.match(sql, /alter table public\.order_items\s+add column if not exists sellpia_supplier_cell_raw text/i);
assert.match(sql, /create table if not exists public\.order_item_operations/i);
assert.match(sql, /operation_id uuid primary key default gen_random_uuid\(\)/i);
assert.match(sql, /order_item_operations_identity_present_check/i);
assert.match(sql, /inbound_expected_source in \('manual', 'sku_schedule'\)/i);
assert.match(sql, /create unique index if not exists order_item_operations_regular_identity_uidx[\s\S]*where nullif\(btrim\(sellpia_order_item_no\), ''\) is not null/i);
assert.match(sql, /create unique index if not exists order_item_operations_legacy_identity_uidx[\s\S]*where nullif\(btrim\(sellpia_order_item_no\), ''\) is null/i);
assert.match(sql, /alter table public\.order_item_operations enable row level security/i);
assert.match(sql, /grant select, insert on table public\.order_item_operations to anon, authenticated/i);
assert.match(sql, /grant update \([\s\S]*inbound_expected_date[\s\S]*supplier_cell_raw_snapshot[\s\S]*\) on table public\.order_item_operations to anon, authenticated/i);
assert.doesNotMatch(sql, /grant delete/i);
assert.doesNotMatch(sql, /references\s+public\.(?:orders|order_items)|on delete cascade/i);
assert.doesNotMatch(sql, /insert into|update public\.order_items|delete from/i, "migration must not transform production order data");

console.log("orderItemOperationsMigration.mock.test: OK");
