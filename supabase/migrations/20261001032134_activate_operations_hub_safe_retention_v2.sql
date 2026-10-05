-- Activate only the two low-risk Operations Hub retention categories approved
-- for the first production rollout. This migration never invokes retention.
-- Cancelled-history cleanup remains explicitly inactive.

do $$
declare
  v_snapshot_job_id bigint;
  v_cron_log_job_id bigint;
  v_cancelled_job_id bigint;
begin
  select jobid into strict v_snapshot_job_id
  from cron.job
  where jobname='operations-hub-snapshot-retention-v2'
    and command='select operations_private.archive_operations_hub_snapshot_history_v2();';

  select jobid into strict v_cron_log_job_id
  from cron.job
  where jobname='operations-hub-cron-log-retention-v2'
    and command='select operations_private.prune_operations_hub_cron_history_v2();';

  select jobid into strict v_cancelled_job_id
  from cron.job
  where jobname='operations-hub-cancelled-history-retention-v1'
    and command='select operations_private.prune_operations_hub_cancelled_history_v1();';

  perform cron.alter_job(v_snapshot_job_id,active:=true);
  perform cron.alter_job(v_cron_log_job_id,active:=true);
  perform cron.alter_job(v_cancelled_job_id,active:=false);

  if not exists (
    select 1 from cron.job where jobid=v_snapshot_job_id and active
  ) or not exists (
    select 1 from cron.job where jobid=v_cron_log_job_id and active
  ) or exists (
    select 1 from cron.job where jobid=v_cancelled_job_id and active
  ) then
    raise exception 'Operations Hub safe retention activation invariant failed';
  end if;
end
$$;

