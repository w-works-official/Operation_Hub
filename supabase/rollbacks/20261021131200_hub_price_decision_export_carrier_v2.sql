-- Restore the frontend v1 route before this additive rollback; all v1 objects
-- and operational data remain unchanged.
set local lock_timeout='2s';
set local statement_timeout='30s';
drop function if exists public.hub_price_decision_export_read_v2(text,text,text[]);
drop function if exists operations_private.hub_price_decision_export_payload_v2(text,text[]);
notify pgrst,'reload schema';
