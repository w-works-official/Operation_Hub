-- Follow-up for production databases where the split-tag migration was already
-- applied before calculation version 3 was added to the exact draft writer.

alter table public.operations_hub_change_queue
  drop constraint if exists operations_hub_change_queue_price_version_check;
alter table public.operations_hub_change_queue
  add constraint operations_hub_change_queue_price_version_check
    check (price_calculation_version in (1, 2, 3));

alter table public.operations_hub_export_items
  drop constraint if exists operations_hub_export_items_price_version_check;
alter table public.operations_hub_export_items
  add constraint operations_hub_export_items_price_version_check
    check (price_calculation_version in (1, 2, 3));
