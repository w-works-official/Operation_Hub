-- Promote an inferred legacy listing and remove one mistaken SKU edge atomically.
-- This lets operators correct old auto-matching results without bulk-remapping the source data.

create or replace function public.disconnect_operations_hub_legacy_listing_component(
  p_source text,
  p_product_code text,
  p_option_code text,
  p_sellpia_sku_code text
)
returns table (
  listing_id bigint,
  component_id bigint,
  remaining_component_count integer,
  promoted_component_count integer
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_listing_id bigint;
  v_component_id bigint;
  v_remaining integer;
  v_promoted integer := 0;
  v_legacy_count integer := 0;
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

  select count(distinct cache.sellpia_sku_code)::integer
    into v_legacy_count
  from public.operations_hub_listing_legacy_cache cache
  where cache.source_channel = p_source
    and cache.product_code = p_product_code
    and cache.option_code = p_option_code;

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
  if v_legacy_count <= 1 then
    raise exception '마지막 연결은 조합 해제로 제거할 수 없습니다. 매칭 검토에서 변경해주세요.';
  end if;

  -- The existing upsert promotes every inferred edge for this exact seller option.
  -- Calling it inside this function keeps promotion + deactivation in one transaction.
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

  select count(*)::integer
    into v_remaining
  from public.operations_hub_listing_components component
  where component.listing_id = v_listing_id
    and component.is_active;

  if v_remaining <= 1 then
    raise exception '연결 해제 후 남는 셀피아 SKU가 없어 작업을 중단했습니다.';
  end if;

  select deactivated.remaining_component_count
    into v_remaining
  from public.deactivate_operations_hub_listing_component(v_component_id) deactivated;

  return query
  select v_listing_id, v_component_id, v_remaining, v_promoted;
end;
$$;

comment on function public.disconnect_operations_hub_legacy_listing_component(text, text, text, text) is
  'Atomically promotes one inferred seller listing and soft-deactivates a mistaken legacy SKU edge with the existing audit trail.';

revoke all on function public.disconnect_operations_hub_legacy_listing_component(text, text, text, text) from public;
grant execute on function public.disconnect_operations_hub_legacy_listing_component(text, text, text, text) to anon, authenticated;
