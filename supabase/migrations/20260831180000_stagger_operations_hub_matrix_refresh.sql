-- Anonymous GitHub Pages reads have a 3-second statement timeout. These two
-- refresh jobs previously started together every minute, while the read-cache
-- refresh had a six-hour p95 above four seconds. Alternate them by minute so
-- catalog reads do not compete with both refreshes at once.
create index if not exists operations_hub_change_queue_updated_at_idx
  on public.operations_hub_change_queue (updated_at desc);

do $$
declare
  v_core_job_id bigint;
  v_cache_job_id bigint;
begin
  select jobid into v_core_job_id
  from cron.job
  where jobname = 'operations-hub-legacy-mapping-refresh'
  limit 1;

  select jobid into v_cache_job_id
  from cron.job
  where jobname = 'operations-hub-csv-export-cache-refresh'
  limit 1;

  if v_core_job_id is null or v_cache_job_id is null then
    raise exception 'Operations Hub refresh cron jobs were not found.';
  end if;

  perform cron.alter_job(v_core_job_id, schedule := '*/2 * * * *');
  perform cron.alter_job(v_cache_job_id, schedule := '1-59/2 * * * *');
end;
$$;

notify pgrst, 'reload schema';
