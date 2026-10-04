do $$
declare
  v_function_definition text;
begin
  v_function_definition := pg_get_functiondef(
    'public.upsert_operations_hub_listing_component(text,text,text,text,integer,text)'::regprocedure
  );
  v_function_definition := replace(
    v_function_definition,
    'on conflict (listing_id, sellpia_sku_code)',
    'on conflict on constraint operations_hub_listing_componen_listing_id_sellpia_sku_code_key'
  );
  execute v_function_definition;
end;
$$;
