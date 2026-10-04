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
  null::integer as smartstore_stock,
  null::numeric as smartstore_price,
  null::timestamptz as smartstore_inventory_at,
  null::integer as makeshop_stock,
  null::numeric as makeshop_price,
  null::timestamptz as makeshop_inventory_at,
  null::integer as ably_stock,
  null::numeric as ably_price,
  null::timestamptz as ably_inventory_at,
  case
    when matrix.smartstore_match_tier = 'FAST_REVIEW'
      or matrix.makeshop_match_tier = 'FAST_REVIEW'
      or matrix.ably_match_tier = 'FAST_REVIEW' then 'review'
    when matrix.smartstore_match_tier is null
      and matrix.makeshop_match_tier is null
      and matrix.ably_match_tier is null then 'unmatched'
    else 'connected'
  end::text as overall_status
from public.operations_hub_matrix matrix
left join public.sellpia_stock_latest stock
  on stock.sellpia_sku_code = matrix.sellpia_sku_code;

comment on view public.operations_hub_matrix_live is
  'Read-only operations matrix enriched with latest Sellpia stock and server-filterable overall mapping status.';

revoke all on public.operations_hub_matrix_live from public;
grant select on public.operations_hub_matrix_live to anon, authenticated;

notify pgrst, 'reload schema';
