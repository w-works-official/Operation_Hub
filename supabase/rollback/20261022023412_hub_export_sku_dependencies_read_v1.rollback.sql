-- Drop only the additive read API. Operator data and existing functions are untouched.
set local lock_timeout='2s';
set local statement_timeout='30s';
drop function public.hub_export_sku_dependencies_read_v1(text,text[],text);
drop function operations_private.hub_export_sku_dependencies_read_session_v1(text,text[],text);
drop function operations_private.hub_export_sku_dependencies_payload_v1(text[],text);
drop function operations_private.hub_export_sku_graph_edges_v1();
notify pgrst,'reload schema';

