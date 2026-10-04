create index if not exists operations_hub_matrix_export_cache_smartstore_code_idx
  on operations_private.operations_hub_matrix_export_cache (
    (case
      when coalesce(smartstore_option_code, '') = '' then smartstore_product_code
      else smartstore_product_code || '-' || smartstore_option_code
    end),
    sellpia_sku_code
  )
  where smartstore_product_code is not null;

create index if not exists operations_hub_matrix_export_cache_makeshop_code_idx
  on operations_private.operations_hub_matrix_export_cache (
    (case
      when coalesce(makeshop_option_code, '') = '' then makeshop_product_code
      else makeshop_product_code || '-' || makeshop_option_code
    end),
    sellpia_sku_code
  )
  where makeshop_product_code is not null;

create index if not exists operations_hub_matrix_export_cache_ably_code_idx
  on operations_private.operations_hub_matrix_export_cache (
    (case
      when coalesce(ably_option_code, '') = '' then ably_product_code
      else ably_product_code || '-' || ably_option_code
    end),
    sellpia_sku_code
  )
  where ably_product_code is not null;

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
  with allowed_sources as materialized (
    select distinct lower(btrim(source)) as source_channel
    from unnest(coalesce(p_sources, '{}'::text[])) source
    where lower(btrim(source)) = any(array['smartstore','makeshop','ably'])
  ), matches as (
    select matrix.sellpia_sku_code
    from operations_private.operations_hub_matrix_export_cache matrix
    where exists (select 1 from allowed_sources where source_channel = 'smartstore')
      and matrix.smartstore_product_code is not null
      and case
        when coalesce(matrix.smartstore_option_code, '') = '' then matrix.smartstore_product_code
        else matrix.smartstore_product_code || '-' || matrix.smartstore_option_code
      end = btrim(coalesce(p_query, ''))
    union all
    select matrix.sellpia_sku_code
    from operations_private.operations_hub_matrix_export_cache matrix
    where exists (select 1 from allowed_sources where source_channel = 'makeshop')
      and matrix.makeshop_product_code is not null
      and case
        when coalesce(matrix.makeshop_option_code, '') = '' then matrix.makeshop_product_code
        else matrix.makeshop_product_code || '-' || matrix.makeshop_option_code
      end = btrim(coalesce(p_query, ''))
    union all
    select matrix.sellpia_sku_code
    from operations_private.operations_hub_matrix_export_cache matrix
    where exists (select 1 from allowed_sources where source_channel = 'ably')
      and matrix.ably_product_code is not null
      and case
        when coalesce(matrix.ably_option_code, '') = '' then matrix.ably_product_code
        else matrix.ably_product_code || '-' || matrix.ably_option_code
      end = btrim(coalesce(p_query, ''))
  )
  select distinct matches.sellpia_sku_code
  from matches
  order by matches.sellpia_sku_code
  limit greatest(1, least(coalesce(p_limit, 500), 2000));
$$;

revoke all on function public.find_operations_hub_listing_skus_by_sources(text, text[], integer) from public;
grant execute on function public.find_operations_hub_listing_skus_by_sources(text, text[], integer) to anon, authenticated;

notify pgrst, 'reload schema';
