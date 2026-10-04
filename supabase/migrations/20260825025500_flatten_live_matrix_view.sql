-- Keep the SKU index visible to the planner. A CTE/subquery wrapper around the
-- live overlay forced a full materialized-cache scan before LIMIT.
create or replace view public.operations_hub_matrix_cached
with (security_invoker = true)
as
select
  matrix.sellpia_sku_code,
  matrix.own_code,
  matrix.image_url,
  matrix.display_name,
  matrix.smartstore_name,
  matrix.smartstore_option_name,
  matrix.smartstore_product_code,
  matrix.smartstore_option_code,
  matrix.smartstore_match_tier,
  matrix.smartstore_match_score,
  matrix.smartstore_listing_count,
  matrix.smartstore_name_is_draft,
  matrix.makeshop_name,
  matrix.makeshop_option_name,
  matrix.makeshop_product_code,
  matrix.makeshop_option_code,
  matrix.makeshop_match_tier,
  matrix.makeshop_match_score,
  matrix.makeshop_listing_count,
  matrix.makeshop_name_is_draft,
  matrix.ably_name,
  matrix.ably_option_name,
  matrix.ably_product_code,
  matrix.ably_option_code,
  matrix.ably_match_tier,
  matrix.ably_match_score,
  matrix.ably_listing_count,
  matrix.ably_name_is_draft,
  matrix.updated_at,
  coalesce(nullif(btrim(sellpia_override.product_name), ''), matrix.sellpia_product_name) as sellpia_product_name,
  coalesce(nullif(btrim(sellpia_override.option_name), ''), matrix.sellpia_option_name) as sellpia_option_name,
  coalesce(nullif(btrim(sellpia_override.own_code), ''), matrix.sellpia_own_code) as sellpia_own_code,
  coalesce(sellpia_override.current_stock, matrix.sellpia_current_stock) as sellpia_current_stock,
  case
    when sellpia_override.current_stock is not null then sellpia_override.current_stock
    else matrix.sellpia_available_stock
  end as sellpia_available_stock,
  matrix.sellpia_safety_stock,
  coalesce(sellpia_override.sale_price, matrix.sellpia_sale_price) as sellpia_sale_price,
  matrix.sellpia_inventory_at,
  matrix.smartstore_stock,
  matrix.smartstore_price,
  matrix.smartstore_sale_status,
  matrix.smartstore_inventory_at,
  matrix.makeshop_stock,
  matrix.makeshop_price,
  matrix.makeshop_sale_status,
  matrix.makeshop_inventory_at,
  matrix.ably_stock,
  matrix.ably_price,
  matrix.ably_sale_status,
  matrix.ably_inventory_at,
  matrix.overall_status,
  case
    when sellpia_override.sellpia_sku_code is null then matrix.sellpia_override_image_url
    when sellpia_override.image_storage_path is null then null::text
    else 'https://bpgvqmtsjgegnrdzmpep.supabase.co/storage/v1/object/public/product-images/' || sellpia_override.image_storage_path
  end as sellpia_override_image_url,
  coalesce(sellpia_override.updated_at, matrix.sellpia_override_updated_at) as sellpia_override_updated_at,
  matrix.cache_refreshed_at,
  matrix.profile_json,
  coalesce(live_drafts.payload, '{}'::jsonb) as seller_drafts_json,
  case when smartstore_policy.is_active then operations_private.calculate_operations_hub_policy_price(
    coalesce(sellpia_override.sale_price, matrix.sellpia_sale_price), smartstore_policy.replace_price,
    smartstore_policy.modify_type, smartstore_policy.modify_value, smartstore_policy.min_price,
    smartstore_policy.max_price, smartstore_policy.rounding_unit, smartstore_policy.rounding_mode
  ) end as smartstore_policy_price,
  coalesce(smartstore_policy.is_active, false) as smartstore_policy_active,
  smartstore_policy.policy_name as smartstore_policy_name,
  case when makeshop_policy.is_active then operations_private.calculate_operations_hub_policy_price(
    coalesce(sellpia_override.sale_price, matrix.sellpia_sale_price), makeshop_policy.replace_price,
    makeshop_policy.modify_type, makeshop_policy.modify_value, makeshop_policy.min_price,
    makeshop_policy.max_price, makeshop_policy.rounding_unit, makeshop_policy.rounding_mode
  ) end as makeshop_policy_price,
  coalesce(makeshop_policy.is_active, false) as makeshop_policy_active,
  makeshop_policy.policy_name as makeshop_policy_name,
  case when ably_policy.is_active then operations_private.calculate_operations_hub_policy_price(
    coalesce(sellpia_override.sale_price, matrix.sellpia_sale_price), ably_policy.replace_price,
    ably_policy.modify_type, ably_policy.modify_value, ably_policy.min_price,
    ably_policy.max_price, ably_policy.rounding_unit, ably_policy.rounding_mode
  ) end as ably_policy_price,
  coalesce(ably_policy.is_active, false) as ably_policy_active,
  ably_policy.policy_name as ably_policy_name
from operations_private.operations_hub_matrix_export_cache matrix
left join lateral (
  select override_row.*
  from public.operations_hub_sellpia_overrides override_row
  where override_row.sellpia_sku_code = matrix.sellpia_sku_code
  offset 0
) sellpia_override on true
left join lateral (
  select jsonb_object_agg(
    draft.source_channel || ':' || draft.field_key,
    to_jsonb(draft.*)
  ) as payload
  from public.operations_hub_active_seller_drafts draft
  where draft.sellpia_sku_code = matrix.sellpia_sku_code
) live_drafts on true
left join public.operations_hub_price_policies smartstore_policy
  on smartstore_policy.source_channel = 'smartstore'
left join public.operations_hub_price_policies makeshop_policy
  on makeshop_policy.source_channel = 'makeshop'
left join public.operations_hub_price_policies ably_policy
  on ably_policy.source_channel = 'ably';

notify pgrst, 'reload schema';
