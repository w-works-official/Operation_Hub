-- The mapping status view reads max(imported_at) on every dashboard poll.
-- Keep that singleton status lookup below the browser statement timeout even
-- when the legacy import table has grown large.
create index if not exists final_excel_mapping_import_imported_at_desc_idx
  on review.final_excel_mapping_import (imported_at desc);
