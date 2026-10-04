-- TARGET: picking project vgxocngpykhlkosiaeew only.
-- Additive SKU-level inbound schedule master. No existing order data is changed.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '15s';

create table if not exists public.sku_inbound_schedules (
  sellpia_sku text primary key,
  inbound_expected_date date not null,
  own_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sku_inbound_schedules_sku_check check (
    length(btrim(sellpia_sku)) > 0
    and sellpia_sku = btrim(sellpia_sku)
  )
);

comment on table public.sku_inbound_schedules is
  'Operator-managed Sellpia SKU inbound schedule master used before legacy order-item dates.';
comment on column public.sku_inbound_schedules.sellpia_sku is
  'Exact Sellpia p_code value. This is a schedule key, never an order-item identity fallback.';

create or replace function public.set_sku_inbound_schedules_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.set_sku_inbound_schedules_updated_at() from public, anon, authenticated;

drop trigger if exists sku_inbound_schedules_set_updated_at on public.sku_inbound_schedules;
create trigger sku_inbound_schedules_set_updated_at
before update on public.sku_inbound_schedules
for each row execute function public.set_sku_inbound_schedules_updated_at();

alter table public.sku_inbound_schedules enable row level security;

revoke all on table public.sku_inbound_schedules from anon, authenticated;
grant select, insert on table public.sku_inbound_schedules to anon, authenticated;
grant update (
  inbound_expected_date,
  own_code,
  updated_at
) on table public.sku_inbound_schedules to anon, authenticated;

drop policy if exists "sku inbound schedules read" on public.sku_inbound_schedules;
drop policy if exists "sku inbound schedules create" on public.sku_inbound_schedules;
drop policy if exists "sku inbound schedules update" on public.sku_inbound_schedules;

create policy "sku inbound schedules read"
on public.sku_inbound_schedules for select to anon, authenticated
using (true);

create policy "sku inbound schedules create"
on public.sku_inbound_schedules for insert to anon, authenticated
with check (
  length(btrim(sellpia_sku)) > 0
  and sellpia_sku = btrim(sellpia_sku)
  and inbound_expected_date is not null
);

create policy "sku inbound schedules update"
on public.sku_inbound_schedules for update to anon, authenticated
using (true)
with check (
  length(btrim(sellpia_sku)) > 0
  and sellpia_sku = btrim(sellpia_sku)
  and inbound_expected_date is not null
);

notify pgrst, 'reload schema';
commit;
