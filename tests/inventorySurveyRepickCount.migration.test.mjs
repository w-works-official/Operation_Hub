import assert from "node:assert/strict";
import fs from "node:fs";

const migration = fs.readFileSync(
  new URL("../supabase/pr_system_migrations/20260907113000_include_shortage_repick_in_inventory_counts.sql", import.meta.url),
  "utf8",
);

assert.match(migration, /current_pick_state/);
assert.match(migration, /'shortage_repick_completed'/);
assert.match(migration, /'shortage_created'/);
assert.match(migration, /'shortage_qty_changed'/);
assert.doesNotMatch(migration, /event_at at time zone 'Asia\/Seoul'/);
assert.match(migration, /join current_pick_state state[\s\S]*?normal_picked/);
assert.match(migration, /join current_pick_state state[\s\S]*?shortage_drawer_picked/);

console.log("Inventory count includes current shortage-repick completion: passed");
