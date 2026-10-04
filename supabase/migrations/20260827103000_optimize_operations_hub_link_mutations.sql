-- Keep operator link mutations below the browser statement timeout.
-- The previous promotion path scanned the catalog-wide live matrix, including
-- catalog-wide identity classification, even when only one seller listing was
-- being edited. Reuse the indexed legacy cache for that exact identity instead.

create or replace function public.upsert_operations_hub_listing_component(
  p_source text,
  p_product_code text,
  p_option_code text,
  p_sellpia_sku_code text,
  p_component_qty integer default 1,
  p_component_role text default 'additional'
)
returns table (
  listing_id bigint,
  component_id bigint,
  promoted_component_count integer
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_listing_id bigint;
  v_component_id bigint;
  v_product_name text;
  v_option_name text;
  v_before jsonb;
  v_promoted_count integer := 0;
begin
  p_source := lower(btrim(coalesce(p_source, '')));
  p_product_code := btrim(coalesce(p_product_code, ''));
  p_option_code := btrim(coalesce(p_option_code, ''));
  p_sellpia_sku_code := btrim(coalesce(p_sellpia_sku_code, ''));
  p_component_role := lower(btrim(coalesce(p_component_role, 'additional')));

  if p_source not in ('smartstore', 'makeshop', 'ably') then
    raise exception '지원하지 않는 판매처입니다.';
  end if;
  if p_product_code = '' or p_sellpia_sku_code = '' then
    raise exception '판매처 상품코드와 셀피아 SKU는 필수입니다.';
  end if;
  if coalesce(p_component_qty, 0) <= 0 then
    raise exception '구성수량은 1 이상이어야 합니다.';
  end if;
  if p_component_role not in ('primary', 'additional') then
    raise exception '구성 역할을 확인해주세요.';
  end if;
  if not exists (
    select 1
    from public.operations_hub_matrix_cached matrix
    where matrix.sellpia_sku_code = p_sellpia_sku_code
  ) then
    raise exception '셀피아 SKU %를 찾을 수 없습니다.', p_sellpia_sku_code;
  end if;

  select latest.product_name, latest.option_name
    into v_product_name, v_option_name
  from public.seller_inventory_latest latest
  where latest.source_channel = p_source
    and latest.product_code = p_product_code
    and latest.option_code = p_option_code
  order by latest.snapshot_completed_at desc nulls last
  limit 1;

  if not found then
    raise exception '최신 % 원본에서 상품코드/옵션코드를 찾을 수 없습니다.', p_source;
  end if;

  insert into public.operations_hub_seller_listings (
    source_channel, product_code, option_code, product_name, option_name, is_active, updated_by, updated_at
  ) values (
    p_source, p_product_code, p_option_code, v_product_name, v_option_name, true, 'operations_hub_frontend', now()
  )
  on conflict (source_channel, product_code, option_code)
  do update set
    product_name = excluded.product_name,
    option_name = excluded.option_name,
    is_active = true,
    updated_by = 'operations_hub_frontend',
    updated_at = now()
  returning operations_hub_seller_listings.listing_id into v_listing_id;

  -- Promote only cached edges for this exact seller listing. Suppressed edges
  -- remain disconnected and are never revived by a later composition edit.
  insert into public.operations_hub_listing_components (
    listing_id, sellpia_sku_code, component_qty, component_role, mapping_origin, is_active, updated_by
  )
  select
    v_listing_id,
    cache.sellpia_sku_code,
    1,
    'primary',
    'legacy_promoted',
    true,
    'operations_hub_frontend'
  from public.operations_hub_listing_legacy_cache cache
  where cache.source_channel = p_source
    and cache.product_code = p_product_code
    and cache.option_code = p_option_code
    and not exists (
      select 1
      from public.operations_hub_link_suppressions suppression
      where suppression.source_channel = cache.source_channel
        and suppression.sellpia_sku_code = cache.sellpia_sku_code
        and suppression.product_code = cache.product_code
        and suppression.option_code = cache.option_code
    )
  on conflict on constraint operations_hub_listing_componen_listing_id_sellpia_sku_code_key do nothing;
  get diagnostics v_promoted_count = row_count;

  select to_jsonb(component.*) into v_before
  from public.operations_hub_listing_components component
  where component.listing_id = v_listing_id
    and component.sellpia_sku_code = p_sellpia_sku_code;

  insert into public.operations_hub_listing_components (
    listing_id, sellpia_sku_code, component_qty, component_role, mapping_origin, is_active, updated_by, updated_at
  ) values (
    v_listing_id, p_sellpia_sku_code, p_component_qty, p_component_role, 'manual', true, 'operations_hub_frontend', now()
  )
  on conflict on constraint operations_hub_listing_componen_listing_id_sellpia_sku_code_key
  do update set
    component_qty = excluded.component_qty,
    component_role = excluded.component_role,
    mapping_origin = case
      when operations_hub_listing_components.mapping_origin = 'legacy_promoted'
        and excluded.component_qty = 1
        and excluded.component_role = 'primary'
        then operations_hub_listing_components.mapping_origin
      else 'manual'
    end,
    is_active = true,
    updated_by = 'operations_hub_frontend',
    updated_at = now()
  returning operations_hub_listing_components.component_id into v_component_id;

  insert into public.operations_hub_listing_component_events (
    listing_id, component_id, event_type, before_value, after_value, changed_by
  )
  select
    v_listing_id,
    v_component_id,
    'UPSERT',
    v_before,
    to_jsonb(component.*),
    'operations_hub_frontend'
  from public.operations_hub_listing_components component
  where component.component_id = v_component_id;

  return query select v_listing_id, v_component_id, v_promoted_count;
end;
$$;

comment on function public.upsert_operations_hub_listing_component(text, text, text, text, integer, text) is
  'Creates or updates one listing component and promotes only indexed exact-listing cache edges, avoiding catalog-wide matrix scans.';

revoke all on function public.upsert_operations_hub_listing_component(text, text, text, text, integer, text) from public;
grant execute on function public.upsert_operations_hub_listing_component(text, text, text, text, integer, text) to anon, authenticated;

-- Manual 1:1 linking is already committed before the UI needs to refresh.
-- Update only this SKU's legacy edge so the focused connection reader can see
-- the result immediately without calling the catalog-wide cache rebuild.
create or replace function public.link_operations_hub_seller_item_v2(
  p_sku text,
  p_source text,
  p_product_code text,
  p_option_code text default ''
)
returns table (
  source_channel text,
  sellpia_sku_code text,
  product_code text,
  option_code text,
  product_name text,
  option_name text,
  stock integer,
  price numeric,
  linked_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  select linked.*
  from public.link_operations_hub_seller_item(
    p_sku,
    p_source,
    p_product_code,
    p_option_code
  ) linked;

  delete from public.operations_hub_link_suppressions suppression
  where suppression.source_channel = lower(btrim(coalesce(p_source, '')))
    and suppression.sellpia_sku_code = btrim(coalesce(p_sku, ''))
    and suppression.product_code = btrim(coalesce(p_product_code, ''))
    and suppression.option_code = btrim(coalesce(p_option_code, ''));

  delete from public.operations_hub_listing_legacy_cache cache
  where cache.source_channel = lower(btrim(coalesce(p_source, '')))
    and cache.sellpia_sku_code = btrim(coalesce(p_sku, ''));

  insert into public.operations_hub_listing_legacy_cache (
    source_channel, product_code, option_code, product_name, option_name, sellpia_sku_code, refreshed_at
  )
  select
    manual.source_channel,
    manual.product_code,
    coalesce(manual.option_code, ''),
    manual.product_name,
    manual.option_name,
    manual.sellpia_sku_code,
    now()
  from public.operations_hub_manual_links manual
  where manual.source_channel = lower(btrim(coalesce(p_source, '')))
    and manual.sellpia_sku_code = btrim(coalesce(p_sku, ''))
  on conflict (source_channel, product_code, option_code, sellpia_sku_code)
  do update set
    product_name = excluded.product_name,
    option_name = excluded.option_name,
    refreshed_at = excluded.refreshed_at;

  -- Reactivate a selected SKU when this seller listing already has an explicit
  -- graph, for example after a previous durable disconnect.
  insert into public.operations_hub_listing_components (
    listing_id, sellpia_sku_code, component_qty, component_role, mapping_origin, is_active, updated_by, updated_at
  )
  select
    listing.listing_id,
    btrim(coalesce(p_sku, '')),
    1,
    'primary',
    'manual',
    true,
    'operations_hub_frontend',
    now()
  from public.operations_hub_seller_listings listing
  where listing.source_channel = lower(btrim(coalesce(p_source, '')))
    and listing.product_code = btrim(coalesce(p_product_code, ''))
    and listing.option_code = btrim(coalesce(p_option_code, ''))
    and listing.is_active
  on conflict on constraint operations_hub_listing_componen_listing_id_sellpia_sku_code_key
  do update set
    component_qty = excluded.component_qty,
    component_role = excluded.component_role,
    mapping_origin = excluded.mapping_origin,
    is_active = true,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;
end;
$$;

comment on function public.link_operations_hub_seller_item_v2(text, text, text, text) is
  'Saves a manual seller link and refreshes only that exact cached edge; no catalog-wide cache rebuild is required.';

revoke all on function public.link_operations_hub_seller_item_v2(text, text, text, text) from public;
grant execute on function public.link_operations_hub_seller_item_v2(text, text, text, text) to anon, authenticated;
