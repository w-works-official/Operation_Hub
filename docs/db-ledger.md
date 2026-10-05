# Database source ownership and live ledger

Captured 2026-10-05 using read-only Supabase connector calls. Project: `bpgvqmtsjgegnrdzmpep`. No database, Storage, API, cron or function deployment write occurred.

## Ownership

This repository owns Operations Hub and its product-image policies. Picking owns all nine legacy pr_system_migrations and eleven formerly mixed root migrations. The image-project-migrations directory targets this Hub project; it is not a third database. The retired manual-order-stock integration migrations remain Hub history; cancellation must remain effective.

## Baseline is an archive, not a deployment queue

- Live migration count: 285.
- Company-owned SQL count at split: 222 (before approved retention-source recovery).
- Exact version matches at split: 59. Name matches at split: 217.
- Live-only by name at split: 68; repo-only by name: 5.
- Version-only differences: live 226, repo 163. Local timestamps often differ from live applied timestamps.
- Read-only schema_migrations columns verified: version, statements, name, created_by, idempotency_key, rollback. Only version, name, statements and derived statement counts/hashes were retrieved; user/idempotency metadata was not copied.

`supabase/baseline/live-ledger-20261005.json` records every live version/name, statement count, live body SHA-256, company source-by-name, candidate historical sources and explicit equivalence limitations. The SHA is computed over UTF-8 `array_to_string(statements, LF)`; it is not the hash of an archive JSON file. Source filename/name matches do not prove body equivalence.

Live-only statement bodies were recovered from migration history using SELECT, not from application row tables. 67 non-runnable `*.statements.json` archives preserve retained statement texts with original array indexes. The initial literal-secret scan was insufficient. A subsequent expanded assignment/comparison, bearer/JWT and embedded-credential URL scan found a deployed import-secret constant and one SQL p_secret literal comparison; both were removed from public source/archives. Top-level data-write statements were withheld conservatively; omitted indexes remain in the ledger. These files are outside `supabase/migrations` and must never be auto-applied, treated as a clean replay baseline, or used to repair production ledger versions.

The three already-live retention migrations and two tests were copied from approved source commit 46023a6450ec6c2492ee24800a9d696e8ca43cf0 with LF line-ending normalization. No retention SQL was executed. Current cron metadata confirms jobs14,15,16,18 active and cancelled-history job17 inactive (job13 selected-source retention also active).

## Review requirements

- NEEDS_REVIEW: `20260618062426_product_image_storage_assets`: 1 original statement(s) withheld; retained 14/15.
- NEEDS_REVIEW: `20260618094115_manual_product_tags_day1`: 1 original statement(s) withheld; retained 22/23.
- Duplicate local migration version20260910090000: hub_calculated_export_stream and hub_seller_unmatched_templates. Automatic migration push is blocked pending explicit migration-history review; preserve filenames for existing tests.
- Five repo-only names: operations_hub_read_model, operations_hub_matrix_presets, cache_operations_hub_csv_export, nonblocking_operations_hub_csv_cache, operations_hub_inventory_survey. The last resembles live create_operations_hub_inventory_survey, but equivalence is unproven.
- Eighteen previously source-unlocated live names are now represented by live ledger archives; neither a filename scan nor recovery proves repository replay completeness.
- No supabase/config.toml existed in the source. Do not infer project linkage or create a guessed deploy config.

## Edge Functions

Four live ACTIVE functions were listed. operations-hub-original-files v5 already had company source; deployed/body equivalence remains unproven. Three missing sources were retrieved read-only. migrate-google-product-image v3 and upload-product-image v1 have no literal credential identified by the expanded scan; upload credentials are read from Deno.env. import-mapping-batch-20260729 v3 PUBLIC SOURCE IS SANITIZED/NEEDS_REVIEW: the deployed literal import secret was removed, replaced by Deno.env.get('MAPPING_IMPORT_SECRET'), and an explicit guard rejects every import when the env variable is absent/empty. This source differs from deployed code. A future deployment requires separately authorized provisioning of MAPPING_IMPORT_SECRET; no deployment or secret provisioning occurred. Deployed bundle SHA values remain historical metadata only. Observed verify_jwt=false metadata was not changed. See baseline/edge-functions-20261005.json.

Historical archive code may contain operational functions that write when executed. Its preservation is provenance only, not authorization or a recommendation to execute it.

Verification: all65 complete Hub statement archives recomputed SHA-256 equal to the live ledger hashes (zero failures). Two partial archives intentionally cannot reproduce the full body hash. The three retention SQL files and two tests match approved source content after line-ending/trailing-newline normalization.

Security correction: NEEDS_REVIEW 20260729070553_add_sheet_mapping_page_rpc contains a literal authorization secret in its live history. Its entire stored statement archive was removed; only safe version/name/count/hash/provenance remains.65 complete archives plus2 partial archives remain. No original sensitive literal is retained in public files.

