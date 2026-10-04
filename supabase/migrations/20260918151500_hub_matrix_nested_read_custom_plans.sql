-- Ensure nested read helpers retain a request-specific plan after repeated batches.
ALTER FUNCTION public.load_operations_hub_matrix_metadata_batch_v1(text[]) SET plan_cache_mode='force_custom_plan';
ALTER FUNCTION public.load_operations_hub_seller_price_components_batch_v1(text[]) SET plan_cache_mode='force_custom_plan';
ALTER FUNCTION operations_private.hub_matrix_shadow_compact_payload_v1(text,jsonb) SET plan_cache_mode='force_custom_plan';
ALTER FUNCTION operations_private.hub_matrix_shadow_payload_batch_v1(text,jsonb) SET plan_cache_mode='force_custom_plan';
ALTER FUNCTION public.hub_matrix_input_fingerprints_batch_v1(text,text[],text) SET plan_cache_mode='force_custom_plan';
