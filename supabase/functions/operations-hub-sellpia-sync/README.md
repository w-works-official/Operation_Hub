# Operational integration (2026-10-13)

This backend continues the existing collector. Production remains disabled until
the separately approved deployment completes. Queue metadata and staged source
files are private. The company-PC runner receives collector authority only.

Apply SQL in order: timeout optimization
`20261013045421_sellpia_inventory_count_fixed_key_copy.sql`, then
`20261013071210_sellpia_sync_operational_queue.sql`. The latter preserves the
timeout-optimized import bodies as private delegates and adds guards to both
existing `hub_sellpia_upload_complete_v1` and `_v2` signatures. Never apply the
timeout rollback after the sync wrapper without first reviewing the definitions.

Edge functions: `operations-hub-sellpia-sync` and the updated
`operations-hub-original-files`. Both must validate the custom operator session;
function JWT verification configuration must permit the handler to perform that
validation. Keep `seller-originals` private. Collector staging has restrictive
anon/authenticated RLS in addition to existing permanent-original boundaries.

Secrets stay in Edge/runtime settings: `SELLPIA_SYNC_ENABLED`,
`SELLPIA_SYNC_APPLY_ENABLED`, and `SELLPIA_SYNC_WORKERS_JSON` (worker-ID to random
secret of at least 32 characters). Legacy `SELLPIA_SYNC_WORKER_ID` plus
`SELLPIA_SYNC_WORKER_TOKEN` remain supported for one PC. The permanent-original
function also checks `SELLPIA_SYNC_APPLY_ENABLED`. No worker receives an operator
session, service-role key, apply token, or other worker's secret.

`sellpia_sync_config.apply_enabled=false` is the independent default DB gate.
Normal enqueue always collects full three-file originals, but freezes a separate
`applicationMode` (`full` or `patch`) and selected fields. Full applies the same
all-field contract as existing manual full replacement. Patch uses the existing
selected-field finalizer; complete source collection does not imply all-field
replacement. Unknown comparison, missing baseline, major SKU addition, removal,
or review-required results cannot auto-apply. Initial reviewed exceptional source
may be approved by an exact fingerprint only after operator review; the initial
config has no exception. A reviewed fingerprint does not waive baseline guards.
Authenticated availability returns `applicationPolicy` with `maxAddedCount`,
`maxAddedRatio`, `maxRemovedCount`, and `approvedSourceFingerprint`. The hash is
review evidence for the exact source only; it grants no apply authority and is
not sent to the collector. Edge/DB activation and scoped authorization still
apply even when the fingerprint matches.

Browser actions are enqueue/status/artifacts/cancel/cancel-request/receipt plus
availability/history/apply-init/apply-progress. All require the existing custom
session and exact company/loopback Origin. Jobs are owned by operator username.
Worker actions are claim/heartbeat/report/upload-init/upload-finalize and hello;
worker authentication uses a distinct per-worker secret and accepts no Origin.

Apply-init returns a short-lived job-bound apply token only to the browser.
Original upload-init adds `sync_job_id` and `sync_apply_token` and delegates to
the existing signed original upload-intent function. File identities, hashes,
selected fields, application mode, baseline and source count are immutable.
Permanent original bytes are checked again before upload-finalize. Imports use
the existing bounded row RPCs and completion functions; the runner never UPSERTs
source tables. Completion serializes with manual full/patch/inventory finalizers,
rechecks the baseline and atomically records the ready snapshot on the job.

Status/history/availability reconcile an already committed import after response
loss. They only inspect its existing intent/snapshot/Matrix proof. Matrix failure
or a page reload must resume Matrix waiting, not recreate or re-upload a source.
Complete is recorded only when the actual Matrix snapshot matches the imported
snapshot and rebuild is no longer pending. Price-calculation warnings remain a
separate client result after source and Matrix proof.

Hello records health; no heartbeat for 90 seconds displays offline. A lost worker
lease cannot finalize. A failed/cancelled staging file is cleaned only after three
hours (past upload capability expiration); previews and complete jobs retain
staging seven days. Permanent `sellpia/<snapshot>` files are never removed by
collector cleanup. Cleanup is server-only and bounded to 30 staging objects.

Rollback file restores original importer delegates and disables apply while
retaining snapshots, original files and private audit history. Resolve an active
import first; frontend rollback is not a data rollback. Stop the worker and
disable Edge gates before rolling back UI/backend code. Do not delete an already
ready snapshot to resolve a Matrix error.

Isolated tests: `node --test tests/operationsHubSellpiaSyncBackend.db.test.mjs
tests/operationsHubSellpiaSyncQueue.test.mjs`. The helper uses shipped signed
upload, full/patch, completion and actual Matrix refresh SQL on synthetic schema.
