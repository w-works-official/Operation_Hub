-- Retire the virtual-option QA feature without deleting historical QA records.
-- Composite-rule deletion now protects only live SKU/channel assignments.

create or replace function public.delete_operations_hub_price_rule_set(
  p_rule_set_id bigint,
  p_updated_by text default 'operations-hub'
)
returns public.operations_hub_price_rule_sets
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_saved public.operations_hub_price_rule_sets%rowtype;
  v_assignment_count integer;
begin
  select count(*) into v_assignment_count
  from public.operations_hub_price_rule_assignments assignment
  where assignment.price_rule_set_id = p_rule_set_id and assignment.is_active;
  if v_assignment_count > 0 then
    raise exception '이 큰 태그는 현재 %개 상품·판매처에 배정되어 있습니다. 배정을 먼저 해제해주세요.', v_assignment_count;
  end if;

  update public.operations_hub_price_rule_sets rule_set
  set is_active = false,
      updated_by = coalesce(nullif(btrim(p_updated_by), ''), 'operations-hub'),
      updated_at = now()
  where rule_set.price_rule_set_id = p_rule_set_id
    and rule_set.is_active
  returning * into v_saved;
  if not found then raise exception '활성 큰 태그를 찾을 수 없습니다: %', p_rule_set_id; end if;
  return v_saved;
end;
$$;

comment on function public.delete_operations_hub_price_rule_set(bigint, text) is
  'Soft-deletes an unused composite price rule. Active SKU/channel assignments block deletion.';

revoke all on function public.delete_operations_hub_price_rule_set(bigint, text) from public;
grant execute on function public.delete_operations_hub_price_rule_set(bigint, text) to anon, authenticated;
