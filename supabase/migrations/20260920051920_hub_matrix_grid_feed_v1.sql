-- Compact, read-only bootstrap feed for the full client-side Matrix dataset.
-- The authoritative write/cache lifecycle is intentionally unchanged.

create index if not exists operations_hub_matrix_export_cache_refreshed_desc_idx
  on operations_private.operations_hub_matrix_export_cache (cache_refreshed_at desc);

create or replace function public.hub_matrix_grid_feed_v1(
  p_session_token text,
  p_after_sku text default null,
  p_limit integer default 3000
) returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog'
set statement_timeout to '15s'
set jit to 'off'
set plan_cache_mode to 'force_custom_plan'
as $function$
declare
  v_started_at timestamptz := clock_timestamp();
  v_total integer;
  v_dataset_version timestamptz;
  v_rows jsonb;
  v_loaded integer;
  v_next_sku text;
  v_has_more boolean;
begin
  perform operations_private.require_operations_hub_operator_session(p_session_token);

  if p_limit is null or p_limit not between 250 and 4000 then
    raise exception 'Matrix Grid feed limit은 250~4,000이어야 합니다.';
  end if;
  if p_after_sku is not null and length(p_after_sku) > 128 then
    raise exception 'Matrix Grid feed cursor가 올바르지 않습니다.';
  end if;

  select count(*)::integer, max(cache_refreshed_at)
    into v_total, v_dataset_version
  from operations_private.operations_hub_matrix_export_cache;

  with page_plus as materialized (
    select cache.*
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
  suppressions as materialized (
    select suppression.sellpia_sku_code,
      jsonb_agg(jsonb_build_object(
        'source_channel', suppression.source_channel,
        'product_code', suppression.product_code,
        'option_code', suppression.option_code,
        'reason', suppression.reason
      ) order by suppression.source_channel, suppression.product_code, suppression.option_code) payload
    from public.operations_hub_link_suppressions suppression
    join page_keys using (sellpia_sku_code)
    group by suppression.sellpia_sku_code
  ),
  effective as materialized (
    select page.*,
      exists (
        select 1 from public.operations_hub_link_suppressions suppression
        where suppression.source_channel = 'smartstore'
          and suppression.sellpia_sku_code = page.sellpia_sku_code
          and suppression.product_code = coalesce(page.smartstore_product_code, '')
          and suppression.option_code = coalesce(page.smartstore_option_code, '')
      ) smartstore_suppressed,
      exists (
        select 1 from public.operations_hub_link_suppressions suppression
        where suppression.source_channel = 'makeshop'
          and suppression.sellpia_sku_code = page.sellpia_sku_code
          and suppression.product_code = coalesce(page.makeshop_product_code, '')
          and suppression.option_code = coalesce(page.makeshop_option_code, '')
      ) makeshop_suppressed,
      exists (
        select 1 from public.operations_hub_link_suppressions suppression
        where suppression.source_channel = 'ably'
          and suppression.sellpia_sku_code = page.sellpia_sku_code
          and suppression.product_code = coalesce(page.ably_product_code, '')
          and suppression.option_code = coalesce(page.ably_option_code, '')
      ) ably_suppressed
    from page
  ),
  active_draft_rows as materialized (
    select distinct on (queue.sellpia_sku_code, queue.source_channel, queue.field_key)
      queue.change_id,
      queue.sellpia_sku_code,
      queue.source_channel,
      queue.field_key,
      queue.before_value,
      queue.after_value,
      queue.status,
      queue.updated_at,
      queue.price_base_after,
      queue.price_discounted_base_after,
      queue.price_option_after,
      queue.price_final_after,
      queue.price_discount_terms_after,
      queue.option_price_source,
      queue.price_rule_set_id
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
          'price_base_after', draft.price_base_after,
          'price_discounted_base_after', draft.price_discounted_base_after,
          'price_option_after', draft.price_option_after,
          'price_final_after', draft.price_final_after,
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
    select assignment.sku,
      assignment.scope,
      assignment.target_field,
      calculated.value,
      calculated.status,
      calculated.error,
      calculated.generation_id,
      calculated.calculated_at,
      jsonb_agg(jsonb_build_object(
        'id', rule.id,
        'name', rule.name,
        'tag_id', rule.tag_id,
        'tag_name', coalesce(tag.tag_name, rule.name),
        'version', rule.version,
        'output_field', rule.target_field,
        'scope', rule.scope
      ) order by rule.name) active_rules,
      array_agg(distinct coalesce(tag.tag_name, rule.name) order by coalesce(tag.tag_name, rule.name)) rule_names,
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
      on tag.tag_id = rule.tag_id
     and tag.is_active
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
        'error', case when field.status = 'error' then field.error when not field.proof_current then '활성 Rule 기준 재계산 필요' end,
        'ruleNames', to_jsonb(field.rule_names),
        'activeOutputRules', field.active_rules,
        'generationId', field.generation_id,
        'calculatedAt', field.calculated_at,
        'stale', not field.proof_current,
        'provenanceMismatch', not field.proof_current
      ))) payload,
      bool_or(not field.proof_current) stale
    from active_rule_fields field
    where field.scope = ''
      and field.target_field in ('actual_inbound_cost','basis_sku_price','calculated_base_price')
    group by field.sku
  ),
  platform_prices_by_source as materialized (
    select field.sku,
      field.scope,
      jsonb_object_agg(field.target_field, field.value) values_by_field,
      array_agg(distinct rule_name order by rule_name) rule_names,
      bool_and(field.proof_current) proof_current,
      string_agg(distinct coalesce(field.error, ''), ' / ') filter (where nullif(field.error, '') is not null) errors
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
        'error', case when price.proof_current then null else coalesce(nullif(price.errors, ''), '활성 Rule 기준 재계산 필요') end
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
      source.source_channel,
      source.product_code,
      source.option_code
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
        'source_base_price', coalesce(source_row.base_price, nullif(source_row.raw_payload ->> 'base_price', '')::numeric, source_row.price),
        'source_discounted_base_price', coalesce(source_row.discounted_base_price, source_row.base_price, source_row.price),
        'source_option_price', coalesce(source_row.option_price, nullif(source_row.raw_payload ->> 'option_price', '')::numeric, 0),
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
  assembled as materialized (
    select effective.sellpia_sku_code,
      (
        to_jsonb(effective)
          - 'profile_json'
          - 'seller_drafts_json'
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
          'sellpia_override_image_url', case when override_row.sellpia_sku_code is null then effective.sellpia_override_image_url when override_row.image_storage_path is null then null else 'https://bpgvqmtsjgegnrdzmpep.supabase.co/storage/v1/object/public/product-images/' || override_row.image_storage_path end,
          'sellpia_override_updated_at', coalesce(override_row.updated_at, effective.sellpia_override_updated_at),
          'sellpia_source_sale_price', nullif(regexp_replace(coalesce(source_stock.raw_payload ->> 'sell_price', ''), '[^0-9.-]', '', 'g'), '')::numeric,
          'sellpia_source_stock', source_stock.stock,
          'sellpia_source_updated_at', source_stock.snapshot_completed_at,
          'sellpia_source_purchase_price', source_stock.purchase_price,
          'sellpia_source_order_unit', source_stock.order_unit,
          'sellpia_source_minimum_order_unit', source_stock.minimum_order_unit,
          'sellpia_purchase_price', coalesce(master.purchase_price, source_stock.purchase_price),
          'sellpia_order_unit', coalesce(master.order_unit, source_stock.order_unit),
          'sellpia_minimum_order_unit', coalesce(master.minimum_order_unit, source_stock.minimum_order_unit),
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
          'actual_inbound_cost', inbound.actual_inbound_cost,
          'actual_inbound_cost_mode', inbound.actual_inbound_cost_mode,
          'inbound_cost_formula_tag_name', inbound.inbound_cost_formula_tag_name,
          'inbound_cost_formula_tag_color', inbound.inbound_cost_formula_tag_color,
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
            'sellpia_product_code', effective.profile_json -> 'sellpia_product_code',
            'material', effective.profile_json -> 'material',
            'product_group', effective.profile_json -> 'product_group',
            'shape', effective.profile_json -> 'shape',
            'tag_summary', effective.profile_json -> 'tag_summary',
            'product_tags', coalesce(effective.profile_json -> 'product_tags', '[]'::jsonb),
            'sku_tags', coalesce(effective.profile_json -> 'sku_tags', '[]'::jsonb)
          )),
          '__grid_tag_ids', coalesce((
            select jsonb_agg(distinct tag -> 'tag_id')
            from jsonb_array_elements(
              coalesce(effective.profile_json -> 'product_tags', '[]'::jsonb)
              || coalesce(effective.profile_json -> 'sku_tags', '[]'::jsonb)
            ) tag
          ), '[]'::jsonb),
          '__sellerDrafts', coalesce(active_drafts.payload, '{}'::jsonb),
          '__sellerProductLinkDrafts', coalesce(product_link_drafts.payload, '{}'::jsonb),
          '__linkSuppressions', coalesce(suppressions.payload, '[]'::jsonb),
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
    left join public.sellpia_stock_latest source_stock using (sellpia_sku_code)
    left join public.operations_hub_sku_operational_master master using (sellpia_sku_code)
    left join public.operations_hub_inbound_cost_live inbound using (sellpia_sku_code)
    left join active_drafts using (sellpia_sku_code)
    left join product_link_drafts using (sellpia_sku_code)
    left join suppressions using (sellpia_sku_code)
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
    'total', v_total,
    'loaded', v_loaded,
    'next_sku', case when v_has_more then v_next_sku else null end,
    'has_more', v_has_more,
    'dataset_version', v_dataset_version,
    'server_ms', round(extract(epoch from (clock_timestamp() - v_started_at)) * 1000, 2)
  );
end;
$function$;

revoke all on function public.hub_matrix_grid_feed_v1(text,text,integer) from public;
revoke all on function public.hub_matrix_grid_feed_v1(text,text,integer) from anon, authenticated;
grant execute on function public.hub_matrix_grid_feed_v1(text,text,integer) to anon, authenticated, service_role;

comment on function public.hub_matrix_grid_feed_v1(text,text,integer) is
  'Session-gated read-only keyset feed for the full client-side Matrix grid. No write/cache refresh semantics.';
