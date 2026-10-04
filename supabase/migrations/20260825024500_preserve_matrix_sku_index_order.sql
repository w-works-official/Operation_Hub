-- Prevent the live override join from turning an indexed first-page read into
-- a full 24k-row cache scan and sort.
do $migration$
declare
  v_definition text := pg_get_viewdef('public.operations_hub_matrix_cached'::regclass, true);
  v_old_join text := 'LEFT JOIN operations_hub_sellpia_overrides sellpia_override ON sellpia_override.sellpia_sku_code = matrix_1.sellpia_sku_code';
  v_new_join text := E'LEFT JOIN LATERAL (\n     SELECT override_row.sellpia_sku_code,\n        override_row.own_code,\n        override_row.product_name,\n        override_row.option_name,\n        override_row.current_stock,\n        override_row.sale_price,\n        override_row.image_storage_path,\n        override_row.updated_by,\n        override_row.updated_at\n       FROM operations_hub_sellpia_overrides override_row\n      WHERE override_row.sellpia_sku_code = matrix_1.sellpia_sku_code\n     OFFSET 0) sellpia_override ON true';
begin
  if strpos(v_definition, v_old_join) > 0 then
    execute 'create or replace view public.operations_hub_matrix_cached with (security_invoker = true) as '
      || replace(v_definition, v_old_join, v_new_join);
  elsif strpos(v_definition, 'OFFSET 0) sellpia_override ON true') = 0 then
    raise exception 'Unexpected operations_hub_matrix_cached override join definition.';
  end if;
end;
$migration$;

notify pgrst, 'reload schema';
