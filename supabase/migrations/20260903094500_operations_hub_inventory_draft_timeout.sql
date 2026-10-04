alter function public.stage_operations_hub_seller_inventory_match_batch(text[], text[], uuid, text, integer)
  set statement_timeout = '45s';

notify pgrst, 'reload schema';
