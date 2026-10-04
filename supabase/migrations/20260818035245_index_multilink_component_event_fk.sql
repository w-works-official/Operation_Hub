create index operations_hub_listing_component_events_component_idx
  on public.operations_hub_listing_component_events (component_id)
  where component_id is not null;
