create materialized view operations_private.operations_hub_seller_unmatched_cache
as
select
  source_channel,
  product_code,
  option_code,
  product_name,
  option_name
from public.operations_hub_seller_unmatched_live;

create unique index operations_hub_seller_unmatched_cache_identity_idx
  on operations_private.operations_hub_seller_unmatched_cache (source_channel, product_code, option_code);

grant select on operations_private.operations_hub_seller_unmatched_cache to anon, authenticated;

create or replace view public.operations_hub_seller_unmatched_live
with (security_invoker = true)
as
select
  source_channel,
  product_code,
  option_code,
  product_name,
  option_name
from operations_private.operations_hub_seller_unmatched_cache;

revoke all on public.operations_hub_seller_unmatched_live from public;
grant select on public.operations_hub_seller_unmatched_live to anon, authenticated;

create or replace function operations_private.refresh_operations_hub_matrix_export_cache(
  p_actor text default 'operations_hub_export_cache'
)
returns jsonb
language plpgsql
set search_path = pg_catalog, public, operations_private
as $$
declare
  v_actor text := coalesce(nullif(btrim(p_actor), ''), 'operations_hub_export_cache');
  v_started_at timestamptz := clock_timestamp();
  v_row_count integer := 0;
  v_refreshed_at timestamptz;
begin
  if v_actor !~ '^[0-9A-Za-z_.:@-]{3,120}$' then
    raise exception 'actor 형식이 올바르지 않습니다.';
  end if;

  if not pg_try_advisory_xact_lock(hashtextextended('operations_hub_matrix_export_cache_refresh', 0)) then
    return jsonb_build_object('status', 'locked', 'refreshed_by', v_actor);
  end if;

  refresh materialized view concurrently operations_private.operations_hub_matrix_export_cache;
  refresh materialized view concurrently operations_private.operations_hub_dashboard_metrics_cache;
  refresh materialized view concurrently operations_private.operations_hub_seller_unmatched_cache;

  select count(*), max(cache_refreshed_at)
  into v_row_count, v_refreshed_at
  from operations_private.operations_hub_matrix_export_cache;

  return jsonb_build_object(
    'status', 'refreshed',
    'row_count', v_row_count,
    'refreshed_at', v_refreshed_at,
    'refreshed_by', v_actor,
    'duration_ms', greatest(0, round(extract(epoch from (clock_timestamp() - v_started_at)) * 1000))
  );
end;
$$;

notify pgrst, 'reload schema';
