-- Carrier mapping filters by seller product code, not the older combined
-- product-option expression. Keep the existing indexes for their consumers.
-- Cover the identity projection without changing rows, grants or timeouts.
create index operations_hub_matrix_export_cache_smartstore_product_lookup_idx
 on operations_private.operations_hub_matrix_export_cache
 (smartstore_product_code,sellpia_sku_code) include (smartstore_option_code)
 where smartstore_product_code is not null;

create index operations_hub_matrix_export_cache_makeshop_product_lookup_idx
 on operations_private.operations_hub_matrix_export_cache
 (makeshop_product_code,sellpia_sku_code) include (makeshop_option_code)
 where makeshop_product_code is not null;

create index operations_hub_matrix_export_cache_ably_product_lookup_idx
 on operations_private.operations_hub_matrix_export_cache
 (ably_product_code,sellpia_sku_code) include (ably_option_code)
 where ably_product_code is not null;
