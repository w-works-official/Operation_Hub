create or replace view public.operations_hub_seller_connection_live
with (security_invoker = true)
as
with seller_skus as materialized (
  select
    source_channel,
    product_code,
    coalesce(option_code, '') as option_code,
    max(product_name) as product_name,
    max(option_name) as option_name
  from public.seller_inventory_latest
  group by source_channel, product_code, coalesce(option_code, '')
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
)
select
  seller.source_channel,
  seller.product_code,
  seller.option_code,
  seller.product_name,
  seller.option_name,
  (
    explicit_link.product_code is not null
    or (explicit_listing.product_code is null and legacy_link.product_code is not null)
  ) as is_connected
from seller_skus seller
left join explicit_listings explicit_listing
  using (source_channel, product_code, option_code)
left join explicit_links explicit_link
  using (source_channel, product_code, option_code)
left join legacy_links legacy_link
  using (source_channel, product_code, option_code);

create or replace view public.operations_hub_seller_unmatched_live
with (security_invoker = true)
as
select
  source_channel,
  product_code,
  option_code,
  product_name,
  option_name
from public.operations_hub_seller_connection_live
where not is_connected;

create or replace view public.operations_hub_seller_connection_summary
with (security_invoker = true)
as
select
  source_channel,
  count(*)::integer as seller_sku_total,
  count(*) filter (where is_connected)::integer as seller_connected_sku,
  count(*) filter (where not is_connected)::integer as seller_unmatched_sku
from public.operations_hub_seller_connection_live
group by source_channel;

revoke all on public.operations_hub_seller_connection_live from public;
revoke all on public.operations_hub_seller_unmatched_live from public;
revoke all on public.operations_hub_seller_connection_summary from public;
grant select on public.operations_hub_seller_connection_live to anon, authenticated;
grant select on public.operations_hub_seller_unmatched_live to anon, authenticated;
grant select on public.operations_hub_seller_connection_summary to anon, authenticated;

notify pgrst, 'reload schema';
