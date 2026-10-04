-- Additive V1 for user-managed relation groups.
-- This migration deliberately does not change existing relation nodes/edges,
-- seller listing components, price rules, inventory calculations, or folders.

create table public.operations_hub_relation_groups (
  group_id bigint generated always as identity primary key,
  folder_id bigint references public.operations_hub_relation_folders(folder_id) on delete restrict,
  group_name text not null check (length(btrim(group_name)) between 1 and 300),
  group_type text not null check (group_type in ('collection', 'exhibition', 'set', 'one_plus_one', 'custom')),
  anchor_node_id bigint references public.operations_hub_relation_nodes(node_id) on delete restrict,
  sort_order integer not null default 100 check (sort_order between 0 and 100000),
  is_active boolean not null default true,
  updated_by text not null default 'operations_hub_frontend',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index operations_hub_relation_groups_active_folder_name_idx
  on public.operations_hub_relation_groups (coalesce(folder_id, 0), lower(btrim(group_name)))
  where is_active;

create index operations_hub_relation_groups_folder_active_idx
  on public.operations_hub_relation_groups (folder_id, sort_order, group_name, group_id)
  where is_active;

create index operations_hub_relation_groups_anchor_active_idx
  on public.operations_hub_relation_groups (anchor_node_id, group_id)
  where is_active and anchor_node_id is not null;

create table public.operations_hub_relation_group_memberships (
  membership_id bigint generated always as identity primary key,
  group_id bigint not null references public.operations_hub_relation_groups(group_id) on delete restrict,
  node_id bigint not null references public.operations_hub_relation_nodes(node_id) on delete restrict,
  member_role text not null default 'member' check (member_role in ('anchor', 'member', 'reference')),
  sort_order integer not null default 100 check (sort_order between 0 and 100000),
  is_active boolean not null default true,
  updated_by text not null default 'operations_hub_frontend',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (group_id, node_id)
);

create unique index operations_hub_relation_group_memberships_active_anchor_idx
  on public.operations_hub_relation_group_memberships (group_id)
  where is_active and member_role = 'anchor';

create index operations_hub_relation_group_memberships_group_active_idx
  on public.operations_hub_relation_group_memberships (group_id, sort_order, membership_id)
  where is_active;

create index operations_hub_relation_group_memberships_node_active_idx
  on public.operations_hub_relation_group_memberships (node_id, group_id)
  where is_active;

create table public.operations_hub_relation_group_edges (
  group_edge_id bigint generated always as identity primary key,
  group_id bigint not null references public.operations_hub_relation_groups(group_id) on delete restrict,
  from_node_id bigint not null references public.operations_hub_relation_nodes(node_id) on delete restrict,
  to_node_id bigint not null references public.operations_hub_relation_nodes(node_id) on delete restrict,
  edge_kind text not null check (edge_kind in (
    'collection_member', 'exhibition_member', 'set_member', 'one_plus_one_member', 'reference', 'custom'
  )),
  sort_order integer not null default 100 check (sort_order between 0 and 100000),
  is_active boolean not null default true,
  updated_by text not null default 'operations_hub_frontend',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (from_node_id <> to_node_id),
  unique (group_id, from_node_id, to_node_id, edge_kind)
);

create index operations_hub_relation_group_edges_group_active_idx
  on public.operations_hub_relation_group_edges (group_id, from_node_id, sort_order, to_node_id)
  where is_active;

create index operations_hub_relation_group_edges_reverse_active_idx
  on public.operations_hub_relation_group_edges (group_id, to_node_id, from_node_id)
  where is_active;

create table public.operations_hub_relation_group_requests (
  request_id uuid primary key,
  request_payload jsonb not null,
  response_payload jsonb,
  status text not null default 'completed' check (status in ('completed')),
  requested_by uuid,
  created_at timestamptz not null default now(),
  completed_at timestamptz not null default now()
);

create table public.operations_hub_relation_group_events (
  event_id bigint generated always as identity primary key,
  request_id uuid references public.operations_hub_relation_group_requests(request_id) on delete restrict,
  event_type text not null check (event_type in (
    'GROUP_SAVE', 'GROUP_ARCHIVE', 'MEMBERSHIP_SAVE', 'MEMBERSHIP_ARCHIVE',
    'MEMBERSHIP_ANCHOR_NORMALIZED', 'EDGE_SAVE', 'EDGE_ARCHIVE'
  )),
  group_id bigint references public.operations_hub_relation_groups(group_id) on delete restrict,
  membership_id bigint references public.operations_hub_relation_group_memberships(membership_id) on delete restrict,
  group_edge_id bigint references public.operations_hub_relation_group_edges(group_edge_id) on delete restrict,
  before_value jsonb,
  after_value jsonb,
  changed_by uuid,
  created_at timestamptz not null default now()
);

create index operations_hub_relation_group_events_group_created_idx
  on public.operations_hub_relation_group_events (group_id, created_at desc, event_id desc);

create index operations_hub_relation_group_events_request_idx
  on public.operations_hub_relation_group_events (request_id, event_id);

create or replace function public.validate_operations_hub_relation_group()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if new.is_active and new.folder_id is not null and not exists (
    select 1
    from public.operations_hub_relation_folders folder
    where folder.folder_id = new.folder_id and folder.is_active
  ) then
    raise exception '활성 폴더를 선택해주세요.';
  end if;

  if new.is_active and new.anchor_node_id is not null and not exists (
    select 1
    from public.operations_hub_relation_nodes node
    where node.node_id = new.anchor_node_id and node.is_active
  ) then
    raise exception '활성 관계 노드를 대표 노드로 선택해주세요.';
  end if;

  return new;
end;
$$;

create or replace function public.validate_operations_hub_relation_group_membership()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_group public.operations_hub_relation_groups%rowtype;
begin
  if not new.is_active then
    return new;
  end if;

  select * into v_group
  from public.operations_hub_relation_groups
  where group_id = new.group_id and is_active;
  if not found then
    raise exception '활성 관계 그룹을 찾을 수 없습니다.';
  end if;

  if not exists (
    select 1 from public.operations_hub_relation_nodes node
    where node.node_id = new.node_id and node.is_active
  ) then
    raise exception '활성 관계 노드를 찾을 수 없습니다.';
  end if;

  if new.member_role = 'anchor' and v_group.anchor_node_id is distinct from new.node_id then
    raise exception '대표 membership은 그룹의 대표 노드와 같아야 합니다.';
  end if;

  if new.member_role <> 'anchor' and v_group.anchor_node_id = new.node_id then
    raise exception '그룹 대표 노드는 anchor membership으로 저장해야 합니다.';
  end if;

  return new;
end;
$$;

create or replace function public.validate_operations_hub_relation_group_edge()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_group_type text;
begin
  if not new.is_active then
    return new;
  end if;

  select group_type into v_group_type
  from public.operations_hub_relation_groups
  where group_id = new.group_id and is_active;
  if not found then
    raise exception '활성 관계 그룹을 찾을 수 없습니다.';
  end if;

  if not exists (
    select 1 from public.operations_hub_relation_group_memberships membership
    join public.operations_hub_relation_nodes node on node.node_id = membership.node_id and node.is_active
    where membership.group_id = new.group_id
      and membership.node_id = new.from_node_id
      and membership.is_active
  ) or not exists (
    select 1 from public.operations_hub_relation_group_memberships membership
    join public.operations_hub_relation_nodes node on node.node_id = membership.node_id and node.is_active
    where membership.group_id = new.group_id
      and membership.node_id = new.to_node_id
      and membership.is_active
  ) then
    raise exception '그룹에 활성 membership으로 등록된 노드만 연결할 수 있습니다.';
  end if;

  if not (
    new.edge_kind in ('reference', 'custom')
    or (v_group_type = 'collection' and new.edge_kind = 'collection_member')
    or (v_group_type = 'exhibition' and new.edge_kind = 'exhibition_member')
    or (v_group_type = 'set' and new.edge_kind = 'set_member')
    or (v_group_type = 'one_plus_one' and new.edge_kind = 'one_plus_one_member')
  ) then
    raise exception '그룹 유형과 edge 유형이 맞지 않습니다.';
  end if;

  if exists (
    with recursive descendants(node_id) as (
      select new.to_node_id
      union
      select edge.to_node_id
      from public.operations_hub_relation_group_edges edge
      join descendants parent on parent.node_id = edge.from_node_id
      where edge.group_id = new.group_id
        and edge.is_active
        and edge.group_edge_id <> coalesce(new.group_edge_id, -1)
    )
    select 1 from descendants where node_id = new.from_node_id
  ) then
    raise exception '그룹 안에 순환 종속관계는 만들 수 없습니다.';
  end if;

  return new;
end;
$$;

create trigger operations_hub_relation_group_guard
before insert or update on public.operations_hub_relation_groups
for each row execute function public.validate_operations_hub_relation_group();

create trigger operations_hub_relation_group_membership_guard
before insert or update on public.operations_hub_relation_group_memberships
for each row execute function public.validate_operations_hub_relation_group_membership();

create trigger operations_hub_relation_group_edge_guard
before insert or update on public.operations_hub_relation_group_edges
for each row execute function public.validate_operations_hub_relation_group_edge();

alter table public.operations_hub_relation_groups enable row level security;
alter table public.operations_hub_relation_group_memberships enable row level security;
alter table public.operations_hub_relation_group_edges enable row level security;
alter table public.operations_hub_relation_group_requests enable row level security;
alter table public.operations_hub_relation_group_events enable row level security;

create policy "operations hub relation groups operator select"
  on public.operations_hub_relation_groups for select to authenticated
  using (coalesce((auth.jwt() -> 'app_metadata' ->> 'operations_hub_role') = 'operator', false));
create policy "operations hub relation groups operator insert"
  on public.operations_hub_relation_groups for insert to authenticated
  with check (coalesce((auth.jwt() -> 'app_metadata' ->> 'operations_hub_role') = 'operator', false));
create policy "operations hub relation groups operator update"
  on public.operations_hub_relation_groups for update to authenticated
  using (coalesce((auth.jwt() -> 'app_metadata' ->> 'operations_hub_role') = 'operator', false))
  with check (coalesce((auth.jwt() -> 'app_metadata' ->> 'operations_hub_role') = 'operator', false));

create policy "operations hub relation group memberships operator select"
  on public.operations_hub_relation_group_memberships for select to authenticated
  using (coalesce((auth.jwt() -> 'app_metadata' ->> 'operations_hub_role') = 'operator', false));
create policy "operations hub relation group memberships operator insert"
  on public.operations_hub_relation_group_memberships for insert to authenticated
  with check (coalesce((auth.jwt() -> 'app_metadata' ->> 'operations_hub_role') = 'operator', false));
create policy "operations hub relation group memberships operator update"
  on public.operations_hub_relation_group_memberships for update to authenticated
  using (coalesce((auth.jwt() -> 'app_metadata' ->> 'operations_hub_role') = 'operator', false))
  with check (coalesce((auth.jwt() -> 'app_metadata' ->> 'operations_hub_role') = 'operator', false));

create policy "operations hub relation group edges operator select"
  on public.operations_hub_relation_group_edges for select to authenticated
  using (coalesce((auth.jwt() -> 'app_metadata' ->> 'operations_hub_role') = 'operator', false));
create policy "operations hub relation group edges operator insert"
  on public.operations_hub_relation_group_edges for insert to authenticated
  with check (coalesce((auth.jwt() -> 'app_metadata' ->> 'operations_hub_role') = 'operator', false));
create policy "operations hub relation group edges operator update"
  on public.operations_hub_relation_group_edges for update to authenticated
  using (coalesce((auth.jwt() -> 'app_metadata' ->> 'operations_hub_role') = 'operator', false))
  with check (coalesce((auth.jwt() -> 'app_metadata' ->> 'operations_hub_role') = 'operator', false));

create policy "operations hub relation group requests operator select"
  on public.operations_hub_relation_group_requests for select to authenticated
  using (coalesce((auth.jwt() -> 'app_metadata' ->> 'operations_hub_role') = 'operator', false));
create policy "operations hub relation group requests operator insert"
  on public.operations_hub_relation_group_requests for insert to authenticated
  with check (
    coalesce((auth.jwt() -> 'app_metadata' ->> 'operations_hub_role') = 'operator', false)
    and requested_by is not distinct from auth.uid()
  );
create policy "operations hub relation group requests operator update"
  on public.operations_hub_relation_group_requests for update to authenticated
  using (coalesce((auth.jwt() -> 'app_metadata' ->> 'operations_hub_role') = 'operator', false))
  with check (
    coalesce((auth.jwt() -> 'app_metadata' ->> 'operations_hub_role') = 'operator', false)
    and requested_by is not distinct from auth.uid()
  );

create policy "operations hub relation group events operator select"
  on public.operations_hub_relation_group_events for select to authenticated
  using (coalesce((auth.jwt() -> 'app_metadata' ->> 'operations_hub_role') = 'operator', false));
create policy "operations hub relation group events operator insert"
  on public.operations_hub_relation_group_events for insert to authenticated
  with check (
    coalesce((auth.jwt() -> 'app_metadata' ->> 'operations_hub_role') = 'operator', false)
    and changed_by is not distinct from auth.uid()
  );

grant select, insert, update on table public.operations_hub_relation_groups to authenticated;
grant select, insert, update on table public.operations_hub_relation_group_memberships to authenticated;
grant select, insert, update on table public.operations_hub_relation_group_edges to authenticated;
grant select, insert, update on table public.operations_hub_relation_group_requests to authenticated;
grant select, insert on table public.operations_hub_relation_group_events to authenticated;
grant usage, select on sequence public.operations_hub_relation_groups_group_id_seq to authenticated;
grant usage, select on sequence public.operations_hub_relation_group_memberships_membership_id_seq to authenticated;
grant usage, select on sequence public.operations_hub_relation_group_edges_group_edge_id_seq to authenticated;
grant usage, select on sequence public.operations_hub_relation_group_events_event_id_seq to authenticated;

create or replace function public.apply_operations_hub_relation_groups_v1(
  p_request_id uuid,
  p_groups jsonb default '[]'::jsonb,
  p_memberships jsonb default '[]'::jsonb,
  p_edges jsonb default '[]'::jsonb,
  p_archive_group_ids bigint[] default '{}'::bigint[],
  p_archive_membership_ids bigint[] default '{}'::bigint[],
  p_archive_edge_ids bigint[] default '{}'::bigint[]
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
set statement_timeout = '8s'
as $$
declare
  v_request public.operations_hub_relation_group_requests%rowtype;
  v_group public.operations_hub_relation_groups%rowtype;
  v_membership public.operations_hub_relation_group_memberships%rowtype;
  v_edge public.operations_hub_relation_group_edges%rowtype;
  v_item jsonb;
  v_payload jsonb;
  v_group_map jsonb := '{}'::jsonb;
  v_client_key text;
  v_group_ref text;
  v_group_id bigint;
  v_folder_id bigint;
  v_anchor_node_id bigint;
  v_node_id bigint;
  v_from_node_id bigint;
  v_to_node_id bigint;
  v_group_name text;
  v_group_type text;
  v_member_role text;
  v_edge_kind text;
  v_sort_order integer;
  v_archive_id bigint;
  v_response jsonb;
  v_group_count integer := 0;
  v_membership_count integer := 0;
  v_edge_count integer := 0;
begin
  if coalesce(auth.jwt() -> 'app_metadata' ->> 'operations_hub_role', '') <> 'operator' then
    raise exception using errcode = '42501', message = '관계 그룹 작업 권한이 없습니다.';
  end if;

  if p_request_id is null then
    raise exception 'request_id가 필요합니다.';
  end if;
  if jsonb_typeof(p_groups) <> 'array'
    or jsonb_typeof(p_memberships) <> 'array'
    or jsonb_typeof(p_edges) <> 'array' then
    raise exception 'groups, memberships, edges는 배열이어야 합니다.';
  end if;
  if jsonb_array_length(p_groups) > 100
    or jsonb_array_length(p_memberships) > 500
    or jsonb_array_length(p_edges) > 1000
    or cardinality(coalesce(p_archive_group_ids, '{}'::bigint[])) > 100
    or cardinality(coalesce(p_archive_membership_ids, '{}'::bigint[])) > 500
    or cardinality(coalesce(p_archive_edge_ids, '{}'::bigint[])) > 1000 then
    raise exception '한 요청은 그룹 100개, membership 500개, edge 1000개를 넘을 수 없습니다.';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_groups) item(value)
    where jsonb_typeof(item.value) <> 'object'
       or exists (
         select 1 from jsonb_object_keys(item.value) key_name
         where key_name not in ('clientKey', 'groupId', 'folderId', 'groupName', 'groupType', 'anchorNodeId', 'sortOrder')
       )
  ) or exists (
    select 1 from jsonb_array_elements(p_memberships) item(value)
    where jsonb_typeof(item.value) <> 'object'
       or exists (
         select 1 from jsonb_object_keys(item.value) key_name
         where key_name not in ('groupRef', 'nodeId', 'memberRole', 'sortOrder')
       )
  ) or exists (
    select 1 from jsonb_array_elements(p_edges) item(value)
    where jsonb_typeof(item.value) <> 'object'
       or exists (
         select 1 from jsonb_object_keys(item.value) key_name
         where key_name not in ('groupRef', 'fromNodeId', 'toNodeId', 'edgeKind', 'sortOrder')
       )
  ) then
    raise exception '허용되지 않은 그룹 작업 필드가 있습니다.';
  end if;

  v_payload := jsonb_build_object(
    'groups', p_groups,
    'memberships', p_memberships,
    'edges', p_edges,
    'archiveGroupIds', coalesce(to_jsonb(p_archive_group_ids), '[]'::jsonb),
    'archiveMembershipIds', coalesce(to_jsonb(p_archive_membership_ids), '[]'::jsonb),
    'archiveEdgeIds', coalesce(to_jsonb(p_archive_edge_ids), '[]'::jsonb)
  );

  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text, 916245));
  select * into v_request
  from public.operations_hub_relation_group_requests request
  where request.request_id = p_request_id
  for update;

  if found then
    if v_request.request_payload is distinct from v_payload then
      raise exception '같은 request_id에 다른 작업 내용을 사용할 수 없습니다.';
    end if;
    return coalesce(v_request.response_payload, jsonb_build_object('requestId', p_request_id, 'status', v_request.status));
  end if;

  insert into public.operations_hub_relation_group_requests (
    request_id, request_payload, requested_by
  ) values (
    p_request_id, v_payload, auth.uid()
  );

  -- Archive in dependency order. A group cannot be archived while active members or edges remain.
  foreach v_archive_id in array coalesce(p_archive_edge_ids, '{}'::bigint[]) loop
    select * into v_edge from public.operations_hub_relation_group_edges
    where group_edge_id = v_archive_id and is_active for update;
    if not found then raise exception '활성 그룹 edge %를 찾을 수 없습니다.', v_archive_id; end if;
    update public.operations_hub_relation_group_edges
    set is_active = false, updated_by = 'operations_hub_frontend', updated_at = now()
    where group_edge_id = v_archive_id;
    insert into public.operations_hub_relation_group_events (
      request_id, event_type, group_id, group_edge_id, before_value, after_value, changed_by
    ) values (
      p_request_id, 'EDGE_ARCHIVE', v_edge.group_id, v_edge.group_edge_id,
      to_jsonb(v_edge), jsonb_build_object('isActive', false), auth.uid()
    );
  end loop;

  foreach v_archive_id in array coalesce(p_archive_membership_ids, '{}'::bigint[]) loop
    select * into v_membership from public.operations_hub_relation_group_memberships
    where membership_id = v_archive_id and is_active for update;
    if not found then raise exception '활성 그룹 membership %를 찾을 수 없습니다.', v_archive_id; end if;
    if v_membership.member_role = 'anchor'
      and not (v_membership.group_id = any(coalesce(p_archive_group_ids, '{}'::bigint[]))) then
      raise exception '대표 membership은 그룹 대표를 변경한 뒤에 해제해주세요.';
    end if;
    if exists (
      select 1 from public.operations_hub_relation_group_edges edge
      where edge.group_id = v_membership.group_id
        and edge.is_active
        and (edge.from_node_id = v_membership.node_id or edge.to_node_id = v_membership.node_id)
    ) then
      raise exception 'membership %의 그룹 edge를 먼저 해제해주세요.', v_archive_id;
    end if;
    update public.operations_hub_relation_group_memberships
    set is_active = false, updated_by = 'operations_hub_frontend', updated_at = now()
    where membership_id = v_archive_id;
    insert into public.operations_hub_relation_group_events (
      request_id, event_type, group_id, membership_id, before_value, after_value, changed_by
    ) values (
      p_request_id, 'MEMBERSHIP_ARCHIVE', v_membership.group_id, v_membership.membership_id,
      to_jsonb(v_membership), jsonb_build_object('isActive', false), auth.uid()
    );
  end loop;

  foreach v_archive_id in array coalesce(p_archive_group_ids, '{}'::bigint[]) loop
    select * into v_group from public.operations_hub_relation_groups
    where group_id = v_archive_id and is_active for update;
    if not found then raise exception '활성 관계 그룹 %를 찾을 수 없습니다.', v_archive_id; end if;
    if exists (select 1 from public.operations_hub_relation_group_memberships membership where membership.group_id = v_archive_id and membership.is_active)
      or exists (select 1 from public.operations_hub_relation_group_edges edge where edge.group_id = v_archive_id and edge.is_active) then
      raise exception '관계 그룹 %의 membership과 edge를 먼저 해제해주세요.', v_archive_id;
    end if;
    update public.operations_hub_relation_groups
    set is_active = false, updated_by = 'operations_hub_frontend', updated_at = now()
    where group_id = v_archive_id;
    insert into public.operations_hub_relation_group_events (
      request_id, event_type, group_id, before_value, after_value, changed_by
    ) values (
      p_request_id, 'GROUP_ARCHIVE', v_group.group_id,
      to_jsonb(v_group), jsonb_build_object('isActive', false), auth.uid()
    );
  end loop;

  for v_item in select value from jsonb_array_elements(p_groups) loop
    v_client_key := btrim(coalesce(v_item ->> 'clientKey', ''));
    v_group_name := btrim(coalesce(v_item ->> 'groupName', ''));
    v_group_type := lower(btrim(coalesce(v_item ->> 'groupType', '')));
    if v_client_key !~ '^[A-Za-z0-9._:-]{1,100}$' or v_group_name = '' or v_group_type not in ('collection', 'exhibition', 'set', 'one_plus_one', 'custom') then
      raise exception '그룹 clientKey, 이름 또는 유형을 확인해주세요.';
    end if;
    if v_group_map ? v_client_key then raise exception '그룹 clientKey가 중복되었습니다: %', v_client_key; end if;
    if nullif(v_item ->> 'groupId', '') is not null and (v_item ->> 'groupId') !~ '^[1-9][0-9]*$' then raise exception 'groupId를 확인해주세요.'; end if;
    if nullif(v_item ->> 'folderId', '') is not null and (v_item ->> 'folderId') !~ '^[1-9][0-9]*$' then raise exception 'folderId를 확인해주세요.'; end if;
    if nullif(v_item ->> 'anchorNodeId', '') is not null and (v_item ->> 'anchorNodeId') !~ '^[1-9][0-9]*$' then raise exception 'anchorNodeId를 확인해주세요.'; end if;
    if nullif(v_item ->> 'sortOrder', '') is not null and (v_item ->> 'sortOrder') !~ '^[0-9]{1,6}$' then raise exception 'sortOrder를 확인해주세요.'; end if;

    v_group_id := nullif(v_item ->> 'groupId', '')::bigint;
    v_folder_id := nullif(v_item ->> 'folderId', '')::bigint;
    v_anchor_node_id := nullif(v_item ->> 'anchorNodeId', '')::bigint;
    v_sort_order := coalesce(nullif(v_item ->> 'sortOrder', '')::integer, 100);

    if v_group_id is null then
      insert into public.operations_hub_relation_groups (
        folder_id, group_name, group_type, anchor_node_id, sort_order, is_active, updated_by, updated_at
      ) values (
        v_folder_id, v_group_name, v_group_type, v_anchor_node_id, v_sort_order, true,
        'operations_hub_frontend', now()
      ) returning * into v_group;
    else
      select * into v_group from public.operations_hub_relation_groups
      where group_id = v_group_id and is_active for update;
      if not found then raise exception '활성 관계 그룹 %를 찾을 수 없습니다.', v_group_id; end if;
      update public.operations_hub_relation_groups
      set folder_id = v_folder_id, group_name = v_group_name, group_type = v_group_type,
          anchor_node_id = v_anchor_node_id, sort_order = v_sort_order,
          updated_by = 'operations_hub_frontend', updated_at = now()
      where group_id = v_group_id
      returning * into v_group;
    end if;

    insert into public.operations_hub_relation_group_events (
      request_id, event_type, group_id, before_value, after_value, changed_by
    ) values (
      p_request_id, 'GROUP_SAVE', v_group.group_id,
      case when v_group_id is null then null else jsonb_build_object('groupId', v_group_id) end,
      to_jsonb(v_group), auth.uid()
    );
    v_group_map := jsonb_set(v_group_map, array[v_client_key], to_jsonb(v_group.group_id), true);
    v_group_count := v_group_count + 1;
  end loop;

  -- Keep at most one active anchor membership and make it match the current group anchor.
  for v_client_key, v_group_ref in select key, value from jsonb_each_text(v_group_map) loop
    v_group_id := v_group_ref::bigint;
    select * into v_group from public.operations_hub_relation_groups where group_id = v_group_id;
    for v_membership in
      update public.operations_hub_relation_group_memberships membership
      set member_role = 'member', updated_by = 'operations_hub_frontend', updated_at = now()
      where membership.group_id = v_group_id
        and membership.is_active
        and membership.member_role = 'anchor'
        and (v_group.anchor_node_id is null or membership.node_id <> v_group.anchor_node_id)
      returning *
    loop
      insert into public.operations_hub_relation_group_events (
        request_id, event_type, group_id, membership_id, before_value, after_value, changed_by
      ) values (
        p_request_id, 'MEMBERSHIP_ANCHOR_NORMALIZED', v_group_id, v_membership.membership_id,
        jsonb_build_object('memberRole', 'anchor'), to_jsonb(v_membership), auth.uid()
      );
    end loop;
  end loop;

  for v_item in select value from jsonb_array_elements(p_memberships) loop
    v_group_ref := btrim(coalesce(v_item ->> 'groupRef', ''));
    if not (v_group_map ? v_group_ref) then raise exception '이 요청의 groupRef를 찾을 수 없습니다: %', v_group_ref; end if;
    if coalesce(v_item ->> 'nodeId', '') !~ '^[1-9][0-9]*$' then raise exception 'nodeId를 확인해주세요.'; end if;
    v_member_role := lower(btrim(coalesce(v_item ->> 'memberRole', 'member')));
    if v_member_role not in ('anchor', 'member', 'reference') then raise exception 'memberRole을 확인해주세요.'; end if;
    if nullif(v_item ->> 'sortOrder', '') is not null and (v_item ->> 'sortOrder') !~ '^[0-9]{1,6}$' then raise exception 'sortOrder를 확인해주세요.'; end if;
    v_group_id := (v_group_map ->> v_group_ref)::bigint;
    v_node_id := (v_item ->> 'nodeId')::bigint;
    v_sort_order := coalesce(nullif(v_item ->> 'sortOrder', '')::integer, 100);

    insert into public.operations_hub_relation_group_memberships (
      group_id, node_id, member_role, sort_order, is_active, updated_by, updated_at
    ) values (
      v_group_id, v_node_id, v_member_role, v_sort_order, true, 'operations_hub_frontend', now()
    ) on conflict (group_id, node_id) do update set
      member_role = excluded.member_role, sort_order = excluded.sort_order, is_active = true,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at
    returning * into v_membership;

    insert into public.operations_hub_relation_group_events (
      request_id, event_type, group_id, membership_id, after_value, changed_by
    ) values (
      p_request_id, 'MEMBERSHIP_SAVE', v_group_id, v_membership.membership_id, to_jsonb(v_membership), auth.uid()
    );
    v_membership_count := v_membership_count + 1;
  end loop;

  for v_client_key, v_group_ref in select key, value from jsonb_each_text(v_group_map) loop
    v_group_id := v_group_ref::bigint;
    select * into v_group from public.operations_hub_relation_groups where group_id = v_group_id;
    if v_group.anchor_node_id is not null and not exists (
      select 1 from public.operations_hub_relation_group_memberships membership
      where membership.group_id = v_group_id
        and membership.node_id = v_group.anchor_node_id
        and membership.member_role = 'anchor'
        and membership.is_active
    ) then
      raise exception '그룹 %의 대표 노드는 active anchor membership으로 함께 저장해야 합니다.', v_group_id;
    end if;
  end loop;

  for v_item in select value from jsonb_array_elements(p_edges) loop
    v_group_ref := btrim(coalesce(v_item ->> 'groupRef', ''));
    if not (v_group_map ? v_group_ref) then raise exception '이 요청의 groupRef를 찾을 수 없습니다: %', v_group_ref; end if;
    if coalesce(v_item ->> 'fromNodeId', '') !~ '^[1-9][0-9]*$'
      or coalesce(v_item ->> 'toNodeId', '') !~ '^[1-9][0-9]*$' then
      raise exception 'fromNodeId와 toNodeId를 확인해주세요.';
    end if;
    v_edge_kind := lower(btrim(coalesce(v_item ->> 'edgeKind', '')));
    if v_edge_kind not in ('collection_member', 'exhibition_member', 'set_member', 'one_plus_one_member', 'reference', 'custom') then
      raise exception 'edgeKind를 확인해주세요.';
    end if;
    if nullif(v_item ->> 'sortOrder', '') is not null and (v_item ->> 'sortOrder') !~ '^[0-9]{1,6}$' then raise exception 'sortOrder를 확인해주세요.'; end if;
    v_group_id := (v_group_map ->> v_group_ref)::bigint;
    v_from_node_id := (v_item ->> 'fromNodeId')::bigint;
    v_to_node_id := (v_item ->> 'toNodeId')::bigint;
    v_sort_order := coalesce(nullif(v_item ->> 'sortOrder', '')::integer, 100);

    insert into public.operations_hub_relation_group_edges (
      group_id, from_node_id, to_node_id, edge_kind, sort_order, is_active, updated_by, updated_at
    ) values (
      v_group_id, v_from_node_id, v_to_node_id, v_edge_kind, v_sort_order,
      true, 'operations_hub_frontend', now()
    ) on conflict (group_id, from_node_id, to_node_id, edge_kind) do update set
      sort_order = excluded.sort_order, is_active = true,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at
    returning * into v_edge;

    insert into public.operations_hub_relation_group_events (
      request_id, event_type, group_id, group_edge_id, after_value, changed_by
    ) values (
      p_request_id, 'EDGE_SAVE', v_group_id, v_edge.group_edge_id, to_jsonb(v_edge), auth.uid()
    );
    v_edge_count := v_edge_count + 1;
  end loop;

  v_response := jsonb_build_object(
    'requestId', p_request_id,
    'status', 'completed',
    'groupCount', v_group_count,
    'membershipCount', v_membership_count,
    'edgeCount', v_edge_count,
    'groupRefs', v_group_map
  );
  update public.operations_hub_relation_group_requests
  set response_payload = v_response, completed_at = now()
  where request_id = p_request_id;

  return v_response;
end;
$$;

create or replace function public.archive_operations_hub_relation_group_v1(
  p_group_id bigint,
  p_request_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
set statement_timeout = '8s'
as $$
begin
  if p_group_id is null or p_request_id is null then
    raise exception 'group_id와 request_id가 필요합니다.';
  end if;
  return public.apply_operations_hub_relation_groups_v1(
    p_request_id,
    '[]'::jsonb,
    '[]'::jsonb,
    '[]'::jsonb,
    array[p_group_id],
    '{}'::bigint[],
    '{}'::bigint[]
  );
end;
$$;

create or replace function public.list_operations_hub_relation_groups_v1(
  p_search text default '',
  p_folder_id bigint default null,
  p_group_id bigint default null,
  p_limit integer default 200
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
set statement_timeout = '4s'
as $$
  with input as (
    select left(btrim(coalesce(p_search, '')), 200) as search_text,
      greatest(1, least(coalesce(p_limit, 200), 200)) as row_limit
  ), filtered_groups as materialized (
    select group_row.*
    from public.operations_hub_relation_groups group_row
    cross join input
    where group_row.is_active
      and (p_folder_id is null or group_row.folder_id = p_folder_id)
      and (p_group_id is null or group_row.group_id = p_group_id)
      and (
        input.search_text = ''
        or group_row.group_name ilike '%' || input.search_text || '%'
        or exists (
          select 1
          from public.operations_hub_relation_group_memberships membership
          join public.operations_hub_relation_nodes node on node.node_id = membership.node_id and node.is_active
          where membership.group_id = group_row.group_id
            and membership.is_active
            and (
              node.display_name ilike '%' || input.search_text || '%'
              or coalesce(node.sellpia_sku_code, '') ilike '%' || input.search_text || '%'
              or coalesce(node.sellpia_product_code, '') ilike '%' || input.search_text || '%'
            )
        )
      )
    order by group_row.sort_order, lower(group_row.group_name), group_row.group_id
    limit (select row_limit from input)
  ), memberships as materialized (
    select membership.*,
      node.node_type, node.display_name, node.sellpia_product_code, node.sellpia_sku_code,
      node.relation_kind
    from public.operations_hub_relation_group_memberships membership
    join public.operations_hub_relation_nodes node on node.node_id = membership.node_id and node.is_active
    where membership.is_active
      and membership.group_id in (select group_id from filtered_groups)
  ), edges as materialized (
    select edge.*
    from public.operations_hub_relation_group_edges edge
    where edge.is_active
      and edge.group_id in (select group_id from filtered_groups)
  )
  select jsonb_build_object(
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object(
        'groupId', group_row.group_id,
        'folderId', group_row.folder_id,
        'groupName', group_row.group_name,
        'groupType', group_row.group_type,
        'anchorNodeId', group_row.anchor_node_id,
        'sortOrder', group_row.sort_order,
        'membershipCount', (select count(*) from memberships membership where membership.group_id = group_row.group_id),
        'edgeCount', (select count(*) from edges edge where edge.group_id = group_row.group_id),
        'updatedAt', group_row.updated_at
      ) order by group_row.sort_order, lower(group_row.group_name), group_row.group_id)
      from filtered_groups group_row
    ), '[]'::jsonb),
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object(
        'membershipId', membership.membership_id,
        'groupId', membership.group_id,
        'nodeId', membership.node_id,
        'memberRole', membership.member_role,
        'sortOrder', membership.sort_order,
        'nodeType', membership.node_type,
        'displayName', membership.display_name,
        'sellpiaProductCode', membership.sellpia_product_code,
        'sellpiaSkuCode', membership.sellpia_sku_code,
        'relationKind', membership.relation_kind
      ) order by membership.group_id, membership.sort_order, membership.membership_id)
      from memberships membership
    ), '[]'::jsonb),
    'edges', coalesce((
      select jsonb_agg(jsonb_build_object(
        'groupEdgeId', edge.group_edge_id,
        'groupId', edge.group_id,
        'fromNodeId', edge.from_node_id,
        'toNodeId', edge.to_node_id,
        'edgeKind', edge.edge_kind,
        'sortOrder', edge.sort_order
      ) order by edge.group_id, edge.from_node_id, edge.sort_order, edge.group_edge_id)
      from edges edge
    ), '[]'::jsonb),
    'matchedGroupCount', (select count(*) from filtered_groups)
  );
$$;

revoke all on function public.validate_operations_hub_relation_group() from public;
revoke all on function public.validate_operations_hub_relation_group_membership() from public;
revoke all on function public.validate_operations_hub_relation_group_edge() from public;
revoke all on function public.apply_operations_hub_relation_groups_v1(uuid, jsonb, jsonb, jsonb, bigint[], bigint[], bigint[]) from public;
revoke all on function public.archive_operations_hub_relation_group_v1(bigint, uuid) from public;
revoke all on function public.list_operations_hub_relation_groups_v1(text, bigint, bigint, integer) from public;

grant execute on function public.apply_operations_hub_relation_groups_v1(uuid, jsonb, jsonb, jsonb, bigint[], bigint[], bigint[]) to authenticated;
grant execute on function public.archive_operations_hub_relation_group_v1(bigint, uuid) to authenticated;
grant execute on function public.list_operations_hub_relation_groups_v1(text, bigint, bigint, integer) to authenticated;

comment on table public.operations_hub_relation_groups is
  'Additive V1 user-managed groups. Folders organize groups only; groups do not change price, inventory, listing components, or existing relation edges.';
comment on table public.operations_hub_relation_group_memberships is
  'Many-to-many group membership over existing relation nodes. Membership is display/relationship metadata, not a BOM or seller listing mapping.';
comment on table public.operations_hub_relation_group_edges is
  'Typed, cycle-safe edges scoped to one relation group. They are not mirrored into operations_hub_relation_edges and have no price or inventory semantics.';
comment on function public.apply_operations_hub_relation_groups_v1(uuid, jsonb, jsonb, jsonb, bigint[], bigint[], bigint[]) is
  'Idempotent, bounded group/membership/typed-edge batch save. It accepts only explicit V1 fields and does not mutate existing relation, listing, price, or inventory records.';

notify pgrst, 'reload schema';
