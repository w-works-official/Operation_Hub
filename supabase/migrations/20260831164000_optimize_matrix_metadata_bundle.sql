-- Keep the one-request metadata bundle below the anon statement timeout by
-- restricting draft and relationship work to the requested page keys first.
create index if not exists operations_hub_change_queue_active_matrix_metadata_idx
  on public.operations_hub_change_queue (
    sellpia_sku_code,
    source_channel,
    field_key,
    updated_at desc,
    change_id desc
  )
  where source_channel in ('smartstore', 'makeshop', 'ably')
    and field_key in ('sellpia_current_stock', 'sellpia_sale_price')
    and status in ('pending', 'validated', 'failed');

create or replace function public.get_operations_hub_sku_link_badges_v2(
  p_skus text[]
)
returns table(
  sellpia_sku_code text,
  source_channel text,
  listing_count integer,
  max_component_count integer,
  relation_type text
)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with selected as materialized (
    select
      component.sellpia_sku_code,
      listing.source_channel,
      listing.product_code,
      coalesce(listing.option_code, '') as option_code
    from public.operations_hub_listing_components component
    join public.operations_hub_seller_listings listing
      on listing.listing_id = component.listing_id
     and listing.is_active
    where component.is_active
      and component.sellpia_sku_code = any(coalesce(p_skus, '{}'::text[]))

    union all

    select
      cache.sellpia_sku_code,
      cache.source_channel,
      cache.product_code,
      coalesce(cache.option_code, '') as option_code
    from public.operations_hub_listing_legacy_cache cache
    where cache.sellpia_sku_code = any(coalesce(p_skus, '{}'::text[]))
      and not exists (
        select 1
        from public.operations_hub_seller_listings listing
        where listing.is_active
          and listing.source_channel = cache.source_channel
          and listing.product_code = cache.product_code
          and listing.option_code = cache.option_code
      )
  ), selected_listings as materialized (
    select distinct source_channel, product_code, option_code
    from selected
  ), listing_components as (
    select
      listing.source_channel,
      listing.product_code,
      coalesce(listing.option_code, '') as option_code,
      component.sellpia_sku_code
    from selected_listings selected_listing
    join public.operations_hub_seller_listings listing
      on listing.is_active
     and listing.source_channel = selected_listing.source_channel
     and listing.product_code = selected_listing.product_code
     and coalesce(listing.option_code, '') = selected_listing.option_code
    join public.operations_hub_listing_components component
      on component.listing_id = listing.listing_id
     and component.is_active

    union all

    select
      cache.source_channel,
      cache.product_code,
      coalesce(cache.option_code, '') as option_code,
      cache.sellpia_sku_code
    from selected_listings selected_listing
    join public.operations_hub_listing_legacy_cache cache
      on cache.source_channel = selected_listing.source_channel
     and cache.product_code = selected_listing.product_code
     and coalesce(cache.option_code, '') = selected_listing.option_code
    where not exists (
      select 1
      from public.operations_hub_seller_listings listing
      where listing.is_active
        and listing.source_channel = cache.source_channel
        and listing.product_code = cache.product_code
        and listing.option_code = cache.option_code
    )
  ), listing_sizes as (
    select
      source_channel,
      product_code,
      option_code,
      count(*)::integer as component_count
    from listing_components
    group by source_channel, product_code, option_code
  )
  select
    selected.sellpia_sku_code,
    selected.source_channel,
    count(distinct (selected.product_code, selected.option_code))::integer as listing_count,
    max(listing_sizes.component_count)::integer as max_component_count,
    case
      when count(distinct (selected.product_code, selected.option_code)) > 1
        and max(listing_sizes.component_count) > 1 then 'multi_bundle'
      when max(listing_sizes.component_count) > 1 then 'bundle'
      when count(distinct (selected.product_code, selected.option_code)) > 1 then 'multi'
      else 'single'
    end as relation_type
  from selected
  join listing_sizes
    on listing_sizes.source_channel = selected.source_channel
   and listing_sizes.product_code = selected.product_code
   and listing_sizes.option_code = selected.option_code
  group by selected.sellpia_sku_code, selected.source_channel;
$$;

revoke all on function public.get_operations_hub_sku_link_badges_v2(text[]) from public;
grant execute on function public.get_operations_hub_sku_link_badges_v2(text[]) to anon, authenticated;

create or replace function public.load_operations_hub_matrix_metadata_v1(
  p_skus text[]
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
as $$
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
      from public.load_operations_hub_seller_price_components(v_skus) component
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
$$;

notify pgrst, 'reload schema';
