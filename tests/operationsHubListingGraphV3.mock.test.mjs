import assert from "node:assert/strict";
import fs from "node:fs";

const migration = fs.readFileSync(
  new URL("../supabase/migrations/20260903055347_operations_hub_listing_graph_v3.sql", import.meta.url),
  "utf8",
);

assert.match(
  migration,
  /create or replace function public\.list_operations_hub_listing_graph_v3\([\s\S]*p_folder_id bigint default null[\s\S]*p_organization_scope text default 'all'[\s\S]*returns jsonb/,
  "V3 must retain the V2 RPC arguments and JSON response shape",
);

assert.match(
  migration,
  /security invoker[\s\S]*set statement_timeout = '5s'/i,
  "the read must preserve caller RLS and have a bounded timeout",
);
assert.match(
  migration,
  /revoke all on function public\.list_operations_hub_listing_graph_v3\([\s\S]*from public;[\s\S]*grant execute[\s\S]*to anon, authenticated;/i,
  "the RPC must not inherit PostgreSQL's default PUBLIC execute grant",
);

const baseIndex = migration.indexOf("candidate_base as materialized");
const allPageIndex = migration.indexOf("all_relation_page as materialized");
const classificationIndex = migration.indexOf("classification_components as materialized");
const enrichmentIndex = migration.indexOf("paged_components as materialized");
assert.ok(baseIndex > 0, "the query must build filtered listing candidates");
assert.ok(allPageIndex > baseIndex, "the common relation-all path must page filtered candidates");
assert.ok(classificationIndex > allPageIndex, "relation classification must happen after the relation-all page boundary");
assert.ok(enrichmentIndex > classificationIndex, "Sellpia enrichment must happen after candidate classification");

assert.match(
  migration,
  /all_relation_page as materialized \([\s\S]*where input\.relation_filter = 'all'[\s\S]*offset[\s\S]*limit[\s\S]*classification_input as materialized/,
  "the common unfiltered relation path must cap listing identities before spread classification",
);
assert.match(
  migration,
  /classification_input as materialized \([\s\S]*from all_relation_page[\s\S]*union all[\s\S]*from candidate_base[\s\S]*where input\.relation_filter <> 'all'/,
  "only explicit relation-type filters may classify the full filtered candidate set",
);

assert.match(
  migration,
  /candidate_base as materialized \([\s\S]*folder_filter[\s\S]*organization_scope[\s\S]*component_search_keys/,
  "folder, organization, and metadata search predicates must precede classification",
);
assert.match(
  migration,
  /classification_skus as materialized[\s\S]*global_sku_listing_edges as materialized[\s\S]*component\.sellpia_sku_code = candidate\.sellpia_sku_code[\s\S]*cache\.sellpia_sku_code = candidate\.sellpia_sku_code/,
  "global spread counts must probe only SKUs present in the classification input",
);

const enrichmentSlice = migration.slice(enrichmentIndex);
assert.match(
  enrichmentSlice,
  /from classification_components component[\s\S]*join paged_keys page[\s\S]*left join public\.operations_hub_sellpia_component_live/,
  "Sellpia metadata and stock must be joined only for paged listing keys",
);
assert.match(
  enrichmentSlice,
  /from paged_graph graph[\s\S]*seller_inventory_latest[\s\S]*operations_hub_change_queue/,
  "seller inventory and active draft lookups must remain page-scoped",
);
assert.doesNotMatch(
  migration,
  /operations_hub_listing_graph_live/,
  "V3 must not materialize the fully enriched compatibility view",
);

assert.match(
  migration,
  /'componentId'[\s\S]*'parentComponentId'[\s\S]*'mappingSource'[\s\S]*'availableStock'/,
  "component JSON must retain V2 fields",
);
assert.match(
  migration,
  /'rows'[\s\S]*'count'[\s\S]*candidate_base[\s\S]*relation_filtered[\s\S]*'page'[\s\S]*'pageSize'/,
  "response pagination and exact count metadata must retain V2 fields",
);
assert.match(
  migration,
  /when listing\.component_count > 1 and spread\.max_listing_count > 1 then 'multi_bundle'[\s\S]*then 'bundle'[\s\S]*then 'multi'[\s\S]*else 'single'/,
  "V3 must retain the V2 relation classification rules",
);

console.log("Operations hub listing graph V3 candidate-first contract: passed");
