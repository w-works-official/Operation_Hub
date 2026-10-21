-- Route the frontend back to its prior RPC before applying this additive rollback.
-- No original, mapping, decision, fingerprint or editor objects are modified.
set local lock_timeout='2s';
set local statement_timeout='30s';
drop function if exists public.hub_price_decision_export_read_v1(text,text,text[]);
drop function if exists operations_private.hub_price_decision_export_payload_v1(text,text[]);
notify pgrst,'reload schema';
