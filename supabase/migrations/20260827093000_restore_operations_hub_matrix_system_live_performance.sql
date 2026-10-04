-- Restore the cached-matrix overlay to its original query shape.
-- Durable link suppressions are projected by the Operations Hub data adapter
-- after the matrix read instead of joining them into this hot query.
create or replace view public.operations_hub_matrix_system_live
with (security_invoker = true)
as
select
  matrix.*,
  nullif(
    regexp_replace(coalesce(source_stock.raw_payload ->> 'sell_price', ''), '[^0-9.-]', '', 'g'),
    ''
  )::numeric as sellpia_source_sale_price,
  source_stock.stock as sellpia_source_stock,
  source_stock.snapshot_completed_at as sellpia_source_updated_at,
  master.base_price as system_base_price,
  master.stock_quantity as system_stock,
  master.price_version as system_price_version,
  master.stock_version as system_stock_version,
  master.price_updated_at as system_price_updated_at,
  master.stock_updated_at as system_stock_updated_at,
  master.updated_at as system_updated_at,
  false as smartstore_link_suppressed,
  false as makeshop_link_suppressed,
  false as ably_link_suppressed
from public.operations_hub_matrix_cached matrix
left join public.sellpia_stock_latest source_stock
  on source_stock.sellpia_sku_code = matrix.sellpia_sku_code
left join public.operations_hub_sku_operational_master master
  on master.sellpia_sku_code = matrix.sellpia_sku_code;

revoke all on public.operations_hub_matrix_system_live from public, anon, authenticated;
grant select on public.operations_hub_matrix_system_live to anon, authenticated;
