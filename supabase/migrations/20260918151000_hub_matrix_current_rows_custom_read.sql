CREATE OR REPLACE FUNCTION public.load_operations_hub_matrix_metadata_batch_v1(p_skus text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public'
 SET jit TO 'off'
AS $function$
declare
  v_skus text[];
  result jsonb;
begin
  select coalesce(array_agg(distinct btrim(sku)), '{}'::text[])
  into v_skus
  from unnest(coalesce(p_skus, '{}'::text[])) sku
  where nullif(btrim(sku), '') is not null;

  if coalesce(cardinality(v_skus), 0) > 200 then
    raise exception '한 번에 최대 200개 SKU의 부가정보만 조회할 수 있습니다.';
  end if;

  EXECUTE $query$ SELECT jsonb_build_object(
    'inbound_costs', coalesce((
      select jsonb_agg(to_jsonb(detail) order by detail.sellpia_sku_code)
      from public.operations_hub_inbound_cost_live detail
      where detail.sellpia_sku_code = any($1)
    ), '[]'::jsonb),
    'operational_details', coalesce((
      select jsonb_agg(to_jsonb(detail) order by detail.sellpia_sku_code)
      from public.operations_hub_sku_operational_live detail
      where detail.sellpia_sku_code = any($1)
    ), '[]'::jsonb),
    'product_link_drafts', coalesce((
      select jsonb_agg(to_jsonb(draft) order by draft.sellpia_sku_code, draft.source_channel)
      from public.operations_hub_product_link_drafts draft
      where draft.sellpia_sku_code = any($1)
    ), '[]'::jsonb),
    'manual_links', coalesce((
      select jsonb_agg(to_jsonb(link) order by link.sellpia_sku_code, link.source_channel)
      from public.operations_hub_manual_links link
      where link.sellpia_sku_code = any($1)
    ), '[]'::jsonb),
    'profiles', coalesce((
      select jsonb_agg(to_jsonb(profile) order by profile.sellpia_sku_code)
      from public.operations_hub_product_profiles profile
      where profile.sellpia_sku_code = any($1)
    ), '[]'::jsonb),
    'link_badges', coalesce((
      select jsonb_agg(to_jsonb(badge) order by badge.sellpia_sku_code, badge.source_channel)
      from public.get_operations_hub_sku_link_badges_v2($1) badge
    ), '[]'::jsonb),
    'seller_price_components', coalesce((
      select jsonb_agg(to_jsonb(component) order by component.sellpia_sku_code, component.source_channel)
      from public.load_operations_hub_seller_price_components_batch_v1($1) component
    ), '[]'::jsonb),
    'seller_drafts', coalesce((
      select jsonb_agg(to_jsonb(draft) order by draft.updated_at desc, draft.change_id desc)
      from (
        select distinct on (queue.sellpia_sku_code, queue.source_channel, queue.field_key)
          queue.change_id,
          queue.sellpia_sku_code,
          queue.source_channel,
          queue.field_key,
          queue.before_value,
          queue.after_value,
          queue.status,
          queue.updated_at,
          queue.price_base_before,
          queue.price_base_after,
          queue.price_option_before,
          queue.price_option_after,
          queue.price_final_before,
          queue.price_final_after,
          queue.option_price_source,
          queue.price_rule_set_id,
          queue.price_discounted_base_before,
          queue.price_discounted_base_after,
          queue.base_price_source,
          queue.price_calculation_version,
          queue.pricing_input_mode,
          queue.source_snapshot_id,
          queue.source_discount_fingerprint,
          queue.price_discount_terms_before,
          queue.price_discount_terms_after
        from public.operations_hub_change_queue queue
        where queue.sellpia_sku_code = any($1)
          and queue.source_channel in ('smartstore', 'makeshop', 'ably')
          and queue.field_key in ('sellpia_current_stock', 'sellpia_sale_price')
          and queue.status in ('pending', 'validated', 'failed')
        order by
          queue.sellpia_sku_code,
          queue.source_channel,
          queue.field_key,
          queue.updated_at desc,
          queue.change_id desc
      ) draft
    ), '[]'::jsonb),
    'price_rule_assignments', coalesce((
      select jsonb_agg(to_jsonb(assignment) order by assignment.sellpia_sku_code, assignment.source_channel)
      from public.operations_hub_price_rule_assignments assignment
      where assignment.target_type = 'sellpia_sku'
        and assignment.is_active
        and assignment.sellpia_sku_code = any($1)
    ), '[]'::jsonb),
    'price_rule_sets', coalesce((
      select jsonb_agg(to_jsonb(rule_set) order by rule_set.price_rule_set_id)
      from public.operations_hub_price_rule_sets rule_set
      where rule_set.is_active
        and rule_set.price_rule_set_id in (
          select assignment.price_rule_set_id
          from public.operations_hub_price_rule_assignments assignment
          where assignment.target_type = 'sellpia_sku'
            and assignment.is_active
            and assignment.sellpia_sku_code = any($1)
        )
    ), '[]'::jsonb),
    'link_suppressions', coalesce((
      select jsonb_agg(to_jsonb(suppression) order by suppression.sellpia_sku_code, suppression.source_channel)
      from public.operations_hub_link_suppressions suppression
      where suppression.sellpia_sku_code = any($1)
    ), '[]'::jsonb)
  ) $query$ INTO result USING v_skus;
  return result;
end;
$function$;

CREATE FUNCTION public.load_operations_hub_matrix_rows_batch_v1(p_skus text[]) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path TO 'pg_catalog' SET jit TO 'off' AS $function$
declare result jsonb;begin
if p_skus is null or cardinality(p_skus) not between 1 and 200 then raise exception 'invalid bounded Matrix row request';end if;
EXECUTE $query$ SELECT coalesce(jsonb_agg(to_jsonb(m) order by m.sellpia_sku_code),'[]'::jsonb) FROM (SELECT sellpia_sku_code,own_code,image_url,display_name,smartstore_name,smartstore_option_name,smartstore_product_code,smartstore_option_code,smartstore_match_tier,smartstore_match_score,smartstore_listing_count,smartstore_name_is_draft,smartstore_sale_status,makeshop_name,makeshop_option_name,makeshop_product_code,makeshop_option_code,makeshop_match_tier,makeshop_match_score,makeshop_listing_count,makeshop_name_is_draft,makeshop_sale_status,ably_name,ably_option_name,ably_product_code,ably_option_code,ably_match_tier,ably_match_score,ably_listing_count,ably_name_is_draft,ably_sale_status,updated_at,sellpia_product_name,sellpia_option_name,sellpia_own_code,sellpia_current_stock,sellpia_available_stock,sellpia_safety_stock,sellpia_sale_price,sellpia_inventory_at,smartstore_stock,smartstore_price,smartstore_policy_price,smartstore_policy_active,smartstore_policy_name,smartstore_inventory_at,makeshop_stock,makeshop_price,makeshop_policy_price,makeshop_policy_active,makeshop_policy_name,makeshop_inventory_at,ably_stock,ably_price,ably_policy_price,ably_policy_active,ably_policy_name,ably_inventory_at,overall_status,sellpia_override_image_url,sellpia_override_updated_at,sellpia_source_sale_price,sellpia_source_stock,sellpia_source_updated_at,system_base_price,system_stock,system_price_version,system_stock_version,system_price_updated_at,system_stock_updated_at,system_updated_at,is_dependent_combination_sku FROM public.operations_hub_matrix_managed_live WHERE sellpia_sku_code=ANY($1)) m $query$ INTO result USING p_skus;return result;end $function$;
REVOKE ALL ON FUNCTION public.load_operations_hub_matrix_rows_batch_v1(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.load_operations_hub_matrix_rows_batch_v1(text[]) TO anon,authenticated,service_role;
CREATE FUNCTION public.load_operations_hub_price_basis_batch_v1(p_skus text[]) RETURNS jsonb LANGUAGE sql STABLE SET search_path TO 'pg_catalog' SET jit TO 'off' SET plan_cache_mode TO 'force_custom_plan' AS $function$ SELECT public.load_operations_hub_price_basis_v1(p_skus) $function$;
REVOKE ALL ON FUNCTION public.load_operations_hub_price_basis_batch_v1(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.load_operations_hub_price_basis_batch_v1(text[]) TO anon,authenticated,service_role;
CREATE FUNCTION public.hub_matrix_calculation_results_batch_v1(p_session_token text,p_skus text[],p_scope text DEFAULT NULL,p_fields text[] DEFAULT NULL,p_after_key jsonb DEFAULT NULL,p_limit integer DEFAULT 1000) RETURNS jsonb LANGUAGE sql STABLE SET search_path TO 'pg_catalog' SET jit TO 'off' SET plan_cache_mode TO 'force_custom_plan' AS $function$ SELECT public.hub_calculation_results_read_v1(p_session_token,p_skus,p_scope,p_fields,p_after_key,p_limit) $function$;
REVOKE ALL ON FUNCTION public.hub_matrix_calculation_results_batch_v1(text,text[],text,text[],jsonb,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hub_matrix_calculation_results_batch_v1(text,text[],text,text[],jsonb,integer) TO anon,authenticated,service_role;
