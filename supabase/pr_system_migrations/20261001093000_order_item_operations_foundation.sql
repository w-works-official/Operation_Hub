-- TARGET: picking project vgxocngpykhlkosiaeew only.
-- Additive foundation for scraper-independent order-item operational state.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '15s';

alter table public.order_items
  add column if not exists sellpia_supplier_cell_raw text;

comment on column public.order_items.sellpia_supplier_cell_raw is
  'Unparsed Sellpia c_in_provider_name value shown as 매입처명/매입처/셀.';

create table if not exists public.order_item_operations (
  operation_id uuid primary key default gen_random_uuid(),
  ord_no text not null,
  sellpia_order_item_no text,
  item_no text,

  custom_required_at timestamptz,
  custom_ordered_on date,
  custom_received_on date,
  custom_cancelled_at timestamptz,

  inbound_expected_date date,
  inbound_expected_source text,
  internal_memo text,

  sellpia_product_code_snapshot text,
  own_code_snapshot text,
  product_name_snapshot text,
  product_option_snapshot text,
  supplier_cell_raw_snapshot text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint order_item_operations_identity_present_check check (
    nullif(btrim(sellpia_order_item_no), '') is not null
    or nullif(btrim(item_no), '') is not null
  ),
  constraint order_item_operations_inbound_source_check check (
    inbound_expected_source is null
    or inbound_expected_source in ('manual', 'sku_schedule')
  ),
  constraint order_item_operations_source_date_check check (
    inbound_expected_source is not null
    or inbound_expected_date is null
  ),
  constraint order_item_operations_sku_schedule_date_check check (
    inbound_expected_source <> 'sku_schedule'
    or inbound_expected_date is not null
  )
);

comment on table public.order_item_operations is
  'Persistent operator-owned state that survives Sellpia order_items cleanup and re-scrape.';
comment on column public.order_item_operations.inbound_expected_source is
  'NULL=no override/legacy fallback; manual includes explicit NULL date clear; sku_schedule is automatic.';

create unique index if not exists order_item_operations_regular_identity_uidx
  on public.order_item_operations (ord_no, sellpia_order_item_no)
  where nullif(btrim(sellpia_order_item_no), '') is not null;

create unique index if not exists order_item_operations_legacy_identity_uidx
  on public.order_item_operations (ord_no, item_no)
  where nullif(btrim(sellpia_order_item_no), '') is null
    and nullif(btrim(item_no), '') is not null;

create index if not exists order_item_operations_inbound_expected_date_idx
  on public.order_item_operations (inbound_expected_date)
  where inbound_expected_source is not null;

create or replace function public.set_order_item_operations_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists order_item_operations_set_updated_at on public.order_item_operations;
create trigger order_item_operations_set_updated_at
before update on public.order_item_operations
for each row execute function public.set_order_item_operations_updated_at();

alter table public.order_item_operations enable row level security;

-- The current picking app uses the publishable key without a Supabase Auth
-- session. Identity and creation metadata stay immutable after insert; only
-- operational state and NULL snapshot backfill fields are updateable.
revoke all on table public.order_item_operations from anon, authenticated;
grant select, insert on table public.order_item_operations to anon, authenticated;
grant update (
  custom_required_at,
  custom_ordered_on,
  custom_received_on,
  custom_cancelled_at,
  inbound_expected_date,
  inbound_expected_source,
  internal_memo,
  sellpia_product_code_snapshot,
  own_code_snapshot,
  product_name_snapshot,
  product_option_snapshot,
  supplier_cell_raw_snapshot,
  updated_at
) on table public.order_item_operations to anon, authenticated;

drop policy if exists "order item operations read" on public.order_item_operations;
drop policy if exists "order item operations create" on public.order_item_operations;
drop policy if exists "order item operations update mutable state" on public.order_item_operations;

create policy "order item operations read"
on public.order_item_operations for select to anon, authenticated
using (true);

create policy "order item operations create"
on public.order_item_operations for insert to anon, authenticated
with check (
  length(btrim(ord_no)) > 0
  and (
    nullif(btrim(sellpia_order_item_no), '') is not null
    or nullif(btrim(item_no), '') is not null
  )
  and (
    inbound_expected_source is null
    or inbound_expected_source in ('manual', 'sku_schedule')
  )
);

create policy "order item operations update mutable state"
on public.order_item_operations for update to anon, authenticated
using (true)
with check (
  length(btrim(ord_no)) > 0
  and (
    inbound_expected_source is null
    or inbound_expected_source in ('manual', 'sku_schedule')
  )
);

notify pgrst, 'reload schema';
commit;
