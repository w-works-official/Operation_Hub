-- Cover foreign keys used by the V1/V2 price draft and export workflows.

create index if not exists operations_hub_change_queue_price_rule_set_idx
  on public.operations_hub_change_queue(price_rule_set_id)
  where price_rule_set_id is not null;

create index if not exists operations_hub_change_queue_source_snapshot_idx
  on public.operations_hub_change_queue(source_snapshot_id)
  where source_snapshot_id is not null;

create index if not exists operations_hub_export_items_price_rule_set_idx
  on public.operations_hub_export_items(price_rule_set_id)
  where price_rule_set_id is not null;

create index if not exists operations_hub_export_items_source_snapshot_idx
  on public.operations_hub_export_items(source_snapshot_id)
  where source_snapshot_id is not null;
