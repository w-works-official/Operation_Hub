-- A legacy/cache edge can outlive the seller item in the latest uploaded
-- source. Disconnect that exact orphaned edge through a durable suppression
-- instead of trying to promote a seller item that no longer exists.
create or replace function public.disconnect_operations_hub_listing_component(
  p_component_id bigint,
  p_source text,
  p_product_code text,
  p_option_code text,
  p_sellpia_sku_code text
)
returns table (
  listing_id bigint,
  component_id bigint,
  remaining_component_count integer,
  promoted_component_count integer,
  suppression_saved boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_listing_id bigint;
  v_component_id bigint;
  v_remaining integer := 0;
  v_promoted integer := 0;
  v_before jsonb;
  v_source_identity_exists boolean := false;
begin
  p_source := lower(btrim(coalesce(p_source, '')));
  p_product_code := btrim(coalesce(p_product_code, ''));
  p_option_code := btrim(coalesce(p_option_code, ''));
  p_sellpia_sku_code := btrim(coalesce(p_sellpia_sku_code, ''));

  if p_source not in ('smartstore', 'makeshop', 'ably') then
    raise exception '지원하지 않는 판매처입니다.';
  end if;
  if p_product_code = '' or p_sellpia_sku_code = '' then
    raise exception '판매처 상품코드와 셀피아 SKU는 필수입니다.';
  end if;

  if p_component_id is not null then
    select listing.listing_id, component.component_id
      into v_listing_id, v_component_id
    from public.operations_hub_listing_components component
    join public.operations_hub_seller_listings listing
      on listing.listing_id = component.listing_id
    where component.component_id = p_component_id
      and component.is_active
      and listing.is_active
      and listing.source_channel = p_source
      and listing.product_code = p_product_code
      and listing.option_code = p_option_code
      and component.sellpia_sku_code = p_sellpia_sku_code;

    if not found then
      raise exception '현재 연결에서 선택한 구성품을 찾을 수 없습니다.';
    end if;
  else
    if not exists (
      select 1
      from public.operations_hub_listing_legacy_cache cache
      where cache.source_channel = p_source
        and cache.product_code = p_product_code
        and cache.option_code = p_option_code
        and cache.sellpia_sku_code = p_sellpia_sku_code
    ) then
      raise exception '현재 자동 연결에서 해당 셀피아 SKU를 찾을 수 없습니다.';
    end if;

    select exists (
      select 1
      from public.seller_inventory_latest latest
      where latest.source_channel = p_source
        and latest.product_code = p_product_code
        and latest.option_code = p_option_code
    ) into v_source_identity_exists;

    if v_source_identity_exists then
      -- Current seller identities keep the explicit promotion/deactivation
      -- workflow so bundle siblings and component history remain intact.
      select promoted.listing_id, promoted.component_id, promoted.promoted_component_count
        into v_listing_id, v_component_id, v_promoted
      from public.upsert_operations_hub_listing_component(
        p_source,
        p_product_code,
        p_option_code,
        p_sellpia_sku_code,
        1,
        'primary'
      ) promoted;
    else
      -- The source item is gone, so there is nothing valid to promote. Count
      -- the still-visible sibling cache edges and suppress only this tuple.
      select count(*)::integer
        into v_remaining
      from public.operations_hub_listing_legacy_cache cache
      where cache.source_channel = p_source
        and cache.product_code = p_product_code
        and cache.option_code = p_option_code
        and cache.sellpia_sku_code <> p_sellpia_sku_code
        and not exists (
          select 1
          from public.operations_hub_link_suppressions suppression
          where suppression.source_channel = cache.source_channel
            and suppression.sellpia_sku_code = cache.sellpia_sku_code
            and suppression.product_code = cache.product_code
            and suppression.option_code = cache.option_code
        );
    end if;
  end if;

  select coalesce(
    (
      select to_jsonb(manual.*)
      from public.operations_hub_manual_links manual
      where manual.source_channel = p_source
        and manual.sellpia_sku_code = p_sellpia_sku_code
    ),
    jsonb_build_object(
      'source_channel', p_source,
      'sellpia_sku_code', p_sellpia_sku_code,
      'product_code', p_product_code,
      'option_code', p_option_code,
      'mapping_origin', case when v_source_identity_exists then 'listing_graph' else 'orphaned_legacy_cache' end
    )
  ) into v_before;

  if v_component_id is not null then
    select deactivated.remaining_component_count
      into v_remaining
    from public.deactivate_operations_hub_listing_component(v_component_id) deactivated;
  end if;

  insert into public.operations_hub_link_suppressions (
    source_channel,
    sellpia_sku_code,
    product_code,
    option_code,
    reason,
    suppressed_by,
    suppressed_at
  ) values (
    p_source,
    p_sellpia_sku_code,
    p_product_code,
    p_option_code,
    case when v_source_identity_exists then 'operator_disconnect' else 'operator_disconnect_source_missing' end,
    'operations_hub_frontend',
    now()
  )
  on conflict (source_channel, sellpia_sku_code, product_code, option_code)
  do update set
    reason = excluded.reason,
    suppressed_by = excluded.suppressed_by,
    suppressed_at = excluded.suppressed_at;

  insert into public.operations_hub_link_history (
    sellpia_sku_code,
    source_channel,
    before_link,
    after_link,
    changed_by,
    changed_at
  ) values (
    p_sellpia_sku_code,
    p_source,
    v_before,
    jsonb_build_object(
      'disconnected', true,
      'product_code', p_product_code,
      'option_code', p_option_code,
      'suppression_saved', true,
      'source_identity_missing', not v_source_identity_exists
    ),
    'operations_hub_frontend',
    now()
  );

  return query
  select v_listing_id, v_component_id, v_remaining, v_promoted, true;
end;
$$;

comment on function public.disconnect_operations_hub_listing_component(bigint, text, text, text, text) is
  'Soft-deactivates an explicit/current inferred component, or suppresses an exact orphaned legacy edge when the seller item no longer exists in the latest source.';

revoke all on function public.disconnect_operations_hub_listing_component(bigint, text, text, text, text) from public;
grant execute on function public.disconnect_operations_hub_listing_component(bigint, text, text, text, text) to anon, authenticated;

-- Manual matching can produce several small writes in a few minutes. Rebuilding
-- the 24k-row export cache after every write used to occupy Postgres for about
-- a minute and made the focused matrix reread time out. Keep live reads exact
-- through the manual-link overlay and coalesce export-cache rebuilds for five
-- minutes.
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

  if v_cache_refreshed_at is not null
     and clock_timestamp() - v_cache_refreshed_at < interval '5 minutes' then
    return jsonb_build_object(
      'status', 'deferred',
      'reason', 'write_burst_debounce',
      'refreshed_at', v_cache_refreshed_at,
      'source_changed_at', v_source_changed_at,
      'retry_after', v_cache_refreshed_at + interval '5 minutes',
      'refreshed_by', v_actor
    );
  end if;

  return operations_private.refresh_operations_hub_matrix_export_cache(v_actor);
end;
$$;

revoke all on function operations_private.refresh_operations_hub_matrix_export_cache_if_stale(text)
  from public, anon, authenticated;

notify pgrst, 'reload schema';
