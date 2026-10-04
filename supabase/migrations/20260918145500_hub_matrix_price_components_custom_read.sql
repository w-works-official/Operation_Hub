-- Identical component query, parameterized custom plan, existing invoker/RLS boundary.
CREATE OR REPLACE FUNCTION public.load_operations_hub_seller_price_components_batch_v1(p_skus text[])
 RETURNS TABLE(sellpia_sku_code text, source_channel text, seller_product_code text, seller_option_code text, source_base_price numeric, source_discounted_base_price numeric, source_option_price numeric, source_final_price numeric, source_reported_final_price numeric, source_discount_terms jsonb, source_discount_calculation_status text, source_discount_fingerprint text, draft_base_price numeric, draft_discounted_base_price numeric, draft_option_price numeric, draft_final_price numeric, option_price_source text, base_price_source text, price_rule_set_id bigint, pricing_input_mode text, price_calculation_version smallint, draft_change_id bigint, draft_status text, draft_updated_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog'
 SET jit TO 'off'
AS $function$
begin
 if p_skus is null or cardinality(p_skus) not between 1 and 200 then raise exception 'invalid bounded Matrix price-component request'; end if;
 RETURN QUERY EXECUTE $query$
with requested as materialized (
    select distinct btrim(sku) as sellpia_sku_code
    from unnest(coalesce($1, '{}'::text[])) sku
    where nullif(btrim(sku), '') is not null
  ),
  latest_snapshot as materialized (
    select distinct on (snapshot.source_channel)
      snapshot.source_channel, snapshot.snapshot_id
    from public.seller_inventory_snapshots snapshot
    where snapshot.upload_status = 'ready'
      and snapshot.source_channel in ('smartstore','makeshop','ably')
    order by snapshot.source_channel,
             snapshot.completed_at desc nulls last,
             snapshot.created_at desc
  ),
  mapped as materialized (
    select matrix.sellpia_sku_code, source.source_channel,
      case source.source_channel
        when 'smartstore' then matrix.smartstore_product_code
        when 'makeshop' then matrix.makeshop_product_code
        when 'ably' then matrix.ably_product_code
      end as seller_product_code,
      case source.source_channel
        when 'smartstore' then coalesce(matrix.smartstore_option_code, '')
        when 'makeshop' then coalesce(matrix.makeshop_option_code, '')
        when 'ably' then coalesce(matrix.ably_option_code, '')
      end as seller_option_code
    from public.operations_hub_matrix_cached matrix
    join requested using (sellpia_sku_code)
    cross join lateral unnest(array['smartstore','makeshop','ably']::text[]) source(source_channel)
  )
  select
    mapped.sellpia_sku_code, mapped.source_channel,
    mapped.seller_product_code, mapped.seller_option_code,
    coalesce(source_row.base_price, nullif(source_row.raw_payload ->> 'base_price', '')::numeric, source_row.price),
    coalesce(source_row.discounted_base_price, source_row.base_price, source_row.price),
    coalesce(source_row.option_price, nullif(source_row.raw_payload ->> 'option_price', '')::numeric, 0),
    coalesce(source_row.final_price, source_row.price),
    source_row.reported_final_price,
    coalesce(source_row.discount_terms, '[]'::jsonb),
    coalesce(source_row.discount_calculation_status, 'none'),
    source_row.source_discount_fingerprint,
    draft.price_base_after,
    draft.price_discounted_base_after,
    draft.price_option_after,
    coalesce(draft.price_final_after, nullif(draft.after_value #>> '{}', '')::numeric),
    draft.option_price_source,
    draft.base_price_source,
    draft.price_rule_set_id,
    draft.pricing_input_mode,
    draft.price_calculation_version,
    draft.change_id, draft.status, draft.updated_at
  from mapped
  left join latest_snapshot snapshot using (source_channel)
  left join public.seller_inventory_snapshot_rows source_row
    on source_row.snapshot_id = snapshot.snapshot_id
   and source_row.product_code = mapped.seller_product_code
   and source_row.option_code = mapped.seller_option_code
  left join public.operations_hub_active_seller_drafts draft
    on draft.sellpia_sku_code = mapped.sellpia_sku_code
   and draft.source_channel = mapped.source_channel
   and draft.field_key = 'sellpia_sale_price'
$query$ USING p_skus;
end
$function$;
REVOKE ALL ON FUNCTION public.load_operations_hub_seller_price_components_batch_v1(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.load_operations_hub_seller_price_components_batch_v1(text[]) TO anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.load_operations_hub_matrix_metadata_batch_v1(p_skus text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'public'
 SET jit TO 'off'
AS $function$
declare
  v_skus text[];
begin
  select coalesce(array_agg(distinct btrim(sku)), '{}'::text[])
  into v_skus
  from unnest(coalesce(p_skus, '{}'::text[])) sku
  where nullif(btrim(sku), '') is not null;

  if coalesce(cardinality(v_skus), 0) > 200 then
    raise exception '한 번에 최대 200개 SKU의 부가정보만 조회할 수 있습니다.';
  end if;

  return jsonb_build_object(
    'inbound_costs', coalesce((
      select jsonb_agg(to_jsonb(detail) order by detail.sellpia_sku_code)
      from public.operations_hub_inbound_cost_live detail
      where detail.sellpia_sku_code = any(v_skus)
    ), '[]'::jsonb),
    'operational_details', coalesce((
      select jsonb_agg(to_jsonb(detail) order by detail.sellpia_sku_code)
      from public.operations_hub_sku_operational_live detail
      where detail.sellpia_sku_code = any(v_skus)
    ), '[]'::jsonb),
    'product_link_drafts', coalesce((
      select jsonb_agg(to_jsonb(draft) order by draft.sellpia_sku_code, draft.source_channel)
      from public.operations_hub_product_link_drafts draft
      where draft.sellpia_sku_code = any(v_skus)
    ), '[]'::jsonb),
    'manual_links', coalesce((
      select jsonb_agg(to_jsonb(link) order by link.sellpia_sku_code, link.source_channel)
      from public.operations_hub_manual_links link
      where link.sellpia_sku_code = any(v_skus)
    ), '[]'::jsonb),
    'profiles', coalesce((
      select jsonb_agg(to_jsonb(profile) order by profile.sellpia_sku_code)
      from public.operations_hub_product_profiles profile
      where profile.sellpia_sku_code = any(v_skus)
    ), '[]'::jsonb),
    'link_badges', coalesce((
      select jsonb_agg(to_jsonb(badge) order by badge.sellpia_sku_code, badge.source_channel)
      from public.get_operations_hub_sku_link_badges_v2(v_skus) badge
    ), '[]'::jsonb),
    'seller_price_components', coalesce((
      select jsonb_agg(to_jsonb(component) order by component.sellpia_sku_code, component.source_channel)
      from public.load_operations_hub_seller_price_components_batch_v1(v_skus) component
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
        where queue.sellpia_sku_code = any(v_skus)
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
        and assignment.sellpia_sku_code = any(v_skus)
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
            and assignment.sellpia_sku_code = any(v_skus)
        )
    ), '[]'::jsonb),
    'link_suppressions', coalesce((
      select jsonb_agg(to_jsonb(suppression) order by suppression.sellpia_sku_code, suppression.source_channel)
      from public.operations_hub_link_suppressions suppression
      where suppression.sellpia_sku_code = any(v_skus)
    ), '[]'::jsonb)
  );
end;
$function$
