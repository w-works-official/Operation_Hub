do $$
declare
  v_before text;
  v_after text;
begin
  v_before := pg_get_functiondef(
    'public.refresh_operations_hub_listing_legacy_cache(text[])'::regprocedure
  );
  v_after := replace(
    v_before,
    '      and (p_skus is null or matrix.sellpia_sku_code = any(p_skus))' || chr(10),
    ''
  );
  v_after := replace(
    v_after,
    '  where edge.option_code <> ''''' || chr(10) || '     or identity.edge_count = 1',
    '  where (p_skus is null or edge.sellpia_sku_code = any(p_skus))' || chr(10) ||
    '    and (edge.option_code <> '''' or identity.edge_count = 1)'
  );
  if v_after <> v_before then
    execute v_after;
  end if;
end;
$$;
