create or replace view public.operations_hub_listing_graph_live
with (security_invoker = true)
as
with component_rows as materialized (
  select * from public.operations_hub_listing_component_projection
), listing_rollup as (
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
  from component_rows component
  group by component.source_channel, component.product_code, component.option_code
), sku_listing_counts as (
  select
    component.source_channel,
    component.sellpia_sku_code,
    count(distinct (component.product_code, component.option_code))::integer as listing_count
  from component_rows component
  group by component.source_channel, component.sellpia_sku_code
), listing_spread as (
  select
    component.source_channel,
    component.product_code,
    component.option_code,
    max(counts.listing_count)::integer as max_listing_count
  from component_rows component
  join sku_listing_counts counts
    on counts.source_channel = component.source_channel
   and counts.sellpia_sku_code = component.sellpia_sku_code
  group by component.source_channel, component.product_code, component.option_code
)
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
 and spread.option_code = rollup.option_code;
