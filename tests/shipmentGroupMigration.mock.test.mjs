import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sql = await readFile(new URL("../supabase/migrations/20260811140611_create_shipment_groups.sql", import.meta.url), "utf8");

for (const token of [
  "create table if not exists public.shipment_groups",
  "create table if not exists public.shipment_group_members",
  "create table if not exists public.shipment_group_events",
  "create or replace function public.create_shipment_group",
  "create or replace function public.change_shipment_representative",
  "create or replace function public.release_shipment_group",
  "create or replace function public.save_shipment_group_drawer_memo",
  "create or replace function public.save_shipment_group_item_memo2",
  "security invoker",
  "enable row level security",
  "shipment_group_members_one_active_group_idx",
]) {
  assert.equal(sql.toLowerCase().includes(token), true, `migration must contain ${token}`);
}

const lifecycleSql = sql.slice(
  sql.indexOf("create or replace function public.create_shipment_group"),
  sql.indexOf("create or replace function public.save_shipment_group_drawer_memo"),
);
assert.equal(/update\s+public\.orders/i.test(lifecycleSql), false, "group lifecycle RPCs must not overwrite original orders");
assert.equal(/update\s+public\.order_items/i.test(lifecycleSql), false, "group lifecycle RPCs must not overwrite original items");
assert.match(sql, /update\s+public\.order_items\s+oi\s+set\s+o_shop_memo\s*=\s*v_drawer_memo/i);
assert.match(sql, /where\s+ord_no\s*=\s*v_ord_no\s+and\s+item_no\s*=\s*v_item_no/i);
assert.match(sql, /insert\s+into\s+public\.workflow_item_events/i);
assert.equal(sql.includes("where active;"), true, "one active group per original order must be enforced");

console.log("Shipment group migration contract: passed");
