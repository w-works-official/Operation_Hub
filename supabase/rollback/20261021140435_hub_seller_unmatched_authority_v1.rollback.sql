-- Roll back read/caching changes only. No source, mapping, exclusion or price rows are rewritten.
-- Compatibility unmatched MV retains its most recently computed derived rows.
set local lock_timeout='2s';
set local statement_timeout='30s';

do $cron$
declare j record;
begin
 if to_regclass('cron.job')is not null then
  for j in select jobid from cron.job where jobname='operations-hub-seller-connection-v1'loop
   perform cron.unschedule(j.jobid);
  end loop;
 end if;
end;
$cron$;

CREATE OR REPLACE FUNCTION operations_private.refresh_operations_hub_matrix_export_cache(p_actor text DEFAULT 'operations_hub_export_cache'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'operations_private'
AS $function$
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
$function$
;

drop function public.hub_seller_unmatched_read_v1(text,integer,integer,text);
drop function operations_private.hub_seller_unmatched_read_session_v1(text,integer,integer,text);
drop function operations_private.hub_seller_unmatched_payload_v1(integer,integer,text);
drop function operations_private.hub_seller_connection_current_v1(text);
drop function operations_private.refresh_hub_seller_connection_cache_v1(text);

create or replace view public.operations_hub_seller_unmatched_live with(security_invoker=true)as
 SELECT source_channel,
    product_code,
    option_code,
    product_name,
    option_name
   FROM operations_private.operations_hub_seller_unmatched_cache;;

-- The added exclusion columns require recreating these read-only views.
-- No CASCADE: an unexpected new dependent object makes rollback stop safely.
drop view public.operations_hub_seller_connection_summary;
drop view public.operations_hub_seller_connection_live;
drop view public.operations_hub_dashboard_metrics;
create view public.operations_hub_seller_connection_live with(security_invoker=true)as
 WITH seller_skus AS MATERIALIZED (
         SELECT seller_inventory_latest.source_channel,
            seller_inventory_latest.product_code,
            COALESCE(seller_inventory_latest.option_code, ''::text) AS option_code,
            max(seller_inventory_latest.product_name) AS product_name,
            max(seller_inventory_latest.option_name) AS option_name
           FROM seller_inventory_latest
          GROUP BY seller_inventory_latest.source_channel, seller_inventory_latest.product_code, (COALESCE(seller_inventory_latest.option_code, ''::text))
        ), explicit_listings AS MATERIALIZED (
         SELECT DISTINCT operations_hub_seller_listings.source_channel,
            operations_hub_seller_listings.product_code,
            COALESCE(operations_hub_seller_listings.option_code, ''::text) AS option_code
           FROM operations_hub_seller_listings
          WHERE operations_hub_seller_listings.is_active
        ), explicit_links AS MATERIALIZED (
         SELECT DISTINCT listing.source_channel,
            listing.product_code,
            COALESCE(listing.option_code, ''::text) AS option_code
           FROM operations_hub_seller_listings listing
             JOIN operations_hub_listing_components component ON component.listing_id = listing.listing_id AND component.is_active
          WHERE listing.is_active
        ), legacy_links AS MATERIALIZED (
         SELECT DISTINCT operations_hub_listing_legacy_cache.source_channel,
            operations_hub_listing_legacy_cache.product_code,
            COALESCE(operations_hub_listing_legacy_cache.option_code, ''::text) AS option_code
           FROM operations_hub_listing_legacy_cache
          WHERE NULLIF(btrim(COALESCE(operations_hub_listing_legacy_cache.sellpia_sku_code, ''::text)), ''::text) IS NOT NULL
        )
 SELECT seller.source_channel,
    seller.product_code,
    seller.option_code,
    seller.product_name,
    seller.option_name,
    explicit_link.product_code IS NOT NULL OR explicit_listing.product_code IS NULL AND legacy_link.product_code IS NOT NULL AS is_connected
   FROM seller_skus seller
     LEFT JOIN explicit_listings explicit_listing USING (source_channel, product_code, option_code)
     LEFT JOIN explicit_links explicit_link USING (source_channel, product_code, option_code)
     LEFT JOIN legacy_links legacy_link USING (source_channel, product_code, option_code);;
create view public.operations_hub_seller_connection_summary with(security_invoker=true)as
select source_channel,count(*)::integer seller_sku_total,count(*)filter(where is_connected)::integer seller_connected_sku,count(*)filter(where not is_connected)::integer seller_unmatched_sku
from public.operations_hub_seller_connection_live group by source_channel;
create view public.operations_hub_dashboard_metrics with(security_invoker=true)as
 SELECT total_sku,
    connected_sku,
    unmatched_sku,
    inventory_mismatch_sku,
    latest_sync_at,
    today_picked,
    shortage_drawer_qty,
    projected_inventory_mismatch_sku,
    inventory_draft_cells,
    inventory_failed_cells,
    seller_sku_total,
    seller_connected_sku,
    seller_unmatched_sku,
    seller_unmatched_smartstore,
    seller_unmatched_makeshop,
    seller_unmatched_ably
   FROM operations_private.operations_hub_dashboard_metrics_cache
  WHERE singleton;;
revoke all on public.operations_hub_seller_connection_live,public.operations_hub_seller_unmatched_live,public.operations_hub_seller_connection_summary,public.operations_hub_dashboard_metrics from public;
grant select on public.operations_hub_seller_connection_live,public.operations_hub_seller_unmatched_live,public.operations_hub_seller_connection_summary,public.operations_hub_dashboard_metrics to anon,authenticated;

drop materialized view operations_private.hub_seller_connection_cache_v1;
drop function operations_private.hub_seller_connection_state_v1();
drop function operations_private.hub_seller_connection_input_version_v1();
notify pgrst,'reload schema';

