-- Recoverable price-rule deletion. Referenced rules are blocked so an active
-- composite or SKU assignment cannot silently change its calculation.

create or replace function public.delete_operations_hub_price_rule_tag(
  p_tag_id bigint,
  p_updated_by text default 'operations-hub'
)
returns public.operations_hub_price_rule_tags
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_saved public.operations_hub_price_rule_tags%rowtype;
  v_used_by text;
begin
  select string_agg(rule_set.set_name, ', ' order by rule_set.set_name)
  into v_used_by
  from public.operations_hub_price_rule_set_items item
  join public.operations_hub_price_rule_sets rule_set
    on rule_set.price_rule_set_id = item.price_rule_set_id
   and rule_set.is_active
  where item.price_rule_tag_id = p_tag_id
    and item.is_active;

  if v_used_by is not null then
    raise exception '이 작은 태그를 먼저 큰 태그에서 빼주세요: %', v_used_by;
  end if;

  update public.operations_hub_price_rule_tags tag
  set is_active = false,
      updated_by = coalesce(nullif(btrim(p_updated_by), ''), 'operations-hub'),
      updated_at = now()
  where tag.price_rule_tag_id = p_tag_id
    and tag.is_active
  returning * into v_saved;
  if not found then raise exception '활성 작은 태그를 찾을 수 없습니다: %', p_tag_id; end if;
  return v_saved;
end;
$$;

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
  v_qa_count integer;
begin
  select count(*) into v_assignment_count
  from public.operations_hub_price_rule_assignments assignment
  where assignment.price_rule_set_id = p_rule_set_id and assignment.is_active;
  if v_assignment_count > 0 then
    raise exception '이 큰 태그는 현재 %개 상품·판매처에 배정되어 있습니다. 배정을 먼저 해제해주세요.', v_assignment_count;
  end if;

  select count(*) into v_qa_count
  from public.operations_hub_price_rule_qa_cases qa
  where qa.price_rule_set_id = p_rule_set_id and qa.is_active;
  if v_qa_count > 0 then
    raise exception '이 큰 태그는 가상 QA %개에서 사용 중이라 삭제할 수 없습니다.', v_qa_count;
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

comment on function public.delete_operations_hub_price_rule_tag(bigint, text) is
  'Soft-deletes an unused atomic price tag. Active composite references block deletion.';
comment on function public.delete_operations_hub_price_rule_set(bigint, text) is
  'Soft-deletes an unused composite price rule. Active assignments and QA cases block deletion.';

revoke all on function public.delete_operations_hub_price_rule_tag(bigint, text) from public;
revoke all on function public.delete_operations_hub_price_rule_set(bigint, text) from public;
grant execute on function public.delete_operations_hub_price_rule_tag(bigint, text) to anon, authenticated;
grant execute on function public.delete_operations_hub_price_rule_set(bigint, text) to anon, authenticated;
