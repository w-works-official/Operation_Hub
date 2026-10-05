# Frontend release and cutover checklist

## Checkpoints and scope

- Personal production source: `kimhyein0214-dot/System_V3` at `491e251ac427954a457e67dc680d9442788e995e`.
- Pre-split company source: `Operation_Hub` at `5e074e47f9c191c12411524fd3fbbc84c955400b` (a production snapshot, not the complete personal Git history).
- Company Hub keeps `mockups/operations-hub/`; company Picking owns the root Picking runtime and Sellpia tools.
- Existing Supabase projects remain Hub `bpgvqmtsjgegnrdzmpep` and Picking `vgxocngpykhlkosiaeew`. They are not copied or reset.
- Code commit/push and static Pages release are the only remote writes in this split. No DB SQL, Edge deployment, Storage write, credential change, personal repo push or personal Pages change is a release step.

## Pages setup (company owner web login required)

For each company repository, use Settings > Pages > Build and deployment > Source: GitHub Actions. Then run the Pages workflow, after CI is green, if changing the source did not trigger deployment. The workflow packages only `_site/`. It cannot create or enable a Pages site without existing repository authorization. Do not create a PAT or change personal credentials to work around an expired company browser login.

A company source commit with green CI is NOT evidence that a Pages URL is deployed. Check the deployment result and the actual URL separately. Until company Picking is live, the old company Hub tools redirects point to an unavailable destination; use the unchanged personal tools for production work.

## October 6 and October 7

- October 6: continue production work on the personal System_V3 URLs, with no extra feature development or deployment in the migration window.
- Company Pages can be prepared alongside this work without touching personal source or production schema.
- Both old and new frontends point to the SAME live data for each app. New company pages are not a sandbox: do not duplicate operational writes during QA.
- October 7 is a target, not an automatic cutover. Switch only after the checks below pass and the user confirms operational readiness.

## Read-only readiness checks

- [ ] Company web login can configure both Pages sites; CI and Pages runs succeed.
- [ ] Hub root redirects to `https://w-works-official.github.io/Operation_Hub/mockups/operations-hub/`.
- [ ] Existing Hub login works; Matrix, multi-seller rows, original file reads and seller export previews load. Do not submit imports or exports that modify server state.
- [ ] Picking `https://w-works-official.github.io/Picking_System/` renders dashboard, order/custom-order and picking screens. Use historical/read-only views.
- [ ] Both Sellpia tool URLs and local assets return successfully; do not run marketplace update/bookmarklet actions.
- [ ] Hub-owned product image reads work from Picking. Upload/rename/delete QA requires a separate controlled approval.
- [ ] Manifest/start_url/scope/icon and network-only service worker are valid under `/Picking_System/`. New origin requires a separate app login and new PWA installation/bookmark if used.
- [ ] Personal root, personal nested Hub, personal tools and personal main SHA are unchanged.

## Backend reconciliation is not a deploy queue

Read `docs/db-ledger.md` and `supabase/baseline/README.md`. Preserved historical ledger archives are provenance, not clean replay migrations. Timestamp/body equivalence gaps, withheld sensitive/data-write statements, duplicate Hub migration versions and sanitized Edge source remain explicitly NEEDS REVIEW. No automatic `supabase db push`, migration apply or function deployment may run from Pages CI. Sanitized import function source must NOT be deployed without separately authorized secret provisioning and review.

## Rollback and old URL conversion

Before any personal URL notice-page conversion, preserve the exact operational commit/checkpoint separately under a future approved change. This split does not convert those pages. If company pages fail, keep using personal URLs; no DB rollback is needed because no DB changes accompany this release. Revert only the company frontend change through a normal reviewed commit if necessary. Never delete the personal history, branches or worktrees during cutover.

