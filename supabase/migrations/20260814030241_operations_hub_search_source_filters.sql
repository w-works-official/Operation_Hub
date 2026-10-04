create or replace function public.find_operations_hub_listing_skus_by_sources(
  p_query text,
  p_sources text[] default array['smartstore', 'makeshop', 'ably']::text[],
  p_limit integer default 500
)
returns table (sellpia_sku_code text)
language sql
security invoker
set search_path = public, operations_private, pg_temp
as $$
  with allowed_sources as (
    select distinct lower(btrim(source)) as source_channel
    from unnest(coalesce(p_sources, '{}'::text[])) as source
    where lower(btrim(source)) in ('smartstore', 'makeshop', 'ably')
  ), effective_links as (
    select 'smartstore'::text as source_channel,
           matrix.sellpia_sku_code,
           matrix.smartstore_product_code as product_code,
           coalesce(matrix.smartstore_option_code, '') as option_code
    from operations_private.operations_hub_matrix_core matrix
    where matrix.smartstore_product_code is not null
      and not exists (
        select 1 from public.operations_hub_manual_links manual
        where manual.source_channel = 'smartstore'
          and manual.sellpia_sku_code = matrix.sellpia_sku_code
      )
    union all
    select 'makeshop', matrix.sellpia_sku_code, matrix.makeshop_product_code, coalesce(matrix.makeshop_option_code, '')
    from operations_private.operations_hub_matrix_core matrix
    where matrix.makeshop_product_code is not null
      and not exists (
        select 1 from public.operations_hub_manual_links manual
        where manual.source_channel = 'makeshop'
          and manual.sellpia_sku_code = matrix.sellpia_sku_code
      )
    union all
    select 'ably', matrix.sellpia_sku_code, matrix.ably_product_code, coalesce(matrix.ably_option_code, '')
    from operations_private.operations_hub_matrix_core matrix
    where matrix.ably_product_code is not null
      and not exists (
        select 1 from public.operations_hub_manual_links manual
        where manual.source_channel = 'ably'
          and manual.sellpia_sku_code = matrix.sellpia_sku_code
      )
    union all
    select manual.source_channel, manual.sellpia_sku_code, manual.product_code, manual.option_code
    from public.operations_hub_manual_links manual
  )
  select distinct link.sellpia_sku_code
  from effective_links link
  join allowed_sources source on source.source_channel = link.source_channel
  where case when link.option_code = '' then link.product_code
             else link.product_code || '-' || link.option_code end = btrim(p_query)
  order by link.sellpia_sku_code
  limit greatest(1, least(coalesce(p_limit, 500), 2000));
$$;

revoke all on function public.find_operations_hub_listing_skus_by_sources(text, text[], integer) from public;
grant execute on function public.find_operations_hub_listing_skus_by_sources(text, text[], integer) to anon, authenticated;
