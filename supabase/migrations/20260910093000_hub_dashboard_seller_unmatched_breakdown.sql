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
),
seller_skus as materialized (
  select distinct
    source_channel,
    product_code,
    coalesce(option_code, '') as option_code
  from public.seller_inventory_latest
),
explicit_listings as materialized (
  select distinct
    source_channel,
    product_code,
    coalesce(option_code, '') as option_code
  from public.operations_hub_seller_listings
  where is_active
),
explicit_links as materialized (
  select distinct
    listing.source_channel,
    listing.product_code,
    coalesce(listing.option_code, '') as option_code
  from public.operations_hub_seller_listings listing
  join public.operations_hub_listing_components component
    on component.listing_id = listing.listing_id
   and component.is_active
  where listing.is_active
),
legacy_links as materialized (
  select distinct
    source_channel,
    product_code,
    coalesce(option_code, '') as option_code
  from public.operations_hub_listing_legacy_cache
  where nullif(btrim(coalesce(sellpia_sku_code, '')), '') is not null
),
seller_metrics as materialized (
  select
    count(*)::integer as seller_sku_total,
    count(*) filter (
      where explicit_link.product_code is not null
         or (explicit_listing.product_code is null and legacy_link.product_code is not null)
    )::integer as seller_connected_sku,
    count(*) filter (
      where explicit_link.product_code is null
        and (explicit_listing.product_code is not null or legacy_link.product_code is null)
    )::integer as seller_unmatched_sku,
    count(*) filter (
      where seller.source_channel = 'smartstore'
        and explicit_link.product_code is null
        and (explicit_listing.product_code is not null or legacy_link.product_code is null)
    )::integer as seller_unmatched_smartstore,
    count(*) filter (
      where seller.source_channel = 'makeshop'
        and explicit_link.product_code is null
        and (explicit_listing.product_code is not null or legacy_link.product_code is null)
    )::integer as seller_unmatched_makeshop,
    count(*) filter (
      where seller.source_channel = 'ably'
        and explicit_link.product_code is null
        and (explicit_listing.product_code is not null or legacy_link.product_code is null)
    )::integer as seller_unmatched_ably
  from seller_skus seller
  left join explicit_listings explicit_listing
    using (source_channel, product_code, option_code)
  left join explicit_links explicit_link
    using (source_channel, product_code, option_code)
  left join legacy_links legacy_link
    using (source_channel, product_code, option_code)
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
  clock_timestamp() as cache_refreshed_at,
  max(seller_metrics.seller_sku_total)::integer as seller_sku_total,
  max(seller_metrics.seller_connected_sku)::integer as seller_connected_sku,
  max(seller_metrics.seller_unmatched_sku)::integer as seller_unmatched_sku,
  max(seller_metrics.seller_unmatched_smartstore)::integer as seller_unmatched_smartstore,
  max(seller_metrics.seller_unmatched_makeshop)::integer as seller_unmatched_makeshop,
  max(seller_metrics.seller_unmatched_ably)::integer as seller_unmatched_ably
from projected
cross join seller_metrics;

drop view if exists public.operations_hub_dashboard_metrics;
drop materialized view if exists operations_private.operations_hub_dashboard_metrics_cache;

create materialized view operations_private.operations_hub_dashboard_metrics_cache
as select * from operations_private.operations_hub_dashboard_metrics_source;

create unique index operations_hub_dashboard_metrics_cache_singleton_idx
  on operations_private.operations_hub_dashboard_metrics_cache (singleton);

grant select on operations_private.operations_hub_dashboard_metrics_cache to anon, authenticated;

create view public.operations_hub_dashboard_metrics
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
  inventory_failed_cells,
  seller_sku_total,
  seller_connected_sku,
  seller_unmatched_sku,
  seller_unmatched_smartstore,
  seller_unmatched_makeshop,
  seller_unmatched_ably
from operations_private.operations_hub_dashboard_metrics_cache
where singleton;

revoke all on public.operations_hub_dashboard_metrics from public;
grant select on public.operations_hub_dashboard_metrics to anon, authenticated;

notify pgrst, 'reload schema';
