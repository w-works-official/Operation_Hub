-- V3 keeps the V2 response contract, but changes the order of work:
--   1. build one lightweight row per seller listing;
--   2. apply source/folder/organization/search predicates;
--   3. for the common relation_type = all path, page those rows first;
--   4. classify only the selected page, then enrich only that page.
--
-- A relation-type filter still has to classify every matching candidate so its
-- count remains exact. Search and organization predicates are nevertheless
-- applied before that classification, and stock/draft/JSON enrichment always
-- remains page-scoped.
create or replace function public.list_operations_hub_listing_graph_v3(
  p_source text default 'all',
  p_relation_type text default 'all',
  p_search text default '',
  p_page integer default 1,
  p_page_size integer default 50,
  p_folder_id bigint default null,
  p_organization_scope text default 'all'
)
returns jsonb
language sql
security invoker
set search_path = public
set statement_timeout = '5s'
as $$
  with input as materialized (
    select
      p_source as source_filter,
      p_relation_type as relation_filter,
      btrim(coalesce(p_search, '')) as search_text,
      greatest(coalesce(p_page, 1), 1) as page_number,
      least(greatest(coalesce(p_page_size, 50), 1), 100) as page_size,
      p_folder_id as folder_filter,
      case
        when p_organization_scope in ('all', 'organized', 'unorganized')
          then p_organization_scope
        else 'all'
      end as organization_scope
  ), explicit_listing_base as materialized (
    select
      listing.source_channel,
      listing.product_code,
      coalesce(listing.option_code, '') as option_code,
      listing.listing_id,
      listing.product_name,
      listing.option_name,
      listing.folder_id,
      folder.folder_name,
      folder.folder_kind,
      folder.sort_order as folder_sort_order,
      listing.relation_kind,
      listing.group_name,
      count(component.component_id)::integer as component_count,
      true as is_explicit,
      max(greatest(listing.updated_at, component.updated_at)) as identity_updated_at
    from public.operations_hub_seller_listings listing
    join public.operations_hub_listing_components component
      on component.listing_id = listing.listing_id
     and component.is_active
    left join public.operations_hub_relation_folders folder
      on folder.folder_id = listing.folder_id
     and folder.is_active
    cross join input
    where listing.is_active
      and (input.source_filter = 'all' or listing.source_channel = input.source_filter)
    group by
      listing.source_channel,
      listing.product_code,
      coalesce(listing.option_code, ''),
      listing.listing_id,
      listing.product_name,
      listing.option_name,
      listing.folder_id,
      folder.folder_name,
      folder.folder_kind,
      folder.sort_order,
      listing.relation_kind,
      listing.group_name
  ), legacy_listing_base as materialized (
    select
      cache.source_channel,
      cache.product_code,
      coalesce(cache.option_code, '') as option_code,
      null::bigint as listing_id,
      max(cache.product_name) as product_name,
      max(cache.option_name) as option_name,
      null::bigint as folder_id,
      null::text as folder_name,
      null::text as folder_kind,
      null::integer as folder_sort_order,
      null::text as relation_kind,
      null::text as group_name,
      count(*)::integer as component_count,
      false as is_explicit,
      max(cache.refreshed_at) as identity_updated_at
    from public.operations_hub_listing_legacy_cache cache
    cross join input
    where (input.source_filter = 'all' or cache.source_channel = input.source_filter)
      and not exists (
        select 1
        from public.operations_hub_seller_listings explicit_listing
        where explicit_listing.is_active
          and explicit_listing.source_channel = cache.source_channel
          and explicit_listing.product_code = cache.product_code
          and coalesce(explicit_listing.option_code, '') = coalesce(cache.option_code, '')
      )
    group by cache.source_channel, cache.product_code, coalesce(cache.option_code, '')
  ), listing_base as materialized (
    select * from explicit_listing_base
    union all
    select * from legacy_listing_base
  ), component_metadata_matches as materialized (
    select sellpia.sellpia_sku_code
    from public.operations_hub_sellpia_component_live sellpia
    cross join input
    where input.search_text <> ''
      and (
        coalesce(sellpia.sellpia_own_code, '') ilike '%' || input.search_text || '%'
        or coalesce(sellpia.sellpia_product_name, '') ilike '%' || input.search_text || '%'
        or coalesce(sellpia.sellpia_option_name, '') ilike '%' || input.search_text || '%'
      )
  ), component_search_keys as materialized (
    select distinct
      listing.source_channel,
      listing.product_code,
      coalesce(listing.option_code, '') as option_code
    from public.operations_hub_seller_listings listing
    join public.operations_hub_listing_components component
      on component.listing_id = listing.listing_id
     and component.is_active
    cross join input
    where input.search_text <> ''
      and listing.is_active
      and (input.source_filter = 'all' or listing.source_channel = input.source_filter)
      and (
        component.sellpia_sku_code ilike '%' || input.search_text || '%'
        or component.sellpia_sku_code in (select sellpia_sku_code from component_metadata_matches)
      )

    union

    select distinct
      cache.source_channel,
      cache.product_code,
      coalesce(cache.option_code, '') as option_code
    from public.operations_hub_listing_legacy_cache cache
    cross join input
    where input.search_text <> ''
      and (input.source_filter = 'all' or cache.source_channel = input.source_filter)
      and (
        cache.sellpia_sku_code ilike '%' || input.search_text || '%'
        or cache.sellpia_sku_code in (select sellpia_sku_code from component_metadata_matches)
      )
      and not exists (
        select 1
        from public.operations_hub_seller_listings explicit_listing
        where explicit_listing.is_active
          and explicit_listing.source_channel = cache.source_channel
          and explicit_listing.product_code = cache.product_code
          and coalesce(explicit_listing.option_code, '') = coalesce(cache.option_code, '')
      )
  ), candidate_base as materialized (
    select listing.*
    from listing_base listing
    cross join input
    where (input.folder_filter is null or listing.folder_id = input.folder_filter)
      and (
        input.organization_scope = 'all'
        or (input.organization_scope = 'organized' and listing.folder_id is not null)
        or (input.organization_scope = 'unorganized' and listing.folder_id is null)
      )
      and (
        input.search_text = ''
        or listing.product_code ilike '%' || input.search_text || '%'
        or listing.option_code ilike '%' || input.search_text || '%'
        or coalesce(listing.product_name, '') ilike '%' || input.search_text || '%'
        or coalesce(listing.option_name, '') ilike '%' || input.search_text || '%'
        or coalesce(listing.group_name, '') ilike '%' || input.search_text || '%'
        or coalesce(listing.folder_name, '') ilike '%' || input.search_text || '%'
        or exists (
          select 1
          from component_search_keys matched
          where matched.source_channel = listing.source_channel
            and matched.product_code = listing.product_code
            and matched.option_code = listing.option_code
        )
      )
  ), all_relation_page as materialized (
    select listing.*
    from candidate_base listing
    cross join input
    where input.relation_filter = 'all'
    order by
      coalesce(listing.folder_sort_order, 2147483647),
      coalesce(listing.group_name, listing.product_name, ''),
      listing.source_channel,
      listing.product_code,
      listing.option_code
    offset (select (page_number - 1) * page_size from input)
    limit (select page_size from input)
  ), classification_input as materialized (
    select listing.*
    from all_relation_page listing

    union all

    select listing.*
    from candidate_base listing
    cross join input
    where input.relation_filter <> 'all'
  ), classification_components as materialized (
    select
      'explicit'::text as mapping_source,
      listing.listing_id,
      component.component_id,
      component.parent_component_id,
      listing.source_channel,
      listing.product_code,
      listing.option_code,
      listing.product_name,
      listing.option_name,
      listing.folder_id,
      listing.folder_name,
      listing.folder_kind,
      listing.folder_sort_order,
      listing.relation_kind,
      listing.group_name,
      component.sellpia_sku_code,
      component.component_qty,
      component.component_role,
      greatest(listing.identity_updated_at, component.updated_at) as identity_updated_at
    from classification_input listing
    join public.operations_hub_listing_components component
      on listing.is_explicit
     and component.listing_id = listing.listing_id
     and component.is_active

    union all

    select
      'legacy'::text,
      null::bigint,
      null::bigint,
      null::bigint,
      listing.source_channel,
      listing.product_code,
      listing.option_code,
      listing.product_name,
      listing.option_name,
      null::bigint,
      null::text,
      null::text,
      null::integer,
      null::text,
      null::text,
      cache.sellpia_sku_code,
      1::integer,
      'primary'::text,
      cache.refreshed_at
    from classification_input listing
    join public.operations_hub_listing_legacy_cache cache
      on not listing.is_explicit
     and cache.source_channel = listing.source_channel
     and cache.product_code = listing.product_code
     and coalesce(cache.option_code, '') = listing.option_code
  ), classification_skus as materialized (
    select distinct component.source_channel, component.sellpia_sku_code
    from classification_components component
  ), global_sku_listing_edges as materialized (
    select
      listing.source_channel,
      component.sellpia_sku_code,
      listing.product_code,
      coalesce(listing.option_code, '') as option_code
    from classification_skus candidate
    join public.operations_hub_listing_components component
      on component.sellpia_sku_code = candidate.sellpia_sku_code
     and component.is_active
    join public.operations_hub_seller_listings listing
      on listing.listing_id = component.listing_id
     and listing.is_active
     and listing.source_channel = candidate.source_channel

    union all

    select
      cache.source_channel,
      cache.sellpia_sku_code,
      cache.product_code,
      coalesce(cache.option_code, '') as option_code
    from classification_skus candidate
    join public.operations_hub_listing_legacy_cache cache
      on cache.sellpia_sku_code = candidate.sellpia_sku_code
     and cache.source_channel = candidate.source_channel
    where not exists (
      select 1
      from public.operations_hub_seller_listings explicit_listing
      where explicit_listing.is_active
        and explicit_listing.source_channel = cache.source_channel
        and explicit_listing.product_code = cache.product_code
        and coalesce(explicit_listing.option_code, '') = coalesce(cache.option_code, '')
    )
  ), sku_listing_counts as materialized (
    select
      edge.source_channel,
      edge.sellpia_sku_code,
      count(*)::integer as listing_count
    from global_sku_listing_edges edge
    group by edge.source_channel, edge.sellpia_sku_code
  ), listing_spread as materialized (
    select
      component.source_channel,
      component.product_code,
      component.option_code,
      max(counts.listing_count)::integer as max_listing_count
    from classification_components component
    join sku_listing_counts counts
      on counts.source_channel = component.source_channel
     and counts.sellpia_sku_code = component.sellpia_sku_code
    group by component.source_channel, component.product_code, component.option_code
  ), classified as materialized (
    select
      listing.*,
      spread.max_listing_count,
      case
        when listing.component_count > 1 and spread.max_listing_count > 1 then 'multi_bundle'
        when listing.component_count > 1 then 'bundle'
        when spread.max_listing_count > 1 then 'multi'
        else 'single'
      end as relation_type
    from classification_input listing
    join listing_spread spread
      using (source_channel, product_code, option_code)
  ), relation_filtered as materialized (
    select graph.*
    from classified graph
    cross join input
    where input.relation_filter <> 'all'
      and (
        (input.relation_filter = 'complex' and graph.relation_type <> 'single')
        or graph.relation_type = input.relation_filter
      )
  ), unpaged_keys as materialized (
    select graph.*
    from classified graph
    cross join input
    where input.relation_filter = 'all'

    union all

    select graph.*
    from relation_filtered graph
    cross join input
  ), paged_keys as materialized (
    select graph.*
    from unpaged_keys graph
    cross join input
    order by
      coalesce(graph.folder_sort_order, 2147483647),
      coalesce(graph.group_name, graph.product_name, ''),
      graph.source_channel,
      graph.product_code,
      graph.option_code
    offset (
      select case
        when relation_filter = 'all' then 0
        else (page_number - 1) * page_size
      end
      from input
    )
    limit (select page_size from input)
  ), paged_components as materialized (
    select
      component.*,
      sellpia.sellpia_product_name,
      sellpia.sellpia_option_name,
      sellpia.sellpia_own_code,
      sellpia.sellpia_available_stock,
      greatest(component.identity_updated_at, sellpia.updated_at) as updated_at
    from classification_components component
    join paged_keys page
      using (source_channel, product_code, option_code)
    left join public.operations_hub_sellpia_component_live sellpia
      on sellpia.sellpia_sku_code = component.sellpia_sku_code
  ), paged_rollup as materialized (
    select
      component.source_channel,
      component.product_code,
      component.option_code,
      max(component.listing_id) as listing_id,
      max(component.product_name) as product_name,
      max(component.option_name) as option_name,
      max(component.folder_id) as folder_id,
      max(component.folder_name) as folder_name,
      max(component.folder_kind) as folder_kind,
      max(component.relation_kind) as relation_kind,
      max(component.group_name) as group_name,
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
          'parentComponentId', component.parent_component_id,
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
    select rollup.*, page.max_listing_count, page.relation_type
    from paged_rollup rollup
    join paged_keys page
      using (source_channel, product_code, option_code)
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
    'rows', coalesce(
      (
        select jsonb_agg(
          to_jsonb(enriched)
          order by
            coalesce(enriched.folder_name, ''),
            coalesce(enriched.group_name, enriched.product_name, ''),
            enriched.source_channel,
            enriched.product_code,
            enriched.option_code
        )
        from enriched
      ),
      '[]'::jsonb
    ),
    'count', (
      select case
        when input.relation_filter = 'all' then (select count(*) from candidate_base)
        else (select count(*) from relation_filtered)
      end
      from input
    ),
    'page', (select page_number from input),
    'pageSize', (select page_size from input)
  );
$$;

comment on function public.list_operations_hub_listing_graph_v3(text, text, text, integer, integer, bigint, text) is
  'Lists seller listing graphs with candidate-first filtering, relation-all page-first classification, and page-scoped enrichment.';

revoke all on function public.list_operations_hub_listing_graph_v3(text, text, text, integer, integer, bigint, text) from public;
grant execute on function public.list_operations_hub_listing_graph_v3(text, text, text, integer, integer, bigint, text) to anon, authenticated;

-- Read-only rollout checks (run after deployment, not as part of this migration):
--
-- explain (analyze, buffers, timing, summary)
-- select public.list_operations_hub_listing_graph_v3(
--   'all', 'all', '', 1, 50, null, 'all'
-- );
--
-- select
--   public.list_operations_hub_listing_graph_v2('all', 'all', '', 1, 50, null, 'all') -> 'count' as v2_count,
--   public.list_operations_hub_listing_graph_v3('all', 'all', '', 1, 50, null, 'all') -> 'count' as v3_count;

notify pgrst, 'reload schema';
