-- Keep interactive Sellpia edits visible immediately without rebuilding the
-- 121 MB matrix export cache after every saved cell.
create or replace view public.operations_hub_matrix_cached
with (security_invoker = true)
as
with live_matrix as (
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
    coalesce(live_drafts.payload, '{}'::jsonb) as seller_drafts_json
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
)
select
  matrix.*,
  case when smartstore_policy.is_active then operations_private.calculate_operations_hub_policy_price(
    matrix.sellpia_sale_price, smartstore_policy.replace_price, smartstore_policy.modify_type,
    smartstore_policy.modify_value, smartstore_policy.min_price, smartstore_policy.max_price,
    smartstore_policy.rounding_unit, smartstore_policy.rounding_mode
  ) end as smartstore_policy_price,
  coalesce(smartstore_policy.is_active, false) as smartstore_policy_active,
  smartstore_policy.policy_name as smartstore_policy_name,
  case when makeshop_policy.is_active then operations_private.calculate_operations_hub_policy_price(
    matrix.sellpia_sale_price, makeshop_policy.replace_price, makeshop_policy.modify_type,
    makeshop_policy.modify_value, makeshop_policy.min_price, makeshop_policy.max_price,
    makeshop_policy.rounding_unit, makeshop_policy.rounding_mode
  ) end as makeshop_policy_price,
  coalesce(makeshop_policy.is_active, false) as makeshop_policy_active,
  makeshop_policy.policy_name as makeshop_policy_name,
  case when ably_policy.is_active then operations_private.calculate_operations_hub_policy_price(
    matrix.sellpia_sale_price, ably_policy.replace_price, ably_policy.modify_type,
    ably_policy.modify_value, ably_policy.min_price, ably_policy.max_price,
    ably_policy.rounding_unit, ably_policy.rounding_mode
  ) end as ably_policy_price,
  coalesce(ably_policy.is_active, false) as ably_policy_active,
  ably_policy.policy_name as ably_policy_name
from live_matrix matrix
left join public.operations_hub_price_policies smartstore_policy
  on smartstore_policy.source_channel = 'smartstore'
left join public.operations_hub_price_policies makeshop_policy
  on makeshop_policy.source_channel = 'makeshop'
left join public.operations_hub_price_policies ably_policy
  on ably_policy.source_channel = 'ably';

comment on view public.operations_hub_matrix_cached is
  'Fast matrix cache with immediate Sellpia override and active seller-draft overlays. Interactive edits do not wait for a full materialized-view refresh.';

revoke all on public.operations_hub_matrix_cached from public;
grant select on public.operations_hub_matrix_cached to anon, authenticated;

create or replace function operations_private.refresh_operations_hub_matrix_export_cache_if_stale(
  p_actor text default 'operations_hub_export_cache'
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, operations_private, catalog
as $$
declare
  v_actor text := coalesce(nullif(btrim(p_actor), ''), 'operations_hub_export_cache');
  v_cache_refreshed_at timestamptz;
  v_source_changed_at timestamptz;
begin
  if v_actor !~ '^[0-9A-Za-z_.:@-]{3,120}$' then
    raise exception 'Invalid cache refresh actor.';
  end if;

  select max(cache_refreshed_at)
  into v_cache_refreshed_at
  from operations_private.operations_hub_matrix_export_cache;

  -- Sellpia cell overrides and seller change drafts are intentionally omitted:
  -- public.operations_hub_matrix_cached overlays both sources at read time.
  select greatest(
    coalesce((select core_refreshed_at from operations_private.operations_hub_matrix_refresh_state where singleton), '-infinity'::timestamptz),
    coalesce((select max(coalesce(completed_at, created_at)) from public.seller_inventory_snapshots where upload_status = 'ready'), '-infinity'::timestamptz),
    coalesce((select max(updated_at) from public.operations_hub_manual_links), '-infinity'::timestamptz),
    coalesce((select max(updated_at) from public.operations_hub_seller_listing_overrides), '-infinity'::timestamptz),
    coalesce((select max(updated_at) from catalog.sellpia_product_attributes), '-infinity'::timestamptz),
    coalesce((select max(updated_at) from public.sellpia_tag_assignments), '-infinity'::timestamptz),
    coalesce((select max(updated_at) from public.product_tags), '-infinity'::timestamptz)
  ) into v_source_changed_at;

  if v_cache_refreshed_at is not null and v_source_changed_at <= v_cache_refreshed_at then
    return jsonb_build_object(
      'status', 'skipped',
      'reason', 'cache_is_current',
      'refreshed_at', v_cache_refreshed_at,
      'source_changed_at', v_source_changed_at,
      'refreshed_by', v_actor
    );
  end if;

  return operations_private.refresh_operations_hub_matrix_export_cache(v_actor);
end;
$$;

revoke all on function operations_private.refresh_operations_hub_matrix_export_cache_if_stale(text)
  from public, anon, authenticated;

notify pgrst, 'reload schema';
