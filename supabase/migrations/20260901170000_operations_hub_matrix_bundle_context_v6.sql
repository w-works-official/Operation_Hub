-- Expand searched matrix roots with all saved relationship families while
-- preserving the v4 direct-page contract. Generic relation edges, canonical
-- Sellpia BOM edges, and seller-only BOM co-components remain separate data
-- sources; this function only projects them into one read-only display context.
--
-- Direct roots alone determine filters, count, sorting, and pagination. Related
-- rows never become direct matches and never copy seller fields from another SKU.

create or replace function public.load_operations_hub_matrix_filtered_v6(
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
  ), relation_root_nodes as materialized (
    select
      direct_rows.row_order,
      direct_rows.root_sku,
      node.node_id,
      node.sellpia_sku_code,
      node.relation_kind
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
    path_skus,
    relationship_type
  ) as (
    select
      relation_root_nodes.root_sku,
      relation_root_nodes.row_order,
      relation_root_nodes.node_id,
      relation_root_nodes.sellpia_sku_code,
      'self'::text,
      0::integer,
      array[relation_root_nodes.node_id]::bigint[],
      array[relation_root_nodes.sellpia_sku_code]::text[],
      relation_root_nodes.relation_kind
    from relation_root_nodes

    union all

    select
      relation_walk.root_sku,
      relation_walk.root_order,
      next_node.node_id,
      next_node.sellpia_sku_code,
      next_step.direction,
      relation_walk.depth + 1,
      relation_walk.path_node_ids || next_node.node_id,
      relation_walk.path_skus || next_node.sellpia_sku_code,
      next_node.relation_kind
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
      and not (next_node.node_id = any(relation_walk.path_node_ids))
  ), canonical_bundle_walk (
    root_sku,
    root_order,
    current_sku,
    related_sku,
    direction,
    depth,
    path_skus,
    relationship_type,
    relationship_details
  ) as (
    select
      direct_rows.root_sku,
      direct_rows.row_order,
      direct_rows.root_sku,
      direct_rows.root_sku,
      'self'::text,
      0::integer,
      array[direct_rows.root_sku]::text[],
      'bundle'::text,
      '{}'::jsonb
    from direct_rows
    where v_include_related
      and v_search <> ''

    union all

    select
      canonical_bundle_walk.root_sku,
      canonical_bundle_walk.root_order,
      next_step.next_sku,
      next_step.next_sku,
      next_step.direction,
      canonical_bundle_walk.depth + 1,
      canonical_bundle_walk.path_skus || next_step.next_sku,
      'bundle'::text,
      next_step.relationship_details
    from canonical_bundle_walk
    join lateral (
      select
        component.component_sku_code as next_sku,
        'bundle_component'::text as direction,
        jsonb_build_object(
          'bundleId', definition.bundle_id,
          'bundleSkuCode', definition.bundle_sku_code,
          'componentSkuCode', component.component_sku_code,
          'componentQty', component.component_qty,
          'componentRole', component.component_role,
          'sortOrder', component.sort_order
        ) as relationship_details
      from public.operations_hub_bundle_definitions definition
      join public.operations_hub_bundle_components component
        on component.bundle_id = definition.bundle_id
        and component.is_active
      where definition.is_active
        and definition.bundle_sku_code = canonical_bundle_walk.current_sku
        and canonical_bundle_walk.direction in ('self', 'bundle_component')

      union all

      select
        definition.bundle_sku_code as next_sku,
        'bundle_parent'::text as direction,
        jsonb_build_object(
          'bundleId', definition.bundle_id,
          'bundleSkuCode', definition.bundle_sku_code,
          'componentSkuCode', component.component_sku_code,
          'componentQty', component.component_qty,
          'componentRole', component.component_role,
          'sortOrder', component.sort_order
        ) as relationship_details
      from public.operations_hub_bundle_components component
      join public.operations_hub_bundle_definitions definition
        on definition.bundle_id = component.bundle_id
        and definition.is_active
      where component.is_active
        and component.component_sku_code = canonical_bundle_walk.current_sku
        and canonical_bundle_walk.direction in ('self', 'bundle_parent')
    ) next_step on true
    where canonical_bundle_walk.depth < 6
      and not (next_step.next_sku = any(canonical_bundle_walk.path_skus))
  ), seller_bundle_candidates as materialized (
    select
      direct_rows.root_sku,
      direct_rows.row_order as root_order,
      peer_component.sellpia_sku_code as related_sku,
      'seller_bundle_sibling'::text as direction,
      1::integer as depth,
      array[direct_rows.root_sku, peer_component.sellpia_sku_code]::text[] as path_skus,
      listing.relation_kind as relationship_type,
      jsonb_build_object(
        'listingId', listing.listing_id,
        'sourceChannel', listing.source_channel,
        'productCode', listing.product_code,
        'optionCode', listing.option_code,
        'componentQty', peer_component.component_qty,
        'componentRole', peer_component.component_role
      ) as relationship_details
    from direct_rows
    join public.operations_hub_listing_components root_component
      on root_component.is_active
      and root_component.sellpia_sku_code = direct_rows.root_sku
    join public.operations_hub_seller_listings listing
      on listing.listing_id = root_component.listing_id
      and listing.is_active
      and listing.relation_kind in ('one_plus_one', 'set')
    join public.operations_hub_listing_components peer_component
      on peer_component.listing_id = listing.listing_id
      and peer_component.is_active
      and peer_component.sellpia_sku_code <> direct_rows.root_sku
    where v_include_related
      and v_search <> ''
  ), all_related_candidates as (
    select
      relation_walk.root_sku,
      relation_walk.root_order,
      relation_walk.related_sku,
      relation_walk.direction,
      relation_walk.depth,
      relation_walk.path_skus,
      'relation'::text as relationship_family,
      coalesce(nullif(relation_walk.relationship_type, ''), 'custom') as relationship_type,
      '{}'::jsonb as relationship_details
    from relation_walk
    where relation_walk.depth > 0

    union all

    select
      canonical_bundle_walk.root_sku,
      canonical_bundle_walk.root_order,
      canonical_bundle_walk.related_sku,
      canonical_bundle_walk.direction,
      canonical_bundle_walk.depth,
      canonical_bundle_walk.path_skus,
      'canonical_bundle'::text as relationship_family,
      canonical_bundle_walk.relationship_type,
      canonical_bundle_walk.relationship_details
    from canonical_bundle_walk
    where canonical_bundle_walk.depth > 0

    union all

    select
      seller_bundle_candidates.root_sku,
      seller_bundle_candidates.root_order,
      seller_bundle_candidates.related_sku,
      seller_bundle_candidates.direction,
      seller_bundle_candidates.depth,
      seller_bundle_candidates.path_skus,
      'seller_bundle'::text as relationship_family,
      seller_bundle_candidates.relationship_type,
      seller_bundle_candidates.relationship_details
    from seller_bundle_candidates
  ), ranked_related_candidates as (
    select
      all_related_candidates.*,
      row_number() over (
        partition by all_related_candidates.root_sku, all_related_candidates.related_sku
        order by
          all_related_candidates.depth,
          case all_related_candidates.relationship_family
            when 'canonical_bundle' then 0
            when 'seller_bundle' then 1
            else 2
          end,
          array_to_string(all_related_candidates.path_skus, ' > '),
          all_related_candidates.relationship_type
      ) as path_rank
    from all_related_candidates
  ), related_contexts as materialized (
    select
      ranked.root_sku,
      ranked.root_order,
      ranked.related_sku,
      ranked.direction,
      ranked.depth,
      ranked.path_skus,
      ranked.relationship_family,
      ranked.relationship_type,
      ranked.relationship_details
    from ranked_related_candidates ranked
    where ranked.path_rank = 1
  ), related_rows as materialized (
    select
      related_contexts.*,
      related_live.row_json
    from related_contexts
    cross join lateral (
      select to_jsonb(live) as row_json
      from public.operations_hub_matrix_managed_live live
      where live.sellpia_sku_code = related_contexts.related_sku
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
          'pathSkus', to_jsonb(array[direct_rows.root_sku]::text[]),
          'relationshipFamily', 'direct',
          'relationshipType', 'direct'
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
          'pathSkus', to_jsonb(related_rows.path_skus),
          'relationshipFamily', related_rows.relationship_family,
          'relationshipType', related_rows.relationship_type,
          'relationshipDetails', related_rows.relationship_details
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
    'count', coalesce(v_direct_result -> 'count', '0'::jsonb),
    'page', coalesce(v_direct_result -> 'page', '1'::jsonb),
    'pageSize', coalesce(v_direct_result -> 'pageSize', '50'::jsonb),
    'directCount', coalesce(v_direct_result -> 'count', '0'::jsonb),
    'relatedCount', (select count(*) from related_rows),
    'directPageSkuCodes', (select value from direct_page_skus)
  ) into v_result;

  return v_result;
end;
$$;

comment on function public.load_operations_hub_matrix_filtered_v6(integer, integer, text, text[], text, text, jsonb, text[], boolean, boolean) is
  'v4 direct matrix page plus optional, deduplicated generic-relation, canonical-bundle, and seller-bundle Sellpia SKU display context. Direct roots alone determine filters, count, and pagination.';

revoke all on function public.load_operations_hub_matrix_filtered_v6(integer, integer, text, text[], text, text, jsonb, text[], boolean, boolean) from public;
grant execute on function public.load_operations_hub_matrix_filtered_v6(integer, integer, text, text[], text, text, jsonb, text[], boolean, boolean) to anon, authenticated;

notify pgrst, 'reload schema';
