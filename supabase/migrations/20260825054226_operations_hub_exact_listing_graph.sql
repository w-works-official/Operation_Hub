-- The focused matrix link manager needs one exact seller listing. Do not route
-- this read through the catalog-wide relation classifier used by the workspace.
create or replace function public.get_operations_hub_listing_graph(
  p_source text,
  p_product_code text,
  p_option_code text default ''
)
returns jsonb
language sql
security invoker
set search_path = public
as $$
  with input as materialized (
    select
      btrim(coalesce(p_source, '')) as source_channel,
      btrim(coalesce(p_product_code, '')) as product_code,
      btrim(coalesce(p_option_code, '')) as option_code
  ), explicit_listing as materialized (
    select listing.*
    from public.operations_hub_seller_listings listing
    join input on input.source_channel = listing.source_channel
              and input.product_code = listing.product_code
              and input.option_code = coalesce(listing.option_code, '')
    where listing.is_active
    limit 1
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
    from explicit_listing listing
    join public.operations_hub_listing_components component
      on component.listing_id = listing.listing_id
     and component.is_active

    union all

    select
      'legacy'::text as mapping_source,
      null::bigint as listing_id,
      null::bigint as component_id,
      cache.source_channel,
      cache.product_code,
      coalesce(cache.option_code, '') as option_code,
      cache.product_name,
      cache.option_name,
      cache.sellpia_sku_code,
      1::integer as component_qty,
      'primary'::text as component_role,
      cache.refreshed_at as identity_updated_at
    from public.operations_hub_listing_legacy_cache cache
    join input on input.source_channel = cache.source_channel
              and input.product_code = cache.product_code
              and input.option_code = coalesce(cache.option_code, '')
    where not exists (select 1 from explicit_listing)
  ), enriched_components as materialized (
    select
      edge.*,
      sellpia.sellpia_product_name,
      sellpia.sellpia_option_name,
      sellpia.sellpia_own_code,
      sellpia.sellpia_available_stock,
      greatest(edge.identity_updated_at, sellpia.updated_at) as updated_at
    from identity_edges edge
    left join public.operations_hub_sellpia_component_live sellpia
      on sellpia.sellpia_sku_code = edge.sellpia_sku_code
  ), rollup as materialized (
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
    from enriched_components component
    group by component.source_channel, component.product_code, component.option_code
  ), exact_graph as materialized (
    select
      rollup.*,
      case when rollup.component_count > 1 then 'bundle' else 'single' end as relation_type,
      1::integer as max_listing_count,
      seller.stock as seller_stock,
      seller.snapshot_completed_at as seller_inventory_at,
      draft.change_id as inventory_change_id,
      draft.status as inventory_draft_status,
      draft.after_value #>> '{}' as inventory_draft_stock
    from rollup
    left join lateral (
      select latest.stock, latest.snapshot_completed_at
      from public.seller_inventory_latest latest
      where latest.source_channel = rollup.source_channel
        and latest.product_code = rollup.product_code
        and latest.option_code = rollup.option_code
      order by latest.snapshot_completed_at desc nulls last
      limit 1
    ) seller on true
    left join lateral (
      select queue.change_id, queue.status, queue.after_value
      from public.operations_hub_change_queue queue
      where queue.source_channel = rollup.source_channel
        and queue.seller_product_code = rollup.product_code
        and coalesce(queue.seller_option_code, '') = rollup.option_code
        and queue.field_key = 'sellpia_current_stock'
        and queue.status in ('pending', 'validated', 'failed')
      order by queue.change_id desc
      limit 1
    ) draft on true
  )
  select to_jsonb(exact_graph)
  from exact_graph;
$$;

comment on function public.get_operations_hub_listing_graph(text, text, text) is
  'Returns one exact seller listing graph for focused link management without catalog-wide classification.';

revoke all on function public.get_operations_hub_listing_graph(text, text, text) from public;
grant execute on function public.get_operations_hub_listing_graph(text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';

