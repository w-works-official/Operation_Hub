create or replace function public.link_operations_hub_seller_item(
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
security invoker
set search_path = public, operations_private, pg_temp
as $$
declare
  v_item public.seller_inventory_latest%rowtype;
  v_before jsonb;
  v_linked_at timestamptz := now();
begin
  if p_source not in ('smartstore', 'makeshop', 'ably') then
    raise exception '지원하지 않는 판매처입니다: %', p_source;
  end if;
  if nullif(btrim(p_sku), '') is null then
    raise exception '셀피아 SKU가 필요합니다.';
  end if;
  if not exists (
    select 1 from operations_private.operations_hub_matrix_core matrix
    where matrix.sellpia_sku_code = btrim(p_sku)
  ) then
    raise exception '매트릭스에 없는 셀피아 SKU입니다: %', p_sku;
  end if;

  select item.* into v_item
  from public.seller_inventory_latest item
  where item.source_channel = p_source
    and item.product_code = btrim(p_product_code)
    and item.option_code = coalesce(btrim(p_option_code), '')
  limit 1;

  if not found then
    raise exception '최신 판매처 원본에서 선택한 상품을 찾을 수 없습니다.';
  end if;

  select to_jsonb(existing.*) into v_before
  from public.operations_hub_manual_links existing
  where existing.source_channel = p_source
    and existing.sellpia_sku_code = btrim(p_sku);

  insert into public.operations_hub_manual_links (
    source_channel, sellpia_sku_code, product_code, option_code,
    product_name, option_name, updated_by, updated_at
  ) values (
    p_source, btrim(p_sku), v_item.product_code, v_item.option_code,
    v_item.product_name, v_item.option_name, 'operations_hub_frontend', v_linked_at
  )
  on conflict on constraint operations_hub_manual_links_pkey do update set
    product_code = excluded.product_code,
    option_code = excluded.option_code,
    product_name = excluded.product_name,
    option_name = excluded.option_name,
    updated_by = 'operations_hub_frontend',
    updated_at = excluded.updated_at;

  insert into public.operations_hub_link_history (
    sellpia_sku_code, source_channel, before_link, after_link, changed_by, changed_at
  ) values (
    btrim(p_sku), p_source, v_before,
    jsonb_build_object(
      'product_code', v_item.product_code,
      'option_code', v_item.option_code,
      'product_name', v_item.product_name,
      'option_name', v_item.option_name
    ),
    'operations_hub_frontend', v_linked_at
  );

  return query select
    p_source, btrim(p_sku), v_item.product_code, v_item.option_code,
    v_item.product_name, v_item.option_name, v_item.stock, v_item.price, v_linked_at;
end;
$$;

revoke all on function public.link_operations_hub_seller_item(text, text, text, text) from public;
grant execute on function public.link_operations_hub_seller_item(text, text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
