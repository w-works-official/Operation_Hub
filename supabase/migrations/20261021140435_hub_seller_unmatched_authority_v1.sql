-- One current seller identity authority for unmatched templates and metrics.
-- Source, mapping, exclusion, ABLY and price/history rows are never changed.
-- Explicit empty listings are disconnect fences; suppressions are not removed.
set local lock_timeout='2s';
set local statement_timeout='30s';

create or replace function operations_private.hub_seller_connection_state_v1()
returns table(source_channel text,product_code text,option_code text,product_name text,option_name text,is_connected boolean,is_excluded boolean)
language sql stable security invoker set search_path=pg_catalog
as $state$
with
seller as materialized(select source_channel,product_code,coalesce(option_code,'')option_code,max(product_name)product_name,max(option_name)option_name from public.seller_inventory_latest group by source_channel,product_code,coalesce(option_code,'')),
skus as materialized(select sellpia_sku_code from public.sellpia_stock_latest),
listings as materialized(select listing_id,source_channel,product_code,coalesce(option_code,'')option_code from public.operations_hub_seller_listings where is_active),
explicit_edges as materialized(select l.source_channel,l.product_code,l.option_code,c.sellpia_sku_code from listings l join public.operations_hub_listing_components c using(listing_id)join skus using(sellpia_sku_code)where c.is_active),
manual_edges as materialized(select m.source_channel,m.product_code,coalesce(m.option_code,'')option_code,m.sellpia_sku_code from public.operations_hub_manual_links m join skus using(sellpia_sku_code)),
primary_edges as materialized(select e.sellpia_sku_code,s.source_channel,coalesce(m.product_code,s.product_code)product_code,coalesce(m.option_code,s.option_code,'')option_code from operations_private.operations_hub_matrix_core e join skus using(sellpia_sku_code)cross join lateral(values('smartstore',e.smartstore_product_code,e.smartstore_option_code),('makeshop',e.makeshop_product_code,e.makeshop_option_code),('ably',e.ably_product_code,e.ably_option_code))s(source_channel,product_code,option_code)left join manual_edges m on m.source_channel=s.source_channel and m.sellpia_sku_code=e.sellpia_sku_code),
legacy_edges as materialized(select c.source_channel,c.product_code,coalesce(c.option_code,'')option_code,c.sellpia_sku_code from public.operations_hub_listing_legacy_cache c join skus using(sellpia_sku_code)left join manual_edges m on m.source_channel=c.source_channel and m.sellpia_sku_code=c.sellpia_sku_code where m.sellpia_sku_code is null or(m.product_code,m.option_code)=(c.product_code,coalesce(c.option_code,''))),
cache_raw as materialized(
select 'smartstore'::text source_channel,smartstore_product_code product_code,coalesce(smartstore_option_code,'')option_code,sellpia_sku_code from operations_private.operations_hub_matrix_export_cache where smartstore_product_code is not null
union all select 'makeshop',makeshop_product_code,coalesce(makeshop_option_code,''),sellpia_sku_code from operations_private.operations_hub_matrix_export_cache where makeshop_product_code is not null
union all select 'ably',ably_product_code,coalesce(ably_option_code,''),sellpia_sku_code from operations_private.operations_hub_matrix_export_cache where ably_product_code is not null),
cache_edges as materialized(select c.*from cache_raw c join skus using(sellpia_sku_code)left join manual_edges m on m.source_channel=c.source_channel and m.sellpia_sku_code=c.sellpia_sku_code where m.sellpia_sku_code is null or(m.product_code,m.option_code)=(c.product_code,c.option_code)),
fallback_edges as materialized(select source_channel,product_code,option_code,sellpia_sku_code from manual_edges union select source_channel,product_code,option_code,sellpia_sku_code from primary_edges where nullif(btrim(product_code),'')is not null union select source_channel,product_code,option_code,sellpia_sku_code from legacy_edges union select source_channel,product_code,option_code,sellpia_sku_code from cache_edges where nullif(btrim(product_code),'')is not null),
candidates as materialized(select *from explicit_edges union select f.*from fallback_edges f left join listings l using(source_channel,product_code,option_code)where l.listing_id is null),
unsuppressed as materialized(select c.*from candidates c left join public.operations_hub_link_suppressions s on(s.source_channel,s.product_code,s.option_code,s.sellpia_sku_code)=(c.source_channel,c.product_code,c.option_code,c.sellpia_sku_code)where s.source_channel is null),
ably_state as materialized(select m.*,k.sellpia_sku_code is not null sku_current from public.operations_hub_ably_inventory_mappings m left join skus k using(sellpia_sku_code)),
ably_blocked as materialized(select product_code,coalesce(option_code,'')option_code from ably_state where mapping_state='conflict' union select product_code,coalesce(option_code,'')option_code from public.operations_hub_link_suppressions where source_channel='ably'),
ably_verified as materialized(select 'ably'::text source_channel,m.product_code,coalesce(m.option_code,'')option_code,m.sellpia_sku_code from ably_state m left join ably_blocked b on(b.product_code,b.option_code)=(m.product_code,coalesce(m.option_code,''))where m.mapping_state='verified'and m.sku_current and b.product_code is null and not exists(select 1 from listings l where l.source_channel='ably'and(l.product_code,l.option_code)=(m.product_code,coalesce(m.option_code,''))and not exists(select 1 from public.operations_hub_listing_components c where c.listing_id=l.listing_id and c.is_active))),
ably_override as materialized(select product_code,coalesce(option_code,'')option_code from ably_state where mapping_state in('verified','conflict') union select product_code,option_code from ably_blocked),
effective_edges as materialized(select u.*from unsuppressed u left join ably_override a on u.source_channel='ably'and(a.product_code,a.option_code)=(u.product_code,u.option_code)where a.product_code is null union select *from ably_verified),
connected as materialized(select distinct source_channel,product_code,option_code from effective_edges),
excluded_identities as materialized(
select l.source_channel,l.product_code,l.option_code from listings l where not exists(select 1 from public.operations_hub_listing_components c where c.listing_id=l.listing_id and c.is_active)
union select source_channel,product_code,coalesce(option_code,'') from public.operations_hub_link_suppressions
),
classified as materialized(select s.*,c.source_channel is not null is_connected,c.source_channel is null and x.source_channel is not null is_excluded from seller s left join connected c using(source_channel,product_code,option_code)left join excluded_identities x using(source_channel,product_code,option_code))

select source_channel,product_code,option_code,product_name,option_name,is_connected,is_excluded from classified;
$state$;

create or replace function operations_private.hub_seller_connection_input_version_v1()
returns text language sql stable security invoker set search_path=pg_catalog set timezone='UTC' set datestyle='ISO, YMD'
as $version$
select 'seller-unmatched-v1:'||md5(jsonb_build_array(
 (select coalesce(jsonb_agg(to_jsonb(s)order by s.source_channel),'[]')from(select distinct on(source_channel)source_channel,snapshot_id,upload_status,created_at,completed_at,valid_row_count from public.seller_inventory_snapshots where upload_status='ready'order by source_channel,completed_at desc nulls last,created_at desc)s),
 (select snapshot_id::text from public.sellpia_stock_snapshots where upload_status='ready'order by created_at desc limit 1),
 (select md5(coalesce(string_agg(row(s.source_channel,s.product_code,s.option_code,s.product_name,s.option_name,s.seller_code,s.price,s.sale_status)::text,E'\n'order by s.source_channel,s.product_code,s.option_code,row(s.source_channel,s.product_code,s.option_code,s.product_name,s.option_name,s.seller_code,s.price,s.sale_status)::text),''))from public.seller_inventory_latest s),
 (select md5(coalesce(string_agg(s.sellpia_sku_code,E'\n'order by s.sellpia_sku_code),''))from public.sellpia_stock_latest s),
 (select md5(coalesce(string_agg(row(m.source_channel,m.sellpia_sku_code,m.product_code,m.option_code,m.updated_at)::text,E'\n'order by m.source_channel,m.sellpia_sku_code),''))from public.operations_hub_manual_links m),
 (select md5(coalesce(string_agg(row(l.listing_id,l.source_channel,l.product_code,l.option_code,l.is_active,l.updated_at)::text,E'\n'order by l.listing_id),''))from public.operations_hub_seller_listings l),
 (select md5(coalesce(string_agg(row(c.component_id,c.listing_id,c.sellpia_sku_code,c.component_qty,c.component_role,c.is_active,c.parent_component_id,c.updated_at)::text,E'\n'order by c.component_id),''))from public.operations_hub_listing_components c),
 (select md5(coalesce(string_agg(row(s.source_channel,s.sellpia_sku_code,s.product_code,s.option_code,s.reason,s.suppressed_at)::text,E'\n'order by s.source_channel,s.sellpia_sku_code,s.product_code,s.option_code),''))from public.operations_hub_link_suppressions s),
 (select md5(coalesce(string_agg(row(a.product_code,a.option_code,a.solution_code,a.sellpia_sku_code,a.mapping_state,a.is_active,a.updated_at)::text,E'\n'order by a.product_code,a.option_code),''))from public.operations_hub_ably_inventory_mappings a),
 (select md5(coalesce(string_agg(row(c.sellpia_sku_code,c.smartstore_product_code,c.smartstore_option_code,c.makeshop_product_code,c.makeshop_option_code,c.ably_product_code,c.ably_option_code,c.updated_at)::text,E'\n'order by c.sellpia_sku_code),''))from operations_private.operations_hub_matrix_core c),
 (select md5(coalesce(string_agg(row(c.source_channel,c.product_code,c.option_code,c.sellpia_sku_code,c.product_name,c.option_name,c.refreshed_at)::text,E'\n'order by c.source_channel,c.product_code,c.option_code,c.sellpia_sku_code),''))from public.operations_hub_listing_legacy_cache c),
 (select md5(coalesce(string_agg(row(c.source_channel,c.product_code,c.option_code,c.sellpia_sku_code)::text,E'\n'order by c.source_channel,c.product_code,c.option_code,c.sellpia_sku_code),''))from(
 select 'smartstore'::text source_channel,smartstore_product_code product_code,smartstore_option_code option_code,sellpia_sku_code from operations_private.operations_hub_matrix_export_cache where smartstore_product_code is not null
 union all select 'makeshop',makeshop_product_code,makeshop_option_code,sellpia_sku_code from operations_private.operations_hub_matrix_export_cache where makeshop_product_code is not null
 union all select 'ably',ably_product_code,ably_option_code,sellpia_sku_code from operations_private.operations_hub_matrix_export_cache where ably_product_code is not null)c)
)::text);
$version$;

create materialized view operations_private.hub_seller_connection_cache_v1 as
with generation as materialized(select operations_private.hub_seller_connection_input_version_v1()input_version,statement_timestamp()refreshed_at)
select s.*,g.input_version,g.refreshed_at from operations_private.hub_seller_connection_state_v1()s cross join generation g;
create unique index hub_seller_connection_cache_v1_identity_idx on operations_private.hub_seller_connection_cache_v1(source_channel,product_code,option_code);
create index hub_seller_connection_cache_v1_unmatched_idx on operations_private.hub_seller_connection_cache_v1(source_channel,product_code,option_code)where not is_connected and not is_excluded;
revoke all on operations_private.hub_seller_connection_cache_v1 from public;
grant select on operations_private.hub_seller_connection_cache_v1 to anon,authenticated;

-- Existing public contracts read one independently populated generation.
-- The historical unmatched MV now reads this public view -> new cache: no cycle.
create or replace view public.operations_hub_seller_connection_live with(security_invoker=true)as
select source_channel,product_code,option_code,product_name,option_name,is_connected,is_excluded from operations_private.hub_seller_connection_cache_v1;
create or replace view public.operations_hub_seller_unmatched_live with(security_invoker=true)as
select source_channel,product_code,option_code,product_name,option_name from operations_private.hub_seller_connection_cache_v1 where not is_connected and not is_excluded;
create or replace view public.operations_hub_seller_connection_summary with(security_invoker=true)as
select source_channel,count(*)::integer seller_sku_total,count(*)filter(where is_connected)::integer seller_connected_sku,count(*)filter(where not is_connected and not is_excluded)::integer seller_unmatched_sku,count(*)filter(where is_excluded)::integer seller_excluded_sku
from operations_private.hub_seller_connection_cache_v1 group by source_channel;
revoke all on public.operations_hub_seller_connection_live,public.operations_hub_seller_unmatched_live,public.operations_hub_seller_connection_summary from public;
grant select on public.operations_hub_seller_connection_live,public.operations_hub_seller_unmatched_live,public.operations_hub_seller_connection_summary to anon,authenticated;

create or replace view public.operations_hub_dashboard_metrics with(security_invoker=true)as
with counts as(
 select count(*)::integer seller_sku_total,count(*)filter(where is_connected)::integer seller_connected_sku,
 count(*)filter(where not is_connected and not is_excluded)::integer seller_unmatched_sku,
 count(*)filter(where not is_connected and not is_excluded and source_channel='smartstore')::integer seller_unmatched_smartstore,
 count(*)filter(where not is_connected and not is_excluded and source_channel='makeshop')::integer seller_unmatched_makeshop,
 count(*)filter(where not is_connected and not is_excluded and source_channel='ably')::integer seller_unmatched_ably,
 count(*)filter(where is_excluded)::integer seller_excluded_sku
 from operations_private.hub_seller_connection_cache_v1)
select base.total_sku,base.connected_sku,base.unmatched_sku,base.inventory_mismatch_sku,base.latest_sync_at,base.today_picked,base.shortage_drawer_qty,base.projected_inventory_mismatch_sku,base.inventory_draft_cells,base.inventory_failed_cells,
 counts.seller_sku_total,counts.seller_connected_sku,counts.seller_unmatched_sku,counts.seller_unmatched_smartstore,counts.seller_unmatched_makeshop,counts.seller_unmatched_ably,counts.seller_excluded_sku
from operations_private.operations_hub_dashboard_metrics_cache base cross join counts where base.singleton;


create or replace function operations_private.hub_seller_connection_current_v1(p_version text)
returns table(source_channel text,product_code text,option_code text,product_name text,option_name text,is_connected boolean,is_excluded boolean)
language plpgsql stable security invoker set search_path=pg_catalog
as $current$
declare v_cached text;
begin
 select c.input_version into v_cached from operations_private.hub_seller_connection_cache_v1 c limit 1;
 if v_cached=p_version then
  return query select c.source_channel,c.product_code,c.option_code,c.product_name,c.option_name,c.is_connected,c.is_excluded from operations_private.hub_seller_connection_cache_v1 c;
 else
  -- Read-only fallback uses the identical authority when any dependency changed.
  return query select s.*from operations_private.hub_seller_connection_state_v1()s;
 end if;
end;
$current$;

create or replace function operations_private.hub_seller_unmatched_payload_v1(p_offset integer default 0,p_limit integer default 1000,p_expected_version text default null)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog
as $payload$
declare v_version text;v_payload jsonb;
begin
 if p_offset is null or p_offset<0 or p_limit is null or p_limit<0 or p_limit>1000 then
  raise exception using errcode='22023',message='미연결 목록 조회 범위가 올바르지 않습니다.';
 end if;
 v_version:=operations_private.hub_seller_connection_input_version_v1();
 if p_expected_version is not null and p_expected_version<>v_version then
  raise exception using errcode='40001',message='조회 중 판매처 연결 데이터가 변경되었습니다. 목록을 다시 조회하세요.';
 end if;
 with state as materialized(select *from operations_private.hub_seller_connection_current_v1(v_version)),
 unmatched as materialized(select source_channel,product_code,option_code,product_name,option_name from state where not is_connected and not is_excluded),
 counts as(select count(*)::integer total,
 count(*)filter(where source_channel='smartstore')::integer smartstore,
 count(*)filter(where source_channel='makeshop')::integer makeshop,
 count(*)filter(where source_channel='ably')::integer ably from unmatched),
 page as(select *from unmatched order by source_channel,product_code,option_code offset p_offset limit p_limit)
 select jsonb_build_object('contract_version',1,'cache_version',v_version,'total',c.total,
 'source_counts',jsonb_build_object('smartstore',c.smartstore,'makeshop',c.makeshop,'ably',c.ably),
 'offset',p_offset,'rows',coalesce((select jsonb_agg(to_jsonb(p)order by p.source_channel,p.product_code,p.option_code)from page p),'[]'::jsonb),
 'has_more',(p_offset::bigint+(select count(*)from page))<c.total,
 'seller_total',(select count(*)from state),'seller_connected',(select count(*)from state where is_connected),'seller_excluded',(select count(*)from state where is_excluded))
 into v_payload from counts c;
 return v_payload;
end;
$payload$;

create or replace function operations_private.hub_seller_unmatched_read_session_v1(p_session_token text,p_offset integer,p_limit integer,p_expected_version text)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog set statement_timeout='20s'
as $session$
begin
 perform operations_private.require_operations_hub_operator_session(p_session_token);
 return operations_private.hub_seller_unmatched_payload_v1(p_offset,p_limit,p_expected_version);
end;
$session$;
create or replace function public.hub_seller_unmatched_read_v1(p_session_token text,p_offset integer default 0,p_limit integer default 1000,p_expected_version text default null)
returns jsonb language sql stable security invoker set search_path=pg_catalog set statement_timeout='20s'
as $rpc$
select operations_private.hub_seller_unmatched_read_session_v1(p_session_token,p_offset,p_limit,p_expected_version);
$rpc$;


create or replace function operations_private.refresh_hub_seller_connection_cache_v1(p_actor text default 'seller_connection_cache')
returns jsonb language plpgsql security invoker set search_path=pg_catalog set statement_timeout='20s'
as $refresh$
declare v_actor text:=coalesce(nullif(btrim(p_actor),''),'seller_connection_cache');v_version text;v_cached text;
begin
 if v_actor!~'^[0-9A-Za-z_.:@-]{3,120}$'then raise exception 'actor 형식이 올바르지 않습니다.';end if;
 if not pg_try_advisory_xact_lock(hashtextextended('hub_seller_connection_cache_v1_refresh',0))then
  return jsonb_build_object('status','locked','refreshed_by',v_actor);
 end if;
 v_version:=operations_private.hub_seller_connection_input_version_v1();
 select input_version into v_cached from operations_private.hub_seller_connection_cache_v1 limit 1;
 if v_version=v_cached then return jsonb_build_object('status','skipped','reason','cache_is_current','cache_version',v_version,'refreshed_by',v_actor);end if;
 refresh materialized view concurrently operations_private.hub_seller_connection_cache_v1;
 refresh materialized view concurrently operations_private.operations_hub_seller_unmatched_cache;
 return jsonb_build_object('status','refreshed','cache_version',(select input_version from operations_private.hub_seller_connection_cache_v1 limit 1),'refreshed_by',v_actor);
end;
$refresh$;


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
  perform operations_private.refresh_hub_seller_connection_cache_v1(v_actor);
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
$function$;


revoke all on function operations_private.hub_seller_connection_state_v1(),operations_private.hub_seller_connection_input_version_v1(),operations_private.hub_seller_connection_current_v1(text),operations_private.hub_seller_unmatched_payload_v1(integer,integer,text),operations_private.refresh_hub_seller_connection_cache_v1(text) from public,anon,authenticated,service_role;
revoke all on function operations_private.hub_seller_unmatched_read_session_v1(text,integer,integer,text),public.hub_seller_unmatched_read_v1(text,integer,integer,text)from public,anon,authenticated,service_role;
grant execute on function operations_private.hub_seller_unmatched_read_session_v1(text,integer,integer,text),public.hub_seller_unmatched_read_v1(text,integer,integer,text)to anon,authenticated;

-- A separate job validates all seller-connection dependencies, including deletes.
-- It refreshes only this derived cache, never source/core/mapping/price data.
do $cron$
begin
 if to_regclass('cron.job')is not null then
  perform cron.schedule('operations-hub-seller-connection-v1','* * * * *','select operations_private.refresh_hub_seller_connection_cache_v1(''pg_cron'')');
 end if;
end;
$cron$;
refresh materialized view operations_private.operations_hub_seller_unmatched_cache;
notify pgrst,'reload schema';

