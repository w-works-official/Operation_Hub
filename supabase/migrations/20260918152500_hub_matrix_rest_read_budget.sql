-- Function-specific REST read budget; existing role defaults, grants and row bounds remain unchanged.
ALTER FUNCTION public.load_operations_hub_matrix_metadata_batch_v1(text[]) SET statement_timeout='15s';
ALTER FUNCTION public.load_operations_hub_matrix_rows_batch_v1(text[]) SET statement_timeout='15s';
ALTER FUNCTION public.load_operations_hub_seller_price_components_batch_v1(text[]) SET statement_timeout='15s';
ALTER FUNCTION public.get_operations_hub_matrix_link_badges_batch_v1(text[]) SET statement_timeout='15s';
ALTER FUNCTION public.load_operations_hub_price_basis_batch_v1(text[]) SET statement_timeout='15s';
ALTER FUNCTION public.hub_matrix_input_fingerprints_batch_v1(text,text[],text) SET statement_timeout='15s';
ALTER FUNCTION public.hub_matrix_calculation_results_batch_v1(text,text[],text,text[],jsonb,integer) SET statement_timeout='15s';
ALTER FUNCTION public.hub_matrix_shadow_compact_batch_v1(text,text,jsonb) SET statement_timeout='15s';
ALTER FUNCTION public.hub_matrix_shadow_metadata_batch_v1(text,text,jsonb) SET statement_timeout='15s';
NOTIFY pgrst, 'reload schema';
