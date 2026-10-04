with latest_snapshot as materialized (
  select distinct on (snapshot.source_channel)
    snapshot.source_channel,
    snapshot.snapshot_id
  from public.seller_inventory_snapshots snapshot
  where snapshot.upload_status = 'ready'
    and snapshot.source_channel in ('smartstore','makeshop','ably')
  order by snapshot.source_channel,
           snapshot.completed_at desc nulls last,
           snapshot.created_at desc
), source_component as materialized (
  select
    snapshot.source_channel,
    row_item.product_code,
    coalesce(row_item.option_code, '') as option_code,
    coalesce(row_item.base_price, nullif(row_item.raw_payload ->> 'base_price', '')::numeric, row_item.price) as base_price,
    coalesce(row_item.option_price, nullif(row_item.raw_payload ->> 'option_price', '')::numeric, 0) as option_price,
    coalesce(row_item.final_price, row_item.price) as final_price
  from public.seller_inventory_snapshot_rows row_item
  join latest_snapshot snapshot
    on snapshot.snapshot_id = row_item.snapshot_id
)
update public.operations_hub_change_queue queue
set price_base_before = coalesce(queue.price_base_before, source_component.base_price),
    price_base_after = coalesce(
      queue.price_base_after,
      (queue.after_value #>> '{}')::numeric - source_component.option_price
    ),
    price_option_before = coalesce(queue.price_option_before, source_component.option_price),
    price_option_after = coalesce(queue.price_option_after, source_component.option_price),
    price_final_before = coalesce(queue.price_final_before, source_component.final_price, (queue.before_value #>> '{}')::numeric),
    price_final_after = coalesce(queue.price_final_after, (queue.after_value #>> '{}')::numeric),
    option_price_source = coalesce(queue.option_price_source, 'original'),
    updated_at = now()
from source_component
where queue.field_key = 'sellpia_sale_price'
  and queue.source_channel = source_component.source_channel
  and queue.seller_product_code = source_component.product_code
  and coalesce(queue.seller_option_code, '') = source_component.option_code
  and queue.status in ('pending','validated','failed')
  and (
    queue.price_base_after is null
    or queue.price_option_after is null
    or queue.price_final_after is null
  );

comment on column public.operations_hub_change_queue.option_price_source is
  'Option-price origin. Legacy active price drafts were backfilled as original-option preservation.';

notify pgrst, 'reload schema';
