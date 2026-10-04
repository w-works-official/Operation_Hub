create or replace view operations_private.operations_hub_dashboard_metrics_source
with (security_invoker = true)
as
with projected as (
  select
    matrix.sellpia_sku_code,
    matrix.overall_status,
    matrix.sellpia_current_stock,
    matrix.smartstore_stock,
    matrix.makeshop_stock,
    matrix.ably_stock,
    matrix.sellpia_inventory_at,
    matrix.smartstore_inventory_at,
    matrix.makeshop_inventory_at,
    matrix.ably_inventory_at,
    matrix.sellpia_override_updated_at,
    coalesce(
      case when smart.status <> 'failed'
        then nullif(regexp_replace(smart.after_value #>> '{}', '[^0-9.-]', '', 'g'), '')::numeric
      end,
      matrix.smartstore_stock::numeric
    ) as projected_smartstore_stock,
    coalesce(
      case when make.status <> 'failed'
        then nullif(regexp_replace(make.after_value #>> '{}', '[^0-9.-]', '', 'g'), '')::numeric
      end,
      matrix.makeshop_stock::numeric
    ) as projected_makeshop_stock,
    coalesce(
      case when ably.status <> 'failed'
        then nullif(regexp_replace(ably.after_value #>> '{}', '[^0-9.-]', '', 'g'), '')::numeric
      end,
      matrix.ably_stock::numeric
    ) as projected_ably_stock,
    (smart.change_id is not null)::integer
      + (make.change_id is not null)::integer
      + (ably.change_id is not null)::integer as inventory_draft_cells,
    (smart.status = 'failed')::integer
      + (make.status = 'failed')::integer
      + (ably.status = 'failed')::integer as inventory_failed_cells
  from operations_private.operations_hub_matrix_export_cache matrix
  left join public.operations_hub_active_seller_drafts smart
    on smart.sellpia_sku_code = matrix.sellpia_sku_code
   and smart.source_channel = 'smartstore'
   and smart.field_key = 'sellpia_current_stock'
  left join public.operations_hub_active_seller_drafts make
    on make.sellpia_sku_code = matrix.sellpia_sku_code
   and make.source_channel = 'makeshop'
   and make.field_key = 'sellpia_current_stock'
  left join public.operations_hub_active_seller_drafts ably
    on ably.sellpia_sku_code = matrix.sellpia_sku_code
   and ably.source_channel = 'ably'
   and ably.field_key = 'sellpia_current_stock'
)
select
  true as singleton,
  count(*)::integer as total_sku,
  count(*) filter (where overall_status <> 'unmatched')::integer as connected_sku,
  count(*) filter (where overall_status = 'unmatched')::integer as unmatched_sku,
  count(*) filter (
    where sellpia_current_stock is not null
      and (
        (smartstore_stock is not null and smartstore_stock <> sellpia_current_stock)
        or (makeshop_stock is not null and makeshop_stock <> sellpia_current_stock)
        or (ably_stock is not null and ably_stock <> sellpia_current_stock)
      )
  )::integer as inventory_mismatch_sku,
  max(greatest(
    coalesce(sellpia_inventory_at, '-infinity'::timestamptz),
    coalesce(smartstore_inventory_at, '-infinity'::timestamptz),
    coalesce(makeshop_inventory_at, '-infinity'::timestamptz),
    coalesce(ably_inventory_at, '-infinity'::timestamptz),
    coalesce(sellpia_override_updated_at, '-infinity'::timestamptz)
  )) as latest_sync_at,
  null::integer as today_picked,
  null::integer as shortage_drawer_qty,
  count(*) filter (
    where sellpia_current_stock is not null
      and (
        (projected_smartstore_stock is not null and projected_smartstore_stock <> sellpia_current_stock::numeric)
        or (projected_makeshop_stock is not null and projected_makeshop_stock <> sellpia_current_stock::numeric)
        or (projected_ably_stock is not null and projected_ably_stock <> sellpia_current_stock::numeric)
      )
  )::integer as projected_inventory_mismatch_sku,
  coalesce(sum(inventory_draft_cells), 0)::integer as inventory_draft_cells,
  coalesce(sum(inventory_failed_cells), 0)::integer as inventory_failed_cells,
  clock_timestamp() as cache_refreshed_at
from projected;

create materialized view if not exists operations_private.operations_hub_dashboard_metrics_cache
as select * from operations_private.operations_hub_dashboard_metrics_source;

create unique index if not exists operations_hub_dashboard_metrics_cache_singleton_idx
  on operations_private.operations_hub_dashboard_metrics_cache (singleton);

grant select on operations_private.operations_hub_dashboard_metrics_cache to anon, authenticated;

create or replace view public.operations_hub_dashboard_metrics
with (security_invoker = true)
as
select
  total_sku,
  connected_sku,
  unmatched_sku,
  inventory_mismatch_sku,
  latest_sync_at,
  today_picked,
  shortage_drawer_qty,
  projected_inventory_mismatch_sku,
  inventory_draft_cells,
  inventory_failed_cells
from operations_private.operations_hub_dashboard_metrics_cache
where singleton;

revoke all on public.operations_hub_dashboard_metrics from public;
grant select on public.operations_hub_dashboard_metrics to anon, authenticated;

do $$
declare
  v_definition text;
  v_rewritten text;
begin
  v_definition := pg_get_functiondef(
    'operations_private.refresh_operations_hub_matrix_export_cache(text)'::regprocedure
  );
  if position('refresh materialized view concurrently operations_private.operations_hub_dashboard_metrics_cache;' in v_definition) = 0 then
    v_rewritten := replace(
      v_definition,
      'refresh materialized view concurrently operations_private.operations_hub_matrix_export_cache;',
      'refresh materialized view concurrently operations_private.operations_hub_matrix_export_cache;
  refresh materialized view concurrently operations_private.operations_hub_dashboard_metrics_cache;'
    );
    if v_rewritten = v_definition then
      raise exception 'Matrix cache refresh statement was not found; dashboard cache hook was not installed.';
    end if;
    execute v_rewritten;
  end if;
end;
$$;

notify pgrst, 'reload schema';
