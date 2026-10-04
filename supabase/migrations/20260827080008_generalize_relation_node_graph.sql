
drop function if exists public.get_operations_hub_listing_parent_groups(text, text, text);
drop function if exists public.save_operations_hub_listing_parent_group(text, text, text, text, bigint, text);
drop function if exists public.remove_operations_hub_listing_parent_group(bigint);

drop table if exists public.operations_hub_listing_group_memberships;
drop table if exists public.operations_hub_relation_groups;

create table public.operations_hub_relation_nodes (
  node_id bigint generated always as identity primary key,
  node_type text not null
    check (node_type in ('sellpia_product', 'seller_listing', 'custom')),
  display_name text not null
    check (length(btrim(display_name)) between 1 and 300),
  sellpia_product_code text,
  listing_id bigint references public.operations_hub_seller_listings(listing_id) on delete restrict,
  folder_id bigint references public.operations_hub_relation_folders(folder_id) on delete set null,
  relation_kind text not null default 'custom'
    check (relation_kind in ('individual', 'collection', 'one_plus_one', 'set', 'custom')),
  is_active boolean not null default true,
  updated_by text not null default 'operations_hub_frontend',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (node_type = 'sellpia_product' and nullif(btrim(sellpia_product_code), '') is not null and listing_id is null)
    or (node_type = 'seller_listing' and sellpia_product_code is null and listing_id is not null)
    or (node_type = 'custom' and sellpia_product_code is null and listing_id is null)
  )
);

create unique index operations_hub_relation_nodes_sellpia_active_idx
  on public.operations_hub_relation_nodes (lower(btrim(sellpia_product_code)))
  where is_active and node_type = 'sellpia_product';

create unique index operations_hub_relation_nodes_listing_active_idx
  on public.operations_hub_relation_nodes (listing_id)
  where is_active and node_type = 'seller_listing';

create index operations_hub_relation_nodes_folder_active_idx
  on public.operations_hub_relation_nodes (folder_id, relation_kind, display_name)
  where is_active;

create table public.operations_hub_relation_edges (
  edge_id bigint generated always as identity primary key,
  parent_node_id bigint not null
    references public.operations_hub_relation_nodes(node_id) on delete restrict,
  child_node_id bigint not null
    references public.operations_hub_relation_nodes(node_id) on delete restrict,
  sort_order integer not null default 100 check (sort_order between 0 and 10000),
  is_active boolean not null default true,
  updated_by text not null default 'operations_hub_frontend',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (parent_node_id <> child_node_id),
  unique (parent_node_id, child_node_id)
);

create index operations_hub_relation_edges_parent_active_idx
  on public.operations_hub_relation_edges (parent_node_id, sort_order, child_node_id)
  where is_active;

create index operations_hub_relation_edges_child_active_idx
  on public.operations_hub_relation_edges (child_node_id, parent_node_id)
  where is_active;

alter table public.operations_hub_relation_nodes enable row level security;
alter table public.operations_hub_relation_edges enable row level security;

create policy "operations hub relation nodes readable"
  on public.operations_hub_relation_nodes for select
  to anon, authenticated using (true);
create policy "operations hub relation nodes insertable"
  on public.operations_hub_relation_nodes for insert
  to anon, authenticated with check (updated_by = 'operations_hub_frontend');
create policy "operations hub relation nodes updatable"
  on public.operations_hub_relation_nodes for update
  to anon, authenticated
  using (updated_by = 'operations_hub_frontend')
  with check (updated_by = 'operations_hub_frontend');

create policy "operations hub relation edges readable"
  on public.operations_hub_relation_edges for select
  to anon, authenticated using (true);
create policy "operations hub relation edges insertable"
  on public.operations_hub_relation_edges for insert
  to anon, authenticated with check (updated_by = 'operations_hub_frontend');
create policy "operations hub relation edges updatable"
  on public.operations_hub_relation_edges for update
  to anon, authenticated
  using (updated_by = 'operations_hub_frontend')
  with check (updated_by = 'operations_hub_frontend');

grant select, insert, update on table public.operations_hub_relation_nodes to anon, authenticated;
grant select, insert, update on table public.operations_hub_relation_edges to anon, authenticated;
grant usage, select on sequence public.operations_hub_relation_nodes_node_id_seq to anon, authenticated;
grant usage, select on sequence public.operations_hub_relation_edges_edge_id_seq to anon, authenticated;

alter table public.operations_hub_relation_events
  drop constraint operations_hub_relation_events_event_type_check;

alter table public.operations_hub_relation_events
  add constraint operations_hub_relation_events_event_type_check
  check (event_type in (
    'FOLDER_SAVE', 'FOLDER_ARCHIVE', 'ORGANIZE', 'REPARENT',
    'NODE_SAVE', 'EDGE_SAVE', 'EDGE_REMOVE'
  ));

create or replace function public.ensure_operations_hub_sellpia_relation_node(
  p_sellpia_product_code text,
  p_folder_id bigint default null,
  p_relation_kind text default 'individual'
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
set statement_timeout = '4s'
as $$
declare
  v_node public.operations_hub_relation_nodes%rowtype;
  v_product_name text;
begin
  p_sellpia_product_code := btrim(coalesce(p_sellpia_product_code, ''));
  p_relation_kind := coalesce(nullif(lower(btrim(coalesce(p_relation_kind, ''))), ''), 'individual');
  if p_sellpia_product_code = '' then
    raise exception '셀피아 상품코드를 선택해주세요.';
  end if;
  if p_relation_kind not in ('individual', 'collection', 'one_plus_one', 'set', 'custom') then
    raise exception '노드 유형을 확인해주세요.';
  end if;
  if p_folder_id is not null and not exists (
    select 1 from public.operations_hub_relation_folders folder
    where folder.folder_id = p_folder_id and folder.is_active
  ) then
    raise exception '선택한 활성 폴더를 찾을 수 없습니다.';
  end if;

  select latest.sellpia_product_name into v_product_name
  from public.sellpia_stock_latest latest
  where latest.sellpia_product_code = p_sellpia_product_code
  order by latest.sellpia_sku_code
  limit 1;
  if nullif(btrim(coalesce(v_product_name, '')), '') is null then
    raise exception '최신 셀피아 원본에서 상품코드 %를 찾을 수 없습니다.', p_sellpia_product_code;
  end if;

  insert into public.operations_hub_relation_nodes (
    node_type, display_name, sellpia_product_code, folder_id, relation_kind,
    is_active, updated_by, updated_at
  ) values (
    'sellpia_product', v_product_name, p_sellpia_product_code, p_folder_id, p_relation_kind,
    true, 'operations_hub_frontend', now()
  )
  on conflict (lower(btrim(sellpia_product_code)))
    where is_active and node_type = 'sellpia_product'
  do update set
    display_name = excluded.display_name,
    folder_id = coalesce(excluded.folder_id, operations_hub_relation_nodes.folder_id),
    relation_kind = excluded.relation_kind,
    updated_by = 'operations_hub_frontend',
    updated_at = now()
  returning * into v_node;

  insert into public.operations_hub_relation_events (
    event_type, folder_id, before_value, after_value, changed_by
  ) values (
    'NODE_SAVE', v_node.folder_id, null, to_jsonb(v_node), 'operations_hub_frontend'
  );

  return jsonb_build_object(
    'nodeId', v_node.node_id,
    'nodeType', v_node.node_type,
    'displayName', v_node.display_name,
    'productCode', v_node.sellpia_product_code,
    'folderId', v_node.folder_id,
    'relationKind', v_node.relation_kind
  );
end;
$$;

create or replace function public.ensure_operations_hub_seller_relation_node(
  p_source text,
  p_product_code text,
  p_option_code text default '',
  p_folder_id bigint default null,
  p_relation_kind text default 'custom'
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
set statement_timeout = '4s'
as $$
declare
  v_listing public.operations_hub_seller_listings%rowtype;
  v_node public.operations_hub_relation_nodes%rowtype;
  v_name text;
begin
  p_source := lower(btrim(coalesce(p_source, '')));
  p_product_code := btrim(coalesce(p_product_code, ''));
  p_option_code := btrim(coalesce(p_option_code, ''));
  p_relation_kind := coalesce(nullif(lower(btrim(coalesce(p_relation_kind, ''))), ''), 'custom');
  if p_source not in ('smartstore', 'makeshop', 'ably') or p_product_code = '' then
    raise exception '판매처와 상품코드를 확인해주세요.';
  end if;
  if p_relation_kind not in ('individual', 'collection', 'one_plus_one', 'set', 'custom') then
    raise exception '노드 유형을 확인해주세요.';
  end if;
  if p_folder_id is not null and not exists (
    select 1 from public.operations_hub_relation_folders folder
    where folder.folder_id = p_folder_id and folder.is_active
  ) then
    raise exception '선택한 활성 폴더를 찾을 수 없습니다.';
  end if;

  select listing.* into v_listing
  from public.operations_hub_seller_listings listing
  where listing.source_channel = p_source
    and listing.product_code = p_product_code
    and listing.option_code = p_option_code
    and listing.is_active
  limit 1;
  if not found then
    raise exception '먼저 판매처 상품/옵션의 실제 SKU 연결을 저장해주세요.';
  end if;

  v_name := concat_ws(' · ',
    nullif(btrim(coalesce(v_listing.product_name, '')), ''),
    nullif(btrim(coalesce(v_listing.option_name, '')), '')
  );
  if v_name = '' then
    v_name := concat_ws(' / ', v_listing.product_code, nullif(v_listing.option_code, ''));
  end if;

  insert into public.operations_hub_relation_nodes (
    node_type, display_name, listing_id, folder_id, relation_kind,
    is_active, updated_by, updated_at
  ) values (
    'seller_listing', v_name, v_listing.listing_id, p_folder_id, p_relation_kind,
    true, 'operations_hub_frontend', now()
  )
  on conflict (listing_id)
    where is_active and node_type = 'seller_listing'
  do update set
    display_name = excluded.display_name,
    folder_id = coalesce(excluded.folder_id, operations_hub_relation_nodes.folder_id),
    relation_kind = excluded.relation_kind,
    updated_by = 'operations_hub_frontend',
    updated_at = now()
  returning * into v_node;

  insert into public.operations_hub_relation_events (
    event_type, listing_id, folder_id, before_value, after_value, changed_by
  ) values (
    'NODE_SAVE', v_listing.listing_id, v_node.folder_id, null, to_jsonb(v_node), 'operations_hub_frontend'
  );

  return jsonb_build_object(
    'nodeId', v_node.node_id,
    'nodeType', v_node.node_type,
    'displayName', v_node.display_name,
    'source', v_listing.source_channel,
    'productCode', v_listing.product_code,
    'optionCode', v_listing.option_code,
    'folderId', v_node.folder_id,
    'relationKind', v_node.relation_kind
  );
end;
$$;

create or replace function public.list_operations_hub_relation_nodes(
  p_search text default '',
  p_folder_id bigint default null,
  p_limit integer default 500
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
set statement_timeout = '4s'
as $$
  with input as (
    select btrim(coalesce(p_search, '')) as search_text,
      greatest(1, least(coalesce(p_limit, 500), 1000)) as row_limit
  ), filtered as materialized (
    select
      node.node_id,
      node.node_type,
      node.display_name,
      node.sellpia_product_code,
      node.listing_id,
      node.folder_id,
      folder.folder_name,
      node.relation_kind,
      listing.source_channel,
      listing.product_code as seller_product_code,
      listing.option_code as seller_option_code,
      (select count(*) from public.operations_hub_relation_edges edge
        where edge.parent_node_id = node.node_id and edge.is_active)::integer as child_count,
      (select count(*) from public.operations_hub_relation_edges edge
        where edge.child_node_id = node.node_id and edge.is_active)::integer as parent_count
    from public.operations_hub_relation_nodes node
    left join public.operations_hub_relation_folders folder
      on folder.folder_id = node.folder_id and folder.is_active
    left join public.operations_hub_seller_listings listing
      on listing.listing_id = node.listing_id and listing.is_active
    cross join input
    where node.is_active
      and (p_folder_id is null or node.folder_id = p_folder_id)
      and (
        input.search_text = ''
        or node.display_name ilike '%' || input.search_text || '%'
        or coalesce(node.sellpia_product_code, '') ilike '%' || input.search_text || '%'
        or coalesce(listing.product_code, '') ilike '%' || input.search_text || '%'
        or coalesce(listing.option_code, '') ilike '%' || input.search_text || '%'
      )
    order by node.display_name, node.node_id
    limit (select row_limit from input)
  ), edges as (
    select edge.edge_id, edge.parent_node_id, edge.child_node_id, edge.sort_order
    from public.operations_hub_relation_edges edge
    where edge.is_active
      and edge.parent_node_id in (select node_id from filtered)
      and edge.child_node_id in (select node_id from filtered)
  )
  select jsonb_build_object(
    'nodes', coalesce((select jsonb_agg(jsonb_build_object(
      'nodeId', filtered.node_id,
      'nodeType', filtered.node_type,
      'displayName', filtered.display_name,
      'sellpiaProductCode', filtered.sellpia_product_code,
      'listingId', filtered.listing_id,
      'folderId', filtered.folder_id,
      'folderName', filtered.folder_name,
      'relationKind', filtered.relation_kind,
      'source', filtered.source_channel,
      'sellerProductCode', filtered.seller_product_code,
      'sellerOptionCode', filtered.seller_option_code,
      'childCount', filtered.child_count,
      'parentCount', filtered.parent_count
    ) order by filtered.display_name, filtered.node_id) from filtered), '[]'::jsonb),
    'edges', coalesce((select jsonb_agg(jsonb_build_object(
      'edgeId', edges.edge_id,
      'parentNodeId', edges.parent_node_id,
      'childNodeId', edges.child_node_id,
      'sortOrder', edges.sort_order
    ) order by edges.parent_node_id, edges.sort_order, edges.child_node_id) from edges), '[]'::jsonb)
  );
$$;

create or replace function public.save_operations_hub_relation_edge(
  p_parent_node_id bigint,
  p_child_node_id bigint,
  p_sort_order integer default 100
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
set statement_timeout = '4s'
as $$
declare
  v_edge public.operations_hub_relation_edges%rowtype;
begin
  if p_parent_node_id is null or p_child_node_id is null or p_parent_node_id = p_child_node_id then
    raise exception '서로 다른 상위 노드와 하위 노드를 선택해주세요.';
  end if;
  if not exists (
    select 1 from public.operations_hub_relation_nodes node
    where node.node_id = p_parent_node_id and node.is_active
  ) or not exists (
    select 1 from public.operations_hub_relation_nodes node
    where node.node_id = p_child_node_id and node.is_active
  ) then
    raise exception '활성 상위/하위 노드를 찾을 수 없습니다.';
  end if;

  if exists (
    with recursive descendants(node_id) as (
      select p_child_node_id
      union
      select edge.child_node_id
      from public.operations_hub_relation_edges edge
      join descendants parent on parent.node_id = edge.parent_node_id
      where edge.is_active
    )
    select 1 from descendants where node_id = p_parent_node_id
  ) then
    raise exception '순환 종속관계는 만들 수 없습니다.';
  end if;

  insert into public.operations_hub_relation_edges (
    parent_node_id, child_node_id, sort_order, is_active, updated_by, updated_at
  ) values (
    p_parent_node_id, p_child_node_id,
    greatest(0, least(coalesce(p_sort_order, 100), 10000)),
    true, 'operations_hub_frontend', now()
  )
  on conflict (parent_node_id, child_node_id)
  do update set
    sort_order = excluded.sort_order,
    is_active = true,
    updated_by = 'operations_hub_frontend',
    updated_at = now()
  returning * into v_edge;

  insert into public.operations_hub_relation_events (
    event_type, before_value, after_value, changed_by
  ) values (
    'EDGE_SAVE', null, to_jsonb(v_edge), 'operations_hub_frontend'
  );

  return jsonb_build_object(
    'edgeId', v_edge.edge_id,
    'parentNodeId', v_edge.parent_node_id,
    'childNodeId', v_edge.child_node_id,
    'sortOrder', v_edge.sort_order
  );
end;
$$;

create or replace function public.remove_operations_hub_relation_edge(
  p_edge_id bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
set statement_timeout = '4s'
as $$
declare
  v_edge public.operations_hub_relation_edges%rowtype;
begin
  select edge.* into v_edge
  from public.operations_hub_relation_edges edge
  where edge.edge_id = p_edge_id and edge.is_active
  for update;
  if not found then
    raise exception '해제할 상위/하위 관계를 찾을 수 없습니다.';
  end if;

  update public.operations_hub_relation_edges edge
  set is_active = false,
      updated_by = 'operations_hub_frontend',
      updated_at = now()
  where edge.edge_id = p_edge_id;

  insert into public.operations_hub_relation_events (
    event_type, before_value, after_value, changed_by
  ) values (
    'EDGE_REMOVE', to_jsonb(v_edge), jsonb_build_object('isActive', false), 'operations_hub_frontend'
  );

  return jsonb_build_object('edgeId', p_edge_id, 'removed', true);
end;
$$;

revoke all on function public.ensure_operations_hub_sellpia_relation_node(text, bigint, text) from public;
revoke all on function public.ensure_operations_hub_seller_relation_node(text, text, text, bigint, text) from public;
revoke all on function public.list_operations_hub_relation_nodes(text, bigint, integer) from public;
revoke all on function public.save_operations_hub_relation_edge(bigint, bigint, integer) from public;
revoke all on function public.remove_operations_hub_relation_edge(bigint) from public;

grant execute on function public.ensure_operations_hub_sellpia_relation_node(text, bigint, text) to anon, authenticated;
grant execute on function public.ensure_operations_hub_seller_relation_node(text, text, text, bigint, text) to anon, authenticated;
grant execute on function public.list_operations_hub_relation_nodes(text, bigint, integer) to anon, authenticated;
grant execute on function public.save_operations_hub_relation_edge(bigint, bigint, integer) to anon, authenticated;
grant execute on function public.remove_operations_hub_relation_edge(bigint) to anon, authenticated;

comment on table public.operations_hub_relation_nodes is
  'User-managed relation nodes. Sellpia product groups, seller listings, and custom labels can each be a parent or child.';
comment on table public.operations_hub_relation_edges is
  'User-managed directed acyclic relations. Supports arbitrary depth and multiple parents without changing price or inventory calculations.';
comment on function public.save_operations_hub_relation_edge(bigint, bigint, integer) is
  'Creates or restores a user-selected parent-child edge and rejects self-links and cycles.';

notify pgrst, 'reload schema';
