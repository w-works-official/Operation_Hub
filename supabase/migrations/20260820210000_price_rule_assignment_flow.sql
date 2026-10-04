-- Connect reusable composite price tags to a specific Sellpia SKU and seller channel.
-- The assignment only controls calculation. A seller change draft is still created
-- explicitly from the product drawer after the calculated price is reviewed.

create or replace function public.save_operations_hub_price_rule_assignment(
  p_sku text,
  p_source text,
  p_rule_set_id bigint,
  p_updated_by text default 'operations-hub'
)
returns table (
  price_rule_assignment_id bigint,
  source_channel text,
  sellpia_sku_code text,
  price_rule_set_id bigint,
  is_active boolean,
  updated_at timestamptz
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_sku text := nullif(btrim(p_sku), '');
  v_assignment_id bigint;
begin
  if v_sku is null then
    raise exception '셀피아 SKU가 필요합니다.';
  end if;
  if p_source not in ('smartstore', 'makeshop', 'ably') then
    raise exception '지원하지 않는 판매처입니다: %', p_source;
  end if;
  if not exists (
    select 1
    from public.operations_hub_matrix_live matrix_row
    where matrix_row.sellpia_sku_code = v_sku
  ) then
    raise exception '현재 매트릭스에서 셀피아 SKU를 찾을 수 없습니다: %', v_sku;
  end if;

  if p_rule_set_id is null then
    update public.operations_hub_price_rule_assignments assignment
    set is_active = false,
        updated_by = coalesce(nullif(btrim(p_updated_by), ''), 'operations-hub'),
        updated_at = now()
    where assignment.target_type = 'sellpia_sku'
      and assignment.source_channel = p_source
      and assignment.sellpia_sku_code = v_sku
      and assignment.is_active;
    return;
  end if;

  if not exists (
    select 1
    from public.operations_hub_price_rule_sets rule_set
    where rule_set.price_rule_set_id = p_rule_set_id
      and rule_set.is_active
  ) then
    raise exception '활성 가격 조합 태그를 찾을 수 없습니다: %', p_rule_set_id;
  end if;

  select assignment.price_rule_assignment_id
  into v_assignment_id
  from public.operations_hub_price_rule_assignments assignment
  where assignment.target_type = 'sellpia_sku'
    and assignment.source_channel = p_source
    and assignment.sellpia_sku_code = v_sku
  order by assignment.is_active desc, assignment.updated_at desc
  limit 1;

  if v_assignment_id is null then
    insert into public.operations_hub_price_rule_assignments (
      source_channel, target_type, sellpia_sku_code, price_rule_set_id,
      is_active, updated_by
    ) values (
      p_source, 'sellpia_sku', v_sku, p_rule_set_id,
      true, coalesce(nullif(btrim(p_updated_by), ''), 'operations-hub')
    )
    returning operations_hub_price_rule_assignments.price_rule_assignment_id
    into v_assignment_id;
  else
    update public.operations_hub_price_rule_assignments assignment
    set price_rule_set_id = p_rule_set_id,
        is_active = true,
        updated_by = coalesce(nullif(btrim(p_updated_by), ''), 'operations-hub'),
        updated_at = now()
    where assignment.price_rule_assignment_id = v_assignment_id;
  end if;

  return query
  select assignment.price_rule_assignment_id,
         assignment.source_channel,
         assignment.sellpia_sku_code,
         assignment.price_rule_set_id,
         assignment.is_active,
         assignment.updated_at
  from public.operations_hub_price_rule_assignments assignment
  where assignment.price_rule_assignment_id = v_assignment_id;
end;
$$;

comment on function public.save_operations_hub_price_rule_assignment(text, text, bigint, text) is
  'Assigns or clears one reusable composite price tag for a Sellpia SKU and seller channel. It never creates an export draft by itself.';

revoke all on function public.save_operations_hub_price_rule_assignment(text, text, bigint, text) from public;
grant execute on function public.save_operations_hub_price_rule_assignment(text, text, bigint, text) to anon, authenticated;
