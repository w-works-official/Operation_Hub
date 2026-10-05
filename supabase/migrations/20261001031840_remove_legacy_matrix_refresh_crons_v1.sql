-- Retire two status-only compatibility cron calls. The compatibility functions
-- remain because apply_operations_hub_mapping_workflow still returns their status
-- payload. The real background refresh jobs must exist and be active before this
-- migration will unschedule either legacy job.

do $$
declare
  v_background_count integer;
  v_bridge_count integer;
  v_job_id bigint;
begin
  select count(*) into v_background_count
  from cron.job
  where active
    and (
      (jobname='system-v3-core-cache-refresh-v1'
       and command like '%refresh_operations_hub_matrix_core_if_stale_background%')
      or
      (jobname='system-v3-export-cache-refresh-v1'
       and command like '%refresh_operations_hub_matrix_export_cache_if_stale_background%')
    );
  if v_background_count<>2 then
    raise exception 'Refusing to remove legacy refresh cron: expected two active background replacements, found %',v_background_count;
  end if;

  select count(*) into v_bridge_count
  from pg_proc routine
  join pg_namespace namespace on namespace.oid=routine.pronamespace
  where namespace.nspname='operations_private'
    and routine.proname in (
      'refresh_operations_hub_matrix_core_if_stale',
      'refresh_operations_hub_matrix_export_cache_if_stale'
    )
    and routine.prosrc like '%background_managed%'
    and routine.prosrc !~* '(^|[^a-z_])(insert|update|delete|merge|truncate|perform)([^a-z_]|$)'
    and routine.prosrc !~* 'refresh[[:space:]]+materialized';
  if v_bridge_count<>2 then
    raise exception 'Refusing to remove legacy refresh cron: compatibility functions are not both read-only status bridges';
  end if;

  for v_job_id in
    select jobid from cron.job
    where jobname in (
      'operations-hub-legacy-mapping-refresh',
      'operations-hub-csv-export-cache-refresh'
    )
  loop
    perform cron.unschedule(v_job_id);
  end loop;

end
$$;

comment on function operations_private.refresh_operations_hub_matrix_core_if_stale(text) is
  'Compatibility/status bridge. Actual stale detection and refresh are managed by system-v3-core-cache-refresh-v1.';
comment on function operations_private.refresh_operations_hub_matrix_export_cache_if_stale(text) is
  'Compatibility/status bridge. Actual stale detection and refresh are managed by system-v3-export-cache-refresh-v1.';

