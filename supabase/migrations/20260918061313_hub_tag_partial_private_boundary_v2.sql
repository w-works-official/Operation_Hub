-- Public invoker entrypoint; privileged implementation stays outside the exposed API schema.
alter function public.hub_tag_bulk_import_v2(text,jsonb,uuid,boolean) set schema operations_private;
create function public.hub_tag_bulk_import_v2(p_session_token text,p_rows jsonb,p_tag_id uuid default null,p_preview boolean default true)
returns jsonb language sql security invoker set search_path=pg_catalog set statement_timeout='60s' set lock_timeout='5s' as $$
 select operations_private.hub_tag_bulk_import_v2(p_session_token,p_rows,p_tag_id,p_preview)
$$;
revoke all on function public.hub_tag_bulk_import_v2(text,jsonb,uuid,boolean) from public;
grant execute on function public.hub_tag_bulk_import_v2(text,jsonb,uuid,boolean) to anon,authenticated;
revoke all on function operations_private.hub_tag_bulk_import_v2(text,jsonb,uuid,boolean) from public;
grant execute on function operations_private.hub_tag_bulk_import_v2(text,jsonb,uuid,boolean) to anon,authenticated;
notify pgrst,'reload schema';
