-- Automatic price rules are product-wide because seller base price and native
-- discount settings are product-level fields. If any option in a seller product
-- was absent from the price-analysis evidence, clear the production assignment
-- from every SKU in that product instead of leaving a partial rule state.

with product_assignment_state as (
  select 'smartstore'::text source_channel,
         matrix.smartstore_product_code product_code,
         count(distinct matrix.sellpia_sku_code) total_skus,
         count(distinct assignment.sellpia_sku_code) filter (
           where assignment.is_active and rule_set.set_code like 'PROD_SET_%'
         ) assigned_skus,
         count(distinct assignment.price_rule_set_id) filter (
           where assignment.is_active and rule_set.set_code like 'PROD_SET_%'
         ) assigned_rules
  from public.operations_hub_matrix_cached matrix
  left join public.operations_hub_price_rule_assignments assignment
    on assignment.source_channel='smartstore'
   and assignment.sellpia_sku_code=matrix.sellpia_sku_code
   and assignment.is_active
  left join public.operations_hub_price_rule_sets rule_set
    on rule_set.price_rule_set_id=assignment.price_rule_set_id
  where matrix.smartstore_product_code is not null
  group by matrix.smartstore_product_code
  union all
  select 'makeshop', matrix.makeshop_product_code,
         count(distinct matrix.sellpia_sku_code),
         count(distinct assignment.sellpia_sku_code) filter (
           where assignment.is_active and rule_set.set_code like 'PROD_SET_%'
         ),
         count(distinct assignment.price_rule_set_id) filter (
           where assignment.is_active and rule_set.set_code like 'PROD_SET_%'
         )
  from public.operations_hub_matrix_cached matrix
  left join public.operations_hub_price_rule_assignments assignment
    on assignment.source_channel='makeshop'
   and assignment.sellpia_sku_code=matrix.sellpia_sku_code
   and assignment.is_active
  left join public.operations_hub_price_rule_sets rule_set
    on rule_set.price_rule_set_id=assignment.price_rule_set_id
  where matrix.makeshop_product_code is not null
  group by matrix.makeshop_product_code
), invalid_products as (
  select source_channel, product_code
  from product_assignment_state
  where assigned_skus>0
    and (assigned_skus<>total_skus or assigned_rules<>1)
), target_assignments as (
  select distinct assignment.price_rule_assignment_id
  from invalid_products invalid
  join public.operations_hub_matrix_cached matrix
    on case invalid.source_channel
      when 'smartstore' then matrix.smartstore_product_code
      when 'makeshop' then matrix.makeshop_product_code
    end=invalid.product_code
  join public.operations_hub_price_rule_assignments assignment
    on assignment.source_channel=invalid.source_channel
   and assignment.sellpia_sku_code=matrix.sellpia_sku_code
   and assignment.is_active
  join public.operations_hub_price_rule_sets rule_set
    on rule_set.price_rule_set_id=assignment.price_rule_set_id
   and rule_set.set_code like 'PROD_SET_%'
)
update public.operations_hub_price_rule_assignments assignment
set is_active=false,
    updated_by='production-price-analysis-partial-cleanup-20260824',
    updated_at=now()
where assignment.price_rule_assignment_id in (
  select price_rule_assignment_id from target_assignments
);

notify pgrst, 'reload schema';
