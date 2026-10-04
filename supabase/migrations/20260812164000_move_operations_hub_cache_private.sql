create schema if not exists operations_private;

revoke all on schema operations_private from public;
grant usage on schema operations_private to anon, authenticated;

create materialized view if not exists operations_private.operations_hub_matrix_core
as
select *
from public.operations_hub_matrix;

create unique index if not exists operations_hub_matrix_core_sku_idx
  on operations_private.operations_hub_matrix_core (sellpia_sku_code);

revoke all on operations_private.operations_hub_matrix_core from public;
grant select on operations_private.operations_hub_matrix_core to anon, authenticated;

create or replace view public.operations_hub_matrix_live
with (security_invoker = true)
as
select
  matrix.*,
  nullif(btrim(stock.sellpia_product_name), '') as sellpia_product_name,
  nullif(btrim(stock.sellpia_option_name), '') as sellpia_option_name,
  nullif(btrim(stock.own_sku), '') as sellpia_own_code,
  stock.stock as sellpia_current_stock,
  coalesce(stock.available_stock, stock.integrated_available_stock, stock.stock) as sellpia_available_stock,
  stock.safety_stock as sellpia_safety_stock,
  nullif(regexp_replace(coalesce(stock.raw_payload ->> 'sell_price', ''), '[^0-9.-]', '', 'g'), '')::numeric as sellpia_sale_price,
  stock.snapshot_completed_at as sellpia_inventory_at,
  smartstore.stock as smartstore_stock,
  smartstore.price as smartstore_price,
  smartstore.snapshot_completed_at as smartstore_inventory_at,
  makeshop.stock as makeshop_stock,
  makeshop.price as makeshop_price,
  makeshop.snapshot_completed_at as makeshop_inventory_at,
  ably.stock as ably_stock,
  ably.price as ably_price,
  ably.snapshot_completed_at as ably_inventory_at,
  case
    when matrix.smartstore_match_tier = 'FAST_REVIEW'
      or matrix.makeshop_match_tier = 'FAST_REVIEW'
      or matrix.ably_match_tier = 'FAST_REVIEW' then 'review'
    when matrix.smartstore_match_tier is null
      and matrix.makeshop_match_tier is null
      and matrix.ably_match_tier is null then 'unmatched'
    else 'connected'
  end::text as overall_status
from operations_private.operations_hub_matrix_core matrix
left join public.sellpia_stock_latest stock
  on stock.sellpia_sku_code = matrix.sellpia_sku_code
left join public.seller_inventory_latest smartstore
  on smartstore.source_channel = 'smartstore'
  and smartstore.product_code = matrix.smartstore_product_code
  and smartstore.option_code = coalesce(matrix.smartstore_option_code, '')
left join public.seller_inventory_latest makeshop
  on makeshop.source_channel = 'makeshop'
  and makeshop.product_code = matrix.makeshop_product_code
  and makeshop.option_code = coalesce(matrix.makeshop_option_code, '')
left join public.seller_inventory_latest ably
  on ably.source_channel = 'ably'
  and ably.product_code = matrix.ably_product_code
  and ably.option_code = coalesce(matrix.ably_option_code, '');

drop materialized view if exists public.operations_hub_matrix_core;

notify pgrst, 'reload schema';
