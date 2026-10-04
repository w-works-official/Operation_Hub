-- System-owned price and stock master.
-- Uploaded Sellpia and seller files remain immutable comparison snapshots.
-- The previously inferred pricing catalog is archived and retired so the
-- representative-approved catalog can be loaded later without losing audit data.

create table if not exists public.operations_hub_pricing_reset_archives (
  archive_id bigint generated always as identity primary key,
  reset_batch_id uuid not null,
  entity_type text not null check (entity_type in (
    'price_rule_tag', 'price_rule_set', 'price_rule_set_item',
    'price_rule_assignment', 'sellpia_override'
  )),
  entity_key text not null,
  payload jsonb not null,
  reset_reason text not null,
  archived_at timestamptz not null default now(),
  unique (reset_batch_id, entity_type, entity_key)
);

create index if not exists operations_hub_pricing_reset_archives_lookup_idx
  on public.operations_hub_pricing_reset_archives (entity_type, entity_key, archived_at desc);

create table if not exists public.operations_hub_sku_operational_master (
  sellpia_sku_code text primary key check (length(btrim(sellpia_sku_code)) > 0),
  base_price numeric check (base_price is null or base_price >= 0),
  stock_quantity integer check (stock_quantity is null or stock_quantity >= 0),
  price_version bigint not null default 0 check (price_version >= 0),
  stock_version bigint not null default 0 check (stock_version >= 0),
  price_updated_at timestamptz,
  stock_updated_at timestamptz,
  updated_by text not null default 'operations-hub',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists operations_hub_sku_operational_master_price_idx
  on public.operations_hub_sku_operational_master (base_price, sellpia_sku_code)
  where base_price is not null;
create index if not exists operations_hub_sku_operational_master_stock_idx
  on public.operations_hub_sku_operational_master (stock_quantity, sellpia_sku_code)
  where stock_quantity is not null;

create table if not exists public.operations_hub_sku_operational_events (
  event_id bigint generated always as identity primary key,
  sellpia_sku_code text not null,
  field_key text not null check (field_key in ('system_base_price', 'system_stock')),
  before_value numeric,
  after_value numeric,
  change_source text not null default 'manual' check (change_source in ('manual', 'source_accept', 'bulk_import', 'reset')),
  actor text not null default 'operations-hub',
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists operations_hub_sku_operational_events_sku_idx
  on public.operations_hub_sku_operational_events (sellpia_sku_code, created_at desc, event_id desc);
create index if not exists operations_hub_sku_operational_events_field_idx
  on public.operations_hub_sku_operational_events (field_key, created_at desc);

alter table public.operations_hub_pricing_reset_archives enable row level security;
alter table public.operations_hub_sku_operational_master enable row level security;
alter table public.operations_hub_sku_operational_events enable row level security;

drop policy if exists "operations hub pricing reset archives readable" on public.operations_hub_pricing_reset_archives;
create policy "operations hub pricing reset archives readable"
  on public.operations_hub_pricing_reset_archives for select
  to anon, authenticated using (true);

drop policy if exists "operations hub sku operational master readable" on public.operations_hub_sku_operational_master;
create policy "operations hub sku operational master readable"
  on public.operations_hub_sku_operational_master for select
  to anon, authenticated using (true);
drop policy if exists "operations hub sku operational master insertable" on public.operations_hub_sku_operational_master;
drop policy if exists "operations hub sku operational master updatable" on public.operations_hub_sku_operational_master;

drop policy if exists "operations hub sku operational events readable" on public.operations_hub_sku_operational_events;
create policy "operations hub sku operational events readable"
  on public.operations_hub_sku_operational_events for select
  to anon, authenticated using (true);
drop policy if exists "operations hub sku operational events insertable" on public.operations_hub_sku_operational_events;

revoke all on public.operations_hub_pricing_reset_archives from public, anon, authenticated;
revoke all on public.operations_hub_sku_operational_master from public, anon, authenticated;
revoke all on public.operations_hub_sku_operational_events from public, anon, authenticated;
grant select on public.operations_hub_pricing_reset_archives to anon, authenticated;
grant select on public.operations_hub_sku_operational_master to anon, authenticated;
grant select on public.operations_hub_sku_operational_events to anon, authenticated;

create or replace view public.operations_hub_sku_operational_live
with (security_invoker = true)
as
select
  master.sellpia_sku_code,
  master.base_price as system_base_price,
  master.stock_quantity as system_stock,
  master.price_version as system_price_version,
  master.stock_version as system_stock_version,
  master.price_updated_at as system_price_updated_at,
  master.stock_updated_at as system_stock_updated_at,
  master.updated_by as system_updated_by,
  master.updated_at as system_updated_at
from public.operations_hub_sku_operational_master master;

revoke all on public.operations_hub_sku_operational_live from public, anon, authenticated;
grant select on public.operations_hub_sku_operational_live to anon, authenticated;

create or replace view public.operations_hub_matrix_system_live
with (security_invoker = true)
as
select
  matrix.*,
  nullif(
    regexp_replace(coalesce(source_stock.raw_payload ->> 'sell_price', ''), '[^0-9.-]', '', 'g'),
    ''
  )::numeric as sellpia_source_sale_price,
  source_stock.stock as sellpia_source_stock,
  source_stock.snapshot_completed_at as sellpia_source_updated_at,
  master.base_price as system_base_price,
  master.stock_quantity as system_stock,
  master.price_version as system_price_version,
  master.stock_version as system_stock_version,
  master.price_updated_at as system_price_updated_at,
  master.stock_updated_at as system_stock_updated_at,
  master.updated_at as system_updated_at
from public.operations_hub_matrix_cached matrix
left join public.sellpia_stock_latest source_stock
  on source_stock.sellpia_sku_code = matrix.sellpia_sku_code
left join public.operations_hub_sku_operational_master master
  on master.sellpia_sku_code = matrix.sellpia_sku_code;

revoke all on public.operations_hub_matrix_system_live from public, anon, authenticated;
grant select on public.operations_hub_matrix_system_live to anon, authenticated;

create or replace function public.save_operations_hub_sku_operational_value(
  p_sellpia_sku_code text,
  p_field_key text,
  p_value numeric,
  p_change_source text default 'manual',
  p_actor text default 'operations-hub',
  p_metadata jsonb default '{}'::jsonb
)
returns setof public.operations_hub_sku_operational_live
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sku text := nullif(btrim(p_sellpia_sku_code), '');
  v_field text := lower(btrim(coalesce(p_field_key, '')));
  v_source text := lower(btrim(coalesce(p_change_source, 'manual')));
  v_before numeric;
  v_saved public.operations_hub_sku_operational_master%rowtype;
  v_now timestamptz := now();
begin
  if v_sku is null then raise exception '셀피아 SKU가 필요합니다.'; end if;
  if v_field not in ('system_base_price', 'system_stock') then
    raise exception '지원하지 않는 시스템 기준 필드입니다: %', v_field;
  end if;
  if v_source not in ('manual', 'source_accept', 'bulk_import', 'reset') then
    raise exception '지원하지 않는 변경 출처입니다: %', v_source;
  end if;
  if p_value is not null and p_value < 0 then raise exception '가격과 재고는 0 이상이어야 합니다.'; end if;
  if v_field = 'system_stock' and p_value is not null and p_value <> trunc(p_value) then
    raise exception '재고는 정수여야 합니다.';
  end if;
  if jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object' then
    raise exception '변경 메타데이터는 JSON 객체여야 합니다.';
  end if;

  select case v_field
    when 'system_base_price' then master.base_price
    else master.stock_quantity::numeric
  end
  into v_before
  from public.operations_hub_sku_operational_master master
  where master.sellpia_sku_code = v_sku
  for update;

  insert into public.operations_hub_sku_operational_master (
    sellpia_sku_code, base_price, stock_quantity,
    price_version, stock_version, price_updated_at, stock_updated_at,
    updated_by, created_at, updated_at
  ) values (
    v_sku,
    case when v_field = 'system_base_price' then p_value else null end,
    case when v_field = 'system_stock' then p_value::integer else null end,
    case when v_field = 'system_base_price' then 1 else 0 end,
    case when v_field = 'system_stock' then 1 else 0 end,
    case when v_field = 'system_base_price' then v_now else null end,
    case when v_field = 'system_stock' then v_now else null end,
    'operations-hub', v_now, v_now
  )
  on conflict (sellpia_sku_code) do update set
    base_price = case when v_field = 'system_base_price' then excluded.base_price else operations_hub_sku_operational_master.base_price end,
    stock_quantity = case when v_field = 'system_stock' then excluded.stock_quantity else operations_hub_sku_operational_master.stock_quantity end,
    price_version = operations_hub_sku_operational_master.price_version + case when v_field = 'system_base_price' and operations_hub_sku_operational_master.base_price is distinct from excluded.base_price then 1 else 0 end,
    stock_version = operations_hub_sku_operational_master.stock_version + case when v_field = 'system_stock' and operations_hub_sku_operational_master.stock_quantity is distinct from excluded.stock_quantity then 1 else 0 end,
    price_updated_at = case when v_field = 'system_base_price' and operations_hub_sku_operational_master.base_price is distinct from excluded.base_price then v_now else operations_hub_sku_operational_master.price_updated_at end,
    stock_updated_at = case when v_field = 'system_stock' and operations_hub_sku_operational_master.stock_quantity is distinct from excluded.stock_quantity then v_now else operations_hub_sku_operational_master.stock_updated_at end,
    updated_by = 'operations-hub',
    updated_at = case
      when (v_field = 'system_base_price' and operations_hub_sku_operational_master.base_price is distinct from excluded.base_price)
        or (v_field = 'system_stock' and operations_hub_sku_operational_master.stock_quantity is distinct from excluded.stock_quantity)
      then v_now else operations_hub_sku_operational_master.updated_at end
  returning * into v_saved;

  if v_before is distinct from p_value then
    insert into public.operations_hub_sku_operational_events (
      sellpia_sku_code, field_key, before_value, after_value,
      change_source, actor, metadata, created_at
    ) values (
      v_sku, v_field, v_before, p_value,
      v_source, 'operations-hub', coalesce(p_metadata, '{}'::jsonb), v_now
    );
  end if;

  -- Compatibility mirror for existing seller export calculators. Source uploads
  -- never write this table; only explicit System master saves do.
  insert into public.operations_hub_sellpia_overrides (
    sellpia_sku_code, current_stock, sale_price, updated_by, updated_at
  ) values (
    v_sku,
    case when v_field = 'system_stock' then p_value::integer else null end,
    case when v_field = 'system_base_price' then p_value else null end,
    'operations_hub_frontend', v_now
  )
  on conflict (sellpia_sku_code) do update set
    current_stock = case when v_field = 'system_stock' then excluded.current_stock else operations_hub_sellpia_overrides.current_stock end,
    sale_price = case when v_field = 'system_base_price' then excluded.sale_price else operations_hub_sellpia_overrides.sale_price end,
    updated_by = 'operations_hub_frontend',
    updated_at = v_now;

  return query
  select live_row.*
  from public.operations_hub_sku_operational_live live_row
  where live_row.sellpia_sku_code = v_sku;
end;
$$;

comment on function public.save_operations_hub_sku_operational_value(text,text,numeric,text,text,jsonb) is
  'Immediately saves a System-owned base price or stock value and its audit event. Uploaded source snapshots never overwrite it.';

revoke all on function public.save_operations_hub_sku_operational_value(text,text,numeric,text,text,jsonb) from public;
grant execute on function public.save_operations_hub_sku_operational_value(text,text,numeric,text,text,jsonb) to anon, authenticated;

create or replace function public.enforce_operations_hub_price_assignment_system_base()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.is_active and not exists (
    select 1
    from public.operations_hub_sku_operational_master master
    where master.sellpia_sku_code = new.sellpia_sku_code
      and master.base_price is not null
  ) then
    raise exception '시스템 기준가격을 먼저 저장한 뒤 가격 조합을 배정해주세요: %', new.sellpia_sku_code;
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_operations_hub_price_assignment_system_base() from public;

drop trigger if exists operations_hub_price_assignment_system_base_trigger
  on public.operations_hub_price_rule_assignments;

-- Archive and retire the inferred/test catalog in one short transaction.
do $$
declare
  v_reset_batch_id uuid := '143c37e5-4d17-4d0e-b8f4-202608250600'::uuid;
  v_reason text := 'Representative catalog pending; retire inferred and test pricing configuration';
begin
  insert into public.operations_hub_pricing_reset_archives (
    reset_batch_id, entity_type, entity_key, payload, reset_reason
  )
  select v_reset_batch_id, 'price_rule_tag', tag.price_rule_tag_id::text, to_jsonb(tag), v_reason
  from public.operations_hub_price_rule_tags tag
  where tag.is_active
  on conflict do nothing;

  insert into public.operations_hub_pricing_reset_archives (
    reset_batch_id, entity_type, entity_key, payload, reset_reason
  )
  select v_reset_batch_id, 'price_rule_set', rule_set.price_rule_set_id::text, to_jsonb(rule_set), v_reason
  from public.operations_hub_price_rule_sets rule_set
  where rule_set.is_active
  on conflict do nothing;

  insert into public.operations_hub_pricing_reset_archives (
    reset_batch_id, entity_type, entity_key, payload, reset_reason
  )
  select v_reset_batch_id, 'price_rule_set_item',
         item.price_rule_set_id::text || ':' || item.price_rule_tag_id::text,
         to_jsonb(item), v_reason
  from public.operations_hub_price_rule_set_items item
  join public.operations_hub_price_rule_sets rule_set
    on rule_set.price_rule_set_id = item.price_rule_set_id
  where rule_set.is_active
  on conflict do nothing;

  insert into public.operations_hub_pricing_reset_archives (
    reset_batch_id, entity_type, entity_key, payload, reset_reason
  )
  select v_reset_batch_id, 'price_rule_assignment', assignment.price_rule_assignment_id::text,
         to_jsonb(assignment), v_reason
  from public.operations_hub_price_rule_assignments assignment
  where assignment.is_active
  on conflict do nothing;

  insert into public.operations_hub_pricing_reset_archives (
    reset_batch_id, entity_type, entity_key, payload, reset_reason
  )
  select v_reset_batch_id, 'sellpia_override', override_row.sellpia_sku_code,
         to_jsonb(override_row), v_reason
  from public.operations_hub_sellpia_overrides override_row
  where override_row.sale_price is not null or override_row.current_stock is not null
  on conflict do nothing;

  update public.operations_hub_price_rule_assignments
  set is_active = false,
      updated_by = 'system-pricing-reset',
      updated_at = now()
  where is_active;

  update public.operations_hub_price_rule_sets
  set is_active = false,
      updated_by = 'system-pricing-reset',
      updated_at = now()
  where is_active;

  update public.operations_hub_price_rule_tags
  set is_active = false,
      updated_by = 'system-pricing-reset',
      updated_at = now()
  where is_active;

  update public.operations_hub_sellpia_overrides
  set sale_price = null,
      current_stock = null,
      updated_at = now()
  where sale_price is not null or current_stock is not null;

  update public.operations_hub_change_queue
  set status = 'cancelled',
      cancelled_at = now(),
      cancelled_by = 'system-pricing-reset',
      status_message = '시스템 기준가격 전환으로 이전 가격 수정안 종료',
      updated_at = now()
  where field_key = 'sellpia_sale_price'
    and status in ('pending', 'validated', 'failed');
end;
$$;

create trigger operations_hub_price_assignment_system_base_trigger
before insert or update of sellpia_sku_code, is_active
on public.operations_hub_price_rule_assignments
for each row execute function public.enforce_operations_hub_price_assignment_system_base();

comment on table public.operations_hub_sku_operational_master is
  'Canonical System-owned price and stock values. Source uploads are comparison snapshots and never overwrite this table.';
comment on table public.operations_hub_pricing_reset_archives is
  'Recovery archive for the inferred pricing catalog retired before representative-approved rules are loaded.';

notify pgrst, 'reload schema';
