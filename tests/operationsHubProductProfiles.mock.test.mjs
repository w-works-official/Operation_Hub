import assert from "node:assert/strict";
import fs from "node:fs";

const migration = fs.readFileSync(
  new URL("../supabase/migrations/20260818024647_operations_hub_product_profiles.sql", import.meta.url),
  "utf8",
);
const data = fs.readFileSync(new URL("../mockups/operations-hub/data-service.js", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../mockups/operations-hub/app.js", import.meta.url), "utf8");

assert.match(migration, /create table if not exists catalog\.sellpia_product_attributes[\s\S]*?primary key/, "product-level attributes need a durable product-code primary key");
assert.match(migration, /material_source[\s\S]*?product_group_source[\s\S]*?shape_source[\s\S]*?classifier_version/, "attribute provenance and classifier version must be preserved");
assert.match(migration, /on conflict \(sellpia_product_code\) do nothing/, "initial classification must never overwrite existing manual values");
assert.match(migration, /operations_hub_product_profiles[\s\S]*?product_tags[\s\S]*?sku_tags[\s\S]*?tag_summary/, "the read model must combine product tags and SKU exception tags");
assert.match(migration, /enable row level security[\s\S]*?sellpia product attributes readable[\s\S]*?security_invoker = true/, "profile reads and writes must honor RLS");
assert.match(migration, /save_operations_hub_product_profile[\s\S]*?tag_scope = 'product'[\s\S]*?tag_scope = 'option'/, "profile saves must maintain product and SKU scopes separately");
assert.doesNotMatch(migration, /product_tag_assignments/, "the review queue assignment table must not be repurposed for operational tags");
assert.match(data, /function attachProductProfiles[\s\S]*?attachProductMetadata/, "matrix pages must attach live product profiles without replacing the base matrix view");
assert.match(app, /const tagSummary = \[profile\.shape, profile\.tag_summary\]/, "matrix rows must compose shape and saved tags");
assert.match(app, /profile\.material[\s\S]*?profile\.product_group[\s\S]*?profile-tags-cell/, "matrix operation columns must render profile data instead of placeholders");

console.log("Operations hub product attributes and tags contract: passed");
