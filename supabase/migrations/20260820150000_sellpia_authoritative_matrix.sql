alter table public.sellpia_stock_snapshot_rows
  add column if not exists supplier_code text,
  add column if not exists supplier_name text,
  add column if not exists supplier_group text,
  add column if not exists supplier_address text,
  add column if not exists supplier_market_name text,
  add column if not exists supplier_phone text,
  add column if not exists purchase_product_name text,
  add column if not exists purchase_option_name text;

comment on column public.sellpia_stock_snapshot_rows.supplier_code is '셀피아 원본 AA열 매입처코드';
comment on column public.sellpia_stock_snapshot_rows.supplier_name is '셀피아 원본 AB열 매입처';
comment on column public.sellpia_stock_snapshot_rows.supplier_group is '셀피아 원본 AC열 매입처그룹';
comment on column public.sellpia_stock_snapshot_rows.supplier_address is '셀피아 원본 AD열 매입처주소';
comment on column public.sellpia_stock_snapshot_rows.supplier_market_name is '셀피아 원본 AE열 상가명';
comment on column public.sellpia_stock_snapshot_rows.supplier_phone is '셀피아 원본 AF열 매입처전화';
comment on column public.sellpia_stock_snapshot_rows.purchase_product_name is '셀피아 원본 AG열 매입상품명';
comment on column public.sellpia_stock_snapshot_rows.purchase_option_name is '셀피아 원본 AH열 매입옵션명';

create or replace view public.sellpia_stock_latest
with (security_invoker = true)
as
select
  r.snapshot_id,
  r.sellpia_sku_code,
  r.sellpia_product_code,
  r.sellpia_product_name,
  r.sellpia_option_name,
  r.own_sku,
  r.stock,
  r.available_stock,
  r.integrated_available_stock,
  r.safety_stock,
  r.source_row_no,
  r.raw_payload,
  r.created_at,
  s.source_file_name,
  s.source_row_count,
  s.valid_row_count,
  s.invalid_row_count,
  s.created_at as snapshot_created_at,
  s.completed_at as snapshot_completed_at,
  r.supplier_code,
  r.supplier_name,
  r.supplier_group,
  r.supplier_address,
  r.supplier_market_name,
  r.supplier_phone,
  r.purchase_product_name,
  r.purchase_option_name
from public.sellpia_stock_snapshot_rows r
join public.sellpia_stock_snapshots s on s.snapshot_id = r.snapshot_id
where s.snapshot_id = (
  select snapshot_id
  from public.sellpia_stock_snapshots
  where upload_status = 'ready'
  order by created_at desc
  limit 1
);

comment on view public.sellpia_stock_latest is
  '가장 최근 ready 셀피아 업로드의 SKU, 재고, 가격 원본 및 매입처 정보. 최신 파일이 활성 SKU 행 집합의 기준이다.';

revoke all on public.sellpia_stock_latest from public;
grant select on public.sellpia_stock_latest to anon, authenticated;

create or replace view public.operations_hub_matrix
with (security_invoker = true)
as
with mapping_candidates as (
  select
    source_channel,
    sellpia_sku,
    channel_code,
    channel_product_name,
    channel_option_name,
    match_tier,
    match_score,
    imported_at as mapped_at,
    1 as source_priority,
    import_id as source_id
  from review.final_excel_mapping_import
  where nullif(btrim(sellpia_sku), '') is not null
  union all
  select
    source_channel,
    sellpia_sku,
    channel_code,
    channel_product_name,
    channel_option_name,
    match_tier,
    match_score,
    coalesce(updated_at, confirmed_at) as mapped_at,
    0 as source_priority,
    manual_mapping_id as source_id
  from review.sheet_manual_mappings
  where nullif(btrim(sellpia_sku), '') is not null
),
ranked as (
  select
    mapping_candidates.*,
    row_number() over (
      partition by source_channel, sellpia_sku
      order by source_priority, match_score desc nulls last, mapped_at desc nulls last, source_id desc
    ) as choice_rank,
    count(*) over (partition by source_channel, sellpia_sku) as listing_count
  from mapping_candidates
),
chosen as (
  select * from ranked where choice_rank = 1
)
select
  stock.sellpia_sku_code,
  coalesce(nullif(btrim(stock.own_sku), ''), nullif(btrim(p.own_code), '')) as own_code,
  coalesce(
    nullif(p.raw_payload ->> 'storage_public_url', ''),
    case
      when nullif(p.raw_payload ->> 'storage_path', '') is not null
      then 'https://bpgvqmtsjgegnrdzmpep.supabase.co/storage/v1/object/public/product-images/' || (p.raw_payload ->> 'storage_path')
      else null
    end,
    nullif(p.legacy_image_url, '')
  ) as image_url,
  coalesce(
    nullif(smart.channel_product_name, ''),
    nullif(makeshop.channel_product_name, ''),
    nullif(ably.channel_product_name, ''),
    nullif(ably.channel_option_name, ''),
    nullif(concat_ws(' / ', nullif(stock.sellpia_product_name, ''), nullif(stock.sellpia_option_name, '')), '')
  ) as display_name,
  smart.channel_product_name as smartstore_name,
  split_part(smart.channel_code, '-', 1) as smartstore_product_code,
  nullif(substring(smart.channel_code from position('-' in smart.channel_code) + 1), smart.channel_code) as smartstore_option_code,
  smart.match_tier as smartstore_match_tier,
  smart.match_score as smartstore_match_score,
  smart.listing_count as smartstore_listing_count,
  makeshop.channel_product_name as makeshop_name,
  split_part(makeshop.channel_code, '-', 1) as makeshop_product_code,
  nullif(substring(makeshop.channel_code from position('-' in makeshop.channel_code) + 1), makeshop.channel_code) as makeshop_option_code,
  makeshop.match_tier as makeshop_match_tier,
  makeshop.match_score as makeshop_match_score,
  makeshop.listing_count as makeshop_listing_count,
  coalesce(ably.channel_product_name, ably.channel_option_name) as ably_name,
  split_part(ably.channel_code, '-', 1) as ably_product_code,
  nullif(substring(ably.channel_code from position('-' in ably.channel_code) + 1), ably.channel_code) as ably_option_code,
  ably.match_tier as ably_match_tier,
  ably.match_score as ably_match_score,
  ably.listing_count as ably_listing_count,
  greatest(
    coalesce(stock.snapshot_completed_at, stock.snapshot_created_at, '-infinity'::timestamptz),
    coalesce(p.updated_at, '-infinity'::timestamptz),
    coalesce(smart.mapped_at, '-infinity'::timestamptz),
    coalesce(makeshop.mapped_at, '-infinity'::timestamptz),
    coalesce(ably.mapped_at, '-infinity'::timestamptz)
  ) as updated_at
from public.sellpia_stock_latest stock
left join catalog.sellpia_products p on p.p_code = stock.sellpia_sku_code
left join chosen smart on smart.sellpia_sku = stock.sellpia_sku_code and smart.source_channel = 'smartstore'
left join chosen makeshop on makeshop.sellpia_sku = stock.sellpia_sku_code and makeshop.source_channel = 'makeshop'
left join chosen ably on ably.sellpia_sku = stock.sellpia_sku_code and ably.source_channel = 'ably';

comment on view public.operations_hub_matrix is
  '최신 ready 셀피아 스냅샷의 SKU 행만 노출하고, 별도 보존된 판매처 매핑을 SKU 기준으로 다시 연결하는 읽기 전용 매트릭스.';

revoke all on public.operations_hub_matrix from public;
grant select on public.operations_hub_matrix to anon, authenticated;

alter table operations_private.operations_hub_matrix_refresh_state
  add column if not exists sellpia_snapshot_id uuid,
  add column if not exists sellpia_snapshot_completed_at timestamptz;

create or replace function operations_private.refresh_operations_hub_matrix_core(
  p_actor text default 'operations_hub_admin'
)
returns jsonb
language plpgsql
security definer
set search_path = public, operations_private, extensions, pg_temp
as $$
declare
  v_started_at timestamptz := clock_timestamp();
  v_completed_at timestamptz;
  v_core_rows integer;
  v_legacy_mapping_at timestamptz;
  v_sellpia_snapshot_id uuid;
  v_sellpia_snapshot_completed_at timestamptz;
begin
  if coalesce(nullif(btrim(p_actor), ''), '') !~ '^[0-9A-Za-z_.:@-]{3,120}$' then
    raise exception 'actor 형식이 올바르지 않습니다.';
  end if;

  select snapshot_id, completed_at
  into v_sellpia_snapshot_id, v_sellpia_snapshot_completed_at
  from public.sellpia_stock_snapshots
  where upload_status = 'ready'
  order by created_at desc
  limit 1;

  refresh materialized view concurrently operations_private.operations_hub_matrix_core;

  select count(*)::integer
  into v_core_rows
  from operations_private.operations_hub_matrix_core;

  select greatest(
    coalesce((select max(imported_at) from review.final_excel_mapping_import), '-infinity'::timestamptz),
    coalesce((select max(updated_at) from review.sheet_manual_mappings), '-infinity'::timestamptz)
  )
  into v_legacy_mapping_at;

  v_completed_at := clock_timestamp();
  insert into operations_private.operations_hub_matrix_refresh_state (
    singleton,
    core_refreshed_at,
    refreshed_by,
    core_row_count,
    legacy_mapping_at,
    sellpia_snapshot_id,
    sellpia_snapshot_completed_at
  ) values (
    true,
    v_completed_at,
    btrim(p_actor),
    v_core_rows,
    v_legacy_mapping_at,
    v_sellpia_snapshot_id,
    v_sellpia_snapshot_completed_at
  )
  on conflict (singleton) do update set
    core_refreshed_at = excluded.core_refreshed_at,
    refreshed_by = excluded.refreshed_by,
    core_row_count = excluded.core_row_count,
    legacy_mapping_at = excluded.legacy_mapping_at,
    sellpia_snapshot_id = excluded.sellpia_snapshot_id,
    sellpia_snapshot_completed_at = excluded.sellpia_snapshot_completed_at;

  return jsonb_build_object(
    'status', 'completed',
    'started_at', v_started_at,
    'completed_at', v_completed_at,
    'core_row_count', v_core_rows,
    'legacy_mapping_at', v_legacy_mapping_at,
    'sellpia_snapshot_id', v_sellpia_snapshot_id,
    'sellpia_snapshot_completed_at', v_sellpia_snapshot_completed_at,
    'refreshed_by', btrim(p_actor)
  );
end;
$$;

revoke all on function operations_private.refresh_operations_hub_matrix_core(text) from public, anon, authenticated;
grant execute on function operations_private.refresh_operations_hub_matrix_core(text) to service_role;

create or replace function operations_private.refresh_operations_hub_matrix_core_if_stale(
  p_actor text default 'operations_hub_legacy_bridge'
)
returns jsonb
language plpgsql
security definer
set search_path = public, operations_private, extensions, pg_temp
as $$
declare
  v_actor text := coalesce(nullif(btrim(p_actor), ''), 'operations_hub_legacy_bridge');
  v_latest_legacy timestamptz;
  v_recorded_legacy timestamptz;
  v_latest_sellpia_snapshot_id uuid;
  v_recorded_sellpia_snapshot_id uuid;
  v_core_refreshed_at timestamptz;
begin
  if v_actor !~ '^[0-9A-Za-z_.:@-]{3,120}$' then
    raise exception 'actor 형식이 올바르지 않습니다.';
  end if;

  if not pg_try_advisory_xact_lock(hashtextextended('operations_hub_matrix_core_refresh', 0)) then
    return jsonb_build_object('status', 'locked', 'refreshed_by', v_actor);
  end if;

  select greatest(
    coalesce((select max(imported_at) from review.final_excel_mapping_import), '-infinity'::timestamptz),
    coalesce((select max(updated_at) from review.sheet_manual_mappings), '-infinity'::timestamptz)
  ) into v_latest_legacy;

  select snapshot_id
  into v_latest_sellpia_snapshot_id
  from public.sellpia_stock_snapshots
  where upload_status = 'ready'
  order by created_at desc
  limit 1;

  select core_refreshed_at, legacy_mapping_at, sellpia_snapshot_id
  into v_core_refreshed_at, v_recorded_legacy, v_recorded_sellpia_snapshot_id
  from operations_private.operations_hub_matrix_refresh_state
  where singleton;

  if v_latest_legacy <= coalesce(v_recorded_legacy, '-infinity'::timestamptz)
     and v_latest_sellpia_snapshot_id is not distinct from v_recorded_sellpia_snapshot_id then
    return jsonb_build_object(
      'status', 'skipped',
      'reason', 'core_is_current',
      'legacy_mapping_at', v_latest_legacy,
      'sellpia_snapshot_id', v_latest_sellpia_snapshot_id,
      'core_refreshed_at', v_core_refreshed_at,
      'refreshed_by', v_actor
    );
  end if;

  return operations_private.refresh_operations_hub_matrix_core(v_actor);
end;
$$;

revoke all on function operations_private.refresh_operations_hub_matrix_core_if_stale(text) from public, anon, authenticated;
grant execute on function operations_private.refresh_operations_hub_matrix_core_if_stale(text) to service_role;

create or replace view public.operations_hub_sellpia_matrix_sync_status
with (security_invoker = true)
as
with latest_ready as (
  select snapshot_id, valid_row_count, completed_at, created_at
  from public.sellpia_stock_snapshots
  where upload_status = 'ready'
  order by created_at desc
  limit 1
)
select
  latest_ready.snapshot_id as latest_ready_snapshot_id,
  latest_ready.valid_row_count as latest_ready_row_count,
  coalesce(latest_ready.completed_at, latest_ready.created_at) as latest_ready_at,
  state.sellpia_snapshot_id as matrix_snapshot_id,
  state.core_row_count as matrix_row_count,
  state.core_refreshed_at as matrix_refreshed_at,
  latest_ready.snapshot_id is distinct from state.sellpia_snapshot_id as rebuild_pending
from latest_ready
cross join operations_private.operations_hub_matrix_refresh_state state
where state.singleton;

comment on view public.operations_hub_sellpia_matrix_sync_status is
  '최신 셀피아 업로드와 매트릭스 코어 재구성 완료 버전을 비교하는 읽기 전용 상태.';

revoke all on public.operations_hub_sellpia_matrix_sync_status from public;
grant select on public.operations_hub_sellpia_matrix_sync_status to anon, authenticated;

select operations_private.refresh_operations_hub_matrix_core('migration_sellpia_authoritative_matrix');

notify pgrst, 'reload schema';
