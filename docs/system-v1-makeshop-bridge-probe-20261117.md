# System_v1 × Makeshop bridge: isolated capability probe (2026-11-17)

## Ownership and scope

- Supabase project: `System_v1` (`bpgvqmtsjgegnrdzmpep`)
- Repository: `w-works-official/Operation_Hub`
- This is **not** an authorization to deploy migrations, change cron schedules, prune records, or register a live Makeshop webhook.
- Existing Operations Hub tables, RPCs, triggers, storage, cron jobs and four pre-existing Edge Functions were not modified.
- Deployed one new function: `makeshop-bridge-probe-20261117` (version 2, ACTIVE, `verify_jwt=true`).
- The code in `experiments/` is intentionally outside the current production application and migrations folders.

## Verified integration behavior

| Probe | Method | Observed |
| --- | --- | --- |
| HTTPS health | PostgreSQL `extensions.http_get` → new Edge Function | HTTP 200, `phase=health` |
| Synthetic JSON delivery | PostgreSQL `extensions.http_post` → new Edge Function | HTTP 200, `phase=synthetic_post`, `persisted=false` |
| Edge outbound HTTPS | Edge Function → `https://api.ipify.org?format=json` | HTTP 200, one observed egress IP `15.164.251.1` |
| Default authentication after lock-down | No credentials → function | HTTP 401 `UNAUTHORIZED_NO_AUTH_HEADER` |

The observed IP is **not** a static or contractual outbound IP. No authenticated Makeshop API request and no actual Makeshop TEST delivery have been attempted. This proof-of-concept accepts synthetic POST only; requests with Makeshop webhook signature/id headers return 503 rather than acknowledging undurably.

## Read-only database cleanup measurement

The existing `operations_private.prune_operations_hub_cancelled_history_v1()` filter was reproduced as a SELECT, preserving its 30-day cutoff, export evidence, recent/exported events and active batch protection:

- Cancelled queue rows: **49,907**
- Queue rows matching its eligibility filter: **18,939**
- Attached change events for eligible changes: **59,779**
- Estimated row payload size (queue): **11.57 MiB**
- Estimated row payload size (attached events): **15.74 MiB**
- The eligible snapshot retention plan currently returns **zero** candidates.

These are logical row payload estimates, **not** physical reclaim or guaranteed invoice savings. Indexes, TOAST, vacuum behavior and actual locking/traffic affect cleanup. Cron job #17 (cancelled history retention) remains **inactive**. Do not run the pruning function or enable the cron until an operating window, rollback plan and latest data checks have been approved.

## Recommended next actions

1. Keep the test function JWT-protected; do not register its URL as a production Makeshop webhook.
2. Implement a separate webhook receiver with `verify_jwt=false`, validate the provider's HMAC-SHA256 signature using the raw body and a secret stored in project secrets, check timestamp, deduplicate by `webhook-id`, durably save receipt before a 2xx response. If storage fails, respond non-2xx so Makeshop can retry.
3. Validate the webhook receiver using Makeshop's TEST feature; scope the API permissions to necessary read events.
4. Only then determine which active API polling/reads require a fixed-egress-IP proxy. Supabase Edge Functions do not provide a guaranteed static egress IP.
5. For cleanup, rehearse batches of at most 1,000 with the existing function's protection conditions in an approved maintenance window. Verify per-batch effects, FK cascades and operational health before enabling automatic retention.
6. Preserve `docs/db-ledger.md` and production migration history; do not replay archived SQL as a cleanup step.

## References

- [Makeshop webhook guide](https://developer.makeshop.co.kr/docs/guide/app/webhook)
- [Makeshop APP development information and allowed IPs](https://developer.makeshop.co.kr/docs/guide/app/dev-info)
- [Supabase Edge Function docs](https://supabase.com/docs/guides/functions)
- [Supabase static-egress IP limitation](https://supabase.com/kb/troubleshooting/why-supabase-edge-functions-cannot-provide-static-egress-ips-for-whitelisting-3d78b0)
- [Operation Hub DB ledger](./db-ledger.md)
