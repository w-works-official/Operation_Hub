create table public.operations_hub_inventory_survey_snapshots (
  snapshot_id uuid primary key default gen_random_uuid(),
  survey_date date not null default ((now() at time zone 'Asia/Seoul')::date),
  source_file_name text not null,
  source_file_size bigint not null default 0,
  source_row_count integer not null default 0,
  valid_row_count integer not null default 0,
  upload_status text not null default 'uploading'
    check (upload_status in ('uploading', 'ready', 'failed')),
  uploaded_by text not null default 'operations_hub_frontend',
  upload_note text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table public.operations_hub_inventory_survey_rows (
  snapshot_id uuid not null references public.operations_hub_inventory_survey_snapshots(snapshot_id) on delete cascade,
  sellpia_sku_code text not null,
  own_code text,
  counted_qty integer not null,
  source_row_no integer,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (snapshot_id, sellpia_sku_code)
);

create index operations_hub_inventory_survey_latest_idx
  on public.operations_hub_inventory_survey_snapshots(survey_date desc, completed_at desc, created_at desc)
  where upload_status = 'ready';

create index operations_hub_inventory_survey_rows_sku_idx
  on public.operations_hub_inventory_survey_rows(sellpia_sku_code, snapshot_id);

alter table public.operations_hub_inventory_survey_snapshots enable row level security;
alter table public.operations_hub_inventory_survey_rows enable row level security;

create policy "inventory survey snapshots readable"
  on public.operations_hub_inventory_survey_snapshots for select
  to anon, authenticated using (true);

create policy "inventory survey snapshots insertable"
  on public.operations_hub_inventory_survey_snapshots for insert
  to anon, authenticated
  with check (uploaded_by = 'operations_hub_frontend' and upload_status in ('uploading', 'failed'));

create policy "inventory survey snapshots updatable"
  on public.operations_hub_inventory_survey_snapshots for update
  to anon, authenticated
  using (uploaded_by = 'operations_hub_frontend')
  with check (uploaded_by = 'operations_hub_frontend' and upload_status in ('uploading', 'ready', 'failed'));

create policy "inventory survey rows readable"
  on public.operations_hub_inventory_survey_rows for select
  to anon, authenticated using (true);

create policy "inventory survey rows insertable"
  on public.operations_hub_inventory_survey_rows for insert
  to anon, authenticated
  with check (exists (
    select 1
    from public.operations_hub_inventory_survey_snapshots snapshot
    where snapshot.snapshot_id = operations_hub_inventory_survey_rows.snapshot_id
      and snapshot.uploaded_by = 'operations_hub_frontend'
      and snapshot.upload_status = 'uploading'
  ));

revoke all on table public.operations_hub_inventory_survey_snapshots from public;
revoke all on table public.operations_hub_inventory_survey_rows from public;
grant select, insert, update on table public.operations_hub_inventory_survey_snapshots to anon, authenticated;
grant select, insert on table public.operations_hub_inventory_survey_rows to anon, authenticated;
