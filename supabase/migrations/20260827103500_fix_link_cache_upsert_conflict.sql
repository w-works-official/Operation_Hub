-- Resolve PL/pgSQL output-column ambiguity in the targeted legacy-cache upsert.
create or replace function public.link_operations_hub_seller_item_v2(
  p_sku text,
  p_source text,
  p_product_code text,
  p_option_code text default ''
)
returns table (
  source_channel text,
  sellpia_sku_code text,
  product_code text,
  option_code text,
  product_name text,
  option_name text,
  stock integer,
  price numeric,
  linked_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  select linked.*
  from public.link_operations_hub_seller_item(
    p_sku,
    p_source,
    p_product_code,
    p_option_code
  ) linked;

  delete from public.operations_hub_link_suppressions suppression
  where suppression.source_channel = lower(btrim(coalesce(p_source, '')))
    and suppression.sellpia_sku_code = btrim(coalesce(p_sku, ''))
    and suppression.product_code = btrim(coalesce(p_product_code, ''))
    and suppression.option_code = btrim(coalesce(p_option_code, ''));

  delete from public.operations_hub_listing_legacy_cache cache
  where cache.source_channel = lower(btrim(coalesce(p_source, '')))
    and cache.sellpia_sku_code = btrim(coalesce(p_sku, ''));

  insert into public.operations_hub_listing_legacy_cache (
    source_channel, product_code, option_code, product_name, option_name, sellpia_sku_code, refreshed_at
  )
  select
    manual.source_channel,
    manual.product_code,
    coalesce(manual.option_code, ''),
    manual.product_name,
    manual.option_name,
    manual.sellpia_sku_code,
    now()
  from public.operations_hub_manual_links manual
  where manual.source_channel = lower(btrim(coalesce(p_source, '')))
    and manual.sellpia_sku_code = btrim(coalesce(p_sku, ''))
  on conflict on constraint operations_hub_listing_legacy_cache_pkey
  do update set
    product_name = excluded.product_name,
    option_name = excluded.option_name,
    refreshed_at = excluded.refreshed_at;

  insert into public.operations_hub_listing_components (
    listing_id, sellpia_sku_code, component_qty, component_role, mapping_origin, is_active, updated_by, updated_at
  )
  select
    listing.listing_id,
    btrim(coalesce(p_sku, '')),
    1,
    'primary',
    'manual',
    true,
    'operations_hub_frontend',
    now()
  from public.operations_hub_seller_listings listing
  where listing.source_channel = lower(btrim(coalesce(p_source, '')))
    and listing.product_code = btrim(coalesce(p_product_code, ''))
    and listing.option_code = btrim(coalesce(p_option_code, ''))
    and listing.is_active
  on conflict on constraint operations_hub_listing_componen_listing_id_sellpia_sku_code_key
  do update set
    component_qty = excluded.component_qty,
    component_role = excluded.component_role,
    mapping_origin = excluded.mapping_origin,
    is_active = true,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;
end;
$$;

comment on function public.link_operations_hub_seller_item_v2(text, text, text, text) is
  'Saves a manual seller link and refreshes only that exact cached edge; no catalog-wide cache rebuild is required.';

revoke all on function public.link_operations_hub_seller_item_v2(text, text, text, text) from public;
grant execute on function public.link_operations_hub_seller_item_v2(text, text, text, text) to anon, authenticated;
