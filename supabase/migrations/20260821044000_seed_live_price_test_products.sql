-- Thirty clearly namespaced live-matrix products for end-to-end price-rule testing.
-- They append to the current ready snapshots and disappear from the matrix when a
-- future full Sellpia snapshot replaces the current authoritative source.

do $$
declare
  v_sellpia_snapshot uuid;
  v_smartstore_snapshot uuid;
  v_makeshop_snapshot uuid;
  v_ably_snapshot uuid;
begin
  select snapshot_id into v_sellpia_snapshot
  from public.sellpia_stock_snapshots
  where upload_status = 'ready'
  order by created_at desc
  limit 1;

  select snapshot_id into v_smartstore_snapshot
  from public.seller_inventory_snapshots
  where upload_status = 'ready' and source_channel = 'smartstore'
  order by completed_at desc nulls last, created_at desc
  limit 1;

  select snapshot_id into v_makeshop_snapshot
  from public.seller_inventory_snapshots
  where upload_status = 'ready' and source_channel = 'makeshop'
  order by completed_at desc nulls last, created_at desc
  limit 1;

  select snapshot_id into v_ably_snapshot
  from public.seller_inventory_snapshots
  where upload_status = 'ready' and source_channel = 'ably'
  order by completed_at desc nulls last, created_at desc
  limit 1;

  if v_sellpia_snapshot is null or v_smartstore_snapshot is null or v_makeshop_snapshot is null or v_ably_snapshot is null then
    raise exception '실매트릭스 테스트 상품을 넣을 준비 완료 원본 스냅샷이 부족합니다.';
  end if;

  insert into public.sellpia_stock_snapshot_rows (
    snapshot_id, sellpia_sku_code, sellpia_product_code, sellpia_product_name,
    sellpia_option_name, own_sku, stock, available_stock,
    integrated_available_stock, safety_stock, source_row_no, raw_payload,
    supplier_code, supplier_name, supplier_group, purchase_product_name,
    purchase_option_name
  )
  select
    v_sellpia_snapshot,
    format('TEST-PRICE-%s', lpad(series_no::text, 3, '0')),
    format('TESTP%s', lpad((((series_no - 1) / 5) + 1)::text, 2, '0')),
    format('[TEST] 가격 규칙 실매트릭스 상품 %s', lpad((((series_no - 1) / 5) + 1)::text, 2, '0')),
    format('옵션 %s · 셀피아 %s원', ((series_no - 1) % 5) + 1, 10000 + series_no * 1000),
    format('[TEST-OWN-%s]', lpad(series_no::text, 3, '0')),
    100,
    100,
    100,
    0,
    900000 + series_no,
    jsonb_build_object(
      'sell_price', (10000 + series_no * 1000)::text,
      'system_v3_live_test', true,
      'test_case', format('price-rule-%s', lpad(series_no::text, 3, '0'))
    ),
    'TEST-SUPPLIER',
    '가격규칙 테스트 매입처',
    'SYSTEM_V3_TEST',
    format('가격 규칙 테스트 상품 %s', lpad((((series_no - 1) / 5) + 1)::text, 2, '0')),
    format('테스트 옵션 %s', ((series_no - 1) % 5) + 1)
  from generate_series(1, 30) series_no
  on conflict (snapshot_id, sellpia_sku_code) do update set
    sellpia_product_code = excluded.sellpia_product_code,
    sellpia_product_name = excluded.sellpia_product_name,
    sellpia_option_name = excluded.sellpia_option_name,
    own_sku = excluded.own_sku,
    stock = excluded.stock,
    available_stock = excluded.available_stock,
    integrated_available_stock = excluded.integrated_available_stock,
    safety_stock = excluded.safety_stock,
    raw_payload = excluded.raw_payload,
    supplier_code = excluded.supplier_code,
    supplier_name = excluded.supplier_name,
    supplier_group = excluded.supplier_group,
    purchase_product_name = excluded.purchase_product_name,
    purchase_option_name = excluded.purchase_option_name;

  insert into public.operations_hub_manual_links (
    source_channel, sellpia_sku_code, product_code, option_code,
    product_name, option_name, updated_by, mapping_origin, match_tier,
    match_score, mapping_note
  )
  select source_channel,
         format('TEST-PRICE-%s', lpad(series_no::text, 3, '0')),
         case source_channel
           when 'smartstore' then format('9901%s', lpad((((series_no - 1) / 5) + 1)::text, 2, '0'))
           when 'makeshop' then format('9902%s', lpad((((series_no - 1) / 5) + 1)::text, 2, '0'))
           else format('9903%s', lpad((((series_no - 1) / 5) + 1)::text, 2, '0'))
         end,
         (((series_no - 1) % 5) + 1)::text,
         format('[TEST] %s 가격 규칙 상품 %s',
           case source_channel when 'smartstore' then '스마트스토어' when 'makeshop' then '메이크샵' else '에이블리' end,
           lpad((((series_no - 1) / 5) + 1)::text, 2, '0')),
         format('옵션 %s', ((series_no - 1) % 5) + 1),
         'system_v3_live_price_test',
         'manual',
         'MANUAL_LINKED',
         100,
         '가격 규칙 실매트릭스 테스트 30종'
  from generate_series(1, 30) series_no
  cross join unnest(array['smartstore','makeshop','ably']::text[]) source_channel
  on conflict (source_channel, sellpia_sku_code) do update set
    product_code = excluded.product_code,
    option_code = excluded.option_code,
    product_name = excluded.product_name,
    option_name = excluded.option_name,
    updated_by = excluded.updated_by,
    mapping_origin = excluded.mapping_origin,
    match_tier = excluded.match_tier,
    match_score = excluded.match_score,
    mapping_note = excluded.mapping_note,
    updated_at = now();

  insert into public.seller_inventory_snapshot_rows (
    snapshot_id, product_code, option_code, seller_code, product_name,
    option_name, stock, price, sale_status, source_row_no, raw_payload,
    base_price, option_price, final_price
  )
  select v_smartstore_snapshot,
         format('9901%s', lpad((((series_no - 1) / 5) + 1)::text, 2, '0')),
         (((series_no - 1) % 5) + 1)::text,
         format('TEST-SM-%s', lpad(series_no::text, 3, '0')),
         format('[TEST] 스마트스토어 가격 규칙 상품 %s', lpad((((series_no - 1) / 5) + 1)::text, 2, '0')),
         format('옵션 %s', ((series_no - 1) % 5) + 1),
         90 - series_no,
         (12000 + (((series_no - 1) / 5) + 1) * 3000 + case ((series_no - 1) % 5) + 1 when 1 then -1000 when 2 then 0 when 3 then 1000 when 4 then 3000 else 5000 end),
         '판매중', 900000 + series_no,
         jsonb_build_object('system_v3_live_test', true),
         (12000 + (((series_no - 1) / 5) + 1) * 3000),
         case ((series_no - 1) % 5) + 1 when 1 then -1000 when 2 then 0 when 3 then 1000 when 4 then 3000 else 5000 end,
         (12000 + (((series_no - 1) / 5) + 1) * 3000 + case ((series_no - 1) % 5) + 1 when 1 then -1000 when 2 then 0 when 3 then 1000 when 4 then 3000 else 5000 end)
  from generate_series(1, 30) series_no
  on conflict (snapshot_id, product_code, option_code) do update set
    seller_code=excluded.seller_code, product_name=excluded.product_name,
    option_name=excluded.option_name, stock=excluded.stock, price=excluded.price,
    sale_status=excluded.sale_status, raw_payload=excluded.raw_payload,
    base_price=excluded.base_price, option_price=excluded.option_price,
    final_price=excluded.final_price;

  insert into public.seller_inventory_snapshot_rows (
    snapshot_id, product_code, option_code, seller_code, product_name,
    option_name, stock, price, sale_status, source_row_no, raw_payload,
    base_price, option_price, final_price
  )
  select v_makeshop_snapshot,
         format('9902%s', lpad((((series_no - 1) / 5) + 1)::text, 2, '0')),
         (((series_no - 1) % 5) + 1)::text,
         format('TEST-MK-%s', lpad(series_no::text, 3, '0')),
         format('[TEST] 메이크샵 가격 규칙 상품 %s', lpad((((series_no - 1) / 5) + 1)::text, 2, '0')),
         format('옵션 %s', ((series_no - 1) % 5) + 1),
         80 - series_no,
         (11000 + (((series_no - 1) / 5) + 1) * 3200 + case ((series_no - 1) % 5) + 1 when 1 then 0 when 2 then 500 when 3 then 1500 when 4 then 2500 else 4500 end),
         '판매중', 910000 + series_no,
         jsonb_build_object('system_v3_live_test', true),
         (11000 + (((series_no - 1) / 5) + 1) * 3200),
         case ((series_no - 1) % 5) + 1 when 1 then 0 when 2 then 500 when 3 then 1500 when 4 then 2500 else 4500 end,
         (11000 + (((series_no - 1) / 5) + 1) * 3200 + case ((series_no - 1) % 5) + 1 when 1 then 0 when 2 then 500 when 3 then 1500 when 4 then 2500 else 4500 end)
  from generate_series(1, 30) series_no
  on conflict (snapshot_id, product_code, option_code) do update set
    seller_code=excluded.seller_code, product_name=excluded.product_name,
    option_name=excluded.option_name, stock=excluded.stock, price=excluded.price,
    sale_status=excluded.sale_status, raw_payload=excluded.raw_payload,
    base_price=excluded.base_price, option_price=excluded.option_price,
    final_price=excluded.final_price;

  insert into public.seller_inventory_snapshot_rows (
    snapshot_id, product_code, option_code, seller_code, product_name,
    option_name, stock, price, sale_status, source_row_no, raw_payload,
    base_price, option_price, final_price
  )
  select v_ably_snapshot,
         format('9903%s', lpad((((series_no - 1) / 5) + 1)::text, 2, '0')),
         (((series_no - 1) % 5) + 1)::text,
         format('TEST-AB-%s', lpad(series_no::text, 3, '0')),
         format('[TEST] 에이블리 가격 규칙 상품 %s', lpad((((series_no - 1) / 5) + 1)::text, 2, '0')),
         format('옵션 %s', ((series_no - 1) % 5) + 1),
         70 - series_no,
         (13000 + (((series_no - 1) / 5) + 1) * 2800 + case ((series_no - 1) % 5) + 1 when 1 then -2000 when 2 then 0 when 3 then 2000 when 4 then 4000 else 6000 end),
         '판매중', 920000 + series_no,
         jsonb_build_object('system_v3_live_test', true),
         (13000 + (((series_no - 1) / 5) + 1) * 2800),
         case ((series_no - 1) % 5) + 1 when 1 then -2000 when 2 then 0 when 3 then 2000 when 4 then 4000 else 6000 end,
         (13000 + (((series_no - 1) / 5) + 1) * 2800 + case ((series_no - 1) % 5) + 1 when 1 then -2000 when 2 then 0 when 3 then 2000 when 4 then 4000 else 6000 end)
  from generate_series(1, 30) series_no
  on conflict (snapshot_id, product_code, option_code) do update set
    seller_code=excluded.seller_code, product_name=excluded.product_name,
    option_name=excluded.option_name, stock=excluded.stock, price=excluded.price,
    sale_status=excluded.sale_status, raw_payload=excluded.raw_payload,
    base_price=excluded.base_price, option_price=excluded.option_price,
    final_price=excluded.final_price;

  refresh materialized view operations_private.operations_hub_matrix_core;
end;
$$;
