# Makeshop Webhook Inbox — 2026-11-17

## Architecture

- Existing company Supabase project: `System_v1` (`bpgvqmtsjgegnrdzmpep`)
- HTTP receiver: `makeshop-webhook` (version 1, `verify_jwt=false`, **fail closed**)
- Internal-only database schema: `makeshop`
- Table: `makeshop.webhook_inbox`, with composite primary key `(client_id, webhook_id)`
- Source: `index.ts`, live schema copy: `schema.applied.sql`
- An earlier, unrelated connectivity probe `makeshop-bridge-probe-20261117` remains JWT-protected. Neither is a fixed-IP outbound API gateway.

The receiver independently verifies Makeshop `webhook-id`, `webhook-timestamp`, `webhook-signature`, and `x-client-id` using raw-body HMAC-SHA256, and checks a five-minute timestamp window. Signatures are `v1,` + Base64; a `whsec_` secret is decoded after its prefix. It rejects requests if configuration is missing. A successful verified notification is inserted with `ON CONFLICT DO NOTHING`; only after the database operation succeeds does the receiver return HTTP 200. It does **not** process business changes, mutate any existing Hub table, or trigger an external API call.

## Secrets (not configured yet)

Add these in **Supabase Dashboard > Edge Functions > Secrets** before using Makeshop TEST:

- `MAKESHOP_WEBHOOK_SECRET`: a Makeshop webhook authentication secret. Never paste it into GitHub or chat.
- `MAKESHOP_CLIENT_ID`: the APP Client ID.
- `SUPABASE_DB_URL` is provided by Supabase automatically; no need to record it in Git.

**Do not register the endpoint as a live webhook before secret provisioning and a controlled TEST transmission.** The endpoint is intentionally exposed at HTTP level because Makeshop cannot send a Supabase JWT; application-level HMAC verifies each message.

The schema is private, with RLS enabled and no RLS policies. `anon` and `authenticated` do not have schema access or table privileges. Supabase's security advisor reports `rls_enabled_no_policy` as informational, expected for this inaccessible internal table. Do not add broad public RLS policies just to suppress the notice.

## Verification on 2026-11-17

- New schema and inbox table created on the **existing** production project. Existing Operations Hub tables/cron/RPC and functions unchanged.
- `makeshop.webhook_inbox` contains **0 rows** following deployment.
- Unconfigured HTTP POST returns **503** with `NOT_CONFIGURED`.
- `anon` has no usage on the `makeshop` schema; `authenticated` has no SELECT privilege on the inbox.
- No signed Makeshop TEST or persisted webhook has been attempted yet.
- Actual APP registration still requires following Makeshop's `dev-info` rules, including an allowed IPv4 for **outbound active API calls**. A NAS or fixed egress proxy remains a separate decision.

## Remaining validation and operating policy

1. Provision secrets via dashboard privately and test a valid signed webhook using Makeshop's TEST button.
2. Verify duplicate delivery yields `duplicate=true` without additional rows.
3. Verify invalid/expired signatures are rejected and no records are written.
4. Simulate storage unavailable and verify non-2xx (retryable), then restore state.
5. Decide event processing strategy with idempotency, retries and poison-message handling; current inbox only stores `pending`.
6. Agree on data retention, access, and PII minimization before registering live events.
7. Build a **separate** fixed-egress API caller only if required for Makeshop API reads. A webhook receiver is not an API bridge.
8. Do not re-run `schema.applied.sql` against production. The migration has already been applied and must be reconciled against the existing migration history.

See:
- https://developer.makeshop.co.kr/docs/guide/app/webhook
- https://developer.makeshop.co.kr/docs/guide/app/dev-info
- https://supabase.com/docs/guides/functions/secrets
