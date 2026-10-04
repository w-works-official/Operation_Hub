create table if not exists public.seller_inventory_snapshots (
  snapshot_id uuid primary key default gen_random_uuid(),
  source_channel text not null check (source_channel in ('smartstore', 'makeshop', 'ably')),
  source_file_names text[] not null default '{}'::text[],
  source_file_size bigint,
  source_row_count integer not null default 0,
  valid_row_count integer not null default 0,
  invalid_row_count integer not null default 0,
  upload_status text not null default 'uploading' check (upload_status in ('uploading', 'ready', 'failed')),
  selected_fields jsonb not null default '{}'::jsonb,
  uploaded_by text not null default 'operations_hub_frontend',
  upload_note text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.seller_inventory_snapshot_rows (
  snapshot_id uuid not null references public.seller_inventory_snapshots(snapshot_id) on delete cascade,
  product_code text not null,
  option_code text not null default '',
  seller_code text,
  product_name text,
  option_name text,
  stock integer,
  price numeric,
  sale_status text,
  source_row_no integer,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (snapshot_id, product_code, option_code)
);

create index if not exists seller_inventory_snapshots_latest_idx
  on public.seller_inventory_snapshots(source_channel, completed_at desc, created_at desc)
  where upload_status = 'ready';

create index if not exists seller_inventory_rows_lookup_idx
  on public.seller_inventory_snapshot_rows(product_code, option_code, snapshot_id);

alter table public.seller_inventory_snapshots enable row level security;
alter table public.seller_inventory_snapshot_rows enable row level security;

drop policy if exists "seller inventory snapshots readable" on public.seller_inventory_snapshots;
create policy "seller inventory snapshots readable"
  on public.seller_inventory_snapshots for select
  to anon, authenticated
  using (true);

drop policy if exists "seller inventory snapshots insertable" on public.seller_inventory_snapshots;
create policy "seller inventory snapshots insertable"
  on public.seller_inventory_snapshots for insert
  to anon, authenticated
  with check (
    uploaded_by = 'operations_hub_frontend'
    and upload_status in ('uploading', 'failed')
  );

drop policy if exists "seller inventory snapshots updatable" on public.seller_inventory_snapshots;
create policy "seller inventory snapshots updatable"
  on public.seller_inventory_snapshots for update
  to anon, authenticated
  using (uploaded_by = 'operations_hub_frontend')
  with check (
    uploaded_by = 'operations_hub_frontend'
    and upload_status in ('uploading', 'ready', 'failed')
  );

drop policy if exists "seller inventory rows readable" on public.seller_inventory_snapshot_rows;
create policy "seller inventory rows readable"
  on public.seller_inventory_snapshot_rows for select
  to anon, authenticated
  using (true);

drop policy if exists "seller inventory rows insertable" on public.seller_inventory_snapshot_rows;
create policy "seller inventory rows insertable"
  on public.seller_inventory_snapshot_rows for insert
  to anon, authenticated
  with check (
    exists (
      select 1
      from public.seller_inventory_snapshots snapshot
      where snapshot.snapshot_id = seller_inventory_snapshot_rows.snapshot_id
        and snapshot.uploaded_by = 'operations_hub_frontend'
        and snapshot.upload_status = 'uploading'
    )
  );

drop policy if exists "seller inventory rows updatable" on public.seller_inventory_snapshot_rows;
create policy "seller inventory rows updatable"
  on public.seller_inventory_snapshot_rows for update
  to anon, authenticated
  using (
    exists (
      select 1
      from public.seller_inventory_snapshots snapshot
      where snapshot.snapshot_id = seller_inventory_snapshot_rows.snapshot_id
        and snapshot.uploaded_by = 'operations_hub_frontend'
        and snapshot.upload_status = 'uploading'
    )
  )
  with check (
    exists (
      select 1
      from public.seller_inventory_snapshots snapshot
      where snapshot.snapshot_id = seller_inventory_snapshot_rows.snapshot_id
        and snapshot.uploaded_by = 'operations_hub_frontend'
        and snapshot.upload_status = 'uploading'
    )
  );

revoke all on table public.seller_inventory_snapshots from public;
revoke all on table public.seller_inventory_snapshot_rows from public;
grant select, insert, update on table public.seller_inventory_snapshots to anon, authenticated;
grant select, insert, update on table public.seller_inventory_snapshot_rows to anon, authenticated;

create or replace function public.finalize_seller_inventory_snapshot(p_snapshot_id uuid)
returns table(snapshot_id uuid, source_channel text, row_count integer, completed_at timestamptz)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_source text;
  v_selected jsonb;
  v_previous uuid;
  v_completed timestamptz := now();
  v_row_count integer;
begin
  select snapshot.source_channel, snapshot.selected_fields
    into v_source, v_selected
  from public.seller_inventory_snapshots snapshot
  where snapshot.snapshot_id = p_snapshot_id
    and snapshot.uploaded_by = 'operations_hub_frontend'
    and snapshot.upload_status = 'uploading'
  for update;

  if not found then
    raise exception '업로드 중인 판매처 스냅샷을 찾을 수 없습니다.';
  end if;

  select snapshot.snapshot_id
    into v_previous
  from public.seller_inventory_snapshots snapshot
  where snapshot.source_channel = v_source
    and snapshot.upload_status = 'ready'
    and snapshot.snapshot_id <> p_snapshot_id
  order by snapshot.completed_at desc nulls last, snapshot.created_at desc
  limit 1;

  if v_previous is not null then
    update public.seller_inventory_snapshot_rows current_row
    set
      seller_code = case when coalesce((v_selected ->> 'basic')::boolean, false) then current_row.seller_code else previous_row.seller_code end,
      product_name = case when coalesce((v_selected ->> 'basic')::boolean, false) then current_row.product_name else previous_row.product_name end,
      option_name = case when coalesce((v_selected ->> 'basic')::boolean, false) then current_row.option_name else previous_row.option_name end,
      stock = case when coalesce((v_selected ->> 'inventory')::boolean, false) then current_row.stock else previous_row.stock end,
      price = case when coalesce((v_selected ->> 'price')::boolean, false) then current_row.price else previous_row.price end,
      sale_status = case when coalesce((v_selected ->> 'status')::boolean, false) then current_row.sale_status else previous_row.sale_status end
    from public.seller_inventory_snapshot_rows previous_row
    where current_row.snapshot_id = p_snapshot_id
      and previous_row.snapshot_id = v_previous
      and previous_row.product_code = current_row.product_code
      and previous_row.option_code = current_row.option_code;
  end if;

  select count(*)::integer
    into v_row_count
  from public.seller_inventory_snapshot_rows row_item
  where row_item.snapshot_id = p_snapshot_id;

  update public.seller_inventory_snapshots snapshot
  set valid_row_count = v_row_count,
      invalid_row_count = greatest(snapshot.source_row_count - v_row_count, 0),
      upload_status = 'ready',
      completed_at = v_completed
  where snapshot.snapshot_id = p_snapshot_id;

  return query select p_snapshot_id, v_source, v_row_count, v_completed;
end;
$$;

revoke all on function public.finalize_seller_inventory_snapshot(uuid) from public;
grant execute on function public.finalize_seller_inventory_snapshot(uuid) to anon, authenticated;

create or replace view public.seller_inventory_latest
with (security_invoker = true)
as
with latest_snapshot as (
  select distinct on (snapshot.source_channel)
    snapshot.snapshot_id,
    snapshot.source_channel,
    snapshot.completed_at
  from public.seller_inventory_snapshots snapshot
  where snapshot.upload_status = 'ready'
  order by snapshot.source_channel, snapshot.completed_at desc nulls last, snapshot.created_at desc
)
select
  latest.source_channel,
  row_item.product_code,
  row_item.option_code,
  row_item.seller_code,
  row_item.product_name,
  row_item.option_name,
  row_item.stock,
  row_item.price,
  row_item.sale_status,
  latest.completed_at as snapshot_completed_at
from latest_snapshot latest
join public.seller_inventory_snapshot_rows row_item
  on row_item.snapshot_id = latest.snapshot_id;

revoke all on public.seller_inventory_latest from public;
grant select on public.seller_inventory_latest to anon, authenticated;

create or replace view public.operations_hub_matrix_live
with (security_invoker = true)
as
select
  matrix.*,
  nullif(btrim(stock.sellpia_product_name), '') as sellpia_product_name,
  nullif(btrim(stock.sellpia_option_name), '') as sellpia_option_name,
  nullif(btrim(stock.own_sku), '') as sellpia_own_code,
  stock.stock as sellpia_current_stock,
  coalesce(stock.available_stock, stock.integrated_available_stock, stock.stock) as sellpia_available_stock,
  stock.safety_stock as sellpia_safety_stock,
  nullif(regexp_replace(coalesce(stock.raw_payload ->> 'sell_price', ''), '[^0-9.-]', '', 'g'), '')::numeric as sellpia_sale_price,
  stock.snapshot_completed_at as sellpia_inventory_at,
  smartstore.stock as smartstore_stock,
  smartstore.price as smartstore_price,
  smartstore.snapshot_completed_at as smartstore_inventory_at,
  makeshop.stock as makeshop_stock,
  makeshop.price as makeshop_price,
  makeshop.snapshot_completed_at as makeshop_inventory_at,
  ably.stock as ably_stock,
  ably.price as ably_price,
  ably.snapshot_completed_at as ably_inventory_at,
  case
    when matrix.smartstore_match_tier = 'FAST_REVIEW'
      or matrix.makeshop_match_tier = 'FAST_REVIEW'
      or matrix.ably_match_tier = 'FAST_REVIEW' then 'review'
    when matrix.smartstore_match_tier is null
      and matrix.makeshop_match_tier is null
      and matrix.ably_match_tier is null then 'unmatched'
    else 'connected'
  end::text as overall_status
from public.operations_hub_matrix matrix
left join public.sellpia_stock_latest stock
  on stock.sellpia_sku_code = matrix.sellpia_sku_code
left join public.seller_inventory_latest smartstore
  on smartstore.source_channel = 'smartstore'
  and smartstore.product_code = matrix.smartstore_product_code
  and smartstore.option_code = coalesce(matrix.smartstore_option_code, '')
left join public.seller_inventory_latest makeshop
  on makeshop.source_channel = 'makeshop'
  and makeshop.product_code = matrix.makeshop_product_code
  and makeshop.option_code = coalesce(matrix.makeshop_option_code, '')
left join public.seller_inventory_latest ably
  on ably.source_channel = 'ably'
  and ably.product_code = matrix.ably_product_code
  and ably.option_code = coalesce(matrix.ably_option_code, '');

comment on view public.operations_hub_matrix_live is
  'Read-only SKU matrix enriched with the latest ready Sellpia and seller stock/price snapshots.';

revoke all on public.operations_hub_matrix_live from public;
grant select on public.operations_hub_matrix_live to anon, authenticated;

create or replace view public.operations_hub_source_status
with (security_invoker = true)
as
select
  event.source,
  event.event_type,
  event.status,
  event.event_at,
  event.duration_ms,
  event.processed_rows,
  event.total_rows,
  event.output_rows,
  event.payload
from public.source_sync_events event
where event.event_at >= now() - interval '30 days'
union all
select
  snapshot.source_channel as source,
  'SOURCE_UPLOAD'::text as event_type,
  case snapshot.upload_status
    when 'ready' then 'SUCCESS'
    when 'failed' then 'ERROR'
    else 'RUNNING'
  end::text as status,
  coalesce(snapshot.completed_at, snapshot.created_at) as event_at,
  case when snapshot.completed_at is null then null else (extract(epoch from snapshot.completed_at - snapshot.created_at) * 1000)::bigint end as duration_ms,
  snapshot.valid_row_count as processed_rows,
  snapshot.source_row_count as total_rows,
  snapshot.valid_row_count as output_rows,
  snapshot.metadata || jsonb_build_object(
    'snapshot_id', snapshot.snapshot_id,
    'file_names', snapshot.source_file_names,
    'selected_fields', snapshot.selected_fields
  ) as payload
from public.seller_inventory_snapshots snapshot
where snapshot.created_at >= now() - interval '30 days';

revoke all on public.operations_hub_source_status from public;
grant select on public.operations_hub_source_status to anon, authenticated;

notify pgrst, 'reload schema';
