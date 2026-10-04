create extension if not exists pg_cron with schema pg_catalog;

create materialized view public.system_v3_inventory_activity_cache as
with latest_pick_state as (
  select distinct on (item_key)
    item_key,
    sellpia_product_code,
    event_type,
    event_at
  from (
    select
      coalesce(
        nullif(trim(sellpia_item_no), ''),
        concat_ws(
          '|',
          coalesce(receipt_date::text, ''),
          coalesce(order_group_no, ''),
          coalesce(invoice_no, ''),
          coalesce(sellpia_product_code, '')
        )
      ) as item_key,
      trim(sellpia_product_code) as sellpia_product_code,
      event_type,
      event_at,
      id
    from public.workflow_item_events
    where (event_at at time zone 'Asia/Seoul')::date =
          (now() at time zone 'Asia/Seoul')::date
      and event_type in ('picked', 'pick_unchecked')
      and nullif(trim(sellpia_product_code), '') is not null
  ) events
  order by item_key, event_at desc, id desc
),
picked_by_sku as (
  select
    sellpia_product_code,
    count(*)::integer as picked_qty,
    max(event_at) as last_event_at
  from latest_pick_state
  where event_type = 'picked'
  group by sellpia_product_code
),
drawer_by_sku as (
  select
    trim(sellpia_p_code) as sellpia_product_code,
    count(*)::integer as drawer_qty,
    max(updated_at) as last_event_at
  from public.shortage
  where status = '서랍입력'
    and coalesce(short_qty, 0) = 0
    and nullif(trim(sellpia_p_code), '') is not null
    and nullif(trim(drawer_no), '') is not null
  group by trim(sellpia_p_code)
)
select
  (now() at time zone 'Asia/Seoul')::date as activity_date,
  coalesce(picked.sellpia_product_code, drawer.sellpia_product_code) as sellpia_sku_code,
  coalesce(picked.picked_qty, 0)::integer as picked_qty,
  coalesce(drawer.drawer_qty, 0)::integer as shortage_drawer_qty,
  greatest(picked.last_event_at, drawer.last_event_at) as last_event_at,
  now() as refreshed_at
from picked_by_sku picked
full join drawer_by_sku drawer using (sellpia_product_code)
with data;

create unique index system_v3_inventory_activity_cache_sku_uidx
  on public.system_v3_inventory_activity_cache (sellpia_sku_code);

create index system_v3_inventory_activity_cache_activity_date_idx
  on public.system_v3_inventory_activity_cache (activity_date);

grant select on public.system_v3_inventory_activity_cache to anon, authenticated;

select cron.schedule(
  'system-v3-inventory-activity-refresh',
  '* * * * *',
  'refresh materialized view concurrently public.system_v3_inventory_activity_cache'
);
