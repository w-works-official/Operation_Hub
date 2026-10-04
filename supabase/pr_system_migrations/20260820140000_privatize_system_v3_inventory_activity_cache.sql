create schema if not exists operations_private;

alter materialized view public.system_v3_inventory_activity_cache
  set schema operations_private;

grant usage on schema operations_private to anon, authenticated;
grant select on operations_private.system_v3_inventory_activity_cache to anon, authenticated;

create or replace function public.get_system_v3_inventory_activity()
returns table (
  activity_date date,
  sellpia_sku_code text,
  picked_qty integer,
  shortage_drawer_qty integer,
  last_event_at timestamptz,
  refreshed_at timestamptz
)
language sql
stable
security invoker
set search_path = public, operations_private, pg_temp
set statement_timeout = '5s'
as $$
  select
    cache.activity_date,
    cache.sellpia_sku_code,
    cache.picked_qty,
    cache.shortage_drawer_qty,
    cache.last_event_at,
    cache.refreshed_at
  from operations_private.system_v3_inventory_activity_cache cache
  order by cache.sellpia_sku_code;
$$;

revoke all on function public.get_system_v3_inventory_activity() from public;
grant execute on function public.get_system_v3_inventory_activity() to anon, authenticated;

select cron.unschedule('system-v3-inventory-activity-refresh');
select cron.schedule(
  'system-v3-inventory-activity-refresh',
  '* * * * *',
  'refresh materialized view concurrently operations_private.system_v3_inventory_activity_cache'
);
