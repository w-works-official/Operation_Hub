# Repository boundary

## Company repositories and URLs

| Purpose | Repository / URL |
| --- | --- |
| Company Operation Hub | `w-works-official/Operation_Hub`; canonical Pages URL <https://w-works-official.github.io/Operation_Hub/mockups/operations-hub/> |
| Hub root alias | <https://w-works-official.github.io/Operation_Hub/> redirects to the canonical Hub URL above |
| Company Picking System | `w-works-official/Picking_System`; Pages URL <https://w-works-official.github.io/Picking_System/> |
| Personal deployment, unchanged | <https://kimhyein0214-dot.github.io/System_V3/>; Hub <https://kimhyein0214-dot.github.io/System_V3/mockups/operations-hub/>; scraper <https://kimhyein0214-dot.github.io/System_V3/tools/sellpia_scraper.html>; memo updater <https://kimhyein0214-dot.github.io/System_V3/tools/sellpia_memo_updater_0707_stockmatch.html> |

The company Hub keeps `mockups/operations-hub/` as its application path to retain existing URLs and tests. The Hub root page is only a redirect/landing alias. Personal repository paths and deployments remain unchanged.

## Ownership

- Hub UI and runtime: `mockups/operations-hub/**`.
- Hub adapter: `src/adapters/operationsHubMappingAdapter.mjs` only. The remaining `src/` runtime is Picking System owned.
- Picking System owns the root Picking application entry, other root `src/` runtime, `tools/`, `assets/`, service worker, and web manifest. These are not shared merely because they existed in the pre-split repository.
- Hub tests are retained in `tests/`, but curated offline Hub tests form the clean-clone CI gate. Tests that inspect Picking runtime or tools remain with the Picking integration/history set and are not Hub-only checks.
- Product image records and seller-original file records have canonical ownership and policy in Operation Hub. Picking System is a consumer. Keep policy SQL canonical in Hub; do not copy policy migrations or create duplicate owners.
- Root scripts, package manifests, workflows, and test policy are managed by the split coordinator, not implicitly owned as Hub files.

No blanket shared package is introduced. Identify an actual consumer and ownership decision before extracting a shared module.

## Hub fixture ownership

Hub tests use these checked-in fixtures:

- `tests/fixtures/ably/ably-price-projection-synthetic.xlsx`
- `tests/fixtures/representativeWiringFixture.mjs`
- `tests/fixtures/sellerMedium1181.json`

`tests/fixtures/customOrderPreviewSupabase.js` is used by the Picking custom-order preview helper, not Hub-only tests. External fixtures supplied through environment variables are not repository-owned fixtures.

## Production boundaries

The split changes source ownership and deployment routing only. It does not authorize or perform production database, API, Storage, or data changes. Picking System continues consuming the existing Hub-owned product-image Storage contract. No Picking seller-original consumer was identified in the copied runtime. Git rollback alone does not reverse production service or data changes.
