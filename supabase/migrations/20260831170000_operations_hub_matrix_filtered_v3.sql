-- Advanced filters follow the same page-first read path as the normal matrix.
-- Filter/count work stays on the compact export cache; only the requested page
-- is expanded through the managed live matrix view.
create or replace function public.load_operations_hub_matrix_filtered_v3(
  p_page integer default 1,
  p_page_size integer default 50,
  p_search text default '',
  p_search_sources text[] default array['sellpia','smartstore','makeshop','ably']::text[],
  p_status text default 'all',
  p_sort text default 'sku_asc',
  p_filter jsonb default '{"logic":"and","conditions":[]}'::jsonb,
  p_skus text[] default '{}'::text[],
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
  v_filter jsonb := coalesce(p_filter, '{"logic":"and","conditions":[]}'::jsonb);
  v_conditions jsonb;
  v_logic text;
  v_condition jsonb;
  v_field text;
  v_operator text;
  v_value text;
  v_type text;
  v_product_term text;
  v_option_term text;
  v_result jsonb;
begin
  if jsonb_typeof(v_filter) <> 'object' then
    raise exception '상세 필터 형식이 올바르지 않습니다.';
  end if;
  v_logic := lower(coalesce(v_filter ->> 'logic', 'and'));
  if v_logic not in ('and','or') then
    raise exception '상세 필터 결합 방식은 and 또는 or만 허용됩니다.';
  end if;
  v_conditions := coalesce(v_filter -> 'conditions', '[]'::jsonb);
  if jsonb_typeof(v_conditions) <> 'array' then
    raise exception '상세 필터 conditions는 배열이어야 합니다.';
  end if;
  if jsonb_array_length(v_conditions) > 12 then
    raise exception '상세 필터는 최대 12개까지 사용할 수 있습니다.';
  end if;

  for v_condition in select value from jsonb_array_elements(v_conditions)
  loop
    if jsonb_typeof(v_condition) <> 'object' then
      raise exception '상세 필터 조건 형식이 올바르지 않습니다.';
    end if;
    v_field := lower(coalesce(v_condition ->> 'field', ''));
    v_operator := lower(coalesce(v_condition ->> 'operator', ''));
    v_value := coalesce(v_condition ->> 'value', '');
    v_type := case
      when v_field = any(array[
        'sellpia_current_stock','sellpia_sale_price','smartstore_stock','smartstore_price',
        'makeshop_stock','makeshop_price','ably_stock','ably_price'
      ]) then 'number'
      when v_field = 'overall_status' then 'status'
      when v_field = any(array[
        'sellpia_sku_code','sellpia_own_code','sellpia_product_name','sellpia_option_name',
        'smartstore_product_code','smartstore_option_code','smartstore_name','smartstore_option_name','smartstore_sale_status',
        'makeshop_product_code','makeshop_option_code','makeshop_name','makeshop_option_name','makeshop_sale_status',
        'ably_product_code','ably_option_code','ably_name','ably_option_name','ably_sale_status',
        'material','product_group','shape','tag_summary'
      ]) then 'text'
      else null
    end;
    if v_type is null then
      raise exception '허용되지 않은 상세 필터 필드입니다: %', v_field;
    end if;
    if v_type = 'number' and v_operator not in ('eq','neq','gt','gte','lt','lte','empty','not_empty') then
      raise exception '숫자 필드에 허용되지 않은 연산자입니다: %', v_operator;
    elsif v_type = 'status' and v_operator not in ('eq','neq') then
      raise exception '연결상태 필드에 허용되지 않은 연산자입니다: %', v_operator;
    elsif v_type = 'text' and v_operator not in ('contains','not_contains','eq','neq','empty','not_empty') then
      raise exception '텍스트 필드에 허용되지 않은 연산자입니다: %', v_operator;
    end if;
    if v_operator not in ('empty','not_empty') and nullif(btrim(v_value), '') is null then
      raise exception '상세 필터 비교값을 입력해주세요.';
    end if;
    if v_type = 'number' and v_operator not in ('empty','not_empty') and btrim(v_value) !~ '^-?[0-9]+([.][0-9]+)?$' then
      raise exception '숫자 필터 값이 올바르지 않습니다: %', v_value;
    end if;
    if v_type = 'status' and lower(v_value) not in ('connected','review','unmatched') then
      raise exception '연결상태 값이 올바르지 않습니다: %', v_value;
    end if;
  end loop;

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

  with filtered_keys as materialized (
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
      and (coalesce(array_length(p_skus, 1), 0) = 0 or cache.sellpia_sku_code = any(p_skus))
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
      and (
        jsonb_array_length(v_conditions) = 0
        or (v_logic = 'and' and not exists (
          select 1 from jsonb_array_elements(v_conditions) condition
          where not public.operations_hub_matrix_condition_matches(
            to_jsonb(cache), coalesce(cache.profile_json, '{}'::jsonb), condition
          )
        ))
        or (v_logic = 'or' and exists (
          select 1 from jsonb_array_elements(v_conditions) condition
          where public.operations_hub_matrix_condition_matches(
            to_jsonb(cache), coalesce(cache.profile_json, '{}'::jsonb), condition
          )
        ))
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

comment on function public.load_operations_hub_matrix_filtered_v3(integer, integer, text, text[], text, text, jsonb, text[], boolean) is
  'Page-first advanced Operations Hub filter. Filters compact cache rows before expanding managed live page details.';

revoke all on function public.load_operations_hub_matrix_filtered_v3(integer, integer, text, text[], text, text, jsonb, text[], boolean) from public;
grant execute on function public.load_operations_hub_matrix_filtered_v3(integer, integer, text, text[], text, text, jsonb, text[], boolean) to anon, authenticated;

notify pgrst, 'reload schema';
