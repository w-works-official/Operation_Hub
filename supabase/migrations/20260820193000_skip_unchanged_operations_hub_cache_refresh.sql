create or replace function operations_private.refresh_operations_hub_matrix_export_cache_if_stale(
  p_actor text default 'operations_hub_export_cache'
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, operations_private, catalog
as $$
declare
  v_actor text := coalesce(nullif(btrim(p_actor), ''), 'operations_hub_export_cache');
  v_cache_refreshed_at timestamptz;
  v_source_changed_at timestamptz;
begin
  if v_actor !~ '^[0-9A-Za-z_.:@-]{3,120}$' then
    raise exception 'Invalid cache refresh actor.';
  end if;

  select max(cache_refreshed_at)
  into v_cache_refreshed_at
  from operations_private.operations_hub_matrix_export_cache;

  select greatest(
    coalesce((select core_refreshed_at from operations_private.operations_hub_matrix_refresh_state where singleton), '-infinity'::timestamptz),
    coalesce((select max(coalesce(completed_at, created_at)) from public.seller_inventory_snapshots where upload_status = 'ready'), '-infinity'::timestamptz),
    coalesce((select max(updated_at) from public.operations_hub_manual_links), '-infinity'::timestamptz),
    coalesce((select max(updated_at) from public.operations_hub_sellpia_overrides), '-infinity'::timestamptz),
    coalesce((select max(updated_at) from public.operations_hub_seller_listing_overrides), '-infinity'::timestamptz),
    coalesce((select max(updated_at) from public.operations_hub_change_queue), '-infinity'::timestamptz),
    coalesce((select max(updated_at) from catalog.sellpia_product_attributes), '-infinity'::timestamptz),
    coalesce((select max(updated_at) from public.sellpia_tag_assignments), '-infinity'::timestamptz),
    coalesce((select max(updated_at) from public.product_tags), '-infinity'::timestamptz)
  ) into v_source_changed_at;

  if v_cache_refreshed_at is not null and v_source_changed_at <= v_cache_refreshed_at then
    return jsonb_build_object(
      'status', 'skipped',
      'reason', 'cache_is_current',
      'refreshed_at', v_cache_refreshed_at,
      'source_changed_at', v_source_changed_at,
      'refreshed_by', v_actor
    );
  end if;

  return operations_private.refresh_operations_hub_matrix_export_cache(v_actor);
end;
$$;

revoke all on function operations_private.refresh_operations_hub_matrix_export_cache_if_stale(text) from public, anon, authenticated;

do $$
declare
  v_job_id bigint;
begin
  select jobid
  into v_job_id
  from cron.job
  where jobname = 'operations-hub-csv-export-cache-refresh'
  limit 1;

  if v_job_id is not null then
    perform cron.alter_job(
      v_job_id,
      command := 'select operations_private.refresh_operations_hub_matrix_export_cache_if_stale(''cron_matrix_read_cache'');'
    );
  end if;
end;
$$;
