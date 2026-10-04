alter table public.operations_hub_relation_nodes
  add column if not exists sellpia_sku_code text;

alter table public.operations_hub_relation_nodes
  drop constraint if exists operations_hub_relation_nodes_node_type_check;
alter table public.operations_hub_relation_nodes
  add constraint operations_hub_relation_nodes_node_type_check
  check (node_type in ('sellpia_product', 'sellpia_sku', 'seller_listing', 'custom'));

alter table public.operations_hub_relation_nodes
  drop constraint if exists operations_hub_relation_nodes_check;
alter table public.operations_hub_relation_nodes
  add constraint operations_hub_relation_nodes_check
  check (
    (node_type = 'sellpia_product'
      and nullif(btrim(sellpia_product_code), '') is not null
      and sellpia_sku_code is null
      and listing_id is null)
    or (node_type = 'sellpia_sku'
      and nullif(btrim(sellpia_product_code), '') is not null
      and nullif(btrim(sellpia_sku_code), '') is not null
      and listing_id is null)
    or (node_type = 'seller_listing'
      and sellpia_product_code is null
      and sellpia_sku_code is null
      and listing_id is not null)
    or (node_type = 'custom'
      and sellpia_product_code is null
      and sellpia_sku_code is null
      and listing_id is null)
  );

create unique index if not exists operations_hub_relation_nodes_sellpia_sku_active_idx
  on public.operations_hub_relation_nodes (lower(btrim(sellpia_sku_code)))
  where is_active and node_type = 'sellpia_sku';

create or replace function public.ensure_operations_hub_sellpia_sku_relation_node(
  p_sellpia_sku_code text,
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
  v_latest public.sellpia_stock_latest%rowtype;
  v_node public.operations_hub_relation_nodes%rowtype;
  v_name text;
begin
  p_sellpia_sku_code := btrim(coalesce(p_sellpia_sku_code, ''));
  p_relation_kind := coalesce(nullif(lower(btrim(coalesce(p_relation_kind, ''))), ''), 'individual');
  if p_sellpia_sku_code = '' then
    raise exception '셀피아 SKU를 확인해주세요.';
  end if;
  if p_relation_kind not in ('individual', 'collection', 'one_plus_one', 'set', 'custom') then
    raise exception '관계 유형을 확인해주세요.';
  end if;
  if p_folder_id is not null and not exists (
    select 1 from public.operations_hub_relation_folders folder
    where folder.folder_id = p_folder_id and folder.is_active
  ) then
    raise exception '선택한 활성 폴더를 찾을 수 없습니다.';
  end if;

  select latest.* into v_latest
  from public.sellpia_stock_latest latest
  where latest.sellpia_sku_code = p_sellpia_sku_code
  limit 1;
  if not found then
    raise exception '최신 셀피아 원본에서 SKU %를 찾을 수 없습니다.', p_sellpia_sku_code;
  end if;

  v_name := concat_ws(' · ',
    nullif(btrim(coalesce(v_latest.sellpia_product_name, '')), ''),
    nullif(btrim(coalesce(v_latest.sellpia_option_name, '')), '')
  );
  if v_name = '' then v_name := p_sellpia_sku_code; end if;

  insert into public.operations_hub_relation_nodes (
    node_type, display_name, sellpia_product_code, sellpia_sku_code,
    folder_id, relation_kind, is_active, updated_by, updated_at
  ) values (
    'sellpia_sku', v_name, v_latest.sellpia_product_code, v_latest.sellpia_sku_code,
    p_folder_id, p_relation_kind, true, 'operations_hub_frontend', now()
  )
  on conflict (lower(btrim(sellpia_sku_code)))
    where is_active and node_type = 'sellpia_sku'
  do update set
    display_name = excluded.display_name,
    sellpia_product_code = excluded.sellpia_product_code,
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
    'sellpiaSkuCode', v_node.sellpia_sku_code,
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
      node.sellpia_sku_code,
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
        or coalesce(node.sellpia_sku_code, '') ilike '%' || input.search_text || '%'
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
      'sellpiaSkuCode', filtered.sellpia_sku_code,
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

create or replace function public.apply_operations_hub_relation_board(
  p_nodes jsonb default '[]'::jsonb,
  p_edges jsonb default '[]'::jsonb,
  p_remove_edge_ids bigint[] default '{}'::bigint[]
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
set statement_timeout = '20s'
as $$
declare
  v_item jsonb;
  v_node jsonb;
  v_edge jsonb;
  v_node_map jsonb := '{}'::jsonb;
  v_client_key text;
  v_node_type text;
  v_parent_key text;
  v_child_key text;
  v_parent_node_id bigint;
  v_child_node_id bigint;
  v_remove_edge_id bigint;
  v_node_count integer := 0;
  v_saved_edge_count integer := 0;
  v_removed_edge_count integer := 0;
begin
  if jsonb_typeof(coalesce(p_nodes, '[]'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_edges, '[]'::jsonb)) <> 'array' then
    raise exception '관계 작업판 nodes와 edges는 배열이어야 합니다.';
  end if;
  if jsonb_array_length(coalesce(p_nodes, '[]'::jsonb)) > 500 then
    raise exception '한 번에 저장할 수 있는 관계 노드는 최대 500개입니다.';
  end if;
  if jsonb_array_length(coalesce(p_edges, '[]'::jsonb)) > 1000 then
    raise exception '한 번에 저장할 수 있는 관계는 최대 1000개입니다.';
  end if;

  for v_item in select value from jsonb_array_elements(coalesce(p_nodes, '[]'::jsonb))
  loop
    v_client_key := btrim(coalesce(v_item ->> 'clientKey', ''));
    if v_client_key = '' or v_node_map ? v_client_key then
      raise exception '관계 노드 clientKey가 비어 있거나 중복되었습니다.';
    end if;
    if nullif(v_item ->> 'nodeId', '') is not null then
      select jsonb_build_object(
        'nodeId', node.node_id,
        'nodeType', node.node_type,
        'displayName', node.display_name
      ) into v_node
      from public.operations_hub_relation_nodes node
      where node.node_id = (v_item ->> 'nodeId')::bigint and node.is_active;
      if v_node is null then raise exception '활성 관계 노드 %를 찾을 수 없습니다.', v_item ->> 'nodeId'; end if;
    else
      v_node_type := lower(btrim(coalesce(v_item ->> 'nodeType', '')));
      if v_node_type = 'sellpia_sku' then
        select public.ensure_operations_hub_sellpia_sku_relation_node(
          v_item ->> 'sellpiaSkuCode',
          nullif(v_item ->> 'folderId', '')::bigint,
          coalesce(nullif(v_item ->> 'relationKind', ''), 'individual')
        ) into v_node;
      elsif v_node_type = 'seller_listing' then
        select public.ensure_operations_hub_seller_relation_node(
          v_item ->> 'source',
          v_item ->> 'productCode',
          coalesce(v_item ->> 'optionCode', ''),
          nullif(v_item ->> 'folderId', '')::bigint,
          coalesce(nullif(v_item ->> 'relationKind', ''), 'custom')
        ) into v_node;
      else
        raise exception '작업판에서 허용되지 않은 신규 노드 유형입니다: %', v_node_type;
      end if;
    end if;
    v_node_map := v_node_map || jsonb_build_object(v_client_key, v_node -> 'nodeId');
    v_node_count := v_node_count + 1;
  end loop;

  for v_remove_edge_id in
    select distinct edge_id
    from unnest(coalesce(p_remove_edge_ids, '{}'::bigint[])) edge_id
  loop
    if exists (
      select 1 from public.operations_hub_relation_edges edge
      where edge.edge_id = v_remove_edge_id and edge.is_active
    ) then
      perform public.remove_operations_hub_relation_edge(v_remove_edge_id);
      v_removed_edge_count := v_removed_edge_count + 1;
    end if;
  end loop;

  for v_item in select value from jsonb_array_elements(coalesce(p_edges, '[]'::jsonb))
  loop
    v_parent_key := btrim(coalesce(v_item ->> 'parentKey', ''));
    v_child_key := btrim(coalesce(v_item ->> 'childKey', ''));
    v_parent_node_id := nullif(v_node_map ->> v_parent_key, '')::bigint;
    v_child_node_id := nullif(v_node_map ->> v_child_key, '')::bigint;
    if v_parent_node_id is null or v_child_node_id is null then
      raise exception '저장할 관계의 상위·하위 노드를 찾을 수 없습니다.';
    end if;
    select public.save_operations_hub_relation_edge(
      v_parent_node_id,
      v_child_node_id,
      greatest(0, least(coalesce(nullif(v_item ->> 'sortOrder', '')::integer, 100), 10000))
    ) into v_edge;
    v_saved_edge_count := v_saved_edge_count + 1;
  end loop;

  return jsonb_build_object(
    'nodeCount', v_node_count,
    'savedEdgeCount', v_saved_edge_count,
    'removedEdgeCount', v_removed_edge_count,
    'nodeMap', v_node_map
  );
end;
$$;

revoke all on function public.ensure_operations_hub_sellpia_sku_relation_node(text, bigint, text) from public;
revoke all on function public.apply_operations_hub_relation_board(jsonb, jsonb, bigint[]) from public;
grant execute on function public.ensure_operations_hub_sellpia_sku_relation_node(text, bigint, text) to anon, authenticated;
grant execute on function public.apply_operations_hub_relation_board(jsonb, jsonb, bigint[]) to anon, authenticated;

comment on function public.ensure_operations_hub_sellpia_sku_relation_node(text, bigint, text) is
  'Creates or refreshes one relation node for an exact Sellpia option SKU.';
comment on function public.apply_operations_hub_relation_board(jsonb, jsonb, bigint[]) is
  'Atomically resolves staged option nodes, removes replaced edges, and saves the desired acyclic relation board.';
