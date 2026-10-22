-- Disable these additive APIs without discarding saved operator preferences or
-- idempotency receipts. Both private RLS tables remain inaccessible to clients.
set local lock_timeout='2s';
set local statement_timeout='30s';
drop function if exists public.hub_product_price_settings_save_v1(text,text,jsonb,uuid);
drop function if exists public.hub_product_price_settings_read_v1(text,text,text[]);
drop function if exists operations_private.hub_product_price_settings_save_session_v1(text,text,jsonb,uuid);
drop function if exists operations_private.hub_product_price_settings_read_session_v1(text,text,text[]);
revoke all on operations_private.hub_product_price_settings,
 operations_private.hub_product_price_setting_requests from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
