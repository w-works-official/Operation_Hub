-- Add a complete, version-pinned keyset reader without changing the legacy RPC.
-- Existing relation/group/source/operator data is never migrated or deleted.
set local lock_timeout = '2s';
set local statement_timeout = '30s';

create or replace function public.list_operations_hub_relation_graph_page_v1(
  p_search text default '',
  p_folder_id bigint default null,
  p_after_node_id bigint default 0,
  p_after_edge_id bigint default 0,
  p_page_size integer default 500,
  p_expected_version text default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
set statement_timeout = '4s'
as $function$
declare
  v_result jsonb;
begin
  if p_after_node_id is null or p_after_node_id < 0
    or p_after_edge_id is null or p_after_edge_id < 0
    or p_page_size is null or p_page_size not between 1 and 1000 then
    raise exception using errcode = '22023', message = '관계 조회 페이지와 커서를 확인해주세요.';
  end if;
  if p_expected_version is not null and p_expected_version !~ '^[0-9a-f]{32}$' then
    raise exception using errcode = '22023', message = '관계 조회 버전을 확인해주세요.';
  end if;
  if (p_after_node_id > 0 or p_after_edge_id > 0) and p_expected_version is null then
    raise exception using errcode = '22023', message = '다음 관계 페이지에는 최초 조회 버전이 필요합니다.';
  end if;

  -- STABLE uses the calling statement's snapshot for the complete projection,
  -- its version/counts and both pages. Every returned UI field participates in
  -- the version; identical counts alone are not accepted as a freshness proof.
  with input as (
    select btrim(coalesce(p_search, '')) as search_text
  ), active_edges as materialized (
    select edge.edge_id, edge.parent_node_id, edge.child_node_id, edge.sort_order
    from public.operations_hub_relation_edges edge
    where edge.is_active
  ), child_counts as (
    select edge.parent_node_id as node_id, count(*)::integer as value
    from active_edges edge group by edge.parent_node_id
  ), parent_counts as (
    select edge.child_node_id as node_id, count(*)::integer as value
    from active_edges edge group by edge.child_node_id
  ), nodes as materialized (
    select node.node_id, jsonb_build_object(
      'nodeId', node.node_id,
      'nodeType', node.node_type,
      'displayName', node.display_name,
      'sellpiaProductCode', node.sellpia_product_code,
      'sellpiaSkuCode', node.sellpia_sku_code,
      'listingId', node.listing_id,
      'folderId', node.folder_id,
      'folderName', folder.folder_name,
      'relationKind', node.relation_kind,
      'source', listing.source_channel,
      'sellerProductCode', listing.product_code,
      'sellerOptionCode', listing.option_code,
      'childCount', coalesce(child_count.value, 0),
      'parentCount', coalesce(parent_count.value, 0)
    ) as payload
    from public.operations_hub_relation_nodes node
    left join public.operations_hub_relation_folders folder
      on folder.folder_id = node.folder_id and folder.is_active
    left join public.operations_hub_seller_listings listing
      on listing.listing_id = node.listing_id and listing.is_active
    left join child_counts child_count on child_count.node_id = node.node_id
    left join parent_counts parent_count on parent_count.node_id = node.node_id
    cross join input
    where node.is_active
      and (p_folder_id is null or node.folder_id = p_folder_id)
      and (
        input.search_text = ''
        or node.display_name ilike '%' || input.search_text || '%'
        or coalesce(node.sellpia_product_code, '') ilike '%' || input.search_text || '%'
        or coalesce(node.sellpia_sku_code, '') ilike '%' || input.search_text || '%'
        or coalesce(listing.product_code, '') ilike '%' || input.search_text || '%'
        or coalesce(listing.option_code, '') ilike '%' || input.search_text || '%'
      )
  ), edges as materialized (
    select edge.edge_id, jsonb_build_object(
      'edgeId', edge.edge_id,
      'parentNodeId', edge.parent_node_id,
      'childNodeId', edge.child_node_id,
      'sortOrder', edge.sort_order
    ) as payload
    from active_edges edge
    join nodes parent_node on parent_node.node_id = edge.parent_node_id
    join nodes child_node on child_node.node_id = edge.child_node_id
  ), node_proof as (
    select count(*)::integer as total,
      coalesce(string_agg(md5(node.payload::text), ',' order by node.node_id), '') as digest
    from nodes node
  ), edge_proof as (
    select count(*)::integer as total,
      coalesce(string_agg(md5(edge.payload::text), ',' order by edge.edge_id), '') as digest
    from edges edge
  ), node_page as materialized (
    select node.node_id, node.payload from nodes node
    where node.node_id > p_after_node_id order by node.node_id limit p_page_size
  ), edge_page as materialized (
    select edge.edge_id, edge.payload from edges edge
    where edge.edge_id > p_after_edge_id order by edge.edge_id limit p_page_size
  ), cursor_values as (
    select coalesce((select max(node.node_id) from node_page node), p_after_node_id) as node_id,
      coalesce((select max(edge.edge_id) from edge_page edge), p_after_edge_id) as edge_id
  )
  select jsonb_build_object(
    'contractVersion', 1,
    'version', md5(jsonb_build_object(
      'contractVersion', 1, 'search', input.search_text, 'folderId', p_folder_id,
      'nodeCount', node_proof.total, 'edgeCount', edge_proof.total,
      'nodes', node_proof.digest, 'edges', edge_proof.digest
    )::text),
    'nodeCount', node_proof.total,
    'edgeCount', edge_proof.total,
    'nodes', coalesce((select jsonb_agg(node.payload order by node.node_id) from node_page node), '[]'::jsonb),
    'edges', coalesce((select jsonb_agg(edge.payload order by edge.edge_id) from edge_page edge), '[]'::jsonb),
    'nextNodeId', cursor_values.node_id,
    'nextEdgeId', cursor_values.edge_id,
    'hasMoreNodes', exists(select 1 from nodes node where node.node_id > cursor_values.node_id),
    'hasMoreEdges', exists(select 1 from edges edge where edge.edge_id > cursor_values.edge_id)
  ) into v_result
  from input cross join node_proof cross join edge_proof cross join cursor_values;

  if p_expected_version is not null and p_expected_version <> v_result->>'version' then
    raise exception using errcode = '40001', message = '조회 중 관계가 변경되었습니다. 관계 목록을 다시 불러와주세요.';
  end if;
  return v_result;
end;
$function$;

revoke all on function public.list_operations_hub_relation_graph_page_v1(text,bigint,bigint,bigint,integer,text) from public;
grant execute on function public.list_operations_hub_relation_graph_page_v1(text,bigint,bigint,bigint,integer,text) to anon, authenticated;

-- Existing archive RPCs are SECURITY INVOKER and group SELECT is intentionally
-- operator-only. Do not widen table grants or let RLS hide a reference check.
-- Non-exposed trigger functions inspect references with owner privileges, have
-- no direct EXECUTE grants, return no group data and never write any table.
create or replace function operations_private.guard_relation_folder_archive_v1()
returns trigger
language plpgsql
stable
security definer
set search_path = pg_catalog
as $function$
begin
  if exists (
    select 1 from public.operations_hub_relation_groups group_row
    where group_row.is_active and group_row.folder_id = old.folder_id
  ) then
    raise exception using errcode = '23503', message = '활성 관계 그룹이 이 폴더를 사용 중입니다. 그룹의 폴더를 먼저 이동하거나 그룹을 보관해주세요.';
  end if;
  return new;
end;
$function$;

create or replace function operations_private.guard_relation_node_archive_v1()
returns trigger
language plpgsql
stable
security definer
set search_path = pg_catalog
as $function$
begin
  if exists (
    select 1 from public.operations_hub_relation_groups group_row
    where group_row.is_active and group_row.anchor_node_id = old.node_id
  ) or exists (
    select 1 from public.operations_hub_relation_group_memberships membership
    join public.operations_hub_relation_groups group_row on group_row.group_id = membership.group_id and group_row.is_active
    where membership.is_active and membership.node_id = old.node_id
  ) or exists (
    select 1 from public.operations_hub_relation_group_edges group_edge
    join public.operations_hub_relation_groups group_row on group_row.group_id = group_edge.group_id and group_row.is_active
    where group_edge.is_active and (group_edge.from_node_id = old.node_id or group_edge.to_node_id = old.node_id)
  ) then
    raise exception using errcode = '23503', message = '활성 관계 그룹이 이 노드를 사용 중입니다. 그룹의 대표·구성원·연결 참조를 먼저 해제하거나 그룹을 보관해주세요.';
  end if;
  return new;
end;
$function$;

revoke all on function operations_private.guard_relation_folder_archive_v1() from public, anon, authenticated, service_role;
revoke all on function operations_private.guard_relation_node_archive_v1() from public, anon, authenticated, service_role;

create or replace trigger operations_hub_relation_folder_archive_group_guard_v1
before update of is_active on public.operations_hub_relation_folders
for each row when (old.is_active and not new.is_active)
execute function operations_private.guard_relation_folder_archive_v1();

create or replace trigger operations_hub_relation_node_archive_group_guard_v1
before update of is_active on public.operations_hub_relation_nodes
for each row when (old.is_active and not new.is_active)
execute function operations_private.guard_relation_node_archive_v1();

notify pgrst, 'reload schema';

