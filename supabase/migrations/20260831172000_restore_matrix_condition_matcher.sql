-- The SQL-inline matcher introduced in the immediately preceding migration
-- produced a substantially worse query plan in production benchmarks. Restore
-- the established matcher before introducing the direct-predicate filter path.
create or replace function public.operations_hub_matrix_condition_matches(
  p_matrix jsonb,
  p_profile jsonb,
  p_condition jsonb
)
returns boolean
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_field text := lower(coalesce(p_condition ->> 'field', ''));
  v_operator text := lower(coalesce(p_condition ->> 'operator', ''));
  v_value text := coalesce(p_condition ->> 'value', '');
  v_text text;
  v_number numeric;
  v_target_number numeric;
begin
  v_text := case v_field
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
  end;

  if v_field = any(array[
    'sellpia_current_stock','sellpia_sale_price',
    'smartstore_stock','smartstore_price',
    'makeshop_stock','makeshop_price',
    'ably_stock','ably_price'
  ]) then
    v_number := nullif(p_matrix ->> v_field, '')::numeric;
    if v_operator in ('empty','not_empty') then
      return case when v_operator = 'empty' then v_number is null else v_number is not null end;
    end if;
    v_target_number := nullif(btrim(v_value), '')::numeric;
    return case v_operator
      when 'eq' then v_number = v_target_number
      when 'neq' then v_number is distinct from v_target_number
      when 'gt' then v_number > v_target_number
      when 'gte' then v_number >= v_target_number
      when 'lt' then v_number < v_target_number
      when 'lte' then v_number <= v_target_number
      else false
    end;
  end if;

  if v_operator = 'empty' then return nullif(btrim(coalesce(v_text, '')), '') is null; end if;
  if v_operator = 'not_empty' then return nullif(btrim(coalesce(v_text, '')), '') is not null; end if;

  return case v_operator
    when 'contains' then position(lower(v_value) in lower(coalesce(v_text, ''))) > 0
    when 'not_contains' then position(lower(v_value) in lower(coalesce(v_text, ''))) = 0
    when 'eq' then lower(coalesce(v_text, '')) = lower(v_value)
    when 'neq' then lower(coalesce(v_text, '')) <> lower(v_value)
    else false
  end;
end;
$$;

comment on function public.operations_hub_matrix_condition_matches(jsonb, jsonb, jsonb) is
  'Evaluates one validated advanced matrix filter condition against a matrix row and its product profile.';

revoke all on function public.operations_hub_matrix_condition_matches(jsonb, jsonb, jsonb) from public;
grant execute on function public.operations_hub_matrix_condition_matches(jsonb, jsonb, jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
