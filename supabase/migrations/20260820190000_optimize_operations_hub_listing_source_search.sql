create or replace function public.find_operations_hub_listing_skus_by_sources(
  p_query text,
  p_sources text[] default array['smartstore','makeshop','ably']::text[],
  p_limit integer default 500
)
returns table (sellpia_sku_code text)
language sql
stable
security invoker
set search_path = pg_catalog, public, operations_private
as $$
  with allowed_sources as (
    select distinct lower(btrim(source)) as source_channel
    from unnest(coalesce(p_sources, '{}'::text[])) source
    where lower(btrim(source)) = any(array['smartstore','makeshop','ably'])
  ), effective_links as (
    select
      matrix.sellpia_sku_code,
      link.source_channel,
      link.product_code,
      coalesce(link.option_code, '') as option_code
    from public.operations_hub_matrix_cached matrix
    cross join lateral (
      values
        ('smartstore'::text, matrix.smartstore_product_code, matrix.smartstore_option_code),
        ('makeshop'::text, matrix.makeshop_product_code, matrix.makeshop_option_code),
        ('ably'::text, matrix.ably_product_code, matrix.ably_option_code)
    ) link(source_channel, product_code, option_code)
    join allowed_sources source using(source_channel)
    where link.product_code is not null
  )
  select distinct link.sellpia_sku_code
  from effective_links link
  where case
    when link.option_code = '' then link.product_code
    else link.product_code || '-' || link.option_code
  end = btrim(coalesce(p_query, ''))
  order by link.sellpia_sku_code
  limit greatest(1, least(coalesce(p_limit, 500), 2000));
$$;

revoke all on function public.find_operations_hub_listing_skus_by_sources(text, text[], integer) from public;
grant execute on function public.find_operations_hub_listing_skus_by_sources(text, text[], integer) to anon, authenticated;

notify pgrst, 'reload schema';
