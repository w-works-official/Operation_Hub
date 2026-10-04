-- The original matcher was PL/pgSQL and ran once for every catalog row and
-- every advanced-filter condition. A SQL expression can be inlined by the
-- planner, preserving the same null/comparison semantics without per-row
-- PL/pgSQL call overhead.
create or replace function public.operations_hub_matrix_condition_matches(
  p_matrix jsonb,
  p_profile jsonb,
  p_condition jsonb
)
returns boolean
language sql
immutable
parallel safe
as $$
  select case
    when parsed.field_name = any(array[
      'sellpia_current_stock','sellpia_sale_price',
      'smartstore_stock','smartstore_price',
      'makeshop_stock','makeshop_price',
      'ably_stock','ably_price'
    ]) then
      case
        when parsed.operator_name = 'empty'
          then nullif(p_matrix ->> parsed.field_name, '')::numeric is null
        when parsed.operator_name = 'not_empty'
          then nullif(p_matrix ->> parsed.field_name, '')::numeric is not null
        when parsed.operator_name = 'eq'
          then nullif(p_matrix ->> parsed.field_name, '')::numeric = nullif(btrim(parsed.compare_value), '')::numeric
        when parsed.operator_name = 'neq'
          then nullif(p_matrix ->> parsed.field_name, '')::numeric is distinct from nullif(btrim(parsed.compare_value), '')::numeric
        when parsed.operator_name = 'gt'
          then nullif(p_matrix ->> parsed.field_name, '')::numeric > nullif(btrim(parsed.compare_value), '')::numeric
        when parsed.operator_name = 'gte'
          then nullif(p_matrix ->> parsed.field_name, '')::numeric >= nullif(btrim(parsed.compare_value), '')::numeric
        when parsed.operator_name = 'lt'
          then nullif(p_matrix ->> parsed.field_name, '')::numeric < nullif(btrim(parsed.compare_value), '')::numeric
        when parsed.operator_name = 'lte'
          then nullif(p_matrix ->> parsed.field_name, '')::numeric <= nullif(btrim(parsed.compare_value), '')::numeric
        else false
      end
    else
      case
        when parsed.operator_name = 'empty'
          then nullif(btrim(coalesce(values.text_value, '')), '') is null
        when parsed.operator_name = 'not_empty'
          then nullif(btrim(coalesce(values.text_value, '')), '') is not null
        when parsed.operator_name = 'contains'
          then position(lower(parsed.compare_value) in lower(coalesce(values.text_value, ''))) > 0
        when parsed.operator_name = 'not_contains'
          then position(lower(parsed.compare_value) in lower(coalesce(values.text_value, ''))) = 0
        when parsed.operator_name = 'eq'
          then lower(coalesce(values.text_value, '')) = lower(parsed.compare_value)
        when parsed.operator_name = 'neq'
          then lower(coalesce(values.text_value, '')) <> lower(parsed.compare_value)
        else false
      end
  end
  from (
    select
      lower(coalesce(p_condition ->> 'field', '')) as field_name,
      lower(coalesce(p_condition ->> 'operator', '')) as operator_name,
      coalesce(p_condition ->> 'value', '') as compare_value
  ) parsed
  cross join lateral (
    select case parsed.field_name
      when 'sellpia_sku_code' then p_matrix ->> 'sellpia_sku_code'
      when 'sellpia_own_code' then coalesce(p_matrix ->> 'sellpia_own_code', p_matrix ->> 'own_code')
      when 'sellpia_product_name' then p_matrix ->> 'sellpia_product_name'
      when 'sellpia_option_name' then p_matrix ->> 'sellpia_option_name'
      when 'smartstore_product_code' then p_matrix ->> 'smartstore_product_code'
      when 'smartstore_option_code' then p_matrix ->> 'smartstore_option_code'
      when 'smartstore_name' then p_matrix ->> 'smartstore_name'
      when 'smartstore_option_name' then p_matrix ->> 'smartstore_option_name'
      when 'smartstore_sale_status' then p_matrix ->> 'smartstore_sale_status'
      when 'makeshop_product_code' then p_matrix ->> 'makeshop_product_code'
      when 'makeshop_option_code' then p_matrix ->> 'makeshop_option_code'
      when 'makeshop_name' then p_matrix ->> 'makeshop_name'
      when 'makeshop_option_name' then p_matrix ->> 'makeshop_option_name'
      when 'makeshop_sale_status' then p_matrix ->> 'makeshop_sale_status'
      when 'ably_product_code' then p_matrix ->> 'ably_product_code'
      when 'ably_option_code' then p_matrix ->> 'ably_option_code'
      when 'ably_name' then p_matrix ->> 'ably_name'
      when 'ably_option_name' then p_matrix ->> 'ably_option_name'
      when 'ably_sale_status' then p_matrix ->> 'ably_sale_status'
      when 'overall_status' then p_matrix ->> 'overall_status'
      when 'material' then p_profile ->> 'material'
      when 'product_group' then p_profile ->> 'product_group'
      when 'shape' then p_profile ->> 'shape'
      when 'tag_summary' then p_profile ->> 'tag_summary'
      else null
    end as text_value
  ) values
$$;

comment on function public.operations_hub_matrix_condition_matches(jsonb, jsonb, jsonb) is
  'Inlinable condition matcher for validated Operations Hub advanced filters.';

revoke all on function public.operations_hub_matrix_condition_matches(jsonb, jsonb, jsonb) from public;
grant execute on function public.operations_hub_matrix_condition_matches(jsonb, jsonb, jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
