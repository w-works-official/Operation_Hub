-- Reduce Operations Hub database usage while preserving current source data
-- and successful export history. Physical compaction is performed separately
-- because VACUUM FULL cannot run inside a transaction.

create or replace function operations_private.prune_operations_hub_history()
returns jsonb
language plpgsql
set search_path = pg_catalog, public, operations_private, cron
as $$
declare
  v_snapshot_rows integer := 0;
  v_cron_rows integer := 0;
begin
  with ranked_ready as (
    select
      snapshot_id,
      row_number() over (order by created_at desc, snapshot_id desc) as snapshot_rank
    from public.sellpia_stock_snapshots
    where upload_status = 'ready'
  ), deleted as (
    delete from public.sellpia_stock_snapshots s
    using ranked_ready r
    where s.snapshot_id = r.snapshot_id
      and r.snapshot_rank > 2
    returning s.snapshot_id
  )
  select count(*) into v_snapshot_rows from deleted;

  with deleted as (
    delete from cron.job_run_details
    where end_time < now() - interval '7 days'
    returning runid
  )
  select count(*) into v_cron_rows from deleted;

  return jsonb_build_object(
    'ready_snapshots_removed', v_snapshot_rows,
    'cron_job_runs_removed', v_cron_rows,
    'completed_at', now()
  );
end;
$$;

revoke all on function operations_private.prune_operations_hub_history() from public, anon, authenticated;

do $$
declare
  v_snapshot_parent_count integer;
  v_snapshot_child_count integer;
  v_export_item_count integer;
  v_deleted integer;
  v_job_id bigint;
begin
  select count(*) into v_snapshot_parent_count
  from public.sellpia_stock_snapshots
  where snapshot_id in (
    'fc3b00e7-82fa-4f54-8a20-fe3bb7a55af6'::uuid,
    '32c873cb-ca30-4d00-a310-6e581186f314'::uuid
  )
    and upload_status = 'ready';

  select count(*) into v_snapshot_child_count
  from public.sellpia_stock_snapshot_rows
  where snapshot_id in (
    'fc3b00e7-82fa-4f54-8a20-fe3bb7a55af6'::uuid,
    '32c873cb-ca30-4d00-a310-6e581186f314'::uuid
  );

  if v_snapshot_parent_count <> 2 or v_snapshot_child_count <> 51456 then
    raise exception
      'Sellpia snapshot cleanup safety check failed: parents %, children %',
      v_snapshot_parent_count,
      v_snapshot_child_count;
  end if;

  select count(*) into v_export_item_count
  from public.operations_hub_export_items
  where export_batch_id in (
    '851c770a-5d2f-496a-8360-769022afcace'::uuid,
    'e0e068f2-4e4c-465f-958e-6c4fdf8bda39'::uuid,
    'f15bf888-4d19-4782-a46a-1cc1919a3169'::uuid
  )
    and status in ('failed', 'cancelled');

  if v_export_item_count <> 30164 then
    raise exception
      'Export item cleanup safety check failed: expected 30164, found %',
      v_export_item_count;
  end if;

  delete from public.sellpia_stock_snapshots
  where snapshot_id in (
    'fc3b00e7-82fa-4f54-8a20-fe3bb7a55af6'::uuid,
    '32c873cb-ca30-4d00-a310-6e581186f314'::uuid
  );
  get diagnostics v_deleted = row_count;
  if v_deleted <> 2 then
    raise exception 'Unexpected Sellpia snapshot delete count: %', v_deleted;
  end if;

  delete from public.operations_hub_export_items
  where export_batch_id in (
    '851c770a-5d2f-496a-8360-769022afcace'::uuid,
    'e0e068f2-4e4c-465f-958e-6c4fdf8bda39'::uuid,
    'f15bf888-4d19-4782-a46a-1cc1919a3169'::uuid
  )
    and status in ('failed', 'cancelled');
  get diagnostics v_deleted = row_count;
  if v_deleted <> 30164 then
    raise exception 'Unexpected export item delete count: %', v_deleted;
  end if;

  delete from cron.job_run_details
  where end_time < now() - interval '7 days';

  for v_job_id in
    select jobid
    from cron.job
    where jobname = 'operations-hub-history-retention'
  loop
    perform cron.unschedule(v_job_id);
  end loop;
end;
$$;

select cron.schedule(
  'operations-hub-history-retention',
  '23 3 * * *',
  $cron$select operations_private.prune_operations_hub_history();$cron$
);

