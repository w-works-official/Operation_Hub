-- pg_cron schedules run in UTC. 18:23 UTC is 03:23 KST the next day.
do $$
declare
  v_job_id bigint;
begin
  select jobid into v_job_id
  from cron.job
  where jobname = 'operations-hub-history-retention'
  limit 1;

  if v_job_id is null then
    raise exception 'Operations Hub history retention job was not found.';
  end if;

  perform cron.alter_job(v_job_id, schedule := '23 18 * * *');
end;
$$;

