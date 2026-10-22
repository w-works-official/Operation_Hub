-- Restore only the pre-hardening v3 public session gate before removing the
-- new private wrapper. Retain v3 payloads, old functions and all operator data.
set local lock_timeout='2s';
set local statement_timeout='30s';

create or replace function public.hub_price_decision_export_read_v3(p_session_token text,p_source text,p_skus text[])
returns jsonb language plpgsql stable security definer set search_path=pg_catalog set statement_timeout='20s' as $$
begin
  perform operations_private.require_operations_hub_operator_session(p_session_token);
  return operations_private.hub_price_decision_export_payload_v3(p_source,p_skus);
end $$;
revoke all on function public.hub_price_decision_export_read_v3(text,text,text[]) from public,anon,authenticated,service_role;
grant execute on function public.hub_price_decision_export_read_v3(text,text,text[]) to anon,authenticated;
drop function if exists operations_private.hub_price_decision_export_read_session_v3(text,text,text[]);
notify pgrst,'reload schema';
