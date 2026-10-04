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
  with candidate_edges as materialized (
    select
      seller.source_channel,
      seller.product_code,
      coalesce(seller.option_code, '') as option_code,
      seller.product_name,
      seller.option_name,
      matrix.sellpia_sku_code
    from public.operations_hub_matrix_live matrix
    cross join lateral (
      values
        ('smartstore'::text, matrix.smartstore_product_code, coalesce(matrix.smartstore_option_code, ''), matrix.smartstore_name, matrix.smartstore_option_name),
        ('makeshop'::text, matrix.makeshop_product_code, coalesce(matrix.makeshop_option_code, ''), matrix.makeshop_name, matrix.makeshop_option_name),
        ('ably'::text, matrix.ably_product_code, coalesce(matrix.ably_option_code, ''), matrix.ably_name, matrix.ably_option_name)
    ) as seller(source_channel, product_code, option_code, product_name, option_name)
    where nullif(btrim(seller.product_code), '') is not null
  ), identity_counts as (
    select source_channel, product_code, option_code, count(*)::integer as edge_count
    from candidate_edges
    group by source_channel, product_code, option_code
  )
  select
    edge.source_channel,
    edge.product_code,
    edge.option_code,
    edge.product_name,
    edge.option_name,
    edge.sellpia_sku_code,
    now()
  from candidate_edges edge
  join identity_counts identity
    on identity.source_channel = edge.source_channel
   and identity.product_code = edge.product_code
   and identity.option_code = edge.option_code
  where (p_skus is null or edge.sellpia_sku_code = any(p_skus))
    and (edge.option_code <> '' or identity.edge_count = 1)
  on conflict (source_channel, product_code, option_code, sellpia_sku_code)
  do update set
    product_name = excluded.product_name,
    option_name = excluded.option_name,
    refreshed_at = excluded.refreshed_at;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

comment on function public.refresh_operations_hub_listing_legacy_cache(text[]) is
  'Refreshes legacy mapping edges, excluding ambiguous product-only identities when one blank option code points at multiple Sellpia SKUs.';

select public.refresh_operations_hub_listing_legacy_cache(null);
