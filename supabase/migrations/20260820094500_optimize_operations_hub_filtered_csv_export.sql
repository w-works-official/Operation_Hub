create or replace function public.export_operations_hub_matrix_chunk(
  p_offset integer default 0,
  p_limit integer default 1000,
  p_search text default '',
  p_search_sources text[] default array['sellpia','smartstore','makeshop','ably']::text[],
  p_status text default 'all',
  p_sort text default 'sku_asc',
  p_filter jsonb default '{"logic":"and","conditions":[]}'::jsonb,
  p_skus text[] default '{}'::text[]
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_limit integer := greatest(1, least(coalesce(p_limit, 1000), 1000));
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
  v_needs_profile boolean := false;
  v_result jsonb;
begin
  if jsonb_typeof(v_filter) <> 'object' then raise exception '상세 필터 형식이 올바르지 않습니다.'; end if;
  v_logic := lower(coalesce(v_filter ->> 'logic', 'and'));
  if v_logic not in ('and','or') then raise exception '상세 필터 결합 방식은 and 또는 or만 허용됩니다.'; end if;
  v_conditions := coalesce(v_filter -> 'conditions', '[]'::jsonb);
  if jsonb_typeof(v_conditions) <> 'array' then raise exception '상세 필터 conditions는 배열이어야 합니다.'; end if;
  if jsonb_array_length(v_conditions) > 12 then raise exception '상세 필터는 최대 12개까지 사용할 수 있습니다.'; end if;
  if coalesce(array_length(p_skus, 1), 0) > 1000 then raise exception 'CSV 청크 SKU는 한 번에 최대 1000개까지 조회할 수 있습니다.'; end if;

  for v_condition in select value from jsonb_array_elements(v_conditions)
  loop
    if jsonb_typeof(v_condition) <> 'object' then raise exception '상세 필터 조건 형식이 올바르지 않습니다.'; end if;
    v_field := lower(coalesce(v_condition ->> 'field', ''));
    v_operator := lower(coalesce(v_condition ->> 'operator', ''));
    v_value := coalesce(v_condition ->> 'value', '');
    v_needs_profile := v_needs_profile or v_field = any(array['material','product_group','shape','tag_summary']);
    v_type := case
      when v_field = any(array['sellpia_current_stock','sellpia_sale_price','smartstore_stock','smartstore_price','makeshop_stock','makeshop_price','ably_stock','ably_price']) then 'number'
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
    if v_type is null then raise exception '허용되지 않은 상세 필터 필드입니다: %', v_field; end if;
    if v_type = 'number' and v_operator not in ('eq','neq','gt','gte','lt','lte','empty','not_empty') then raise exception '숫자 필드에 허용되지 않은 연산자입니다: %', v_operator;
    elsif v_type = 'status' and v_operator not in ('eq','neq') then raise exception '연결상태 필드에 허용되지 않은 연산자입니다: %', v_operator;
    elsif v_type = 'text' and v_operator not in ('contains','not_contains','eq','neq','empty','not_empty') then raise exception '텍스트 필드에 허용되지 않은 연산자입니다: %', v_operator;
    end if;
    if v_operator not in ('empty','not_empty') and nullif(btrim(v_value), '') is null then raise exception '상세 필터 비교값을 입력해주세요.'; end if;
    if v_type = 'number' and v_operator not in ('empty','not_empty') and btrim(v_value) !~ '^-?[0-9]+([.][0-9]+)?$' then raise exception '숫자 필터 값이 올바르지 않습니다: %', v_value; end if;
    if v_type = 'status' and lower(v_value) not in ('connected','review','unmatched') then raise exception '연결상태 값이 올바르지 않습니다: %', v_value; end if;
  end loop;

  select coalesce(array_agg(distinct lower(btrim(source))), '{}'::text[])
  into v_sources
  from unnest(coalesce(p_search_sources, '{}'::text[])) source
  where lower(btrim(source)) = any(array['sellpia','smartstore','makeshop','ably']);
  if v_status not in ('all','attention','connected','review','unmatched') then v_status := 'all'; end if;
  if v_sort not in ('sku_asc','stock_desc','price_desc','updated_desc') then v_sort := 'sku_asc'; end if;
  if position('/' in v_search) > 0 then
    v_product_term := nullif(btrim(split_part(v_search, '/', 1)), '');
    v_option_term := nullif(btrim(substr(v_search, position('/' in v_search) + 1)), '');
  end if;

  with filtered as (
    select matrix.*
    from public.operations_hub_matrix_live matrix
    left join lateral (
      select to_jsonb(profile) as profile_json
      from public.operations_hub_product_profiles profile
      where profile.sellpia_sku_code = matrix.sellpia_sku_code
      limit 1
    ) filter_profile on v_needs_profile
    where
      (coalesce(array_length(p_skus, 1), 0) = 0 or matrix.sellpia_sku_code = any(p_skus))
      and (v_status = 'all' or (v_status = 'attention' and matrix.overall_status = any(array['review','unmatched'])) or matrix.overall_status = v_status)
      and (
        v_search = ''
        or (
          coalesce(array_length(v_sources, 1), 0) > 0
          and case when v_product_term is not null and v_option_term is not null then
            ('sellpia' = any(v_sources) and coalesce(matrix.sellpia_product_name, '') ilike '%' || v_product_term || '%' and coalesce(matrix.sellpia_option_name, '') ilike '%' || v_option_term || '%')
            or ('smartstore' = any(v_sources) and coalesce(matrix.smartstore_name, '') ilike '%' || v_product_term || '%' and coalesce(matrix.smartstore_option_name, '') ilike '%' || v_option_term || '%')
            or ('makeshop' = any(v_sources) and coalesce(matrix.makeshop_name, '') ilike '%' || v_product_term || '%' and coalesce(matrix.makeshop_option_name, '') ilike '%' || v_option_term || '%')
            or ('ably' = any(v_sources) and coalesce(matrix.ably_name, '') ilike '%' || v_product_term || '%' and coalesce(matrix.ably_option_name, '') ilike '%' || v_option_term || '%')
          else
            ('sellpia' = any(v_sources) and concat_ws(' ', matrix.sellpia_sku_code, matrix.own_code, matrix.sellpia_own_code, matrix.display_name, matrix.sellpia_product_name, matrix.sellpia_option_name) ilike '%' || v_search || '%')
            or ('smartstore' = any(v_sources) and concat_ws(' ', matrix.smartstore_product_code, matrix.smartstore_option_code, matrix.smartstore_name, matrix.smartstore_option_name) ilike '%' || v_search || '%')
            or ('makeshop' = any(v_sources) and concat_ws(' ', matrix.makeshop_product_code, matrix.makeshop_option_code, matrix.makeshop_name, matrix.makeshop_option_name) ilike '%' || v_search || '%')
            or ('ably' = any(v_sources) and concat_ws(' ', matrix.ably_product_code, matrix.ably_option_code, matrix.ably_name, matrix.ably_option_name) ilike '%' || v_search || '%')
          end
        )
      )
      and (
        jsonb_array_length(v_conditions) = 0
        or (v_logic = 'and' and not exists (
          select 1 from jsonb_array_elements(v_conditions) condition
          where not public.operations_hub_matrix_condition_matches(to_jsonb(matrix), coalesce(filter_profile.profile_json, '{}'::jsonb), condition)
        ))
        or (v_logic = 'or' and exists (
          select 1 from jsonb_array_elements(v_conditions) condition
          where public.operations_hub_matrix_condition_matches(to_jsonb(matrix), coalesce(filter_profile.profile_json, '{}'::jsonb), condition)
        ))
      )
    order by
      case when v_sort = 'stock_desc' then matrix.sellpia_current_stock end desc nulls last,
      case when v_sort = 'price_desc' then matrix.sellpia_sale_price end desc nulls last,
      case when v_sort = 'updated_desc' then matrix.updated_at end desc nulls last,
      matrix.sellpia_sku_code asc
    offset v_offset
    limit v_limit
  )
  select jsonb_build_object(
    'rows', coalesce(jsonb_agg(
      to_jsonb(filtered)
      || jsonb_build_object('__profile', to_jsonb(profile))
      || jsonb_build_object('__sellerDrafts', coalesce(drafts.payload, '{}'::jsonb))
      order by
        case when v_sort = 'stock_desc' then filtered.sellpia_current_stock end desc nulls last,
        case when v_sort = 'price_desc' then filtered.sellpia_sale_price end desc nulls last,
        case when v_sort = 'updated_desc' then filtered.updated_at end desc nulls last,
        filtered.sellpia_sku_code asc
    ), '[]'::jsonb),
    'offset', v_offset,
    'limit', v_limit
  ) into v_result
  from filtered
  left join public.operations_hub_product_profiles profile
    on profile.sellpia_sku_code = filtered.sellpia_sku_code
  left join lateral (
    select jsonb_object_agg(draft.source_channel || ':' || draft.field_key, to_jsonb(draft)) as payload
    from public.operations_hub_active_seller_drafts draft
    where draft.sellpia_sku_code = filtered.sellpia_sku_code
  ) drafts on true;

  return coalesce(v_result, jsonb_build_object('rows', '[]'::jsonb, 'offset', v_offset, 'limit', v_limit));
end;
$$;

comment on function public.export_operations_hub_matrix_chunk(integer, integer, text, text[], text, text, jsonb, text[]) is
  'Exports one ordered matrix CSV chunk; profile filtering is conditional and profile metadata joins only after paging.';

revoke all on function public.export_operations_hub_matrix_chunk(integer, integer, text, text[], text, text, jsonb, text[]) from public;
grant execute on function public.export_operations_hub_matrix_chunk(integer, integer, text, text[], text, text, jsonb, text[]) to anon, authenticated;

notify pgrst, 'reload schema';
