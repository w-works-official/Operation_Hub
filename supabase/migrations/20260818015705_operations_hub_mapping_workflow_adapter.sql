alter table operations_private.operations_hub_mapping_batches
  add column if not exists request_id uuid;

create unique index if not exists operations_hub_mapping_batches_request_id_idx
  on operations_private.operations_hub_mapping_batches (request_id)
  where request_id is not null;

alter table operations_private.operations_hub_matrix_refresh_state
  add column if not exists legacy_auto_refresh_enabled boolean not null default false,
  add column if not exists legacy_auto_refresh_schedule text;

create or replace function operations_private.refresh_operations_hub_matrix_core_if_stale(
  p_actor text default 'operations_hub_legacy_bridge'
)
returns jsonb
language plpgsql
security definer
set search_path = public, operations_private, extensions, pg_temp
as $$
declare
  v_actor text := coalesce(nullif(btrim(p_actor), ''), 'operations_hub_legacy_bridge');
  v_latest_legacy timestamptz;
  v_core_refreshed_at timestamptz;
begin
  if v_actor !~ '^[0-9A-Za-z_.:@-]{3,120}$' then
    raise exception 'actor 형식이 올바르지 않습니다.';
  end if;

  if not pg_try_advisory_xact_lock(hashtextextended('operations_hub_matrix_core_refresh', 0)) then
    return jsonb_build_object('status', 'locked', 'refreshed_by', v_actor);
  end if;

  select greatest(
    coalesce((select max(imported_at) from review.final_excel_mapping_import), '-infinity'::timestamptz),
    coalesce((select max(updated_at) from review.sheet_manual_mappings), '-infinity'::timestamptz)
  ) into v_latest_legacy;

  select core_refreshed_at
  into v_core_refreshed_at
  from operations_private.operations_hub_matrix_refresh_state
  where singleton;

  if v_latest_legacy <= coalesce(v_core_refreshed_at, '-infinity'::timestamptz) then
    return jsonb_build_object(
      'status', 'skipped',
      'reason', 'core_is_current',
      'legacy_mapping_at', v_latest_legacy,
      'core_refreshed_at', v_core_refreshed_at,
      'refreshed_by', v_actor
    );
  end if;

  return operations_private.refresh_operations_hub_matrix_core(v_actor);
end;
$$;

revoke all on function operations_private.refresh_operations_hub_matrix_core_if_stale(text) from public;
revoke all on function operations_private.refresh_operations_hub_matrix_core_if_stale(text) from anon, authenticated;
grant execute on function operations_private.refresh_operations_hub_matrix_core_if_stale(text) to service_role;

create or replace function public.apply_operations_hub_mapping_workflow(
  p_request_id uuid,
  p_items jsonb,
  p_actor text default 'operations_hub_automation',
  p_origin text default 'automatic',
  p_note text default null,
  p_finalize boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, operations_private, extensions, pg_temp
as $$
declare
  v_batch jsonb;
  v_core jsonb;
  v_sync jsonb;
  v_existing operations_private.operations_hub_mapping_batches%rowtype;
begin
  if p_request_id is null then
    raise exception 'request_id가 필요합니다.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 0));

  select *
  into v_existing
  from operations_private.operations_hub_mapping_batches
  where request_id = p_request_id;

  if found then
    v_batch := jsonb_build_object(
      'batch_id', v_existing.batch_id,
      'request_id', v_existing.request_id,
      'status', v_existing.status,
      'requested_count', v_existing.requested_count,
      'saved_count', v_existing.saved_count,
      'failed_count', v_existing.failed_count,
      'failure_items', v_existing.failure_items,
      'idempotent_replay', true
    );
  else
    v_batch := operations_private.save_operations_hub_mapping_batch(
      p_items,
      p_actor,
      p_origin,
      p_note
    );

    update operations_private.operations_hub_mapping_batches
    set request_id = p_request_id
    where batch_id = (v_batch ->> 'batch_id')::uuid;

    v_batch := v_batch || jsonb_build_object(
      'request_id', p_request_id,
      'idempotent_replay', false
    );
  end if;

  if coalesce(p_finalize, true) then
    v_core := operations_private.refresh_operations_hub_matrix_core_if_stale(p_actor);
  else
    v_core := jsonb_build_object('status', 'deferred', 'reason', 'more_batches_expected');
  end if;

  select to_jsonb(status_row.*)
  into v_sync
  from public.operations_hub_mapping_sync_status status_row;

  return jsonb_build_object(
    'request_id', p_request_id,
    'batch', v_batch,
    'core', v_core,
    'sync', v_sync
  );
end;
$$;

revoke all on function public.apply_operations_hub_mapping_workflow(uuid, jsonb, text, text, text, boolean) from public;
revoke all on function public.apply_operations_hub_mapping_workflow(uuid, jsonb, text, text, text, boolean) from anon, authenticated;
grant execute on function public.apply_operations_hub_mapping_workflow(uuid, jsonb, text, text, text, boolean) to service_role;

create extension if not exists pg_cron;

do $$
declare
  v_job_id bigint;
begin
  for v_job_id in
    select jobid from cron.job where jobname = 'operations-hub-legacy-mapping-refresh'
  loop
    perform cron.unschedule(v_job_id);
  end loop;
end;
$$;

select cron.schedule(
  'operations-hub-legacy-mapping-refresh',
  '* * * * *',
  $cron$select operations_private.refresh_operations_hub_matrix_core_if_stale('cron_legacy_mapping_bridge');$cron$
);

update operations_private.operations_hub_matrix_refresh_state
set
  legacy_auto_refresh_enabled = true,
  legacy_auto_refresh_schedule = '* * * * *'
where singleton;

create or replace view public.operations_hub_mapping_sync_status
with (security_invoker = true)
as
with official as (
  select
    count(*)::integer as official_mapping_count,
    count(*) filter (where mapping_origin = 'manual')::integer as manual_mapping_count,
    count(*) filter (where mapping_origin = 'automatic')::integer as automatic_mapping_count,
    count(*) filter (where mapping_origin = 'import')::integer as import_mapping_count,
    max(updated_at) as latest_official_mapping_at
  from public.operations_hub_manual_links
),
legacy as (
  select greatest(
    coalesce((select max(imported_at) from review.final_excel_mapping_import), '-infinity'::timestamptz),
    coalesce((select max(updated_at) from review.sheet_manual_mappings), '-infinity'::timestamptz)
  ) as latest_legacy_mapping_at
),
latest_batch as (
  select
    batch_id,
    request_id,
    mapping_origin,
    actor,
    status,
    requested_count,
    saved_count,
    failed_count,
    created_at,
    completed_at
  from operations_private.operations_hub_mapping_batches
  order by created_at desc, batch_id desc
  limit 1
)
select
  official.official_mapping_count,
  official.manual_mapping_count,
  official.automatic_mapping_count,
  official.import_mapping_count,
  official.latest_official_mapping_at,
  legacy.latest_legacy_mapping_at,
  state.core_refreshed_at,
  state.refreshed_by as core_refreshed_by,
  state.core_row_count,
  legacy.latest_legacy_mapping_at > state.core_refreshed_at as core_refresh_needed,
  latest_batch.batch_id as latest_batch_id,
  latest_batch.mapping_origin as latest_batch_origin,
  latest_batch.actor as latest_batch_actor,
  latest_batch.status as latest_batch_status,
  latest_batch.requested_count as latest_batch_requested_count,
  latest_batch.saved_count as latest_batch_saved_count,
  latest_batch.failed_count as latest_batch_failed_count,
  latest_batch.created_at as latest_batch_created_at,
  latest_batch.completed_at as latest_batch_completed_at,
  md5(concat_ws('|',
    official.official_mapping_count::text,
    coalesce(official.latest_official_mapping_at::text, ''),
    legacy.latest_legacy_mapping_at::text,
    state.core_refreshed_at::text,
    coalesce(latest_batch.batch_id::text, ''),
    coalesce(latest_batch.status, '')
  )) as mapping_version,
  latest_batch.request_id as latest_batch_request_id,
  state.legacy_auto_refresh_enabled,
  state.legacy_auto_refresh_schedule
from official
cross join legacy
cross join operations_private.operations_hub_matrix_refresh_state state
left join latest_batch on true
where state.singleton;

revoke all on public.operations_hub_mapping_sync_status from public;
grant select on public.operations_hub_mapping_sync_status to anon, authenticated;

comment on function public.apply_operations_hub_mapping_workflow(uuid, jsonb, text, text, text, boolean) is
  'Service-role adapter for idempotent 500-row mapping batches. Official overlay writes are immediate; finalize refreshes the legacy core only when stale.';

notify pgrst, 'reload schema';
