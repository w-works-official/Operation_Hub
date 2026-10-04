-- Keep the listing graph response contract, but defer Sellpia stock enrichment and
-- component JSON aggregation until after the requested seller-listing page is known.
-- The legacy implementation expanded the full compatibility graph before LIMIT,
-- which made the default complex-list request vulnerable to statement_timeout.

create or replace function public.list_operations_hub_listing_graph(
  p_source text default 'all',
  p_relation_type text default 'all',
  p_search text default '',
  p_page integer default 1,
  p_page_size integer default 50
)
returns jsonb
language sql
security invoker
set search_path = public
as $$
  with input as materialized (
    select
      p_source as source_filter,
      p_relation_type as relation_filter,
      btrim(coalesce(p_search, '')) as search_text,
      greatest(coalesce(p_page, 1), 1) as page_number,
      least(greatest(coalesce(p_page_size, 50), 1), 100) as page_size
  ), identity_edges as materialized (
    select
      'explicit'::text as mapping_source,
      listing.listing_id,
      component.component_id,
      listing.source_channel,
      listing.product_code,
      coalesce(listing.option_code, '') as option_code,
      listing.product_name,
      listing.option_name,
      component.sellpia_sku_code,
      component.component_qty,
      component.component_role,
      greatest(listing.updated_at, component.updated_at) as identity_updated_at
    from public.operations_hub_seller_listings listing
    join public.operations_hub_listing_components component
      on component.listing_id = listing.listing_id
     and component.is_active
    cross join input
    where listing.is_active
      and (input.source_filter = 'all' or listing.source_channel = input.source_filter)

    union all

    select
      'legacy'::text as mapping_source,
      null::bigint as listing_id,
      null::bigint as component_id,
      cache.source_channel,
      cache.product_code,
      cache.option_code,
      cache.product_name,
      cache.option_name,
      cache.sellpia_sku_code,
      1::integer as component_qty,
      'primary'::text as component_role,
      cache.refreshed_at as identity_updated_at
    from public.operations_hub_listing_legacy_cache cache
    cross join input
    where (input.source_filter = 'all' or cache.source_channel = input.source_filter)
      and not exists (
        select 1
        from public.operations_hub_seller_listings explicit_listing
        where explicit_listing.is_active
          and explicit_listing.source_channel = cache.source_channel
          and explicit_listing.product_code = cache.product_code
          and explicit_listing.option_code = cache.option_code
      )
  ), listing_rollup as materialized (
    select
      edge.source_channel,
      edge.product_code,
      edge.option_code,
      max(edge.listing_id) as listing_id,
      max(edge.product_name) as product_name,
      max(edge.option_name) as option_name,
      count(*)::integer as component_count,
      bool_or(edge.mapping_source = 'explicit') as is_explicit,
      max(edge.identity_updated_at) as identity_updated_at
    from identity_edges edge
    group by edge.source_channel, edge.product_code, edge.option_code
  ), sku_listing_counts as materialized (
    select
      edge.source_channel,
      edge.sellpia_sku_code,
      count(distinct (edge.product_code, edge.option_code))::integer as listing_count
    from identity_edges edge
    group by edge.source_channel, edge.sellpia_sku_code
  ), listing_spread as materialized (
    select
      edge.source_channel,
      edge.product_code,
      edge.option_code,
      max(counts.listing_count)::integer as max_listing_count
    from identity_edges edge
    join sku_listing_counts counts
      on counts.source_channel = edge.source_channel
     and counts.sellpia_sku_code = edge.sellpia_sku_code
    group by edge.source_channel, edge.product_code, edge.option_code
  ), classified as materialized (
    select
      rollup.*,
      spread.max_listing_count,
      case
        when rollup.component_count > 1 and spread.max_listing_count > 1 then 'multi_bundle'
        when rollup.component_count > 1 then 'bundle'
        when spread.max_listing_count > 1 then 'multi'
        else 'single'
      end as relation_type
    from listing_rollup rollup
    join listing_spread spread
      on spread.source_channel = rollup.source_channel
     and spread.product_code = rollup.product_code
     and spread.option_code = rollup.option_code
  ), component_metadata_matches as not materialized (
    select sellpia.sellpia_sku_code
    from public.operations_hub_sellpia_component_live sellpia
    cross join input
    where input.search_text <> ''
      and (
        coalesce(sellpia.sellpia_own_code, '') ilike '%' || input.search_text || '%'
        or coalesce(sellpia.sellpia_product_name, '') ilike '%' || input.search_text || '%'
        or coalesce(sellpia.sellpia_option_name, '') ilike '%' || input.search_text || '%'
      )
  ), component_search_matches as materialized (
    select distinct
      edge.source_channel,
      edge.product_code,
      edge.option_code
    from identity_edges edge
    cross join input
    where input.search_text <> ''
      and (
        edge.sellpia_sku_code ilike '%' || input.search_text || '%'
        or edge.sellpia_sku_code in (select matched.sellpia_sku_code from component_metadata_matches matched)
      )
  ), filtered as materialized (
    select graph.*
    from classified graph
    cross join input
    where (
        input.relation_filter = 'all'
        or (input.relation_filter = 'complex' and graph.relation_type <> 'single')
        or graph.relation_type = input.relation_filter
      )
      and (
        input.search_text = ''
        or graph.product_code ilike '%' || input.search_text || '%'
        or graph.option_code ilike '%' || input.search_text || '%'
        or coalesce(graph.product_name, '') ilike '%' || input.search_text || '%'
        or coalesce(graph.option_name, '') ilike '%' || input.search_text || '%'
        or exists (
          select 1
          from component_search_matches matched
          where matched.source_channel = graph.source_channel
            and matched.product_code = graph.product_code
            and matched.option_code = graph.option_code
        )
      )
  ), paged_keys as materialized (
    select graph.*
    from filtered graph
    cross join input
    order by graph.source_channel, graph.product_code, graph.option_code
    offset (select (page_number - 1) * page_size from input)
    limit (select page_size from input)
  ), paged_components as materialized (
    select
      edge.mapping_source,
      edge.listing_id,
      edge.component_id,
      edge.source_channel,
      edge.product_code,
      edge.option_code,
      edge.product_name,
      edge.option_name,
      edge.sellpia_sku_code,
      edge.component_qty,
      edge.component_role,
      sellpia.sellpia_product_name,
      sellpia.sellpia_option_name,
      sellpia.sellpia_own_code,
      sellpia.sellpia_available_stock,
      greatest(edge.identity_updated_at, sellpia.updated_at) as updated_at
    from identity_edges edge
    join paged_keys page
      on page.source_channel = edge.source_channel
     and page.product_code = edge.product_code
     and page.option_code = edge.option_code
    left join public.operations_hub_sellpia_component_live sellpia
      on sellpia.sellpia_sku_code = edge.sellpia_sku_code
  ), paged_rollup as materialized (
    select
      component.source_channel,
      component.product_code,
      component.option_code,
      max(component.listing_id) as listing_id,
      max(component.product_name) as product_name,
      max(component.option_name) as option_name,
      count(*)::integer as component_count,
      case
        when count(component.sellpia_available_stock) = count(*) then
          min(floor(component.sellpia_available_stock::numeric / component.component_qty))::integer
        else null
      end as calculated_stock,
      bool_or(component.mapping_source = 'explicit') as is_explicit,
      max(component.updated_at) as updated_at,
      jsonb_agg(
        jsonb_build_object(
          'componentId', component.component_id,
          'sku', component.sellpia_sku_code,
          'qty', component.component_qty,
          'role', component.component_role,
          'mappingSource', component.mapping_source,
          'productName', component.sellpia_product_name,
          'optionName', component.sellpia_option_name,
          'ownCode', component.sellpia_own_code,
          'availableStock', component.sellpia_available_stock
        ) order by component.sellpia_sku_code
      ) as components
    from paged_components component
    group by component.source_channel, component.product_code, component.option_code
  ), paged_graph as materialized (
    select
      rollup.source_channel,
      rollup.product_code,
      rollup.option_code,
      rollup.listing_id,
      rollup.product_name,
      rollup.option_name,
      rollup.component_count,
      rollup.calculated_stock,
      rollup.is_explicit,
      rollup.updated_at,
      rollup.components,
      page.max_listing_count,
      page.relation_type
    from paged_rollup rollup
    join paged_keys page
      on page.source_channel = rollup.source_channel
     and page.product_code = rollup.product_code
     and page.option_code = rollup.option_code
  ), enriched as materialized (
    select
      graph.*,
      seller.stock as seller_stock,
      seller.snapshot_completed_at as seller_inventory_at,
      draft.change_id as inventory_change_id,
      draft.status as inventory_draft_status,
      draft.after_value #>> '{}' as inventory_draft_stock
    from paged_graph graph
    left join lateral (
      select latest.stock, latest.snapshot_completed_at
      from public.seller_inventory_latest latest
      where latest.source_channel = graph.source_channel
        and latest.product_code = graph.product_code
        and latest.option_code = graph.option_code
      order by latest.snapshot_completed_at desc nulls last
      limit 1
    ) seller on true
    left join lateral (
      select queue.change_id, queue.status, queue.after_value
      from public.operations_hub_change_queue queue
      where queue.source_channel = graph.source_channel
        and queue.seller_product_code = graph.product_code
        and coalesce(queue.seller_option_code, '') = graph.option_code
        and queue.field_key = 'sellpia_current_stock'
        and queue.status in ('pending', 'validated', 'failed')
      order by queue.change_id desc
      limit 1
    ) draft on true
  )
  select jsonb_build_object(
    'rows', coalesce((
      select jsonb_agg(
        to_jsonb(enriched)
        order by enriched.source_channel, enriched.product_code, enriched.option_code
      )
      from enriched
    ), '[]'::jsonb),
    'count', (select count(*) from filtered),
    'page', (select page_number from input),
    'pageSize', (select page_size from input)
  );
$$;

comment on function public.list_operations_hub_listing_graph(text, text, text, integer, integer) is
  'Lists seller listing relationships with identity-first classification and page-scoped Sellpia stock enrichment.';

revoke all on function public.list_operations_hub_listing_graph(text, text, text, integer, integer) from public;
grant execute on function public.list_operations_hub_listing_graph(text, text, text, integer, integer) to anon, authenticated;

notify pgrst, 'reload schema';
