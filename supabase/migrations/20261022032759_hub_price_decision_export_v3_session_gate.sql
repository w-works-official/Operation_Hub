-- Move only the v3 privileged session gate into the unexposed schema.
-- The public RPC keeps its exact arguments, payload and per-request timeout.
-- Canonical/carrier proof helpers and deployed v1/v2/editor functions are untouched.
set local lock_timeout='2s';
set local statement_timeout='30s';

create function operations_private.hub_price_decision_export_read_session_v3(
 p_session_token text,p_source text,p_skus text[]
)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog set statement_timeout='20s'
as $session$
begin
 perform operations_private.require_operations_hub_operator_session(p_session_token);
 return operations_private.hub_price_decision_export_payload_v3(p_source,p_skus);
end;
$session$;

create or replace function public.hub_price_decision_export_read_v3(
 p_session_token text,p_source text,p_skus text[]
)
returns jsonb language sql stable security invoker
set search_path=pg_catalog set statement_timeout='20s'
as $rpc$
 select operations_private.hub_price_decision_export_read_session_v3(p_session_token,p_source,p_skus);
$rpc$;

revoke all on function operations_private.hub_price_decision_export_read_session_v3(text,text,text[]),
 public.hub_price_decision_export_read_v3(text,text,text[])
 from public,anon,authenticated,service_role;
grant execute on function operations_private.hub_price_decision_export_read_session_v3(text,text,text[]),
 public.hub_price_decision_export_read_v3(text,text,text[])to anon,authenticated;
notify pgrst,'reload schema';
