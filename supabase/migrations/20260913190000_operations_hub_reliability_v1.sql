-- Reliability V1
-- Production applied on 2026-09-13.
-- Goals:
-- 1) persistent/resumable seller-export checkpoints
-- 2) move expensive matrix cache refreshes out of interactive reads
-- 3) background cron refresh
-- 4) indexes for rule/dependency FK paths

create table if not exists public.operations_hub_export_jobs (
  job_id uuid primary key default gen_random_uuid(),
  job_type text not null default 'seller_export' check (job_type = 'seller_export'),
  source_channel text not null check (source_channel in ('smartstore','makeshop','ably')),
  requested_by text not null,
  selected_skus text[] not null default '{}'::text[],
  include_stock boolean not null default false,
  overwrite_blank boolean not null default false,
  status text not null default 'queued'
    check (status in ('queued','running','inventory_ready','ready','failed','cancelled')),
  phase text not null default 'queued',
  processed_count integer not null default 0 check (processed_count >= 0),
  total_count integer not null default 0 check (total_count >= 0),
  staged_count integer not null default 0 check (staged_count >= 0),
  blank_preserved_count integer not null default 0 check (blank_preserved_count >= 0),
  blank_overwrite_count integer not null default 0 check (blank_overwrite_count >= 0),
  after_cursor text,
  change_batch_id uuid,
  retry_count integer not null default 0 check (retry_count >= 0),
  last_error text,
  snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz
);

create index if not exists operations_hub_export_jobs_actor_status_idx
  on public.operations_hub_export_jobs(requested_by,status,updated_at desc);
create index if not exists operations_hub_export_jobs_source_status_idx
  on public.operations_hub_export_jobs(source_channel,status,updated_at desc);

alter table public.operations_hub_export_jobs enable row level security;
revoke all on public.operations_hub_export_jobs from anon, authenticated;

create or replace function public.hub_export_job_begin_v1(
  p_session_token text,
  p_source_channel text,
  p_skus text[] default null,
  p_include_stock boolean default false,
  p_overwrite_blank boolean default false
) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,operations_private
as $$
declare
  v_session jsonb;
  v_actor text;
  v_source text := lower(btrim(coalesce(p_source_channel,'')));
  v_skus text[];
  v_job public.operations_hub_export_jobs%rowtype;
begin
  v_session := operations_private.require_operations_hub_operator_session(p_session_token);
  v_actor := v_session->>'username';
  if v_source not in ('smartstore','makeshop','ably') then
    raise exception '지원하지 않는 판매처입니다.';
  end if;

  select coalesce(array_agg(distinct btrim(x) order by btrim(x)),'{}'::text[])
  into v_skus
  from unnest(coalesce(p_skus,'{}'::text[])) x
  where nullif(btrim(x),'') is not null;

  select * into v_job
  from public.operations_hub_export_jobs
  where requested_by=v_actor
    and source_channel=v_source
    and status in ('queued','running','inventory_ready','failed')
    and include_stock=coalesce(p_include_stock,false)
    and overwrite_blank=coalesce(p_overwrite_blank,false)
    and selected_skus=v_skus
    and updated_at > clock_timestamp()-interval '6 hours'
  order by updated_at desc
  limit 1;

  if found then
    update public.operations_hub_export_jobs
      set status=case when v_job.status='failed' then 'running' else v_job.status end,
          retry_count=case when v_job.status='failed' then retry_count+1 else retry_count end,
          last_error=case when v_job.status='failed' then null else last_error end,
          updated_at=clock_timestamp()
    where job_id=v_job.job_id
    returning * into v_job;
    return to_jsonb(v_job) || jsonb_build_object('resumed',true);
  end if;

  insert into public.operations_hub_export_jobs(
    source_channel,requested_by,selected_skus,include_stock,overwrite_blank,status,phase,snapshot
  ) values(
    v_source,v_actor,v_skus,coalesce(p_include_stock,false),coalesce(p_overwrite_blank,false),
    'queued','queued',jsonb_build_object('createdAt',clock_timestamp())
  )
  returning * into v_job;

  return to_jsonb(v_job) || jsonb_build_object('resumed',false);
end
$$;

create or replace function public.hub_export_job_checkpoint_v1(
  p_session_token text,
  p_job_id uuid,
  p_status text,
  p_phase text,
  p_processed_count integer default null,
  p_total_count integer default null,
  p_staged_count integer default null,
  p_blank_preserved_count integer default null,
  p_blank_overwrite_count integer default null,
  p_after_cursor text default null,
  p_change_batch_id uuid default null,
  p_last_error text default null
) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,operations_private
as $$
declare
  v_session jsonb;
  v_actor text;
  v_job public.operations_hub_export_jobs%rowtype;
  v_status text := lower(btrim(coalesce(p_status,'')));
begin
  v_session := operations_private.require_operations_hub_operator_session(p_session_token);
  v_actor := v_session->>'username';

  if v_status not in ('queued','running','inventory_ready','ready','failed','cancelled') then
    raise exception '작업 상태가 올바르지 않습니다.';
  end if;

  update public.operations_hub_export_jobs
  set status=v_status,
      phase=coalesce(nullif(btrim(p_phase),''),phase),
      processed_count=coalesce(p_processed_count,processed_count),
      total_count=coalesce(p_total_count,total_count),
      staged_count=coalesce(p_staged_count,staged_count),
      blank_preserved_count=coalesce(p_blank_preserved_count,blank_preserved_count),
      blank_overwrite_count=coalesce(p_blank_overwrite_count,blank_overwrite_count),
      after_cursor=coalesce(p_after_cursor,after_cursor),
      change_batch_id=coalesce(p_change_batch_id,change_batch_id),
      last_error=p_last_error,
      completed_at=case when v_status in ('ready','cancelled') then clock_timestamp() else completed_at end,
      updated_at=clock_timestamp()
  where job_id=p_job_id and requested_by=v_actor
  returning * into v_job;

  if not found then raise exception '내보내기 작업을 찾을 수 없습니다.'; end if;
  return to_jsonb(v_job);
end
$$;

create or replace function public.hub_export_job_get_v1(
  p_session_token text,
  p_job_id uuid default null,
  p_source_channel text default null
) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,operations_private
as $$
declare
  v_session jsonb;
  v_actor text;
  v_job public.operations_hub_export_jobs%rowtype;
begin
  v_session := operations_private.require_operations_hub_operator_session(p_session_token);
  v_actor := v_session->>'username';

  select * into v_job
  from public.operations_hub_export_jobs
  where requested_by=v_actor
    and (p_job_id is null or job_id=p_job_id)
    and (
      nullif(btrim(coalesce(p_source_channel,'')),'') is null
      or source_channel=lower(btrim(p_source_channel))
    )
  order by updated_at desc
  limit 1;

  if not found then return null; end if;
  return to_jsonb(v_job);
end
$$;

revoke all on function public.hub_export_job_begin_v1(text,text,text[],boolean,boolean) from public;
revoke all on function public.hub_export_job_checkpoint_v1(text,uuid,text,text,integer,integer,integer,integer,integer,text,uuid,text) from public;
revoke all on function public.hub_export_job_get_v1(text,uuid,text) from public;
grant execute on function public.hub_export_job_begin_v1(text,text,text[],boolean,boolean) to anon,authenticated;
grant execute on function public.hub_export_job_checkpoint_v1(text,uuid,text,text,integer,integer,integer,integer,integer,text,uuid,text) to anon,authenticated;
grant execute on function public.hub_export_job_get_v1(text,uuid,text) to anon,authenticated;

create or replace function operations_private.refresh_operations_hub_matrix_core_if_stale_background(
  p_actor text default 'operations_hub_background'
) returns jsonb
language plpgsql security definer
set search_path=public,operations_private,extensions,pg_temp
as $$
declare
  v_actor text := coalesce(nullif(btrim(p_actor),''),'operations_hub_background');
  v_latest_legacy timestamptz;
  v_recorded_legacy timestamptz;
  v_latest_sellpia_snapshot_id uuid;
  v_recorded_sellpia_snapshot_id uuid;
  v_core_refreshed_at timestamptz;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('operations_hub_matrix_core_refresh',0)) then
    return jsonb_build_object('status','locked','refreshed_by',v_actor);
  end if;

  select greatest(
    coalesce((select max(imported_at) from review.final_excel_mapping_import),'-infinity'::timestamptz),
    coalesce((select max(updated_at) from review.sheet_manual_mappings),'-infinity'::timestamptz)
  ) into v_latest_legacy;

  select snapshot_id into v_latest_sellpia_snapshot_id
  from public.sellpia_stock_snapshots
  where upload_status='ready'
  order by created_at desc
  limit 1;

  select core_refreshed_at,legacy_mapping_at,sellpia_snapshot_id
  into v_core_refreshed_at,v_recorded_legacy,v_recorded_sellpia_snapshot_id
  from operations_private.operations_hub_matrix_refresh_state
  where singleton;

  if v_latest_legacy <= coalesce(v_recorded_legacy,'-infinity'::timestamptz)
     and v_latest_sellpia_snapshot_id is not distinct from v_recorded_sellpia_snapshot_id then
    return jsonb_build_object(
      'status','skipped','reason','core_is_current',
      'core_refreshed_at',v_core_refreshed_at,'refreshed_by',v_actor
    );
  end if;

  return operations_private.refresh_operations_hub_matrix_core(v_actor);
end
$$;

create or replace function operations_private.refresh_operations_hub_matrix_core_if_stale(
  p_actor text default 'operations_hub_legacy_bridge'
) returns jsonb
language plpgsql security definer
set search_path=public,operations_private,extensions,pg_temp
as $$
declare v_at timestamptz;
begin
  select core_refreshed_at into v_at
  from operations_private.operations_hub_matrix_refresh_state
  where singleton;

  return jsonb_build_object(
    'status','background_managed',
    'core_refreshed_at',v_at,
    'refreshed_by',coalesce(nullif(btrim(p_actor),''),'operations_hub_legacy_bridge')
  );
end
$$;

create or replace function operations_private.refresh_operations_hub_matrix_export_cache_if_stale_background(
  p_actor text default 'operations_hub_background'
) returns jsonb
language plpgsql
set search_path=pg_catalog,public,operations_private,catalog
as $$
declare
  v_actor text := coalesce(nullif(btrim(p_actor),''),'operations_hub_background');
  v_cache_refreshed_at timestamptz;
  v_source_changed_at timestamptz;
begin
  select max(cache_refreshed_at)
  into v_cache_refreshed_at
  from operations_private.operations_hub_matrix_export_cache;

  select greatest(
    coalesce((select core_refreshed_at from operations_private.operations_hub_matrix_refresh_state where singleton),'-infinity'::timestamptz),
    coalesce((select max(coalesce(completed_at,created_at)) from public.seller_inventory_snapshots where upload_status='ready'),'-infinity'::timestamptz),
    coalesce((select max(updated_at) from public.operations_hub_manual_links),'-infinity'::timestamptz),
    coalesce((select max(updated_at) from public.operations_hub_seller_listing_overrides),'-infinity'::timestamptz),
    coalesce((select max(updated_at) from catalog.sellpia_product_attributes),'-infinity'::timestamptz),
    coalesce((select max(updated_at) from public.sellpia_tag_assignments),'-infinity'::timestamptz),
    coalesce((select max(updated_at) from public.product_tags),'-infinity'::timestamptz)
  ) into v_source_changed_at;

  if v_cache_refreshed_at is not null and v_source_changed_at <= v_cache_refreshed_at then
    return jsonb_build_object(
      'status','skipped','reason','cache_is_current',
      'refreshed_at',v_cache_refreshed_at,
      'source_changed_at',v_source_changed_at,
      'refreshed_by',v_actor
    );
  end if;

  if v_cache_refreshed_at is not null
     and clock_timestamp()-v_cache_refreshed_at < interval '5 minutes' then
    return jsonb_build_object(
      'status','deferred','reason','write_burst_debounce',
      'refreshed_at',v_cache_refreshed_at,
      'source_changed_at',v_source_changed_at,
      'refreshed_by',v_actor
    );
  end if;

  return operations_private.refresh_operations_hub_matrix_export_cache(v_actor);
end
$$;

create or replace function operations_private.refresh_operations_hub_matrix_export_cache_if_stale(
  p_actor text default 'operations_hub_export_cache'
) returns jsonb
language plpgsql
set search_path=pg_catalog,public,operations_private,catalog
as $$
declare v_at timestamptz;
begin
  select max(cache_refreshed_at) into v_at
  from operations_private.operations_hub_matrix_export_cache;

  return jsonb_build_object(
    'status','background_managed',
    'refreshed_at',v_at,
    'refreshed_by',coalesce(nullif(btrim(p_actor),''),'operations_hub_export_cache')
  );
end
$$;

do $$
declare r record;
begin
  for r in
    select jobid from cron.job
    where jobname in ('system-v3-core-cache-refresh-v1','system-v3-export-cache-refresh-v1')
  loop
    perform cron.unschedule(r.jobid);
  end loop;
end
$$;

select cron.schedule(
  'system-v3-core-cache-refresh-v1',
  '* * * * *',
  $$select operations_private.refresh_operations_hub_matrix_core_if_stale_background('pg_cron')$$
);

select cron.schedule(
  'system-v3-export-cache-refresh-v1',
  '* * * * *',
  $$select operations_private.refresh_operations_hub_matrix_export_cache_if_stale_background('pg_cron')$$
);

create index if not exists hub_field_references_child_rule_idx
  on operations_private.hub_field_references(child_sku,rule_id);
create index if not exists hub_field_references_relation_edge_idx
  on operations_private.hub_field_references(relation_edge_id)
  where relation_edge_id is not null;
create index if not exists hub_rule_assignments_tag_idx
  on operations_private.hub_rule_assignments(assigned_tag_id)
  where assigned_tag_id is not null;
create index if not exists hub_rule_assignments_rule_target_scope_idx
  on operations_private.hub_rule_assignments(rule_id,target_field,scope);
create index if not exists hub_rules_tag_idx
  on operations_private.hub_rules(tag_id)
  where tag_id is not null;

analyze public.operations_hub_change_queue;
analyze operations_private.operations_hub_matrix_export_cache;
notify pgrst,'reload schema';
