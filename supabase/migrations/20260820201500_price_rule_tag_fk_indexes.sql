-- Cover foreign keys used by composite-tag editing and future assignments.

create index operations_hub_price_rule_set_items_tag_idx
  on public.operations_hub_price_rule_set_items (price_rule_tag_id, price_rule_set_id);

create index operations_hub_price_rule_assignments_set_idx
  on public.operations_hub_price_rule_assignments (price_rule_set_id, source_channel)
  where is_active;
