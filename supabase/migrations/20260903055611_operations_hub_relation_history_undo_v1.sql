alter table public.operations_hub_relation_events
  drop constraint if exists operations_hub_relation_events_event_type_check;

alter table public.operations_hub_relation_events
  add constraint operations_hub_relation_events_event_type_check
  check (event_type in (
    'FOLDER_SAVE', 'FOLDER_ARCHIVE', 'ORGANIZE', 'REPARENT',
    'NODE_SAVE', 'NODE_ARCHIVE', 'EDGE_SAVE', 'EDGE_REMOVE', 'EDGE_UNDO'
  ));

create index if not exists operations_hub_relation_events_edge_time_idx
  on public.operations_hub_relation_events (
    ((coalesce(after_value ->> 'edge_id', before_value ->> 'edge_id'))::bigint),
    changed_at desc,
    event_id desc
  )
  where event_type in ('EDGE_SAVE', 'EDGE_REMOVE', 'EDGE_UNDO')
    and coalesce(after_value ->> 'edge_id', before_value ->> 'edge_id') is not null;

create unique index if not exists operations_hub_relation_events_undo_event_uidx
  on public.operations_hub_relation_events (
    ((after_value ->> 'undoOfEventId')::bigint)
  )
  where event_type = 'EDGE_UNDO'
    and after_value ->> 'undoOfEventId' is not null;

create or replace function public.list_operations_hub_relation_edge_history_v1(
  p_session_token text,
  p_edge_id bigint,
  p_limit integer default 20
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
set statement_timeout = '5s'
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 100));
begin
  perform operations_private.require_operations_hub_operator_session(p_session_token);

  if p_edge_id is null then
    raise exception '관계 ID가 필요합니다.';
  end if;

  return jsonb_build_object(
    'edgeId', p_edge_id,
    'events', coalesce((
      select jsonb_agg(to_jsonb(history_row) order by history_row."changedAt" desc, history_row."eventId" desc)
      from (
        select
          event.event_id as "eventId",
          event.event_type as "eventType",
          event.changed_by as "changedBy",
          event.changed_at as "changedAt",
          event.before_value as "beforeValue",
          event.after_value as "afterValue",
          case
            when event.event_type not in ('EDGE_SAVE', 'EDGE_REMOVE') then false
            when exists (
              select 1
              from public.operations_hub_relation_events undo_event
              where undo_event.event_type = 'EDGE_UNDO'
                and (undo_event.after_value ->> 'undoOfEventId')::bigint = event.event_id
            ) then false
            when exists (
              select 1
              from public.operations_hub_relation_events later_event
              where later_event.event_id > event.event_id
                and later_event.event_type in ('EDGE_SAVE', 'EDGE_REMOVE')
                and coalesce(
                  (later_event.after_value ->> 'edge_id')::bigint,
                  (later_event.before_value ->> 'edge_id')::bigint
                ) = p_edge_id
            ) then false
            when event.before_value is null then true
            else row(
              event.before_value ->> 'parent_node_id',
              event.before_value ->> 'child_node_id',
              event.before_value ->> 'sort_order',
              event.before_value ->> 'is_active'
            ) is distinct from row(
              coalesce(event.after_value ->> 'parent_node_id', event.before_value ->> 'parent_node_id'),
              coalesce(event.after_value ->> 'child_node_id', event.before_value ->> 'child_node_id'),
              coalesce(event.after_value ->> 'sort_order', event.before_value ->> 'sort_order'),
              coalesce(event.after_value ->> 'is_active', event.after_value ->> 'isActive', event.before_value ->> 'is_active')
            )
          end as "canUndo"
        from public.operations_hub_relation_events event
        where event.event_type in ('EDGE_SAVE', 'EDGE_REMOVE', 'EDGE_UNDO')
          and coalesce(
            (event.after_value ->> 'edge_id')::bigint,
            (event.before_value ->> 'edge_id')::bigint
          ) = p_edge_id
        order by event.changed_at desc, event.event_id desc
        limit v_limit
      ) history_row
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.undo_operations_hub_relation_edge_event_v1(
  p_session_token text,
  p_event_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
set statement_timeout = '5s'
as $$
declare
  v_session jsonb;
  v_actor text;
  v_event public.operations_hub_relation_events%rowtype;
  v_edge_id bigint;
  v_current public.operations_hub_relation_edges%rowtype;
  v_restored public.operations_hub_relation_edges%rowtype;
  v_parent_node_id bigint;
  v_child_node_id bigint;
  v_sort_order integer;
  v_is_active boolean;
begin
  v_session := operations_private.require_operations_hub_operator_session(p_session_token);
  v_actor := coalesce(nullif(v_session ->> 'username', ''), 'operations_hub_operator');

  select event.*
    into v_event
  from public.operations_hub_relation_events event
  where event.event_id = p_event_id
    and event.event_type in ('EDGE_SAVE', 'EDGE_REMOVE');

  if not found then
    raise exception '되돌릴 수 있는 관계 변경 이력을 찾지 못했습니다.';
  end if;

  v_edge_id := coalesce(
    (v_event.after_value ->> 'edge_id')::bigint,
    (v_event.before_value ->> 'edge_id')::bigint
  );

  -- Serialize every undo decision for one edge before checking whether the
  -- event was already undone or superseded by a later edge change.
  select edge.*
    into v_current
  from public.operations_hub_relation_edges edge
  where edge.edge_id = v_edge_id
  for update;

  if not found then
    raise exception '현재 관계를 찾지 못했습니다.';
  end if;

  if exists (
    select 1
    from public.operations_hub_relation_events undo_event
    where undo_event.event_type = 'EDGE_UNDO'
      and (undo_event.after_value ->> 'undoOfEventId')::bigint = p_event_id
  ) then
    return jsonb_build_object('eventId', p_event_id, 'alreadyUndone', true);
  end if;

  if exists (
    select 1
    from public.operations_hub_relation_events later_event
    where later_event.event_id > v_event.event_id
      and later_event.event_type in ('EDGE_SAVE', 'EDGE_REMOVE')
      and coalesce(
        (later_event.after_value ->> 'edge_id')::bigint,
        (later_event.before_value ->> 'edge_id')::bigint
      ) = v_edge_id
  ) then
    raise exception '이후에 저장된 관계 변경이 있어 이 이력을 바로 되돌릴 수 없습니다.';
  end if;

  if row(
    v_current.parent_node_id::text,
    v_current.child_node_id::text,
    v_current.sort_order::text,
    v_current.is_active::text
  ) is distinct from row(
    coalesce(v_event.after_value ->> 'parent_node_id', v_event.before_value ->> 'parent_node_id'),
    coalesce(v_event.after_value ->> 'child_node_id', v_event.before_value ->> 'child_node_id'),
    coalesce(v_event.after_value ->> 'sort_order', v_event.before_value ->> 'sort_order'),
    coalesce(v_event.after_value ->> 'is_active', v_event.after_value ->> 'isActive', v_event.before_value ->> 'is_active')
  ) then
    raise exception '현재 관계가 선택한 이력 이후 변경되어 안전하게 되돌릴 수 없습니다.';
  end if;

  if v_event.before_value is not null and row(
    v_event.before_value ->> 'parent_node_id',
    v_event.before_value ->> 'child_node_id',
    v_event.before_value ->> 'sort_order',
    v_event.before_value ->> 'is_active'
  ) is not distinct from row(
    coalesce(v_event.after_value ->> 'parent_node_id', v_event.before_value ->> 'parent_node_id'),
    coalesce(v_event.after_value ->> 'child_node_id', v_event.before_value ->> 'child_node_id'),
    coalesce(v_event.after_value ->> 'sort_order', v_event.before_value ->> 'sort_order'),
    coalesce(v_event.after_value ->> 'is_active', v_event.after_value ->> 'isActive', v_event.before_value ->> 'is_active')
  ) then
    raise exception '실제 변경이 없는 이력은 되돌릴 수 없습니다.';
  end if;

  if v_event.before_value is null then
    update public.operations_hub_relation_edges edge
    set is_active = false,
        updated_by = 'operations_hub_frontend',
        updated_at = clock_timestamp()
    where edge.edge_id = v_edge_id
    returning * into v_restored;
  else
    v_parent_node_id := (v_event.before_value ->> 'parent_node_id')::bigint;
    v_child_node_id := (v_event.before_value ->> 'child_node_id')::bigint;
    v_sort_order := greatest(0, least(coalesce((v_event.before_value ->> 'sort_order')::integer, 100), 10000));
    v_is_active := coalesce((v_event.before_value ->> 'is_active')::boolean, true);

    if v_parent_node_id is null or v_child_node_id is null or v_parent_node_id = v_child_node_id then
      raise exception '이전 관계 정보가 올바르지 않아 되돌릴 수 없습니다.';
    end if;

    if v_is_active and not exists (
      select 1
      from public.operations_hub_relation_nodes node
      where node.node_id in (v_parent_node_id, v_child_node_id)
        and node.is_active
      group by true
      having count(*) = 2
    ) then
      raise exception '이전 상위·하위 상품 중 현재 사용할 수 없는 상품이 있습니다.';
    end if;

    if v_is_active and exists (
      select 1
      from public.operations_hub_relation_edges duplicate_edge
      where duplicate_edge.edge_id <> v_edge_id
        and duplicate_edge.parent_node_id = v_parent_node_id
        and duplicate_edge.child_node_id = v_child_node_id
    ) then
      raise exception '같은 상위·하위 관계 이력이 이미 있어 자동으로 되돌릴 수 없습니다.';
    end if;

    if v_is_active and exists (
      with recursive descendants(node_id) as (
        select v_child_node_id
        union
        select edge.child_node_id
        from public.operations_hub_relation_edges edge
        join descendants current_node on current_node.node_id = edge.parent_node_id
        where edge.is_active
          and edge.edge_id <> v_edge_id
      )
      select 1 from descendants where node_id = v_parent_node_id
    ) then
      raise exception '되돌리면 순환 관계가 생겨 저장할 수 없습니다.';
    end if;

    update public.operations_hub_relation_edges edge
    set parent_node_id = v_parent_node_id,
        child_node_id = v_child_node_id,
        sort_order = v_sort_order,
        is_active = v_is_active,
        updated_by = 'operations_hub_frontend',
        updated_at = clock_timestamp()
    where edge.edge_id = v_edge_id
    returning * into v_restored;
  end if;

  insert into public.operations_hub_relation_events (
    event_type, before_value, after_value, changed_by
  ) values (
    'EDGE_UNDO',
    to_jsonb(v_current),
    to_jsonb(v_restored) || jsonb_build_object('undoOfEventId', p_event_id),
    v_actor
  );

  return jsonb_build_object(
    'eventId', p_event_id,
    'edgeId', v_edge_id,
    'alreadyUndone', false,
    'restored', jsonb_build_object(
      'parentNodeId', v_restored.parent_node_id,
      'childNodeId', v_restored.child_node_id,
      'sortOrder', v_restored.sort_order,
      'isActive', v_restored.is_active
    )
  );
end;
$$;

revoke all on function public.list_operations_hub_relation_edge_history_v1(text, bigint, integer)
  from public, anon, authenticated;
revoke all on function public.undo_operations_hub_relation_edge_event_v1(text, bigint)
  from public, anon, authenticated;

grant execute on function public.list_operations_hub_relation_edge_history_v1(text, bigint, integer)
  to anon, authenticated;
grant execute on function public.undo_operations_hub_relation_edge_event_v1(text, bigint)
  to anon, authenticated;

comment on function public.list_operations_hub_relation_edge_history_v1(text, bigint, integer) is
  'Lists authenticated edge audit history and marks only the latest effective edge change as undoable.';
comment on function public.undo_operations_hub_relation_edge_event_v1(text, bigint) is
  'Safely restores the immediately preceding state of the latest relation-edge change with stale, duplicate, and cycle checks.';

notify pgrst, 'reload schema';
