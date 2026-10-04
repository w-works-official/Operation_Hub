-- Carrier workbook matching needs only the cached seller identity columns.
-- The public matrix view also probes Sellpia overrides for every matching SKU,
-- even though those overrides cannot change these identity columns.
create or replace function public.hub_carrier_seller_identity_read_v1(
  p_session_token text,
  p_source_channel text,
  p_product_codes text[],
  p_offset integer default 0,
  p_limit integer default 1000
) returns table (
  sellpia_sku_code text,
  product_code text,
  option_code text
)
language plpgsql
stable
security definer
set search_path=pg_catalog
set statement_timeout='8s'
as $$
begin
  perform operations_private.require_operations_hub_operator_session(p_session_token);

  if p_source_channel is null or p_source_channel not in ('smartstore','makeshop','ably')
     or p_product_codes is null or cardinality(p_product_codes) not between 1 and 100
     or exists (
       select 1 from unnest(p_product_codes) code
       where code is null or length(btrim(code)) not between 1 and 128
     )
     or p_offset is null or p_offset < 0 or p_offset > 100000
     or p_limit is null or p_limit not between 1 and 1000 then
    raise exception '유효하지 않은 판매처 identity 조회 범위';
  end if;

  if p_source_channel = 'smartstore' then
    return query
      select matrix.sellpia_sku_code, matrix.smartstore_product_code, matrix.smartstore_option_code
        from operations_private.operations_hub_matrix_export_cache matrix
       where matrix.smartstore_product_code = any(p_product_codes)
       order by matrix.sellpia_sku_code
       offset p_offset limit p_limit;
  elsif p_source_channel = 'makeshop' then
    return query
      select matrix.sellpia_sku_code, matrix.makeshop_product_code, matrix.makeshop_option_code
        from operations_private.operations_hub_matrix_export_cache matrix
       where matrix.makeshop_product_code = any(p_product_codes)
       order by matrix.sellpia_sku_code
       offset p_offset limit p_limit;
  else
    return query
      select matrix.sellpia_sku_code, matrix.ably_product_code, matrix.ably_option_code
        from operations_private.operations_hub_matrix_export_cache matrix
       where matrix.ably_product_code = any(p_product_codes)
       order by matrix.sellpia_sku_code
       offset p_offset limit p_limit;
  end if;
end;
$$;

revoke all on function public.hub_carrier_seller_identity_read_v1(text,text,text[],integer,integer) from public;
grant execute on function public.hub_carrier_seller_identity_read_v1(text,text,text[],integer,integer) to anon, authenticated;
notify pgrst, 'reload schema';
