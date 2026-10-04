-- Compact positional, session-gated Matrix bootstrap feed.
-- v5 keeps the positional v4 wire while moving expensive link-badge projection
-- into the one-time manifest. Data pages no longer recompute listing topology.

create or replace function public.hub_matrix_grid_manifest_v5(
  p_session_token text,
  p_chunk_size integer default 2000
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
  v_tag_catalog jsonb;
  v_link_badges jsonb;
begin
  perform operations_private.require_operations_hub_operator_session(p_session_token);

  if p_chunk_size is null or p_chunk_size not between 250 and 4000 then
    raise exception 'Matrix Grid manifest chunk size는 250~4,000이어야 합니다.';
  end if;

  select count(*)::integer, max(cache_refreshed_at)
    into v_total, v_dataset_version
  from operations_private.operations_hub_matrix_export_cache;

  select coalesce(jsonb_object_agg(tag.tag_id::text, jsonb_strip_nulls(jsonb_build_object(
    'name', tag.tag_name,
    'color', tag.tag_color,
    'group', tag.tag_group
  ))), '{}'::jsonb)
    into v_tag_catalog
  from public.product_tags tag
  where tag.is_active;

  select coalesce(jsonb_agg(jsonb_build_array(
    badge.sellpia_sku_code,
    badge.source_channel,
    badge.max_component_count,
    badge.relation_type
  ) order by badge.sellpia_sku_code, badge.source_channel), '[]'::jsonb)
    into v_link_badges
  from public.get_operations_hub_sku_link_badges_v2(
    (select array_agg(cache.sellpia_sku_code order by cache.sellpia_sku_code)
     from operations_private.operations_hub_matrix_export_cache cache)
  ) badge;

  return jsonb_build_object(
    'contract_version', 5,
    'total', v_total,
    'dataset_version', v_dataset_version,
    'recommended_chunk_size', 1250,
    'max_chunk_size', 4000,
    'page_cursors', (
      select jsonb_agg(cursor.after_sku order by cursor.page_number)
      from (
        select ((rn - 1) / p_chunk_size + 1)::integer page_number,
          lag(sellpia_sku_code) over (order by rn) after_sku,
          rn
        from (
          select sellpia_sku_code,
            row_number() over (order by sellpia_sku_code) rn
          from operations_private.operations_hub_matrix_export_cache
        ) numbered
      ) cursor
      where (cursor.rn - 1) % p_chunk_size = 0
    ),
    'tag_catalog', v_tag_catalog,
    'link_badges', v_link_badges,
    'server_ms', round(extract(epoch from (clock_timestamp() - v_started_at)) * 1000, 2)
  );
end;
$function$;

create or replace function public.hub_matrix_grid_feed_v5(
  p_session_token text,
  p_dataset_version timestamptz,
  p_after_sku text default null,
  p_limit integer default 2000
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

  if p_limit is null or p_limit not between 250 and 4000 then
    raise exception 'Matrix Grid feed limit은 250~4,000이어야 합니다.';
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
      snapshot.source_channel, snapshot.snapshot_id
    from public.seller_inventory_snapshots snapshot
    where snapshot.upload_status = 'ready'
      and snapshot.source_channel in ('smartstore','makeshop','ably')
    order by snapshot.source_channel,
      snapshot.completed_at desc nulls last, snapshot.created_at desc
  ),
  page_plus as materialized (
    select
      cache.sellpia_sku_code,
      cache.image_url,
      cache.sellpia_product_name,
      cache.sellpia_option_name,
      cache.sellpia_own_code,
      cache.sellpia_current_stock,
      cache.sellpia_sale_price,
      cache.sellpia_inventory_at,
      cache.smartstore_name,
      cache.smartstore_option_name,
      cache.smartstore_product_code,
      cache.smartstore_option_code,
      cache.smartstore_match_tier,
      cache.smartstore_listing_count,
      cache.smartstore_name_is_draft,
      cache.smartstore_stock,
      cache.smartstore_price,
      cache.makeshop_name,
      cache.makeshop_option_name,
      cache.makeshop_product_code,
      cache.makeshop_option_code,
      cache.makeshop_match_tier,
      cache.makeshop_listing_count,
      cache.makeshop_name_is_draft,
      cache.makeshop_stock,
      cache.makeshop_price,
      cache.ably_name,
      cache.ably_option_name,
      cache.ably_product_code,
      cache.ably_option_code,
      cache.ably_match_tier,
      cache.ably_listing_count,
      cache.ably_name_is_draft,
      cache.ably_stock,
      cache.ably_price,
      cache.overall_status,
      cache.updated_at,
      cache.sellpia_override_image_url,
      cache.sellpia_override_updated_at,
      cache.profile_json
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
  effective as materialized (
    select page_source.*,
      exists (
        select 1 from public.operations_hub_link_suppressions suppression
        where suppression.source_channel = 'smartstore'
          and suppression.sellpia_sku_code = page_source.sellpia_sku_code
          and suppression.product_code = coalesce(page_source.smartstore_product_code, '')
          and suppression.option_code = coalesce(page_source.smartstore_option_code, '')
      ) smartstore_suppressed,
      exists (
        select 1 from public.operations_hub_link_suppressions suppression
        where suppression.source_channel = 'makeshop'
          and suppression.sellpia_sku_code = page_source.sellpia_sku_code
          and suppression.product_code = coalesce(page_source.makeshop_product_code, '')
          and suppression.option_code = coalesce(page_source.makeshop_option_code, '')
      ) makeshop_suppressed,
      exists (
        select 1 from public.operations_hub_link_suppressions suppression
        where suppression.source_channel = 'ably'
          and suppression.sellpia_sku_code = page_source.sellpia_sku_code
          and suppression.product_code = coalesce(page_source.ably_product_code, '')
          and suppression.option_code = coalesce(page_source.ably_option_code, '')
      ) ably_suppressed
    from page_source
  ),
  active_draft_rows as materialized (
    select distinct on (queue.sellpia_sku_code, queue.source_channel, queue.field_key)
      queue.change_id, queue.sellpia_sku_code, queue.source_channel, queue.field_key,
      queue.after_value, queue.status,
      queue.price_base_after, queue.price_discounted_base_after,
      queue.price_option_after, queue.price_final_after,
      queue.price_discount_terms_after
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
          'id', draft.change_id,
          'status', draft.status,
          'after', draft.after_value,
          'b', draft.price_base_after,
          'd', draft.price_discounted_base_after,
          'o', draft.price_option_after,
          'f', draft.price_final_after,
          'terms', draft.price_discount_terms_after
        ))
      ) payload
    from active_draft_rows draft
    group by draft.sellpia_sku_code
  ),
  product_link_drafts as materialized (
    select draft.sellpia_sku_code,
      jsonb_object_agg(draft.source_channel, jsonb_build_object(
        'code', draft.product_code,
        'name', draft.product_name
      )) payload
    from public.operations_hub_product_link_drafts draft
    join page_keys using (sellpia_sku_code)
    where draft.source_channel in ('smartstore','makeshop','ably')
    group by draft.sellpia_sku_code
  ),
  active_rule_fields as materialized (
    select assignment.sku, assignment.scope, assignment.target_field,
      calculated.value, calculated.status, calculated.error,
      array_agg(distinct coalesce(tag.tag_name, rule.name)
        order by coalesce(tag.tag_name, rule.name)) rule_names,
      array_agg(distinct rule.tag_id) filter (where rule.tag_id is not null) rule_tag_ids,
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
      calculated.value, calculated.status, calculated.error
  ),
  internal_prices as materialized (
    select field.sku,
      jsonb_object_agg(field.target_field, jsonb_strip_nulls(jsonb_build_object(
        'v', field.value,
        'e', case when field.status = 'error' then field.error
          when not coalesce(field.proof_current, false) then '활성 Rule 기준 재계산 필요' end,
        'n', to_jsonb(field.rule_names),
        't', to_jsonb(field.rule_tag_ids),
        'stale', not coalesce(field.proof_current, false)
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
        'b', price.values_by_field -> 'platform_registration_price',
        'd', price.values_by_field -> 'platform_discount_price',
        'o', price.values_by_field -> 'platform_option_price',
        'f', price.values_by_field -> 'platform_final_price',
        'n', to_jsonb(price.rule_names),
        'e', case when price.proof_current then null
          else coalesce(nullif(price.errors, ''), '활성 Rule 기준 재계산 필요') end
      ))) payload,
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
        'b', coalesce(source_row.base_price, source_row.price),
        'd', coalesce(source_row.discounted_base_price, source_row.base_price, source_row.price),
        'o', coalesce(source_row.option_price, 0),
        'f', coalesce(source_row.final_price, source_row.price),
        't', nullif(coalesce(source_row.discount_terms, '[]'::jsonb), '[]'::jsonb)
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
    where component.is_active and component.parent_component_id is not null
  ),
  assembled as materialized (
    select effective.sellpia_sku_code,
      jsonb_build_array(
        effective.sellpia_sku_code,
        effective.image_url,
        coalesce(nullif(btrim(override_row.product_name), ''), effective.sellpia_product_name),
        coalesce(nullif(btrim(override_row.option_name), ''), effective.sellpia_option_name),
        coalesce(nullif(btrim(override_row.own_code), ''), effective.sellpia_own_code),
        coalesce(override_row.current_stock, effective.sellpia_current_stock),
        coalesce(override_row.sale_price, effective.sellpia_sale_price),
        effective.sellpia_inventory_at,
        case
          when override_row.sellpia_sku_code is null then effective.sellpia_override_image_url
          when override_row.image_storage_path is null then null
          else 'https://bpgvqmtsjgegnrdzmpep.supabase.co/storage/v1/object/public/product-images/' || override_row.image_storage_path
        end,
        coalesce(override_row.updated_at, effective.sellpia_override_updated_at),
        coalesce(master.purchase_price, effective.sellpia_source_purchase_price),
        effective.sellpia_source_purchase_price,
        coalesce(master.order_unit, effective.sellpia_source_order_unit),
        effective.sellpia_source_order_unit,
        coalesce(master.minimum_order_unit, effective.sellpia_source_minimum_order_unit),
        effective.sellpia_source_minimum_order_unit,
        master.purchase_price_updated_at,
        master.order_unit_updated_at,
        master.minimum_order_unit_updated_at,
        master.base_price,
        master.stock_quantity,
        master.price_updated_at,
        master.stock_updated_at,
        master.updated_at,
        effective.updated_at,
        case when effective.smartstore_suppressed then null else jsonb_build_array(
          effective.smartstore_product_code, effective.smartstore_option_code, effective.smartstore_name,
          effective.smartstore_option_name, effective.smartstore_match_tier, effective.smartstore_listing_count,
          effective.smartstore_name_is_draft, effective.smartstore_stock, effective.smartstore_price) end,
        case when effective.makeshop_suppressed then null else jsonb_build_array(
          effective.makeshop_product_code, effective.makeshop_option_code, effective.makeshop_name,
          effective.makeshop_option_name, effective.makeshop_match_tier, effective.makeshop_listing_count,
          effective.makeshop_name_is_draft, effective.makeshop_stock, effective.makeshop_price) end,
        case when effective.ably_suppressed then null else jsonb_build_array(
          effective.ably_product_code, effective.ably_option_code, effective.ably_name,
          effective.ably_option_name, effective.ably_match_tier, effective.ably_listing_count,
          effective.ably_name_is_draft, effective.ably_stock, effective.ably_price) end,
        case
          when inbound.manual_cost is not null then inbound.manual_cost
          when inbound.formula_tag_id is not null then public.calculate_operations_hub_inbound_cost(
            coalesce(master.purchase_price, effective.sellpia_source_purchase_price),
            formula.multiply_value, formula.divide_value, formula.add_value,
            formula.rounding_unit, formula.rounding_mode
          )
          else null
        end,
        case
          when inbound.manual_cost is not null then 'manual'
          when inbound.formula_tag_id is not null then 'formula'
          else null
        end,
        formula.tag_name,
        formula.tag_color,
        dependent.sellpia_sku_code is not null,
        jsonb_build_array(
          coalesce(internal_prices.stale, false) or coalesce(platform_prices.stale, false),
          effective.overall_status = 'review'
            or effective.smartstore_match_tier = 'FAST_REVIEW'
            or effective.makeshop_match_tier = 'FAST_REVIEW'
            or effective.ably_match_tier = 'FAST_REVIEW',
          active_drafts.sellpia_sku_code is not null or product_link_drafts.sellpia_sku_code is not null,
          (not effective.smartstore_suppressed and effective.smartstore_product_code is not null and effective.smartstore_stock is not null and master.stock_quantity is not null and effective.smartstore_stock <> master.stock_quantity)
            or (not effective.makeshop_suppressed and effective.makeshop_product_code is not null and effective.makeshop_stock is not null and master.stock_quantity is not null and effective.makeshop_stock <> master.stock_quantity)
            or (not effective.ably_suppressed and effective.ably_product_code is not null and effective.ably_stock is not null and master.stock_quantity is not null and effective.ably_stock <> master.stock_quantity),
          (not effective.smartstore_suppressed and effective.smartstore_product_code is not null and effective.smartstore_price is not null and master.base_price is not null and effective.smartstore_price <> master.base_price)
            or (not effective.makeshop_suppressed and effective.makeshop_product_code is not null and effective.makeshop_price is not null and master.base_price is not null and effective.makeshop_price <> master.base_price)
            or (not effective.ably_suppressed and effective.ably_product_code is not null and effective.ably_price is not null and master.base_price is not null and effective.ably_price <> master.base_price)
        ),
        jsonb_build_array(
          jsonb_build_array(
            effective.sellpia_product_code,
            effective.profile_json ->> 'material',
            effective.profile_json ->> 'product_group',
            effective.profile_json ->> 'shape',
            jsonb_path_query_array(effective.profile_json, '$.product_tags[*].tag_id'),
            jsonb_path_query_array(effective.profile_json, '$.sku_tags[*].tag_id')
          ),
          active_drafts.payload,
          product_link_drafts.payload,
          null,
          seller_price_components.payload,
          platform_prices.payload,
          internal_prices.payload
        )
      ) row_json
    from effective
    left join public.operations_hub_sellpia_overrides override_row using (sellpia_sku_code)
    left join public.operations_hub_sku_operational_master master using (sellpia_sku_code)
    left join public.operations_hub_inbound_cost_settings inbound using (sellpia_sku_code)
    left join public.operations_hub_inbound_cost_formula_tags formula
      on formula.tag_id = inbound.formula_tag_id and formula.is_active
    left join active_drafts using (sellpia_sku_code)
    left join product_link_drafts using (sellpia_sku_code)
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
    'contract_version', 5,
    'rows', v_rows,
    'loaded', v_loaded,
    'next_sku', case when v_has_more then v_next_sku else null end,
    'has_more', v_has_more,
    'dataset_version', v_current_version,
    'payload_bytes', octet_length(v_rows::text),
    'server_ms', round(extract(epoch from (clock_timestamp() - v_started_at)) * 1000, 2)
  );
end;
$function$;

revoke all on function public.hub_matrix_grid_manifest_v5(text,integer) from public;
revoke all on function public.hub_matrix_grid_manifest_v5(text,integer) from anon, authenticated;
grant execute on function public.hub_matrix_grid_manifest_v5(text,integer) to anon, authenticated, service_role;

revoke all on function public.hub_matrix_grid_feed_v5(text,timestamptz,text,integer) from public;
revoke all on function public.hub_matrix_grid_feed_v5(text,timestamptz,text,integer) from anon, authenticated;
grant execute on function public.hub_matrix_grid_feed_v5(text,timestamptz,text,integer) to anon, authenticated, service_role;

comment on function public.hub_matrix_grid_manifest_v5(text,integer) is
  'Session-gated v5 manifest with tag and link-badge catalogs plus keyset page cursors.';
comment on function public.hub_matrix_grid_feed_v5(text,timestamptz,text,integer) is
  'Session-gated read-only positional keyset page for the compact v4 Operations Hub Matrix Grid feed.';


create or replace function public.hub_matrix_grid_guard_v5(
  p_session_token text
) returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog'
set statement_timeout to '4s'
set jit to 'off'
as $function$
declare
  v_total integer;
  v_dataset_version timestamptz;
begin
  perform operations_private.require_operations_hub_operator_session(p_session_token);
  select count(*)::integer, max(cache_refreshed_at)
    into v_total, v_dataset_version
  from operations_private.operations_hub_matrix_export_cache;
  return jsonb_build_object(
    'contract_version', 5,
    'total', v_total,
    'dataset_version', v_dataset_version
  );
end;
$function$;

revoke all on function public.hub_matrix_grid_guard_v5(text) from public;
revoke all on function public.hub_matrix_grid_guard_v5(text) from anon, authenticated;
grant execute on function public.hub_matrix_grid_guard_v5(text) to anon, authenticated, service_role;

comment on function public.hub_matrix_grid_guard_v5(text) is
  'Lightweight final count/version guard for Matrix Grid v5 bootstrap.';
