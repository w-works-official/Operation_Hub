-- Operations Hub retention lifecycle V2.
--
-- Safety contract:
-- 1) Never delete snapshot parent rows, upload intents, or Storage objects.
-- 2) Preserve every current snapshot lineage and every seller snapshot that is
--    referenced by an operational/baseline record.
-- 3) Archive only old, unprotected snapshot metadata and prune its child rows.
-- 4) Run snapshot, cancelled-change, and cron-log retention as separate cron
--    transactions so one category cannot block the others.
-- 5) This migration installs policy/functions/schedules only. It does not invoke
--    any retention function and therefore does not delete production rows on apply.

create or replace function operations_private.operations_hub_retention_policy_v2()
returns jsonb
language sql
immutable
set search_path = pg_catalog
as $$
  select jsonb_build_object(
    'sellpia_ready_days', 90,
    'sellpia_min_versions', 10,
    'seller_ready_days', 180,
    'seller_min_versions_per_channel', 6,
    'failed_snapshot_days', 30,
    'cron_log_days', 14,
    'selected_source_detail_days', 90,
    'cancelled_change_days', 30,
    'upload_intent_auto_delete', false,
    'storage_original_auto_delete', false
  )
$$;

revoke all on function operations_private.operations_hub_retention_policy_v2()
  from public, anon, authenticated;

comment on function operations_private.operations_hub_retention_policy_v2() is
  'Single source of truth for Operations Hub retention V2. Snapshot metadata, upload intents, and Storage originals are retained; only eligible child rows are pruned.';

alter table public.sellpia_stock_snapshots
  drop constraint if exists ck_sellpia_stock_snapshots_status;
alter table public.sellpia_stock_snapshots
  add constraint ck_sellpia_stock_snapshots_status
  check (upload_status in ('uploading','ready','failed','archived')) not valid;
alter table public.sellpia_stock_snapshots
  validate constraint ck_sellpia_stock_snapshots_status;

alter table public.seller_inventory_snapshots
  drop constraint if exists seller_inventory_snapshots_upload_status_check;
alter table public.seller_inventory_snapshots
  add constraint seller_inventory_snapshots_upload_status_check
  check (upload_status in ('uploading','ready','failed','archived')) not valid;
alter table public.seller_inventory_snapshots
  validate constraint seller_inventory_snapshots_upload_status_check;

create or replace function operations_private.operations_hub_snapshot_retention_plan_v2(
  p_as_of timestamptz default clock_timestamp()
)
returns table(
  snapshot_kind text,
  source_channel text,
  snapshot_id uuid,
  upload_status text,
  action text,
  reason text,
  child_row_count bigint,
  created_at timestamptz,
  completed_at timestamptz
)
language sql
stable
security invoker
set search_path = pg_catalog, public, operations_private
as $$
with recursive
policy as (
  select operations_private.operations_hub_retention_policy_v2() as value
),
sellpia_ranked as (
  select
    snapshot.*,
    row_number() over (
      order by coalesce(snapshot.completed_at,snapshot.created_at) desc,
               snapshot.created_at desc,
               snapshot.snapshot_id desc
    ) as version_rank
  from public.sellpia_stock_snapshots snapshot
  where snapshot.upload_status='ready'
),
sellpia_seed as (
  select ranked.snapshot_id
  from sellpia_ranked ranked cross join policy
  where ranked.version_rank <= (policy.value->>'sellpia_min_versions')::integer
     or coalesce(ranked.completed_at,ranked.created_at) >=
        p_as_of-make_interval(days=>(policy.value->>'sellpia_ready_days')::integer)
  union
  select state.sellpia_snapshot_id
  from operations_private.operations_hub_matrix_refresh_state state
  where state.singleton and state.sellpia_snapshot_id is not null
  union
  select intent.snapshot_id
  from operations_private.operations_hub_original_upload_intents intent
  where intent.status in ('uploading','uploaded','parsing')
),
sellpia_protected(snapshot_id) as (
  select seed.snapshot_id from sellpia_seed seed
  union
  select base.snapshot_id
  from sellpia_protected protected
  join public.sellpia_stock_snapshots child on child.snapshot_id=protected.snapshot_id
  join public.sellpia_stock_snapshots base
    on base.snapshot_id=case
      when coalesce(child.metadata->>'base_snapshot_id','') ~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then (child.metadata->>'base_snapshot_id')::uuid
      else null
    end
  where child.upload_status='ready' and base.upload_status='ready'
),
seller_ranked as (
  select
    snapshot.*,
    row_number() over (
      partition by snapshot.source_channel
      order by coalesce(snapshot.completed_at,snapshot.created_at) desc,
               snapshot.created_at desc,
               snapshot.snapshot_id desc
    ) as version_rank
  from public.seller_inventory_snapshots snapshot
  where snapshot.upload_status='ready'
),
seller_seed as (
  select ranked.snapshot_id
  from seller_ranked ranked cross join policy
  where ranked.version_rank <= (policy.value->>'seller_min_versions_per_channel')::integer
     or coalesce(ranked.completed_at,ranked.created_at) >=
        p_as_of-make_interval(days=>(policy.value->>'seller_ready_days')::integer)
  union
  select version.source_snapshot_id
  from operations_private.hub_baseline_versions version
  where version.source_snapshot_id is not null
  union
  select draft.source_snapshot_id
  from public.operations_hub_active_seller_drafts draft
  where draft.source_snapshot_id is not null
  union
  select change.source_snapshot_id
  from public.operations_hub_change_queue change
  where change.source_snapshot_id is not null
  union
  select item.source_snapshot_id
  from public.operations_hub_export_items item
  where item.source_snapshot_id is not null
),
seller_protected(snapshot_id) as (
  select seed.snapshot_id from seller_seed seed
  union
  select base.snapshot_id
  from seller_protected protected
  join public.seller_inventory_snapshots child on child.snapshot_id=protected.snapshot_id
  join public.seller_inventory_snapshots base on base.snapshot_id=child.base_snapshot_id
  where child.upload_status='ready' and base.upload_status='ready'
),
candidates as (
  select
    'sellpia'::text as snapshot_kind,
    'sellpia'::text as source_channel,
    snapshot.snapshot_id,
    snapshot.upload_status,
    case when snapshot.upload_status='ready' then 'archive_ready_rows' else 'prune_failed_rows' end as action,
    case when snapshot.upload_status='ready'
      then 'outside_ready_window_and_not_protected'
      else 'failed_snapshot_outside_window'
    end as reason,
    snapshot.created_at,
    snapshot.completed_at
  from public.sellpia_stock_snapshots snapshot cross join policy
  where (
      snapshot.upload_status='ready'
      and coalesce(snapshot.completed_at,snapshot.created_at) <
        p_as_of-make_interval(days=>(policy.value->>'sellpia_ready_days')::integer)
      and not exists (
        select 1 from sellpia_protected protected
        where protected.snapshot_id=snapshot.snapshot_id
      )
    ) or (
      snapshot.upload_status='failed'
      and coalesce(snapshot.completed_at,snapshot.created_at) <
        p_as_of-make_interval(days=>(policy.value->>'failed_snapshot_days')::integer)
      and exists (
        select 1 from public.sellpia_stock_snapshot_rows row_item
        where row_item.snapshot_id=snapshot.snapshot_id
      )
      and not exists (
        select 1
        from operations_private.operations_hub_original_upload_intents intent
        where intent.snapshot_id=snapshot.snapshot_id
          and intent.status in ('uploading','uploaded','parsing')
      )
    )
  union all
  select
    'seller'::text,
    snapshot.source_channel,
    snapshot.snapshot_id,
    snapshot.upload_status,
    case when snapshot.upload_status='ready' then 'archive_ready_rows' else 'prune_failed_rows' end,
    case when snapshot.upload_status='ready'
      then 'outside_ready_window_and_not_protected'
      else 'failed_snapshot_outside_window'
    end,
    snapshot.created_at,
    snapshot.completed_at
  from public.seller_inventory_snapshots snapshot cross join policy
  where (
      snapshot.upload_status='ready'
      and coalesce(snapshot.completed_at,snapshot.created_at) <
        p_as_of-make_interval(days=>(policy.value->>'seller_ready_days')::integer)
      and not exists (
        select 1 from seller_protected protected
        where protected.snapshot_id=snapshot.snapshot_id
      )
    ) or (
      snapshot.upload_status='failed'
      and coalesce(snapshot.completed_at,snapshot.created_at) <
        p_as_of-make_interval(days=>(policy.value->>'failed_snapshot_days')::integer)
      and exists (
        select 1 from public.seller_inventory_snapshot_rows row_item
        where row_item.snapshot_id=snapshot.snapshot_id
      )
    )
)
select
  candidate.snapshot_kind,
  candidate.source_channel,
  candidate.snapshot_id,
  candidate.upload_status,
  candidate.action,
  candidate.reason,
  case candidate.snapshot_kind
    when 'sellpia' then (
      select count(*) from public.sellpia_stock_snapshot_rows row_item
      where row_item.snapshot_id=candidate.snapshot_id
    )
    else (
      select count(*) from public.seller_inventory_snapshot_rows row_item
      where row_item.snapshot_id=candidate.snapshot_id
    )
  end as child_row_count,
  candidate.created_at,
  candidate.completed_at
from candidates candidate
order by candidate.snapshot_kind,candidate.source_channel,candidate.created_at,candidate.snapshot_id
$$;

revoke all on function operations_private.operations_hub_snapshot_retention_plan_v2(timestamptz)
  from public, anon, authenticated;

comment on function operations_private.operations_hub_snapshot_retention_plan_v2(timestamptz) is
  'Read-only dry-run plan. Protects current/young/minimum versions, patch ancestry, upload-in-flight snapshots, baselines, drafts, queued changes, and export references.';

create or replace function operations_private.archive_operations_hub_snapshot_history_v2(
  p_as_of timestamptz default clock_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, operations_private
set statement_timeout = '60s'
set lock_timeout = '5s'
as $$
declare
  v_sellpia_ids uuid[] := '{}'::uuid[];
  v_seller_ids uuid[] := '{}'::uuid[];
  v_sellpia_archived integer := 0;
  v_seller_archived integer := 0;
  v_sellpia_rows integer := 0;
  v_seller_rows integer := 0;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('operations_hub_snapshot_retention_v2',0)) then
    return jsonb_build_object('status','skipped','reason','already_running');
  end if;

  select
    coalesce(array_agg(plan.snapshot_id order by plan.created_at)
      filter (where plan.snapshot_kind='sellpia'),'{}'::uuid[]),
    coalesce(array_agg(plan.snapshot_id order by plan.created_at)
      filter (where plan.snapshot_kind='seller'),'{}'::uuid[])
  into v_sellpia_ids,v_seller_ids
  from operations_private.operations_hub_snapshot_retention_plan_v2(p_as_of) plan;

  update public.sellpia_stock_snapshots snapshot
  set upload_status='archived',
      upload_note=concat_ws(' · ',nullif(snapshot.upload_note,''),'retention metadata-only archive'),
      metadata=coalesce(snapshot.metadata,'{}'::jsonb)||jsonb_build_object(
        'retention',jsonb_build_object('state','metadata_only','archived_at',p_as_of,'policy','v2')
      )
  where snapshot.snapshot_id=any(v_sellpia_ids)
    and snapshot.upload_status='ready';
  get diagnostics v_sellpia_archived=row_count;

  update public.seller_inventory_snapshots snapshot
  set upload_status='archived',
      upload_note=concat_ws(' · ',nullif(snapshot.upload_note,''),'retention metadata-only archive'),
      metadata=coalesce(snapshot.metadata,'{}'::jsonb)||jsonb_build_object(
        'retention',jsonb_build_object('state','metadata_only','archived_at',p_as_of,'policy','v2')
      )
  where snapshot.snapshot_id=any(v_seller_ids)
    and snapshot.upload_status='ready';
  get diagnostics v_seller_archived=row_count;

  update public.sellpia_stock_snapshots snapshot
  set metadata=coalesce(snapshot.metadata,'{}'::jsonb)||jsonb_build_object(
        'retention',jsonb_build_object('state','failed_rows_pruned','archived_at',p_as_of,'policy','v2')
      )
  where snapshot.snapshot_id=any(v_sellpia_ids)
    and snapshot.upload_status='failed';

  update public.seller_inventory_snapshots snapshot
  set metadata=coalesce(snapshot.metadata,'{}'::jsonb)||jsonb_build_object(
        'retention',jsonb_build_object('state','failed_rows_pruned','archived_at',p_as_of,'policy','v2')
      )
  where snapshot.snapshot_id=any(v_seller_ids)
    and snapshot.upload_status='failed';

  delete from public.sellpia_stock_snapshot_rows row_item
  where row_item.snapshot_id=any(v_sellpia_ids);
  get diagnostics v_sellpia_rows=row_count;

  delete from public.seller_inventory_snapshot_rows row_item
  where row_item.snapshot_id=any(v_seller_ids);
  get diagnostics v_seller_rows=row_count;

  return jsonb_build_object(
    'status','completed',
    'as_of',p_as_of,
    'sellpia_snapshots_archived',v_sellpia_archived,
    'sellpia_child_rows_removed',v_sellpia_rows,
    'seller_snapshots_archived',v_seller_archived,
    'seller_child_rows_removed',v_seller_rows,
    'parent_snapshots_removed',0,
    'upload_intents_removed',0,
    'storage_objects_removed',0
  );
end
$$;

revoke all on function operations_private.archive_operations_hub_snapshot_history_v2(timestamptz)
  from public, anon, authenticated;

create or replace function operations_private.prune_operations_hub_cron_history_v2(
  p_as_of timestamptz default clock_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, operations_private, cron
set statement_timeout = '30s'
as $$
declare
  v_policy jsonb := operations_private.operations_hub_retention_policy_v2();
  v_cutoff timestamptz;
  v_deleted integer := 0;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('operations_hub_cron_log_retention_v2',0)) then
    return jsonb_build_object('status','skipped','reason','already_running');
  end if;
  v_cutoff:=p_as_of-make_interval(days=>(v_policy->>'cron_log_days')::integer);
  delete from cron.job_run_details where end_time is not null and end_time<v_cutoff;
  get diagnostics v_deleted=row_count;
  return jsonb_build_object(
    'status','completed','retention_days',(v_policy->>'cron_log_days')::integer,
    'cutoff',v_cutoff,'cron_job_runs_removed',v_deleted,'completed_at',clock_timestamp()
  );
end
$$;

revoke all on function operations_private.prune_operations_hub_cron_history_v2(timestamptz)
  from public, anon, authenticated;

-- Compatibility entry point for manual operators. Each sub-block is a separate
-- PL/pgSQL subtransaction so an unexpected failure in one category does not roll
-- back successful cleanup in the other categories. Scheduled jobs below call the
-- category-specific functions directly for clearer pg_cron health reporting.
create or replace function operations_private.prune_operations_hub_history()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, operations_private, cron
as $$
declare
  v_snapshots jsonb;
  v_cancelled jsonb;
  v_cron jsonb;
  v_partial boolean := false;
begin
  begin
    v_snapshots:=operations_private.archive_operations_hub_snapshot_history_v2(clock_timestamp());
  exception when others then
    v_partial:=true;
    v_snapshots:=jsonb_build_object('status','failed','sqlstate',sqlstate,'message',sqlerrm);
    raise warning 'Operations Hub snapshot retention failed [%]: %',sqlstate,sqlerrm;
  end;

  begin
    v_cancelled:=operations_private.prune_operations_hub_cancelled_history_v1();
  exception when others then
    v_partial:=true;
    v_cancelled:=jsonb_build_object('status','failed','sqlstate',sqlstate,'message',sqlerrm);
    raise warning 'Operations Hub cancelled-history retention failed [%]: %',sqlstate,sqlerrm;
  end;

  begin
    v_cron:=operations_private.prune_operations_hub_cron_history_v2(clock_timestamp());
  exception when others then
    v_partial:=true;
    v_cron:=jsonb_build_object('status','failed','sqlstate',sqlstate,'message',sqlerrm);
    raise warning 'Operations Hub cron-log retention failed [%]: %',sqlstate,sqlerrm;
  end;

  return jsonb_build_object(
    'status',case when v_partial then 'partial_failure' else 'completed' end,
    'snapshots',v_snapshots,'cancelled_history',v_cancelled,'cron_logs',v_cron,
    'completed_at',clock_timestamp()
  );
end
$$;

revoke all on function operations_private.prune_operations_hub_history()
  from public, anon, authenticated;

do $$
declare
  v_job_id bigint;
begin
  for v_job_id in
    select jobid from cron.job
    where jobname in (
      'operations-hub-history-retention',
      'operations-hub-snapshot-retention-v2',
      'operations-hub-cancelled-history-retention-v1',
      'operations-hub-cron-log-retention-v2'
    )
  loop
    perform cron.unschedule(v_job_id);
  end loop;
end
$$;

-- pg_cron runs in UTC. These are 03:23, 03:28, and 03:33 KST.
-- The jobs are installed INACTIVE. A separate, explicitly approved production
-- activation must follow review of the read-only dry-run counts.
select cron.schedule(
  'operations-hub-snapshot-retention-v2',
  '23 18 * * *',
  $cron$select operations_private.archive_operations_hub_snapshot_history_v2();$cron$
);
select cron.schedule(
  'operations-hub-cancelled-history-retention-v1',
  '28 18 * * *',
  $cron$select operations_private.prune_operations_hub_cancelled_history_v1();$cron$
);
select cron.schedule(
  'operations-hub-cron-log-retention-v2',
  '33 18 * * *',
  $cron$select operations_private.prune_operations_hub_cron_history_v2();$cron$
);

do $$
declare
  v_job_id bigint;
begin
  for v_job_id in
    select jobid from cron.job
    where jobname in (
      'operations-hub-snapshot-retention-v2',
      'operations-hub-cancelled-history-retention-v1',
      'operations-hub-cron-log-retention-v2'
    )
  loop
    perform cron.alter_job(v_job_id,active:=false);
  end loop;
end
$$;

notify pgrst,'reload schema';

