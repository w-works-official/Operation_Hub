-- Roll back only the additive large-group export reader. Existing editor,
-- v1/v2 readers and all source/mapping/price data remain untouched.
set local lock_timeout='2s';
set local statement_timeout='30s';
drop function if exists public.hub_price_decision_export_read_v3(text,text,text[]);
drop function if exists operations_private.hub_price_decision_export_payload_v3(text,text[]);
drop function if exists operations_private.hub_price_decision_export_base_v3(text,text[]);
notify pgrst,'reload schema';
