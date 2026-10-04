-- Make relation folders a user-editable hierarchy and allow operators to
-- recoverably remove an unlinked relation node. These structures remain
-- management-only and do not alter inventory or price calculations.

alter table public.operations_hub_relation_folders
  add column if not exists parent_folder_id bigint;

alter table public.operations_hub_relation_folders
  drop constraint if exists operations_hub_relation_folders_parent_folder_id_fkey;

alter table public.operations_hub_relation_folders
  add constraint operations_hub_relation_folders_parent_folder_id_fkey
  foreign key (parent_folder_id)
  references public.operations_hub_relation_folders(folder_id)
  on delete restrict;

alter table public.operations_hub_relation_folders
  drop constraint if exists operations_hub_relation_folders_not_self_parent;

alter table public.operations_hub_relation_folders
  add constraint operations_hub_relation_folders_not_self_parent
  check (parent_folder_id is null or parent_folder_id <> folder_id);

drop index if exists public.operations_hub_relation_folders_active_name_idx;

create unique index if not exists operations_hub_relation_folders_active_parent_name_idx
  on public.operations_hub_relation_folders (
    coalesce(parent_folder_id, 0),
    lower(btrim(folder_name))
  )
  where is_active;

create index if not exists operations_hub_relation_folders_parent_active_idx
  on public.operations_hub_relation_folders (parent_folder_id, sort_order, folder_name, folder_id)
  where is_active;

create or replace function public.validate_operations_hub_relation_folder_parent()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if new.parent_folder_id is null then
    return new;
  end if;
  if new.parent_folder_id = new.folder_id then
    raise exception '폴더 자신을 상위 폴더로 지정할 수 없습니다.';
  end if;
  if not exists (
    select 1
    from public.operations_hub_relation_folders parent_folder
    where parent_folder.folder_id = new.parent_folder_id and parent_folder.is_active
  ) then
    raise exception '선택한 상위 폴더를 찾을 수 없습니다.';
  end if;
  if tg_op = 'UPDATE' and exists (
    with recursive descendants as (
      select folder.folder_id
      from public.operations_hub_relation_folders folder
      where folder.parent_folder_id = new.folder_id and folder.is_active
      union all
      select child.folder_id
      from descendants
      join public.operations_hub_relation_folders child
        on child.parent_folder_id = descendants.folder_id and child.is_active
    )
    select 1 from descendants where folder_id = new.parent_folder_id
  ) then
    raise exception '하위 폴더를 상위로 지정하는 순환 구조는 만들 수 없습니다.';
  end if;
  return new;
end;
$$;

drop trigger if exists operations_hub_relation_folder_parent_guard
  on public.operations_hub_relation_folders;

create trigger operations_hub_relation_folder_parent_guard
before insert or update of parent_folder_id
on public.operations_hub_relation_folders
for each row execute function public.validate_operations_hub_relation_folder_parent();

alter table public.operations_hub_relation_events
  drop constraint if exists operations_hub_relation_events_event_type_check;

alter table public.operations_hub_relation_events
  add constraint operations_hub_relation_events_event_type_check
  check (event_type in (
    'FOLDER_SAVE', 'FOLDER_ARCHIVE', 'ORGANIZE', 'REPARENT',
    'NODE_SAVE', 'NODE_ARCHIVE', 'EDGE_SAVE', 'EDGE_REMOVE'
  ));

create or replace function public.list_operations_hub_relation_folders_v2()
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
set statement_timeout = '4s'
as $$
  with recursive active_folders as materialized (
    select
      folder.folder_id,
      folder.folder_name,
      folder.folder_kind,
      folder.parent_folder_id,
      folder.sort_order,
      folder.updated_at
    from public.operations_hub_relation_folders folder
    where folder.is_active
  ), closure as (
    select folder.folder_id as ancestor_id, folder.folder_id as descendant_id
    from active_folders folder
    union all
    select closure.ancestor_id, child.folder_id
    from closure
    join active_folders child on child.parent_folder_id = closure.descendant_id
  ), direct_counts as (
    select node.folder_id, count(*)::integer as node_count
    from public.operations_hub_relation_nodes node
    where node.is_active and node.folder_id is not null
    group by node.folder_id
  ), descendant_counts as (
    select closure.ancestor_id as folder_id, count(node.node_id)::integer as node_count
    from closure
    left join public.operations_hub_relation_nodes node
      on node.folder_id = closure.descendant_id and node.is_active
    group by closure.ancestor_id
  )
  select jsonb_build_object(
    'folders', coalesce((
      select jsonb_agg(jsonb_build_object(
        'folderId', folder.folder_id,
        'name', folder.folder_name,
        'kind', folder.folder_kind,
        'parentFolderId', folder.parent_folder_id,
        'sortOrder', folder.sort_order,
        'directNodeCount', coalesce(direct_counts.node_count, 0),
        'descendantNodeCount', coalesce(descendant_counts.node_count, 0),
        'updatedAt', folder.updated_at
      ) order by folder.sort_order, folder.folder_name, folder.folder_id)
      from active_folders folder
      left join direct_counts on direct_counts.folder_id = folder.folder_id
      left join descendant_counts on descendant_counts.folder_id = folder.folder_id
    ), '[]'::jsonb),
    'organizedCount', (
      select count(*) from public.operations_hub_relation_nodes node
      where node.is_active and node.folder_id is not null
    ),
    'unorganizedExplicitCount', (
      select count(*) from public.operations_hub_relation_nodes node
      where node.is_active and node.folder_id is null
    )
  );
$$;

create or replace function public.save_operations_hub_relation_folder_v2(
  p_folder_id bigint,
  p_folder_name text,
  p_folder_kind text default 'custom',
  p_sort_order integer default 100,
  p_parent_folder_id bigint default null
)
returns table (
  folder_id bigint,
  folder_name text,
  folder_kind text,
  parent_folder_id bigint,
  sort_order integer,
  updated_at timestamptz
)
language plpgsql
security invoker
set search_path = pg_catalog, public
set statement_timeout = '4s'
as $$
declare
  v_before jsonb;
  v_folder_id bigint;
begin
  p_folder_name := btrim(coalesce(p_folder_name, ''));
  p_folder_kind := lower(btrim(coalesce(p_folder_kind, 'custom')));
  p_sort_order := greatest(0, least(coalesce(p_sort_order, 100), 10000));

  if length(p_folder_name) not between 1 and 60 then
    raise exception '폴더명은 1~60자로 입력해주세요.';
  end if;
  if p_folder_kind not in ('collection', 'one_plus_one', 'set', 'custom') then
    raise exception '폴더 유형을 확인해주세요.';
  end if;
  if p_parent_folder_id is not null and not exists (
    select 1
    from public.operations_hub_relation_folders parent_folder
    where parent_folder.folder_id = p_parent_folder_id and parent_folder.is_active
  ) then
    raise exception '선택한 상위 폴더를 찾을 수 없습니다.';
  end if;
  if p_folder_id is not null and p_parent_folder_id = p_folder_id then
    raise exception '폴더 자신을 상위 폴더로 지정할 수 없습니다.';
  end if;
  if p_folder_id is not null and p_parent_folder_id is not null and exists (
    with recursive descendants as (
      select folder.folder_id
      from public.operations_hub_relation_folders folder
      where folder.parent_folder_id = p_folder_id and folder.is_active
      union all
      select child.folder_id
      from descendants
      join public.operations_hub_relation_folders child
        on child.parent_folder_id = descendants.folder_id and child.is_active
    )
    select 1 from descendants where folder_id = p_parent_folder_id
  ) then
    raise exception '하위 폴더를 상위로 지정하는 순환 구조는 만들 수 없습니다.';
  end if;
  if exists (
    select 1
    from public.operations_hub_relation_folders duplicate
    where duplicate.is_active
      and duplicate.parent_folder_id is not distinct from p_parent_folder_id
      and lower(btrim(duplicate.folder_name)) = lower(p_folder_name)
      and duplicate.folder_id <> coalesce(p_folder_id, -1)
  ) then
    raise exception '같은 상위 폴더 안에 동일한 이름의 폴더가 이미 있습니다.';
  end if;

  if p_folder_id is null then
    insert into public.operations_hub_relation_folders (
      folder_name, folder_kind, parent_folder_id, sort_order,
      is_active, updated_by, updated_at
    ) values (
      p_folder_name, p_folder_kind, p_parent_folder_id, p_sort_order,
      true, 'operations_hub_frontend', now()
    )
    returning operations_hub_relation_folders.folder_id into v_folder_id;
  else
    select to_jsonb(folder.*) into v_before
    from public.operations_hub_relation_folders folder
    where folder.folder_id = p_folder_id and folder.is_active
    for update;
    if not found then
      raise exception '수정할 폴더를 찾을 수 없습니다.';
    end if;

    update public.operations_hub_relation_folders folder
    set folder_name = p_folder_name,
        folder_kind = p_folder_kind,
        parent_folder_id = p_parent_folder_id,
        sort_order = p_sort_order,
        updated_by = 'operations_hub_frontend',
        updated_at = now()
    where folder.folder_id = p_folder_id;
    v_folder_id := p_folder_id;
  end if;

  insert into public.operations_hub_relation_events (
    event_type, folder_id, before_value, after_value, changed_by
  )
  select 'FOLDER_SAVE', folder.folder_id, v_before, to_jsonb(folder.*), 'operations_hub_frontend'
  from public.operations_hub_relation_folders folder
  where folder.folder_id = v_folder_id;

  return query
  select
    folder.folder_id,
    folder.folder_name,
    folder.folder_kind,
    folder.parent_folder_id,
    folder.sort_order,
    folder.updated_at
  from public.operations_hub_relation_folders folder
  where folder.folder_id = v_folder_id;
end;
$$;

create or replace function public.archive_operations_hub_relation_folder_v2(p_folder_id bigint)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
set statement_timeout = '4s'
as $$
declare
  v_before jsonb;
  v_unassigned_listings integer := 0;
  v_unassigned_nodes integer := 0;
begin
  select to_jsonb(folder.*) into v_before
  from public.operations_hub_relation_folders folder
  where folder.folder_id = p_folder_id and folder.is_active
  for update;
  if not found then
    raise exception '보관할 폴더를 찾을 수 없습니다.';
  end if;

  if exists (
    select 1
    from public.operations_hub_relation_folders child
    where child.parent_folder_id = p_folder_id and child.is_active
  ) then
    raise exception '하위 폴더를 먼저 이동하거나 보관해주세요.';
  end if;

  update public.operations_hub_seller_listings listing
  set folder_id = null,
      organization_updated_at = now(),
      updated_by = 'operations_hub_frontend',
      updated_at = now()
  where listing.folder_id = p_folder_id;
  get diagnostics v_unassigned_listings = row_count;

  update public.operations_hub_relation_nodes node
  set folder_id = null,
      updated_by = 'operations_hub_frontend',
      updated_at = now()
  where node.folder_id = p_folder_id and node.is_active;
  get diagnostics v_unassigned_nodes = row_count;

  update public.operations_hub_relation_folders folder
  set is_active = false,
      parent_folder_id = null,
      updated_by = 'operations_hub_frontend',
      updated_at = now()
  where folder.folder_id = p_folder_id;

  insert into public.operations_hub_relation_events (
    event_type, folder_id, before_value, after_value, changed_by
  ) values (
    'FOLDER_ARCHIVE', p_folder_id, v_before,
    jsonb_build_object(
      'archived', true,
      'unassignedListings', v_unassigned_listings,
      'unassignedNodes', v_unassigned_nodes
    ),
    'operations_hub_frontend'
  );

  return jsonb_build_object(
    'folderId', p_folder_id,
    'unassignedListings', v_unassigned_listings,
    'unassignedNodes', v_unassigned_nodes
  );
end;
$$;

create or replace function public.archive_operations_hub_relation_node(p_node_id bigint)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
set statement_timeout = '4s'
as $$
declare
  v_before jsonb;
  v_folder_id bigint;
begin
  select to_jsonb(node.*), node.folder_id
  into v_before, v_folder_id
  from public.operations_hub_relation_nodes node
  where node.node_id = p_node_id and node.is_active
  for update;
  if not found then
    raise exception '삭제할 상품 노드를 찾을 수 없습니다.';
  end if;

  if exists (
    select 1
    from public.operations_hub_relation_edges edge
    where edge.is_active
      and (edge.parent_node_id = p_node_id or edge.child_node_id = p_node_id)
  ) then
    raise exception '연결된 상위·하위 관계를 먼저 해제해주세요.';
  end if;

  update public.operations_hub_relation_nodes node
  set is_active = false,
      updated_by = 'operations_hub_frontend',
      updated_at = now()
  where node.node_id = p_node_id;

  insert into public.operations_hub_relation_events (
    event_type, folder_id, before_value, after_value, changed_by
  ) values (
    'NODE_ARCHIVE', v_folder_id, v_before,
    jsonb_build_object('nodeId', p_node_id, 'archived', true),
    'operations_hub_frontend'
  );

  return jsonb_build_object('nodeId', p_node_id, 'archived', true);
end;
$$;

revoke all on function public.list_operations_hub_relation_folders_v2() from public;
revoke all on function public.validate_operations_hub_relation_folder_parent() from public;
revoke all on function public.save_operations_hub_relation_folder_v2(bigint, text, text, integer, bigint) from public;
revoke all on function public.archive_operations_hub_relation_folder_v2(bigint) from public;
revoke all on function public.archive_operations_hub_relation_node(bigint) from public;

grant execute on function public.list_operations_hub_relation_folders_v2() to anon, authenticated;
grant execute on function public.save_operations_hub_relation_folder_v2(bigint, text, text, integer, bigint) to anon, authenticated;
grant execute on function public.archive_operations_hub_relation_folder_v2(bigint) to anon, authenticated;
grant execute on function public.archive_operations_hub_relation_node(bigint) to anon, authenticated;
