create or replace view public.operations_hub_dashboard_metrics
with (security_invoker = true)
as
with projected as (
  select
    matrix.*,
    coalesce(
      case when smart.status <> 'failed' then nullif(regexp_replace(smart.after_value #>> '{}', '[^0-9.-]', '', 'g'), '')::numeric end,
      matrix.smartstore_stock
    ) as projected_smartstore_stock,
    coalesce(
      case when make.status <> 'failed' then nullif(regexp_replace(make.after_value #>> '{}', '[^0-9.-]', '', 'g'), '')::numeric end,
      matrix.makeshop_stock
    ) as projected_makeshop_stock,
    coalesce(
      case when ably.status <> 'failed' then nullif(regexp_replace(ably.after_value #>> '{}', '[^0-9.-]', '', 'g'), '')::numeric end,
      matrix.ably_stock
    ) as projected_ably_stock,
    ((smart.change_id is not null)::integer + (make.change_id is not null)::integer + (ably.change_id is not null)::integer) as inventory_draft_cells,
    ((smart.status = 'failed')::integer + (make.status = 'failed')::integer + (ably.status = 'failed')::integer) as inventory_failed_cells
  from public.operations_hub_matrix_live matrix
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
        (projected_smartstore_stock is not null and projected_smartstore_stock <> sellpia_current_stock)
        or (projected_makeshop_stock is not null and projected_makeshop_stock <> sellpia_current_stock)
        or (projected_ably_stock is not null and projected_ably_stock <> sellpia_current_stock)
      )
  )::integer as projected_inventory_mismatch_sku,
  sum(inventory_draft_cells)::integer as inventory_draft_cells,
  sum(inventory_failed_cells)::integer as inventory_failed_cells
from projected;

revoke all on public.operations_hub_dashboard_metrics from public;
grant select on public.operations_hub_dashboard_metrics to anon, authenticated;
