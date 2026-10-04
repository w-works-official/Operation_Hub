-- Keep the v4 direct-search path as the single authority for filters, sorting,
-- pagination, and the compact-cache performance characteristics. This v5
-- wrapper only expands the current direct page through the user-managed
-- Sellpia SKU relation graph when the caller explicitly opts in.
--
-- Direct search roots always remain the only items counted and paginated.
-- Related rows are display context: they never satisfy/override direct filters,
-- and their seller information is read from the related SKU's own live matrix
-- row rather than copied onto the direct SKU.

create or replace function public.load_operations_hub_matrix_filtered_v5(
  p_page integer default 1,
  p_page_size integer default 50,
  p_search text default '',
  p_search_sources text[] default array['sellpia','smartstore','makeshop','ably']::text[],
  p_status text default 'all',
  p_sort text default 'sku_asc',
  p_filter jsonb default '{"logic":"and","conditions":[]}'::jsonb,
  p_skus text[] default '{}'::text[],
  p_exclude_dependent boolean default false,
  p_include_related_sku_context boolean default false
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_direct_result jsonb;
  v_include_related boolean := coalesce(p_include_related_sku_context, false);
  v_search text := btrim(coalesce(p_search, ''));
  v_result jsonb;
begin
  -- v4 validates the advanced-filter input and performs the page-first direct
  -- lookup. Keep this call first so relationship traversal can never make a
  -- direct page larger or change which roots are selected.
  v_direct_result := public.load_operations_hub_matrix_filtered_v4(
    p_page,
    p_page_size,
    p_search,
    p_search_sources,
    p_status,
    p_sort,
    p_filter,
    p_skus,
    p_exclude_dependent
  );

  with recursive direct_rows as materialized (
    select
      item.row_json,
      item.row_order::integer as row_order,
      btrim(coalesce(item.row_json ->> 'sellpia_sku_code', '')) as root_sku
    from jsonb_array_elements(coalesce(v_direct_result -> 'rows', '[]'::jsonb))
      with ordinality as item(row_json, row_order)
    where nullif(btrim(coalesce(item.row_json ->> 'sellpia_sku_code', '')), '') is not null
  ), root_nodes as materialized (
    select
      direct_rows.row_json,
      direct_rows.row_order,
      direct_rows.root_sku,
      node.node_id,
      node.sellpia_sku_code
    from direct_rows
    join public.operations_hub_relation_nodes node
      on node.is_active
      and node.node_type = 'sellpia_sku'
      and lower(btrim(node.sellpia_sku_code)) = lower(direct_rows.root_sku)
    where v_include_related
      and v_search <> ''
  ), relation_walk (
    root_sku,
    root_order,
    current_node_id,
    related_sku,
    direction,
    depth,
    path_node_ids,
    path_skus
  ) as (
    select
      root_nodes.root_sku,
      root_nodes.row_order,
      root_nodes.node_id,
      root_nodes.sellpia_sku_code,
      'self'::text,
      0::integer,
      array[root_nodes.node_id]::bigint[],
      array[root_nodes.sellpia_sku_code]::text[]
    from root_nodes

    union all

    select
      relation_walk.root_sku,
      relation_walk.root_order,
      next_node.node_id,
      next_node.sellpia_sku_code,
      next_step.direction,
      relation_walk.depth + 1,
      relation_walk.path_node_ids || next_node.node_id,
      relation_walk.path_skus || next_node.sellpia_sku_code
    from relation_walk
    join lateral (
      select edge.child_node_id as node_id, 'descendant'::text as direction
      from public.operations_hub_relation_edges edge
      where edge.is_active
        and edge.parent_node_id = relation_walk.current_node_id
        and relation_walk.direction in ('self', 'descendant')

      union all

      select edge.parent_node_id as node_id, 'ancestor'::text as direction
      from public.operations_hub_relation_edges edge
      where edge.is_active
        and edge.child_node_id = relation_walk.current_node_id
        and relation_walk.direction in ('self', 'ancestor')
    ) next_step on true
    join public.operations_hub_relation_nodes next_node
      on next_node.node_id = next_step.node_id
      and next_node.is_active
      and next_node.node_type = 'sellpia_sku'
    where relation_walk.depth < 6
      -- Existing writes reject cycles, but this guard also protects reads from
      -- old or manually altered graph data.
      and not (next_node.node_id = any(relation_walk.path_node_ids))
  ), related_candidates as (
    select
      relation_walk.root_sku,
      relation_walk.root_order,
      relation_walk.related_sku,
      relation_walk.direction,
      relation_walk.depth,
      relation_walk.path_skus,
      row_number() over (
        partition by relation_walk.root_sku, relation_walk.related_sku
        order by
          relation_walk.depth,
          case relation_walk.direction
            when 'descendant' then 0
            when 'ancestor' then 1
            else 2
          end,
          array_to_string(relation_walk.path_skus, ' > ')
      ) as path_rank
    from relation_walk
    where relation_walk.depth > 0
  ), related_contexts as materialized (
    select
      related_candidates.root_sku,
      related_candidates.root_order,
      related_candidates.related_sku,
      related_candidates.direction,
      related_candidates.depth,
      related_candidates.path_skus
    from related_candidates
    where related_candidates.path_rank = 1
  ), related_rows as materialized (
    select
      related_contexts.root_sku,
      related_contexts.root_order,
      related_contexts.related_sku,
      related_contexts.direction,
      related_contexts.depth,
      related_contexts.path_skus,
      related_live.row_json
    from related_contexts
    cross join lateral (
      select to_jsonb(live) as row_json
      from public.operations_hub_matrix_managed_live live
      where live.sellpia_sku_code = related_contexts.related_sku
      -- Keep this correlated detail fetch from being flattened into a full
      -- managed-matrix expansion before the small relation context is known.
      offset 0
    ) related_live
  ), rendered_rows as (
    select
      direct_rows.row_order as root_order,
      0::integer as display_group,
      0::integer as depth,
      direct_rows.root_sku as related_sku,
      direct_rows.row_json || jsonb_build_object(
        'matrix_context', jsonb_build_object(
          'kind', 'direct',
          'rootSku', direct_rows.root_sku,
          'direction', 'self',
          'depth', 0,
          'pathSkus', to_jsonb(array[direct_rows.root_sku]::text[])
        )
      ) as row_json
    from direct_rows

    union all

    select
      related_rows.root_order,
      1::integer as display_group,
      related_rows.depth,
      related_rows.related_sku,
      related_rows.row_json || jsonb_build_object(
        'matrix_context', jsonb_build_object(
          'kind', 'related',
          'rootSku', related_rows.root_sku,
          'direction', related_rows.direction,
          'depth', related_rows.depth,
          'pathSkus', to_jsonb(related_rows.path_skus)
        )
      ) as row_json
    from related_rows
  ), direct_page_skus as (
    select coalesce(jsonb_agg(direct_rows.root_sku order by direct_rows.row_order), '[]'::jsonb) as value
    from direct_rows
  )
  select jsonb_build_object(
    'rows', coalesce((
      select jsonb_agg(rendered_rows.row_json order by
        rendered_rows.root_order,
        rendered_rows.display_group,
        rendered_rows.depth,
        rendered_rows.related_sku
      )
      from rendered_rows
    ), '[]'::jsonb),
    -- `count` deliberately keeps the existing v4 meaning: direct roots only.
    'count', coalesce(v_direct_result -> 'count', '0'::jsonb),
    'page', coalesce(v_direct_result -> 'page', '1'::jsonb),
    'pageSize', coalesce(v_direct_result -> 'pageSize', '50'::jsonb),
    'directCount', coalesce(v_direct_result -> 'count', '0'::jsonb),
    'relatedCount', (select count(*) from related_rows),
    'directPageSkuCodes', (select value from direct_page_skus)
  )
  into v_result;

  return v_result;
end;
$$;

comment on function public.load_operations_hub_matrix_filtered_v5(integer, integer, text, text[], text, text, jsonb, text[], boolean, boolean) is
  'v4 direct matrix page plus optional, cycle-safe Sellpia SKU ancestor/descendant display context. Direct roots alone determine filters, count, and pagination.';

revoke all on function public.load_operations_hub_matrix_filtered_v5(integer, integer, text, text[], text, text, jsonb, text[], boolean, boolean) from public;
grant execute on function public.load_operations_hub_matrix_filtered_v5(integer, integer, text, text[], text, text, jsonb, text[], boolean, boolean) to anon, authenticated;

notify pgrst, 'reload schema';
