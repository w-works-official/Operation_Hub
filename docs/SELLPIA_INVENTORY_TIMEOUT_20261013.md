# Sellpia inventory completion timeout — implementation and isolated verification

Repository: `w-works-official/Operation_Hub`
Base: `e0f5aabc8c667863a6a186018484a39df4bf6b12` (freshly fetched company `origin/main`)
Branch: `codex/sellpia-inventory-timeout-20261013`
Date: 2026-10-13 KST
Production writes, migration applies, uploads, snapshot cleanup, main merges and Pages deployments: **0**

## 1. Direct cause

The 2026-10-13 13:44:32.862 KST PostgreSQL error is SQLSTATE 57014 in the INSERT that preserves the unmodified base rows inside `finalize_operations_hub_sellpia_inventory_count`, called by `hub_sellpia_upload_complete_v2`. The original wrapper remains statement_timeout=90s and lock_timeout=5s.

Verified call order: inventory preview → file/mapping preflight → preview proof revalidation → intent and original XLSX Storage upload/finalize → changed rows in chunks of at most 500 via rows_v2 → **complete_v2** → requested-snapshot Matrix rebuild wait → four seller XLSX generation and reopen validation. The failed SQL precedes XLSX generation.

Chunk uploads commit independently. The completion transaction includes changed-row preservation UPDATE, full-row copy INSERT, snapshot ready and intent ready. A completion cancellation rolls that transaction back; previously committed upload chunks can remain.

## 2. Actual plan bottleneck

The existing composite PK (snapshot_id, sellpia_sku_code) and SKU index both exist. No index was added. Production has only the internal FK insert/update triggers on snapshot rows, with no user row trigger.

The production read-only EXPLAIN estimates **1 base row**, although that ready snapshot contains **23,816 rows**. Its UUID and the failed destination UUID are absent from the snapshot_id most-common-value statistics. Autoanalyze preceded the new ready base.

The chosen Nested Loop Anti plan scans the destination PK with an Index Cond on **snapshot_id only**; the SKU equality is a Join Filter. The INSERT writes to that same destination index. Newly inserted tuples remain invisible to the command but physically expand the range rescanned by the inner index operation.

The isolated PostgreSQL 17.6 reproduction with the same stale-statistics shape confirms:

| Isolated 76-change copy | Before | After |
| --- | ---: | ---: |
| Destination key scan loops | 23,816 | 1 |
| Destination key scan heap fetches | 283,589,096 | 76 |
| Destination key scan shared buffer hits | 33,748,903 | 26 |
| Copy execution | 56,561.257 ms | 958.114 ms |
| FK trigger calls | 23,740 | 23,740 |
| FK trigger total time | 117.261 ms | 119.759 ms |

The base scan itself took 38.761 ms in the original copy. The repeated destination scan, rather than the FK checks, accounts for the long run. Production historical per-statement WAL/I/O and lock wait time were not measured. The read-only investigation observed no lock wait at collection time; this does not prove absence of incident-time contention. Production track_io_timing is off and track_functions is none.

## 3. Why full copying remains necessary

`sellpia_stock_latest` reads the rows of one latest ready snapshot directly. Explicit snapshot reads, Matrix rebuilding, stock-source lookup, price/source/carrier readers and provenance rely on a complete materialized snapshot. Removing the copy would silently omit unchanged and not-in-this-file SKUs.

The input had 20,475 valid SKUs, but the existing ready universe contains 23,816 SKUs. With 76 changes, **23,740 preserved rows** are required under that contract. This implementation keeps that contract.

## 4. Chosen optimization and alternatives

A: Freeze the uploaded SKU set in a MATERIALIZED CTE and exclude it with NOT IN. Both SKU columns are NOT NULL through the composite PK, so exclusion semantics match the original NOT EXISTS. The measured plan builds a hashed SubPlan once, avoiding the growing destination index range. This remains efficient even when the new snapshot UUID is absent from statistics.

B: Delta snapshots would reduce row-copy, JSONB and WAL volume, but would require a resolver and coordinated changes to current/explicit reads, Matrix, exports, prices, source lineage and retention. That is a broader compatibility migration and was unnecessary after the minimal optimization succeeded.

C: Raising 90s to 180s was not used. Statement and lock timeouts remain unchanged. Refreshing statistics alone could improve the old plan but would not prevent recurrence when subsequent new UUIDs are missing from statistics.

## 5. Modified functions and code

Migration: `supabase/migrations/20261013045421_sellpia_inventory_count_fixed_key_copy.sql`

- `public.finalize_operations_hub_sellpia_inventory_count(uuid,jsonb)`: only the preserved-copy exclusion uses a fixed MATERIALIZED key relation and hashed NOT IN.
- `public.hub_sellpia_upload_complete_v1(text,uuid)`: full promotion takes the same advisory transaction lock already used by patch and inventory_count, so concurrent full completion cannot bypass the base-proof boundary.
- `operations_private.hub_sellpia_patch_read_v3(...)`: the existing carrier lineage follows both patch and inventory_count. A regression reproduced the pre-existing inventory_count carrier rejection before applying this one-clause repair.
- `supabase/functions/operations-hub-original-files/index.ts`: abort performs the locked DB failure transition before Storage deletion. Completion winning the intent lock therefore prevents deletion of a successfully ready original, including a lost-response race. A Storage deletion failure leaves failed/aborted state that cleanup can retry.

Migration and rollback include body/config/security drift checks. They accept only the captured baseline or reviewed fixed definitions and reject unexpected parallel changes.

No inventory UI, data-service implementation, collector, MCP or browser automation implementation was changed. The legacy price regression fixture was made independent of the execution date; no price algorithm changed.

## 6. Preserved contracts and failed operational state

Signatures, arguments, JSON response shapes, security mode, volatility, search_path, timeout configuration and existing ACL/owner contracts are preserved. Changed rows inherit the same non-stock fields. Copied rows retain stock, available stock, integrated stock, safety stock, supplier/product/procurement fields and identical JSONB provenance construction.

Tests cover NULL raw payload, negative source stock, raw sale/base prices, operational master precedence and existing calculation provenance. Inventory upload does not invoke price recalculation or update the operational master.

Production read-only evidence:

- Failed snapshot `a5557de2-4eca-46fe-afdc-af4b5f5b24de`: failed, 76 rows, intent aborted.
- Ready snapshot `a9878cb5-1a35-4537-9741-a2b840ebd6ad`: 23,816 rows, remains the current ready source and Matrix source.
- All 76 current source stock tuples equal the ready base; **0** equal the failed changed tuples.
- All 76 operational master rows exist. **0** master stock/any-update timestamps are at or after the failed upload. Stock timestamps are no later than September 15 and any-update timestamps no later than October 6.
- Operational master stock_quantity is a separate value: some happen to equal the failed source quantities, so numeric equality alone was not treated as evidence of application.
- No operational snapshot was removed, reused, promoted or modified.

Zero-change previews skip the inventory upload. Direct empty completion remains rejected. Unknown SKU payloads are rejected by the finalizer. Duplicate conflicts remain blocked by the frontend parser; the unchanged rows_v2 RPC retains its existing ON CONFLICT DO NOTHING retry behavior and is not represented as a standalone conflicting-duplicate validator.

## 7. Measured performance

Isolated Windows PostgreSQL 17.6, loopback-only database, work_mem=3500kB. Eleven historical snapshots were ANALYZEd before adding the new base; local table autovacuum was disabled solely to reproduce the incident's absent UUID statistics. No planner switch was used in the measured SQL. Expensive test assertions alone use a hash join preference.

Synthetic base: 23,816 rows; all-table fixture 285,792 rows. Mean row size 742.534 bytes versus production 743.880; mean raw JSONB text 311.534 bytes versus production 339.325 (maximum 312 versus 603). This is an isolated comparison, not a production time guarantee or percentile distribution.

| 23,816 total SKU; 76 changed | Before | After |
| --- | ---: | ---: |
| Completion RPC database execution | 58,319.720 ms | 1,388.038 ms |
| Full completion transaction client wall time | 58,454.315 ms | 1,520.126 ms |
| Preserved-copy SQL execution | 56,561.257 ms | 958.114 ms |
| Preserved-copy rows | 23,740 | 23,740 |
| JSONB preservation expression/merge count | unchanged / 23,740 | unchanged / 23,740 |
| Plan | growing destination Nested Loop Anti scan | fixed MATERIALIZED keys + hashed SubPlan |
| Full snapshot rows / missing | 23,816 / 0 | 23,816 / 0 |
| Raw price / product / master mismatches | 0 | 0 |
| Full transaction WAL bytes | 26,241,208 | 24,206,192 |

WAL remains about the same order of magnitude because full rows and both indexes are retained; checkpoint/full-page-write conditions can affect the numbers. The optimization targets repeated scanning.

After-fix completion measurements:

| Changed SKU | Total SKU | Database execution | Final completeness |
| ---: | ---: | ---: | --- |
| 0 | 23,816 | no upload; direct empty RPC rejected | existing ready preserved |
| 1 | 23,816 | 1,167.753 ms | 23,816 rows, no mismatches |
| 76 | 23,816 | 1,388.038 ms | 23,816 rows, no mismatches |
| 500 | 23,816 | 4,922.731 ms | 23,816 rows, no mismatches |
| 2,000 | 23,816 | 18,995.043 ms | 23,816 rows, no mismatches |
| 76 | 20,475 | 1,140.669 ms | 20,475 rows, no mismatches |

Only the representative 76-change before/after pair is reported. Unmeasured pre-fix counts are not estimated. Copy EXPLAIN ANALYZE and full completion are separate executions.

The retained JSONB expression was also measured on 20,475 rows with a read+merge+aggregate probe: 39.759–41.875 ms across three samples; a read-only aggregate took 14.680–19.624 ms. These include read and aggregate work and are not a pure JSONB CPU measurement or a before/after algorithm change.

## 8. Regression evidence

- Default `npm test`: **269 passed / 0 failed**.
- Existing inventory browser/UI regressions: **18 passed / 0 failed**. No new browser automation implementation.
- Isolated real PostgreSQL scenarios: **14 passed / 0 failed**, plus final guarded apply/reapply, drift rejection, rollback/reapply, real connection termination, actual fail endpoint and retry checks.
- `npm run check`: 60 syntax checks and boundary/client-credential/import checks passed.
- `npm run build`: passed in a fresh local output directory; no Pages deployment.
- `git diff --check`: passed.

Required coverage includes 0/1/76/500/2,000 changes; 20,475 and 23,816 total rows; real two-file 20,612 input/20,399 unchanged/137 unknown counts; unknown/duplicate blocking; partial chunk failure; copy cancellation; ready-promotion failure; connection termination; lost successful response; same-intent replay; same-base competing intents; full promotion serialization; base drift; Matrix pending/failure/export-only recovery; product/price/negative stock/provenance preservation; full/patch/inventory_count lineage; actual four-XLSX roundtrip regression.

Network interruption does not universally imply a DB rollback. An in-flight server-session termination was tested separately from successful commit with a lost response. Ready intents cannot be demoted; the original app's recovery for unknown success remains a fresh preview (which finds zero changes and avoids re-upload), rather than a new automatic same-intent recovery feature.

The real PostgreSQL harness uses an isolated session-auth stub and a fixture operational-master table. It does not reproduce every deployed Matrix materializer, Supabase Storage service or network intermediary. Those boundaries have executable SQL/app/edge regression tests; prohibited production write tests were not run.

## 9. Parallel development boundary

The worktree and branch are independent of `codex/sellpia-one-click-sync-20261013`. No files or commits in that worktree were changed, and no branch was force-pushed. The patch does not create or modify a Sellpia collector or MCP/browser integration. Existing RPC interfaces remain compatible with that work; future integration should inspect both diffs and honor the function drift checks.

## 10. Approved application and rollback procedure

This procedure is prepared for a later explicit Production approval. It has **not** been executed on Production.

1. Re-fetch company main and compare relevant DB definitions and original-files code with this reviewed baseline. Re-read current source/Matrix state. Preserve the failed snapshot as investigation evidence.
2. Back up the current three function definitions, their settings/ACL/owners and the deployed original-files revision. Apply the SQL file in a single explicit transaction. Its drift guard must pass; any drift means stop and revise/review, rather than bypassing the guard.
3. Deploy the reviewed existing `operations-hub-original-files` Edge Function change as a separately approved operation, preserving the existing authentication policy. This is required for the tested concurrent-abort original-file protection; SQL application alone does not deploy TypeScript.
4. Perform read-only signature/settings/ACL and ready/Matrix checks. Any operational upload validation requires separately approved fresh input and a fresh preview; never reuse or promote the failed incident snapshot.
5. Rollback SQL: `supabase/rollback/20261013045421_sellpia_inventory_count_fixed_key_copy.sql`, in a single explicit transaction after its drift check. It restores exactly the prior function bodies. Restore the previous Edge revision separately if the approved rollback requires it.
6. Rollback changes executable code only. It does not undo valid inventory changes, delete snapshots, reset intents or restore prior data. Never delete/reuse the investigation snapshot as part of rollback.

Reproduction:

```powershell
npm ci
npm test
npm run check
# PostgreSQL 17.x must already be running on loopback with the dedicated fixture DB.
# The runner accepts only 127.0.0.1 and database sellpia_timeout_test.
$env:SELLPIA_TEST_PSQL = 'C:\path\to\PostgreSQL\bin\psql.exe'
$env:SELLPIA_TEST_PORT = '55473'
node scripts/test-sellpia-inventory-count-timeout.mjs
# Optional quick final guarded apply/retry/connection check on the seeded fixture:
node scripts/test-sellpia-inventory-count-timeout.mjs --verify-final-migration
```

The harness resets only the named isolated fixture schemas/database. It must never be pointed at Production. Supabase CLI 2.120.0 created the migration. `supabase migration list --local` could not connect to the default Docker port 54322; the complete migration and rollback were instead executed on the isolated PostgreSQL 17.6 instance at port 55473.

Artifacts: `outputs/db-maintenance/sellpia-inventory-timeout-20261013/production-readonly.json`, `outputs/sellpia-inventory-count-timeout-results.json`, `outputs/sellpia-inventory-count-timeout-final-validation.json`, and `outputs/db-maintenance/sellpia-inventory-timeout-20261013/npm-test.log`.

**Ready for Production Approval:** Implementation, isolated performance reproduction, rollback and regression validation are complete. Production application awaits approval.
