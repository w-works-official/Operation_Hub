import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sql = await readFile(
  new URL("../supabase/pr_system_migrations/20261001140506_sku_inbound_schedules.sql", import.meta.url),
  "utf8",
);

assert.match(sql, /TARGET: picking project vgxocngpykhlkosiaeew only/i);
assert.match(sql, /create table if not exists public\.sku_inbound_schedules/i);
assert.match(sql, /sellpia_sku text primary key/i);
assert.match(sql, /inbound_expected_date date not null/i);
assert.match(sql, /set search_path = ''/i);
assert.match(sql, /alter table public\.sku_inbound_schedules enable row level security/i);
assert.match(sql, /grant select, insert on table public\.sku_inbound_schedules to anon, authenticated/i);
assert.match(sql, /grant update \([\s\S]*?inbound_expected_date,[\s\S]*?own_code,[\s\S]*?updated_at[\s\S]*?\) on table public\.sku_inbound_schedules/i);
assert.doesNotMatch(sql, /grant delete/i);
assert.doesNotMatch(sql, /for delete/i);
assert.doesNotMatch(sql, /update\s+public\.(orders|order_items|order_item_operations)/i);
assert.doesNotMatch(sql, /delete\s+from/i);
assert.doesNotMatch(sql, /references\s+public\.(orders|order_items)/i);

console.log("skuInboundSchedulesMigration.mock.test: OK");
