create or replace function public.validate_operations_hub_component_parent()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_parent_listing_id bigint;
begin
  if new.parent_component_id is null then return new; end if;
  if new.component_id is not null and new.parent_component_id = new.component_id then
    raise exception '자기 자신을 상위 SKU로 지정할 수 없습니다.';
  end if;

  select parent.listing_id into v_parent_listing_id
  from public.operations_hub_listing_components parent
  where parent.component_id = new.parent_component_id and parent.is_active;
  if v_parent_listing_id is null or v_parent_listing_id <> new.listing_id then
    raise exception '같은 조합 안의 활성 SKU만 상위 SKU로 지정할 수 있습니다.';
  end if;

  if new.component_id is not null and exists (
    with recursive ancestors as (
      select parent.component_id, parent.parent_component_id
      from public.operations_hub_listing_components parent
      where parent.component_id = new.parent_component_id
      union
      select parent.component_id, parent.parent_component_id
      from public.operations_hub_listing_components parent
      join ancestors child on child.parent_component_id = parent.component_id
      where parent.is_active
    )
    select 1 from ancestors where component_id = new.component_id
  ) then
    raise exception '순환 종속관계는 만들 수 없습니다.';
  end if;
  return new;
end;
$$;

drop trigger if exists operations_hub_component_parent_guard
  on public.operations_hub_listing_components;
create trigger operations_hub_component_parent_guard
before insert or update of parent_component_id, listing_id, is_active
on public.operations_hub_listing_components
for each row
when (new.parent_component_id is not null)
execute function public.validate_operations_hub_component_parent();

create or replace function public.clear_operations_hub_component_children()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  with cleared as (
    update public.operations_hub_listing_components child
    set parent_component_id = null,
        updated_by = 'operations_hub_frontend',
        updated_at = now()
    where child.is_active and child.parent_component_id = old.component_id
    returning child.component_id, child.listing_id
  )
  insert into public.operations_hub_relation_events (
    event_type, listing_id, component_id, before_value, after_value, changed_by
  )
  select 'REPARENT', cleared.listing_id, cleared.component_id,
    jsonb_build_object('parentComponentId', old.component_id),
    jsonb_build_object('parentComponentId', null),
    'operations_hub_frontend'
  from cleared;
  return new;
end;
$$;

drop trigger if exists operations_hub_component_children_cleanup
  on public.operations_hub_listing_components;
create trigger operations_hub_component_children_cleanup
after update of is_active
on public.operations_hub_listing_components
for each row
when (old.is_active and not new.is_active)
execute function public.clear_operations_hub_component_children();

revoke all on function public.validate_operations_hub_component_parent() from public;
revoke all on function public.clear_operations_hub_component_children() from public;

notify pgrst, 'reload schema';
