# Rollback

## Source rollback anchor

The pre-split Hub source anchor is commit `5e074e47f9c191c12411524fd3fbbc84c955400b` (`5e074e4`). It remains in company Git history and a local `Operation_Hub-before-split.bundle` backup. No recovery tag was created. Personal production remains at `491e251ac427954a457e67dc680d9442788e995e`. If the company Hub release needs source rollback, restore/revert the Hub repository to the pre-split commit through a reviewed Git change, then publish the restored Hub build through the normal release process. Never force-push or rewrite the personal repository as a recovery step.

This anchor predates the repository split. It contains the combined application layout, so restoring it is a source recovery point, not a final split layout; coordinate the company Picking repository and root alias before using it as a deployed state.

## URL recovery

The intended company Hub URL is <https://w-works-official.github.io/Operation_Hub/mockups/operations-hub/>. The root URL <https://w-works-official.github.io/Operation_Hub/> is an alias that redirects there. If the alias fails, link directly to the canonical URL while the root-page redirect is repaired. Company Picking remains at <https://w-works-official.github.io/Picking_System/>.

Personal URLs are out of scope and remain unchanged: root <https://kimhyein0214-dot.github.io/System_V3/>, Hub <https://kimhyein0214-dot.github.io/System_V3/mockups/operations-hub/>, scraper <https://kimhyein0214-dot.github.io/System_V3/tools/sellpia_scraper.html>, and memo updater <https://kimhyein0214-dot.github.io/System_V3/tools/sellpia_memo_updater_0707_stockmatch.html>.

## Production recovery boundary

The split and this source rollback procedure make no production database, API, Storage, or data changes. Do not run SQL rollback or copy policy SQL as part of a Git rollback. If a later, separately authorized production change needs recovery, use that change's own reviewed snapshot and compensation plan; reverting Git cannot restore production data or Storage objects.
