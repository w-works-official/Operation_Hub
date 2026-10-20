-- Revert the frontend to search_operations_hub_seller_items_v2 before this rollback.
-- V2, mapping records, snapshots and all existing indexes remain unchanged.
set local lock_timeout = '2s';
set local statement_timeout = '30s';

drop function if exists public.search_operations_hub_seller_items_v3(text, text, integer, integer, text);
drop index if exists public.seller_inventory_rows_search_option_v3_idx;
drop index if exists public.seller_inventory_rows_search_listing_v3_idx;
drop index if exists operations_private.operations_hub_matrix_core_smartstore_identity_v3_idx;
drop index if exists operations_private.operations_hub_matrix_core_makeshop_identity_v3_idx;
drop index if exists operations_private.operations_hub_matrix_core_ably_identity_v3_idx;

notify pgrst, 'reload schema';
