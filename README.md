# Operation Hub

The company Operation Hub owns product matching, catalog and listing operations, pricing rules, source imports, and related seller workflows. Its deployed interface remains at the existing mockup path so links and test references keep working.

## Company Pages

- Canonical Hub: <https://w-works-official.github.io/Operation_Hub/mockups/operations-hub/>
- Root alias: <https://w-works-official.github.io/Operation_Hub/> (redirects to the canonical Hub)
- Picking System: <https://w-works-official.github.io/Picking_System/>

The personal deployment remains unchanged:

- Personal System V3 root: <https://kimhyein0214-dot.github.io/System_V3/>
- Personal Operations Hub: <https://kimhyein0214-dot.github.io/System_V3/mockups/operations-hub/>
- Personal Sellpia scraper: <https://kimhyein0214-dot.github.io/System_V3/tools/sellpia_scraper.html>
- Personal Sellpia memo updater: <https://kimhyein0214-dot.github.io/System_V3/tools/sellpia_memo_updater_0707_stockmatch.html>

## Ownership and production boundaries

`mockups/operations-hub/` is the Hub application and remains at this path. In `src/`, only `src/adapters/operationsHubMappingAdapter.mjs` belongs to Hub; the other `src/` application files belong to Picking System. Root Picking runtime, tools, PWA files, and assets are not Hub runtime.

Product image records and seller-original file records are canonical Hub-owned data and policy. Picking System consumes the Hub-owned product image Storage contract; it must not copy or maintain duplicate policy SQL. Both applications continue to use the existing production services and storage boundaries. This split changes repository ownership only; it does not migrate or rewrite production data, API, database, or storage.

Do not add a general shared package by assumption. A shared module requires an identified consumer and an explicit owner.

## Local checks

Use Node.js 22 or later. From this repository directory:

```powershell
npm ci
npm run check
npm test
npx playwright install chromium
npm run test:browser
npm run build
```

The curated 31 test files passed at the split baseline (91 assertions/subtests). The browser smoke uses only synthetic local services and blocks production requests. Historical browser and database tests are optional local checks: some need extra XLSX/PGlite setup, and a few retain machine-specific dependency paths. They are not the clean-clone CI gate. The Pages artifact contains only frontend runtime files; migrations, baseline archives, tests and dependencies are excluded. Pages workflows never deploy Supabase resources.

This source explains production ownership and migration provenance; it is not a clean database replay queue. Read [database ledger](docs/db-ledger.md) before any separately approved backend work.

See [repository boundary](docs/repository-boundary.md) for file ownership and [rollback](docs/rollback.md) for recovery anchors.
