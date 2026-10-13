-- Separate approval required. This restores importer entry bodies while
-- retaining source snapshots, originals and private job audit history.
begin;
update operations_private.sellpia_sync_config set apply_enabled=false,approved_source_fingerprint=null where singleton;
do $$ begin
  if exists(select 1 from operations_private.sellpia_sync_jobs where state='applying') then
    raise exception 'Resolve active import before removing sync guards';
  end if;
end $$;
update operations_private.sellpia_sync_apply_scopes set expires_at=clock_timestamp();
do $$ declare v_definition text; begin
  v_definition:=pg_get_functiondef('operations_private.hub_sellpia_upload_complete_pre_sync_v2(text,uuid)'::regprocedure);
  execute replace(v_definition,'operations_private.hub_sellpia_upload_complete_pre_sync_v1','public.hub_sellpia_upload_complete_v1');
end $$;
drop function public.hub_sellpia_upload_complete_v1(text,uuid);
drop function public.hub_sellpia_upload_complete_v2(text,uuid);
alter function operations_private.hub_sellpia_upload_complete_pre_sync_v1(text,uuid) rename to hub_sellpia_upload_complete_v1;
alter function operations_private.hub_sellpia_upload_complete_v1(text,uuid) set schema public;
alter function operations_private.hub_sellpia_upload_complete_pre_sync_v2(text,uuid) rename to hub_sellpia_upload_complete_v2;
alter function operations_private.hub_sellpia_upload_complete_v2(text,uuid) set schema public;
revoke all on function public.hub_sellpia_upload_complete_v1(text,uuid),public.hub_sellpia_upload_complete_v2(text,uuid) from public;
grant execute on function public.hub_sellpia_upload_complete_v1(text,uuid),public.hub_sellpia_upload_complete_v2(text,uuid) to anon,authenticated;
-- Keep the queue/runtime bridge and restrictive staging RLS until retention is
-- complete. Disable SELLPIA_SYNC_ENABLED and SELLPIA_SYNC_APPLY_ENABLED in Edge,
-- stop the runner, and deploy the pre-sync frontend/original-files revision.
commit;
