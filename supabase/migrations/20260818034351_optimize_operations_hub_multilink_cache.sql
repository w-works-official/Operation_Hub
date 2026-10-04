-- Cache only stable listing identity/mapping edges. Sellpia stock stays live through a lightweight view.

create table public.operations_hub_listing_legacy_cache (
  source_channel text not null check (source_channel in ('smartstore', 'makeshop', 'ably')),
  product_code text not null,
  option_code text not null default '',
  product_name text,
  option_name text,
  sellpia_sku_code text not null,
  refreshed_at timestamptz not null default now(),
  primary key (source_channel, product_code, option_code, sellpia_sku_code)
);

create index operations_hub_listing_legacy_cache_sku_idx
  on public.operations_hub_listing_legacy_cache (sellpia_sku_code, source_channel);

alter table public.operations_hub_listing_legacy_cache enable row level security;
create policy "operations hub listing legacy cache readable"
  on public.operations_hub_listing_legacy_cache for select
  to anon, authenticated using (true);
create policy "operations hub listing legacy cache insertable"
  on public.operations_hub_listing_legacy_cache for insert
  to anon, authenticated with check (true);
create policy "operations hub listing legacy cache updatable"
  on public.operations_hub_listing_legacy_cache for update
  to anon, authenticated using (true) with check (true);
create policy "operations hub listing legacy cache deletable"
  on public.operations_hub_listing_legacy_cache for delete
  to anon, authenticated using (true);
grant select, insert, update, delete on public.operations_hub_listing_legacy_cache to anon, authenticated;

create or replace view public.operations_hub_sellpia_component_live
with (security_invoker = true)
as
select
  stock.sellpia_sku_code,
  coalesce(nullif(btrim(override_row.product_name), ''), nullif(btrim(stock.sellpia_product_name), '')) as sellpia_product_name,
  coalesce(nullif(btrim(override_row.option_name), ''), nullif(btrim(stock.sellpia_option_name), '')) as sellpia_option_name,
  coalesce(nullif(btrim(override_row.own_code), ''), nullif(btrim(stock.own_sku), '')) as sellpia_own_code,
  case
    when override_row.current_stock is not null then override_row.current_stock
    else coalesce(stock.available_stock, stock.integrated_available_stock, stock.stock)
  end as sellpia_available_stock,
  greatest(stock.snapshot_completed_at, coalesce(override_row.updated_at, '-infinity'::timestamptz)) as updated_at
from public.sellpia_stock_latest stock
left join public.operations_hub_sellpia_overrides override_row
  on override_row.sellpia_sku_code = stock.sellpia_sku_code;

grant select on public.operations_hub_sellpia_component_live to anon, authenticated;

create or replace function public.refresh_operations_hub_listing_legacy_cache(p_skus text[] default null)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_rows integer := 0;
begin
  delete from public.operations_hub_listing_legacy_cache cache
  where p_skus is null
     or cache.sellpia_sku_code = any(p_skus);

  insert into public.operations_hub_listing_legacy_cache (
    source_channel, product_code, option_code, product_name, option_name, sellpia_sku_code, refreshed_at
  )
  select
    seller.source_channel,
    seller.product_code,
    coalesce(seller.option_code, ''),
    seller.product_name,
    seller.option_name,
    matrix.sellpia_sku_code,
    now()
  from public.operations_hub_matrix_live matrix
  cross join lateral (
    values
      ('smartstore'::text, matrix.smartstore_product_code, coalesce(matrix.smartstore_option_code, ''), matrix.smartstore_name, matrix.smartstore_option_name),
      ('makeshop'::text, matrix.makeshop_product_code, coalesce(matrix.makeshop_option_code, ''), matrix.makeshop_name, matrix.makeshop_option_name),
      ('ably'::text, matrix.ably_product_code, coalesce(matrix.ably_option_code, ''), matrix.ably_name, matrix.ably_option_name)
  ) as seller(source_channel, product_code, option_code, product_name, option_name)
  where nullif(btrim(seller.product_code), '') is not null
    and (p_skus is null or matrix.sellpia_sku_code = any(p_skus))
  on conflict (source_channel, product_code, option_code, sellpia_sku_code)
  do update set
    product_name = excluded.product_name,
    option_name = excluded.option_name,
    refreshed_at = excluded.refreshed_at;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke all on function public.refresh_operations_hub_listing_legacy_cache(text[]) from public;
grant execute on function public.refresh_operations_hub_listing_legacy_cache(text[]) to anon, authenticated;

create or replace view public.operations_hub_listing_component_projection
with (security_invoker = true)
as
with explicit_components as (
  select
    'explicit'::text as mapping_source,
    listing.listing_id,
    component.component_id,
    listing.source_channel,
    listing.product_code,
    coalesce(listing.option_code, '') as option_code,
    listing.product_name,
    listing.option_name,
    component.sellpia_sku_code,
    component.component_qty,
    component.component_role,
    sellpia.sellpia_product_name,
    sellpia.sellpia_option_name,
    sellpia.sellpia_own_code,
    sellpia.sellpia_available_stock,
    greatest(listing.updated_at, component.updated_at, sellpia.updated_at) as updated_at
  from public.operations_hub_seller_listings listing
  join public.operations_hub_listing_components component
    on component.listing_id = listing.listing_id
   and component.is_active
  left join public.operations_hub_sellpia_component_live sellpia
    on sellpia.sellpia_sku_code = component.sellpia_sku_code
  where listing.is_active
), legacy_components as (
  select
    'legacy'::text as mapping_source,
    null::bigint as listing_id,
    null::bigint as component_id,
    cache.source_channel,
    cache.product_code,
    cache.option_code,
    cache.product_name,
    cache.option_name,
    cache.sellpia_sku_code,
    1::integer as component_qty,
    'primary'::text as component_role,
    sellpia.sellpia_product_name,
    sellpia.sellpia_option_name,
    sellpia.sellpia_own_code,
    sellpia.sellpia_available_stock,
    greatest(cache.refreshed_at, sellpia.updated_at) as updated_at
  from public.operations_hub_listing_legacy_cache cache
  left join public.operations_hub_sellpia_component_live sellpia
    on sellpia.sellpia_sku_code = cache.sellpia_sku_code
  where not exists (
    select 1
    from public.operations_hub_seller_listings explicit_listing
    where explicit_listing.is_active
      and explicit_listing.source_channel = cache.source_channel
      and explicit_listing.product_code = cache.product_code
      and explicit_listing.option_code = cache.option_code
  )
)
select * from explicit_components
union all
select * from legacy_components;

-- Seed once. Later mapping changes can refresh only their SKU(s); external bulk remaps can request a full refresh.
select public.refresh_operations_hub_listing_legacy_cache(null);
