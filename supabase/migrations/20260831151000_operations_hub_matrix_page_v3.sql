-- Page keys are selected from the compact export cache before the expensive
-- managed matrix view is expanded. OFFSET 0 inside the lateral lookup is
-- intentional: it keeps PostgreSQL from flattening the detail view and
-- rebuilding all catalog rows before joining the requested page.
create or replace function public.load_operations_hub_matrix_page_v3(
  p_page integer default 1,
  p_page_size integer default 50,
  p_search text default '',
  p_search_sources text[] default array['sellpia','smartstore','makeshop','ably']::text[],
  p_status text default 'all',
  p_sort text default 'sku_asc',
  p_exclude_dependent boolean default false
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := greatest(1, least(coalesce(p_page_size, 50), 200));
  v_search text := btrim(coalesce(p_search, ''));
  v_sources text[];
  v_status text := lower(coalesce(p_status, 'all'));
  v_sort text := lower(coalesce(p_sort, 'sku_asc'));
  v_product_term text;
  v_option_term text;
  v_result jsonb;
begin
  select coalesce(array_agg(distinct lower(btrim(source))), '{}'::text[])
  into v_sources
  from unnest(coalesce(p_search_sources, '{}'::text[])) source
  where lower(btrim(source)) = any(array['sellpia','smartstore','makeshop','ably']);

  if v_status not in ('all','connected','review','unmatched','attention') then
    v_status := 'all';
  end if;
  if v_sort not in ('sku_asc','stock_desc','price_desc','updated_desc') then
    v_sort := 'sku_asc';
  end if;
  if position('/' in v_search) > 0 then
    v_product_term := nullif(btrim(split_part(v_search, '/', 1)), '');
    v_option_term := nullif(btrim(substr(v_search, position('/' in v_search) + 1)), '');
  end if;

  with filtered_keys as not materialized (
    select
      cache.sellpia_sku_code,
      coalesce(master.stock_quantity, cache.sellpia_current_stock) as sort_stock,
      coalesce(master.base_price, cache.sellpia_sale_price) as sort_price,
      cache.updated_at as sort_updated_at,
      case
        when cache.sellpia_sku_code ~ '^[0-9]+'
          then substring(cache.sellpia_sku_code from '^([0-9]+)')::numeric
        else null
      end as sku_prefix_number,
      (cache.sellpia_sku_code ~ '^[0-9]+-[0-9]+') as sku_has_numeric_suffix,
      case
        when cache.sellpia_sku_code ~ '^[0-9]+-[0-9]+'
          then substring(cache.sellpia_sku_code from '^[0-9]+-([0-9]+)')::numeric
        else null
      end as sku_suffix_number,
      lower(cache.sellpia_sku_code) as sku_fallback
    from operations_private.operations_hub_matrix_export_cache cache
    left join public.operations_hub_sku_operational_master master
      on master.sellpia_sku_code = cache.sellpia_sku_code
    where
      (
        not coalesce(p_exclude_dependent, false)
        or not exists (
          select 1
          from public.operations_hub_listing_components component
          where component.is_active
            and component.parent_component_id is not null
            and component.sellpia_sku_code = cache.sellpia_sku_code
        )
      )
      and (
        v_status = 'all'
        or (v_status in ('connected','review') and cache.overall_status <> 'unmatched')
        or (v_status in ('unmatched','attention') and cache.overall_status = 'unmatched')
      )
      and (
        v_search = ''
        or (
          coalesce(array_length(v_sources, 1), 0) > 0
          and case
            when v_product_term is not null and v_option_term is not null then
              ('sellpia' = any(v_sources)
                and coalesce(cache.sellpia_product_name, '') ilike '%' || v_product_term || '%'
                and coalesce(cache.sellpia_option_name, '') ilike '%' || v_option_term || '%')
              or ('smartstore' = any(v_sources)
                and coalesce(cache.smartstore_name, '') ilike '%' || v_product_term || '%'
                and coalesce(cache.smartstore_option_name, '') ilike '%' || v_option_term || '%')
              or ('makeshop' = any(v_sources)
                and coalesce(cache.makeshop_name, '') ilike '%' || v_product_term || '%'
                and coalesce(cache.makeshop_option_name, '') ilike '%' || v_option_term || '%')
              or ('ably' = any(v_sources)
                and coalesce(cache.ably_name, '') ilike '%' || v_product_term || '%'
                and coalesce(cache.ably_option_name, '') ilike '%' || v_option_term || '%')
            else
              ('sellpia' = any(v_sources) and concat_ws(' ',
                cache.sellpia_sku_code, cache.own_code, cache.sellpia_own_code,
                cache.display_name, cache.sellpia_product_name, cache.sellpia_option_name
              ) ilike '%' || v_search || '%')
              or ('smartstore' = any(v_sources) and concat_ws(' ',
                cache.smartstore_product_code, cache.smartstore_option_code,
                cache.smartstore_name, cache.smartstore_option_name
              ) ilike '%' || v_search || '%')
              or ('makeshop' = any(v_sources) and concat_ws(' ',
                cache.makeshop_product_code, cache.makeshop_option_code,
                cache.makeshop_name, cache.makeshop_option_name
              ) ilike '%' || v_search || '%')
              or ('ably' = any(v_sources) and concat_ws(' ',
                cache.ably_product_code, cache.ably_option_code,
                cache.ably_name, cache.ably_option_name
              ) ilike '%' || v_search || '%')
          end
        )
      )
  ), ordered_page as materialized (
    select filtered_keys.*
    from filtered_keys
    order by
      case when v_sort = 'stock_desc' then sort_stock end desc nulls last,
      case when v_sort = 'price_desc' then sort_price end desc nulls last,
      case when v_sort = 'updated_desc' then sort_updated_at end desc nulls last,
      sku_prefix_number asc nulls last,
      sku_has_numeric_suffix asc nulls first,
      sku_suffix_number asc nulls first,
      sku_fallback asc
    offset (v_page - 1) * v_page_size
    limit v_page_size
  ), page_keys as materialized (
    select
      ordered_page.sellpia_sku_code,
      row_number() over (
        order by
          case when v_sort = 'stock_desc' then sort_stock end desc nulls last,
          case when v_sort = 'price_desc' then sort_price end desc nulls last,
          case when v_sort = 'updated_desc' then sort_updated_at end desc nulls last,
          sku_prefix_number asc nulls last,
          sku_has_numeric_suffix asc nulls first,
          sku_suffix_number asc nulls first,
          sku_fallback asc
      ) as row_order
    from ordered_page
  ), details as (
    select page_keys.row_order, matrix.*
    from page_keys
    cross join lateral (
      select live.*
      from public.operations_hub_matrix_managed_live live
      where live.sellpia_sku_code = page_keys.sellpia_sku_code
      offset 0
    ) matrix
  )
  select jsonb_build_object(
    'rows', coalesce((
      select jsonb_agg(to_jsonb(details) - 'row_order' order by row_order)
      from details
    ), '[]'::jsonb),
    'count', (select count(*) from filtered_keys),
    'page', v_page,
    'pageSize', v_page_size
  )
  into v_result;

  return v_result;
end;
$$;

comment on function public.load_operations_hub_matrix_page_v3(integer, integer, text, text[], text, text, boolean) is
  'Page-first Operations Hub matrix read. Selects compact page keys before expanding managed live details.';

revoke all on function public.load_operations_hub_matrix_page_v3(integer, integer, text, text[], text, text, boolean) from public;
grant execute on function public.load_operations_hub_matrix_page_v3(integer, integer, text, text[], text, text, boolean) to anon, authenticated;

notify pgrst, 'reload schema';
