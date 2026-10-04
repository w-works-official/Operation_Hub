-- Read-only Matrix bootstrap v2.
-- Keep the full client-side dataset contract while avoiding the large cached
-- profile/draft JSON columns and the repeated count/version work of v1.

create or replace function public.hub_matrix_grid_manifest_v2(
  p_session_token text
) returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog'
set statement_timeout to '8s'
set jit to 'off'
as $function$
declare
  v_started_at timestamptz := clock_timestamp();
  v_total integer;
  v_dataset_version timestamptz;
begin
  perform operations_private.require_operations_hub_operator_session(p_session_token);

  select count(*)::integer, max(cache_refreshed_at)
    into v_total, v_dataset_version
  from operations_private.operations_hub_matrix_export_cache;

  return jsonb_build_object(
    'total', v_total,
    'dataset_version', v_dataset_version,
    'recommended_chunk_size', 3000,
    'max_chunk_size', 5000,
    'server_ms', round(extract(epoch from (clock_timestamp() - v_started_at)) * 1000, 2)
  );
end;
$function$;

create or replace function public.hub_matrix_grid_feed_v2(
  p_session_token text,
  p_dataset_version timestamptz,
  p_after_sku text default null,
  p_limit integer default 3000
) returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog'
set statement_timeout to '12s'
set jit to 'off'
set plan_cache_mode to 'force_custom_plan'
as $function$
declare
  v_started_at timestamptz := clock_timestamp();
  v_current_version timestamptz;
  v_rows jsonb;
  v_loaded integer;
  v_next_sku text;
  v_has_more boolean;
begin
  perform operations_private.require_operations_hub_operator_session(p_session_token);

  if p_limit is null or p_limit not between 250 and 5000 then
    raise exception 'Matrix Grid feed limit은 250~5,000이어야 합니다.';
  end if;
  if p_after_sku is not null and length(p_after_sku) > 128 then
    raise exception 'Matrix Grid feed cursor가 올바르지 않습니다.';
  end if;
  if p_dataset_version is null then
    raise exception 'Matrix Grid feed dataset version이 필요합니다.';
  end if;

  select max(cache_refreshed_at)
    into v_current_version
  from operations_private.operations_hub_matrix_export_cache;

  if v_current_version is distinct from p_dataset_version then
    raise exception using
      errcode = '40001',
      message = 'Matrix Grid feed cache version이 변경되었습니다. DB 새로고침 후 다시 시도해주세요.';
  end if;

  with latest_sellpia_snapshot as materialized (
    select snapshot.snapshot_id
    from public.sellpia_stock_snapshots snapshot
    where snapshot.upload_status = 'ready'
    order by snapshot.completed_at desc nulls last, snapshot.created_at desc
    limit 1
  ),
  latest_seller_snapshot as materialized (
    select distinct on (snapshot.source_channel)
      snapshot.source_channel,
      snapshot.snapshot_id
    from public.seller_inventory_snapshots snapshot
    where snapshot.upload_status = 'ready'
      and snapshot.source_channel in ('smartstore','makeshop','ably')
    order by snapshot.source_channel,
      snapshot.completed_at desc nulls last,
      snapshot.created_at desc
  ),
  page_plus as materialized (
    select
      cache.sellpia_sku_code, cache.own_code, cache.image_url, cache.display_name,
      cache.smartstore_name, cache.smartstore_option_name,
      cache.smartstore_product_code, cache.smartstore_option_code,
      cache.smartstore_match_tier, cache.smartstore_match_score,
      cache.smartstore_listing_count, cache.smartstore_name_is_draft,
      cache.makeshop_name, cache.makeshop_option_name,
      cache.makeshop_product_code, cache.makeshop_option_code,
      cache.makeshop_match_tier, cache.makeshop_match_score,
      cache.makeshop_listing_count, cache.makeshop_name_is_draft,
      cache.ably_name, cache.ably_option_name,
      cache.ably_product_code, cache.ably_option_code,
      cache.ably_match_tier, cache.ably_match_score,
      cache.ably_listing_count, cache.ably_name_is_draft,
      cache.updated_at,
      cache.sellpia_product_name, cache.sellpia_option_name, cache.sellpia_own_code,
      cache.sellpia_current_stock, cache.sellpia_available_stock,
      cache.sellpia_safety_stock, cache.sellpia_sale_price, cache.sellpia_inventory_at,
      cache.smartstore_stock, cache.smartstore_price,
      cache.smartstore_sale_status, cache.smartstore_inventory_at,
      cache.makeshop_stock, cache.makeshop_price,
      cache.makeshop_sale_status, cache.makeshop_inventory_at,
      cache.ably_stock, cache.ably_price,
      cache.ably_sale_status, cache.ably_inventory_at,
      cache.overall_status,
      cache.sellpia_override_image_url, cache.sellpia_override_updated_at
    from operations_private.operations_hub_matrix_export_cache cache
    where p_after_sku is null or cache.sellpia_sku_code > p_after_sku
    order by cache.sellpia_sku_code
    limit p_limit + 1
  ),
  page as materialized (
    select * from page_plus order by sellpia_sku_code limit p_limit
  ),
  page_keys as materialized (
    select sellpia_sku_code from page
  ),
  page_source as materialized (
    select page.*,
      source.sellpia_product_code,
      source.purchase_price as sellpia_source_purchase_price,
      source.order_unit as sellpia_source_order_unit,
      source.minimum_order_unit as sellpia_source_minimum_order_unit
    from page
    left join latest_sellpia_snapshot snapshot on true
    left join public.sellpia_stock_snapshot_rows source
      on source.snapshot_id = snapshot.snapshot_id
     and source.sellpia_sku_code = page.sellpia_sku_code
  ),
  suppression_rows as materialized (
    select suppression.source_channel, suppression.sellpia_sku_code,
      suppression.product_code, suppression.option_code, suppression.reason
    from public.operations_hub_link_suppressions suppression
    join page_keys using (sellpia_sku_code)
  ),
  suppressions as materialized (
    select suppression.sellpia_sku_code,
      jsonb_agg(jsonb_build_object(
        'source_channel', suppression.source_channel,
        'product_code', suppression.product_code,
        'option_code', suppression.option_code,
        'reason', suppression.reason
      ) order by suppression.source_channel, suppression.product_code, suppression.option_code) payload
    from suppression_rows suppression
    group by suppression.sellpia_sku_code
  ),
  effective as materialized (
    select page_source.*,
      exists (
        select 1 from suppression_rows suppression
        where suppression.source_channel = 'smartstore'
          and suppression.sellpia_sku_code = page_source.sellpia_sku_code
          and suppression.product_code = coalesce(page_source.smartstore_product_code, '')
          and suppression.option_code = coalesce(page_source.smartstore_option_code, '')
      ) smartstore_suppressed,
      exists (
        select 1 from suppression_rows suppression
        where suppression.source_channel = 'makeshop'
          and suppression.sellpia_sku_code = page_source.sellpia_sku_code
          and suppression.product_code = coalesce(page_source.makeshop_product_code, '')
          and suppression.option_code = coalesce(page_source.makeshop_option_code, '')
      ) makeshop_suppressed,
      exists (
        select 1 from suppression_rows suppression
        where suppression.source_channel = 'ably'
          and suppression.sellpia_sku_code = page_source.sellpia_sku_code
          and suppression.product_code = coalesce(page_source.ably_product_code, '')
          and suppression.option_code = coalesce(page_source.ably_option_code, '')
      ) ably_suppressed
    from page_source
  ),
  tag_rows as materialized (
    select effective.sellpia_sku_code, assignment.tag_scope,
      tag.tag_id, tag.tag_name, tag.tag_color, tag.tag_group, tag.display_order
    from effective
    join public.sellpia_tag_assignments assignment
      on assignment.is_active
     and (
       (assignment.tag_scope = 'option' and assignment.sellpia_sku_code = effective.sellpia_sku_code)
       or (assignment.tag_scope = 'product' and assignment.sellpia_product_code = effective.sellpia_product_code)
     )
    join public.product_tags tag
      on tag.tag_id = assignment.tag_id
     and tag.is_active
  ),
  tags as materialized (
    select tag.sellpia_sku_code,
      jsonb_agg(jsonb_build_object(
        'tag_id', tag.tag_id,
        'tag_name', tag.tag_name,
        'tag_color', tag.tag_color,
        'tag_group', tag.tag_group
      ) order by tag.display_order, tag.tag_name) filter (where tag.tag_scope = 'product') product_tags,
      jsonb_agg(jsonb_build_object(
        'tag_id', tag.tag_id,
        'tag_name', tag.tag_name,
        'tag_color', tag.tag_color,
        'tag_group', tag.tag_group
      ) order by tag.display_order, tag.tag_name) filter (where tag.tag_scope = 'option') sku_tags,
      concat_ws(' · ',
        string_agg(tag.tag_name, ' · ' order by tag.display_order, tag.tag_name) filter (where tag.tag_scope = 'product'),
        string_agg(tag.tag_name, ' · ' order by tag.display_order, tag.tag_name) filter (where tag.tag_scope = 'option')
      ) tag_summary,
      to_jsonb(array_agg(distinct tag.tag_id)) tag_ids
    from tag_rows tag
    group by tag.sellpia_sku_code
  ),
  active_draft_rows as materialized (
    select distinct on (queue.sellpia_sku_code, queue.source_channel, queue.field_key)
      queue.change_id, queue.sellpia_sku_code, queue.source_channel, queue.field_key,
      queue.before_value, queue.after_value, queue.status, queue.updated_at,
      queue.price_base_before, queue.price_base_after,
      queue.price_discounted_base_before, queue.price_discounted_base_after,
      queue.price_option_before, queue.price_option_after,
      queue.price_final_before, queue.price_final_after,
      queue.price_discount_terms_before, queue.price_discount_terms_after,
      queue.option_price_source, queue.price_rule_set_id
    from public.operations_hub_change_queue queue
    join page_keys using (sellpia_sku_code)
    where queue.source_channel in ('smartstore','makeshop','ably')
      and queue.field_key in ('sellpia_current_stock','sellpia_sale_price')
      and queue.status in ('pending','validated','failed','processing')
    order by queue.sellpia_sku_code, queue.source_channel, queue.field_key,
      queue.updated_at desc, queue.change_id desc
  ),
  active_drafts as materialized (
    select draft.sellpia_sku_code,
      jsonb_object_agg(
        draft.source_channel || ':' || draft.field_key,
        jsonb_strip_nulls(jsonb_build_object(
          'change_id', draft.change_id,
          'sellpia_sku_code', draft.sellpia_sku_code,
          'source_channel', draft.source_channel,
          'field_key', draft.field_key,
          'before_value', draft.before_value,
          'after_value', draft.after_value,
          'status', draft.status,
          'updated_at', draft.updated_at,
          'price_base_before', draft.price_base_before,
          'price_base_after', draft.price_base_after,
          'price_discounted_base_before', draft.price_discounted_base_before,
          'price_discounted_base_after', draft.price_discounted_base_after,
          'price_option_before', draft.price_option_before,
          'price_option_after', draft.price_option_after,
          'price_final_before', draft.price_final_before,
          'price_final_after', draft.price_final_after,
          'price_discount_terms_before', draft.price_discount_terms_before,
          'price_discount_terms_after', draft.price_discount_terms_after,
          'option_price_source', draft.option_price_source,
          'price_rule_set_id', draft.price_rule_set_id
        ))
      ) payload
    from active_draft_rows draft
    group by draft.sellpia_sku_code
  ),
  product_link_drafts as materialized (
    select draft.sellpia_sku_code,
      jsonb_object_agg(draft.source_channel, jsonb_build_object(
        'source_channel', draft.source_channel,
        'sellpia_sku_code', draft.sellpia_sku_code,
        'product_code', draft.product_code,
        'product_name', draft.product_name,
        'updated_at', draft.updated_at
      )) payload
    from public.operations_hub_product_link_drafts draft
    join page_keys using (sellpia_sku_code)
    where draft.source_channel in ('smartstore','makeshop','ably')
    group by draft.sellpia_sku_code
  ),
  active_rule_fields as materialized (
    select assignment.sku, assignment.scope, assignment.target_field,
      calculated.value, calculated.status, calculated.error,
      calculated.generation_id, calculated.calculated_at,
      jsonb_agg(jsonb_build_object(
        'id', rule.id,
        'name', rule.name,
        'tag_id', rule.tag_id,
        'tag_name', coalesce(tag.tag_name, rule.name),
        'version', rule.version,
        'output_field', rule.target_field,
        'scope', rule.scope
      ) order by rule.name) active_rules,
      array_agg(distinct coalesce(tag.tag_name, rule.name)
        order by coalesce(tag.tag_name, rule.name)) rule_names,
      bool_and(
        calculated.status = 'calculated'
        and coalesce(calculated.rule_versions, '[]'::jsonb) @> jsonb_build_array(
          jsonb_build_object('id', rule.id, 'version', rule.version)
        )
      ) proof_current
    from operations_private.hub_rule_assignments assignment
    join page_keys on page_keys.sellpia_sku_code = assignment.sku
    join operations_private.hub_rules rule
      on rule.id = assignment.rule_id
     and rule.target_field = assignment.target_field
     and rule.scope = assignment.scope
     and rule.is_active
    left join public.product_tags tag
      on tag.tag_id = rule.tag_id and tag.is_active
    left join operations_private.hub_calculated_results calculated
      on calculated.sku = assignment.sku
     and calculated.scope = assignment.scope
     and calculated.field = assignment.target_field
    where rule.tag_id is null or tag.tag_id is not null
    group by assignment.sku, assignment.scope, assignment.target_field,
      calculated.value, calculated.status, calculated.error,
      calculated.generation_id, calculated.calculated_at
  ),
  internal_prices as materialized (
    select field.sku,
      jsonb_object_agg(field.target_field, jsonb_strip_nulls(jsonb_build_object(
        'value', field.value,
        'error', case when field.status = 'error' then field.error
          when not coalesce(field.proof_current, false) then '활성 Rule 기준 재계산 필요' end,
        'ruleNames', to_jsonb(field.rule_names),
        'activeOutputRules', field.active_rules,
        'generationId', field.generation_id,
        'calculatedAt', field.calculated_at,
        'stale', not coalesce(field.proof_current, false),
        'provenanceMismatch', not coalesce(field.proof_current, false)
      ))) payload,
      bool_or(not coalesce(field.proof_current, false)) stale
    from active_rule_fields field
    where field.scope = ''
      and field.target_field in ('actual_inbound_cost','basis_sku_price','calculated_base_price')
    group by field.sku
  ),
  platform_prices_by_source as materialized (
    select field.sku, field.scope,
      jsonb_object_agg(field.target_field, field.value) values_by_field,
      array_agg(distinct rule_name order by rule_name) rule_names,
      bool_and(coalesce(field.proof_current, false)) proof_current,
      string_agg(distinct coalesce(field.error, ''), ' / ')
        filter (where nullif(field.error, '') is not null) errors
    from active_rule_fields field
    cross join lateral unnest(field.rule_names) rule_name
    where field.scope in ('smartstore','makeshop','ably')
      and field.target_field like 'platform_%'
    group by field.sku, field.scope
  ),
  platform_prices as materialized (
    select price.sku,
      jsonb_object_agg(price.scope, jsonb_strip_nulls(jsonb_build_object(
        'platformBase', price.values_by_field -> 'platform_registration_price',
        'discounted', price.values_by_field -> 'platform_discount_price',
        'platformOption', price.values_by_field -> 'platform_option_price',
        'platformFinal', price.values_by_field -> 'platform_final_price',
        'platformTerms', '[]'::jsonb,
        'ruleNames', to_jsonb(price.rule_names),
        'error', case when price.proof_current then null
          else coalesce(nullif(price.errors, ''), '활성 Rule 기준 재계산 필요') end
      ))) payload,
      jsonb_object_agg(price.scope, true) active_payload,
      jsonb_object_agg(price.scope, jsonb_build_object(
        'set_name', array_to_string(price.rule_names, ' · '),
        'color', '#1558c0'
      )) assignment_payload,
      bool_or(not price.proof_current) stale
    from platform_prices_by_source price
    group by price.sku
  ),
  mapped_seller_rows as materialized (
    select effective.sellpia_sku_code,
      source.source_channel, source.product_code, source.option_code
    from effective
    cross join lateral (values
      ('smartstore'::text,
        case when effective.smartstore_suppressed then null else effective.smartstore_product_code end,
        case when effective.smartstore_suppressed then null else coalesce(effective.smartstore_option_code, '') end),
      ('makeshop'::text,
        case when effective.makeshop_suppressed then null else effective.makeshop_product_code end,
        case when effective.makeshop_suppressed then null else coalesce(effective.makeshop_option_code, '') end),
      ('ably'::text,
        case when effective.ably_suppressed then null else effective.ably_product_code end,
        case when effective.ably_suppressed then null else coalesce(effective.ably_option_code, '') end)
    ) source(source_channel, product_code, option_code)
    where nullif(btrim(source.product_code), '') is not null
  ),
  seller_price_components as materialized (
    select mapped.sellpia_sku_code,
      jsonb_object_agg(mapped.source_channel, jsonb_strip_nulls(jsonb_build_object(
        'seller_product_code', mapped.product_code,
        'seller_option_code', mapped.option_code,
        'source_base_price', coalesce(source_row.base_price, source_row.price),
        'source_discounted_base_price', coalesce(source_row.discounted_base_price, source_row.base_price, source_row.price),
        'source_option_price', coalesce(source_row.option_price, 0),
        'source_final_price', coalesce(source_row.final_price, source_row.price),
        'source_discount_terms', coalesce(source_row.discount_terms, '[]'::jsonb),
        'source_discount_calculation_status', coalesce(source_row.discount_calculation_status, 'none')
      ))) payload
    from mapped_seller_rows mapped
    left join latest_seller_snapshot snapshot
      on snapshot.source_channel = mapped.source_channel
    left join public.seller_inventory_snapshot_rows source_row
      on source_row.snapshot_id = snapshot.snapshot_id
     and source_row.product_code = mapped.product_code
     and coalesce(source_row.option_code, '') = mapped.option_code
    group by mapped.sellpia_sku_code
  ),
  dependent_skus as materialized (
    select distinct component.sellpia_sku_code
    from public.operations_hub_listing_components component
    join page_keys using (sellpia_sku_code)
    where component.is_active
      and component.parent_component_id is not null
  ),
  link_badge_rows as materialized (
    select badge.*
    from public.get_operations_hub_sku_link_badges_v2(
      (select array_agg(page_keys.sellpia_sku_code order by page_keys.sellpia_sku_code) from page_keys)
    ) badge
  ),
  link_badges as materialized (
    select badge.sellpia_sku_code,
      jsonb_object_agg(badge.source_channel, jsonb_build_object(
        'source_channel', badge.source_channel,
        'listing_count', badge.listing_count,
        'max_component_count', badge.max_component_count,
        'relation_type', badge.relation_type
      )) payload
    from link_badge_rows badge
    join effective on effective.sellpia_sku_code = badge.sellpia_sku_code
    where (badge.source_channel = 'smartstore' and not effective.smartstore_suppressed and effective.smartstore_product_code is not null)
       or (badge.source_channel = 'makeshop' and not effective.makeshop_suppressed and effective.makeshop_product_code is not null)
       or (badge.source_channel = 'ably' and not effective.ably_suppressed and effective.ably_product_code is not null)
    group by badge.sellpia_sku_code
  ),
  assembled as materialized (
    select effective.sellpia_sku_code,
      (
        to_jsonb(effective)
          - 'smartstore_suppressed'
          - 'makeshop_suppressed'
          - 'ably_suppressed'
        || jsonb_build_object(
          'sellpia_product_name', coalesce(nullif(btrim(override_row.product_name), ''), effective.sellpia_product_name),
          'sellpia_option_name', coalesce(nullif(btrim(override_row.option_name), ''), effective.sellpia_option_name),
          'sellpia_own_code', coalesce(nullif(btrim(override_row.own_code), ''), effective.sellpia_own_code),
          'sellpia_current_stock', coalesce(override_row.current_stock, effective.sellpia_current_stock),
          'sellpia_available_stock', case when override_row.current_stock is not null then override_row.current_stock else effective.sellpia_available_stock end,
          'sellpia_sale_price', coalesce(override_row.sale_price, effective.sellpia_sale_price),
          'sellpia_override_image_url', case
            when override_row.sellpia_sku_code is null then effective.sellpia_override_image_url
            when override_row.image_storage_path is null then null
            else 'https://bpgvqmtsjgegnrdzmpep.supabase.co/storage/v1/object/public/product-images/' || override_row.image_storage_path
          end,
          'sellpia_override_updated_at', coalesce(override_row.updated_at, effective.sellpia_override_updated_at),
          'sellpia_purchase_price', coalesce(master.purchase_price, effective.sellpia_source_purchase_price),
          'sellpia_order_unit', coalesce(master.order_unit, effective.sellpia_source_order_unit),
          'sellpia_minimum_order_unit', coalesce(master.minimum_order_unit, effective.sellpia_source_minimum_order_unit),
          'sellpia_purchase_price_updated_at', master.purchase_price_updated_at,
          'sellpia_order_unit_updated_at', master.order_unit_updated_at,
          'sellpia_minimum_order_unit_updated_at', master.minimum_order_unit_updated_at,
          'system_base_price', master.base_price,
          'system_stock', master.stock_quantity,
          'system_price_version', coalesce(master.price_version, 0),
          'system_stock_version', coalesce(master.stock_version, 0),
          'system_price_updated_at', master.price_updated_at,
          'system_stock_updated_at', master.stock_updated_at,
          'system_updated_at', master.updated_at,
          'actual_inbound_cost', case
            when inbound.manual_cost is not null then inbound.manual_cost
            when inbound.formula_tag_id is not null then public.calculate_operations_hub_inbound_cost(
              coalesce(master.purchase_price, effective.sellpia_source_purchase_price),
              formula.multiply_value, formula.divide_value, formula.add_value,
              formula.rounding_unit, formula.rounding_mode
            )
            else null
          end,
          'actual_inbound_cost_mode', case
            when inbound.manual_cost is not null then 'manual'
            when inbound.formula_tag_id is not null then 'formula'
            else null
          end,
          'inbound_cost_formula_tag_name', formula.tag_name,
          'inbound_cost_formula_tag_color', formula.tag_color,
          'smartstore_product_code', case when effective.smartstore_suppressed then null else effective.smartstore_product_code end,
          'smartstore_option_code', case when effective.smartstore_suppressed then null else effective.smartstore_option_code end,
          'smartstore_name', case when effective.smartstore_suppressed then null else effective.smartstore_name end,
          'smartstore_option_name', case when effective.smartstore_suppressed then null else effective.smartstore_option_name end,
          'smartstore_match_tier', case when effective.smartstore_suppressed then null else effective.smartstore_match_tier end,
          'smartstore_listing_count', case when effective.smartstore_suppressed then 0 else effective.smartstore_listing_count end,
          'smartstore_stock', case when effective.smartstore_suppressed then null else effective.smartstore_stock end,
          'smartstore_price', case when effective.smartstore_suppressed then null else effective.smartstore_price end,
          'makeshop_product_code', case when effective.makeshop_suppressed then null else effective.makeshop_product_code end,
          'makeshop_option_code', case when effective.makeshop_suppressed then null else effective.makeshop_option_code end,
          'makeshop_name', case when effective.makeshop_suppressed then null else effective.makeshop_name end,
          'makeshop_option_name', case when effective.makeshop_suppressed then null else effective.makeshop_option_name end,
          'makeshop_match_tier', case when effective.makeshop_suppressed then null else effective.makeshop_match_tier end,
          'makeshop_listing_count', case when effective.makeshop_suppressed then 0 else effective.makeshop_listing_count end,
          'makeshop_stock', case when effective.makeshop_suppressed then null else effective.makeshop_stock end,
          'makeshop_price', case when effective.makeshop_suppressed then null else effective.makeshop_price end,
          'ably_product_code', case when effective.ably_suppressed then null else effective.ably_product_code end,
          'ably_option_code', case when effective.ably_suppressed then null else effective.ably_option_code end,
          'ably_name', case when effective.ably_suppressed then null else effective.ably_name end,
          'ably_option_name', case when effective.ably_suppressed then null else effective.ably_option_name end,
          'ably_match_tier', case when effective.ably_suppressed then null else effective.ably_match_tier end,
          'ably_listing_count', case when effective.ably_suppressed then 0 else effective.ably_listing_count end,
          'ably_stock', case when effective.ably_suppressed then null else effective.ably_stock end,
          'ably_price', case when effective.ably_suppressed then null else effective.ably_price end,
          'overall_status', case when
            (not effective.smartstore_suppressed and nullif(btrim(effective.smartstore_product_code), '') is not null)
            or (not effective.makeshop_suppressed and nullif(btrim(effective.makeshop_product_code), '') is not null)
            or (not effective.ably_suppressed and nullif(btrim(effective.ably_product_code), '') is not null)
            then 'connected' else 'unmatched' end,
          'is_dependent_combination_sku', dependent.sellpia_sku_code is not null,
          '__profile', jsonb_strip_nulls(jsonb_build_object(
            'sellpia_sku_code', effective.sellpia_sku_code,
            'sellpia_product_code', effective.sellpia_product_code,
            'material', attributes.material,
            'product_group', attributes.product_group,
            'shape', attributes.shape,
            'tag_summary', tags.tag_summary,
            'product_tags', coalesce(tags.product_tags, '[]'::jsonb),
            'sku_tags', coalesce(tags.sku_tags, '[]'::jsonb)
          )),
          '__grid_tag_ids', coalesce(tags.tag_ids, '[]'::jsonb),
          '__sellerDrafts', coalesce(active_drafts.payload, '{}'::jsonb),
          '__sellerProductLinkDrafts', coalesce(product_link_drafts.payload, '{}'::jsonb),
          '__linkSuppressions', coalesce(suppressions.payload, '[]'::jsonb),
          '__linkBadges', coalesce(link_badges.payload, '{}'::jsonb),
          '__sellerPriceComponents', coalesce(seller_price_components.payload, '{}'::jsonb),
          '__hubInternalPrices', coalesce(internal_prices.payload, '{}'::jsonb),
          '__hubRulePrices', coalesce(platform_prices.payload, '{}'::jsonb),
          '__hubActivePriceRules', jsonb_build_object(
            'smartstore', coalesce((platform_prices.active_payload ->> 'smartstore')::boolean, false),
            'makeshop', coalesce((platform_prices.active_payload ->> 'makeshop')::boolean, false),
            'ably', coalesce((platform_prices.active_payload ->> 'ably')::boolean, false)
          ),
          '__priceRuleAssignments', coalesce(platform_prices.assignment_payload, '{}'::jsonb),
          '__grid_stale', coalesce(internal_prices.stale, false) or coalesce(platform_prices.stale, false),
          '__grid_conflict', effective.overall_status = 'review'
            or effective.smartstore_match_tier = 'FAST_REVIEW'
            or effective.makeshop_match_tier = 'FAST_REVIEW'
            or effective.ably_match_tier = 'FAST_REVIEW',
          '__grid_pending', active_drafts.sellpia_sku_code is not null or product_link_drafts.sellpia_sku_code is not null,
          '__grid_stock_mismatch',
            (not effective.smartstore_suppressed and effective.smartstore_product_code is not null and effective.smartstore_stock is not null and master.stock_quantity is not null and effective.smartstore_stock <> master.stock_quantity)
            or (not effective.makeshop_suppressed and effective.makeshop_product_code is not null and effective.makeshop_stock is not null and master.stock_quantity is not null and effective.makeshop_stock <> master.stock_quantity)
            or (not effective.ably_suppressed and effective.ably_product_code is not null and effective.ably_stock is not null and master.stock_quantity is not null and effective.ably_stock <> master.stock_quantity),
          '__grid_price_mismatch',
            (not effective.smartstore_suppressed and effective.smartstore_product_code is not null and effective.smartstore_price is not null and master.base_price is not null and effective.smartstore_price <> master.base_price)
            or (not effective.makeshop_suppressed and effective.makeshop_product_code is not null and effective.makeshop_price is not null and master.base_price is not null and effective.makeshop_price <> master.base_price)
            or (not effective.ably_suppressed and effective.ably_product_code is not null and effective.ably_price is not null and master.base_price is not null and effective.ably_price <> master.base_price),
          '__grid_compact', true
        )
      ) row_json
    from effective
    left join public.operations_hub_sellpia_overrides override_row using (sellpia_sku_code)
    left join public.operations_hub_sku_operational_master master using (sellpia_sku_code)
    left join public.operations_hub_inbound_cost_settings inbound using (sellpia_sku_code)
    left join public.operations_hub_inbound_cost_formula_tags formula
      on formula.tag_id = inbound.formula_tag_id and formula.is_active
    left join catalog.sellpia_product_attributes attributes
      on attributes.sellpia_product_code = effective.sellpia_product_code
    left join tags using (sellpia_sku_code)
    left join active_drafts using (sellpia_sku_code)
    left join product_link_drafts using (sellpia_sku_code)
    left join suppressions using (sellpia_sku_code)
    left join link_badges using (sellpia_sku_code)
    left join seller_price_components using (sellpia_sku_code)
    left join internal_prices on internal_prices.sku = effective.sellpia_sku_code
    left join platform_prices on platform_prices.sku = effective.sellpia_sku_code
    left join dependent_skus dependent using (sellpia_sku_code)
  )
  select coalesce(jsonb_agg(assembled.row_json order by assembled.sellpia_sku_code), '[]'::jsonb),
    count(*)::integer,
    (select sellpia_sku_code from page order by sellpia_sku_code desc limit 1),
    exists(select 1 from page_plus offset p_limit)
  into v_rows, v_loaded, v_next_sku, v_has_more
  from assembled;

  return jsonb_build_object(
    'rows', v_rows,
    'loaded', v_loaded,
    'next_sku', case when v_has_more then v_next_sku else null end,
    'has_more', v_has_more,
    'dataset_version', v_current_version,
    'payload_bytes', pg_column_size(v_rows),
    'server_ms', round(extract(epoch from (clock_timestamp() - v_started_at)) * 1000, 2)
  );
end;
$function$;

revoke all on function public.hub_matrix_grid_manifest_v2(text) from public;
revoke all on function public.hub_matrix_grid_manifest_v2(text) from anon, authenticated;
grant execute on function public.hub_matrix_grid_manifest_v2(text) to anon, authenticated, service_role;

revoke all on function public.hub_matrix_grid_feed_v2(text,timestamptz,text,integer) from public;
revoke all on function public.hub_matrix_grid_feed_v2(text,timestamptz,text,integer) from anon, authenticated;
grant execute on function public.hub_matrix_grid_feed_v2(text,timestamptz,text,integer) to anon, authenticated, service_role;

comment on function public.hub_matrix_grid_manifest_v2(text) is
  'Session-gated read-only manifest for a consistent full Matrix grid bootstrap.';
comment on function public.hub_matrix_grid_feed_v2(text,timestamptz,text,integer) is
  'Session-gated read-only compact Matrix keyset feed. Rebuilds bounded tag/draft projections instead of reading cached large JSON columns.';
