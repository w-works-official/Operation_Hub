create table if not exists public.operations_hub_price_policies (
  source_channel text primary key check (source_channel in ('smartstore','makeshop','ably')),
  policy_name text not null default '공통 가격정책',
  is_active boolean not null default false,
  base_field text not null default 'sellpia_sale_price' check (base_field = 'sellpia_sale_price'),
  replace_price numeric check (replace_price is null or replace_price >= 0),
  modify_type text not null default 'none' check (modify_type in ('none','add','percent')),
  modify_value numeric not null default 0,
  min_price numeric check (min_price is null or min_price >= 0),
  max_price numeric check (max_price is null or max_price >= 0),
  rounding_unit numeric not null default 1 check (rounding_unit > 0),
  rounding_mode text not null default 'nearest' check (rounding_mode in ('nearest','up','down')),
  source_note text,
  updated_by text not null default 'operations-hub',
  updated_at timestamptz not null default now(),
  constraint operations_hub_price_policies_guard_range check (
    min_price is null or max_price is null or min_price <= max_price
  )
);

create table if not exists public.operations_hub_price_policy_events (
  event_id bigint generated always as identity primary key,
  source_channel text not null references public.operations_hub_price_policies(source_channel) on delete restrict,
  before_policy jsonb,
  after_policy jsonb not null,
  changed_by text not null default 'operations-hub',
  changed_at timestamptz not null default now()
);

create index if not exists operations_hub_price_policy_events_source_changed_idx
  on public.operations_hub_price_policy_events (source_channel, changed_at desc);

alter table public.operations_hub_price_policies enable row level security;
alter table public.operations_hub_price_policy_events enable row level security;

drop policy if exists "operations hub price policies readable" on public.operations_hub_price_policies;
create policy "operations hub price policies readable"
  on public.operations_hub_price_policies for select to anon, authenticated using (true);
drop policy if exists "operations hub price policies insertable" on public.operations_hub_price_policies;
create policy "operations hub price policies insertable"
  on public.operations_hub_price_policies for insert to anon, authenticated with check (true);
drop policy if exists "operations hub price policies updatable" on public.operations_hub_price_policies;
create policy "operations hub price policies updatable"
  on public.operations_hub_price_policies for update to anon, authenticated using (true) with check (true);
drop policy if exists "operations hub price policy events readable" on public.operations_hub_price_policy_events;
create policy "operations hub price policy events readable"
  on public.operations_hub_price_policy_events for select to anon, authenticated using (true);
drop policy if exists "operations hub price policy events insertable" on public.operations_hub_price_policy_events;
create policy "operations hub price policy events insertable"
  on public.operations_hub_price_policy_events for insert to anon, authenticated with check (true);

revoke all on table public.operations_hub_price_policies from anon, authenticated;
revoke all on table public.operations_hub_price_policy_events from anon, authenticated;
grant select, insert, update on table public.operations_hub_price_policies to anon, authenticated;
grant select, insert on table public.operations_hub_price_policy_events to anon, authenticated;
grant usage, select on sequence public.operations_hub_price_policy_events_event_id_seq to anon, authenticated;

insert into public.operations_hub_price_policies (
  source_channel, policy_name, is_active, source_note
)
values
  ('smartstore', '스마트스토어 공통 가격정책', false, '15_스마트스토어_가격정책 확인식에서 이관 대기'),
  ('makeshop', '메이크샵 공통 가격정책', false, '공통 정책 미설정'),
  ('ably', '에이블리 공통 가격정책', false, '공통 정책 미설정')
on conflict (source_channel) do nothing;

create or replace function public.preview_operations_hub_price_policy(
  p_sku text,
  p_source text
)
returns table (
  sellpia_sku_code text,
  source_channel text,
  policy_name text,
  is_configured boolean,
  is_active boolean,
  base_price numeric,
  replaced_price numeric,
  modified_price numeric,
  guarded_price numeric,
  final_price numeric,
  formula_summary text,
  policy jsonb
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_matrix public.operations_hub_matrix_live%rowtype;
  v_policy public.operations_hub_price_policies%rowtype;
  v_base numeric;
  v_replaced numeric;
  v_modified numeric;
  v_guarded numeric;
  v_final numeric;
begin
  if nullif(btrim(p_sku), '') is null then raise exception '셀피아 SKU가 필요합니다.'; end if;
  if p_source not in ('smartstore','makeshop','ably') then raise exception '지원하지 않는 판매처입니다.'; end if;

  select matrix_row.* into v_matrix
  from public.operations_hub_matrix_live matrix_row
  where matrix_row.sellpia_sku_code = btrim(p_sku)
  limit 1;
  if not found then raise exception '셀피아 SKU를 찾을 수 없습니다: %', p_sku; end if;
  v_base := v_matrix.sellpia_sale_price;
  select policy_row.* into v_policy
  from public.operations_hub_price_policies policy_row
  where policy_row.source_channel = p_source;

  if not found or not coalesce(v_policy.is_active, false) then
    return query select btrim(p_sku), p_source, coalesce(v_policy.policy_name, '정책 미설정'), found,
      coalesce(v_policy.is_active, false), v_base, v_base, v_base, v_base, v_base,
      'BASE: 셀피아 판매가 · 활성 정책 없음',
      case when found then to_jsonb(v_policy) else null::jsonb end;
    return;
  end if;

  v_replaced := coalesce(v_policy.replace_price, v_base);
  v_modified := case v_policy.modify_type
    when 'add' then v_replaced + v_policy.modify_value
    when 'percent' then v_replaced * (1 + v_policy.modify_value / 100.0)
    else v_replaced
  end;
  v_guarded := greatest(coalesce(v_policy.min_price, v_modified), v_modified);
  v_guarded := least(coalesce(v_policy.max_price, v_guarded), v_guarded);
  v_final := case v_policy.rounding_mode
    when 'up' then ceil(v_guarded / v_policy.rounding_unit) * v_policy.rounding_unit
    when 'down' then floor(v_guarded / v_policy.rounding_unit) * v_policy.rounding_unit
    else round(v_guarded / v_policy.rounding_unit) * v_policy.rounding_unit
  end;

  return query select btrim(p_sku), p_source, v_policy.policy_name, true, true,
    v_base, v_replaced, v_modified, v_guarded, greatest(v_final, 0),
    concat_ws(' → ',
      format('BASE %s', coalesce(v_base::text, '-')),
      case when v_policy.replace_price is not null then format('REPLACE %s', v_replaced) end,
      case when v_policy.modify_type <> 'none' then format('MODIFY %s %s', v_policy.modify_type, v_policy.modify_value) end,
      case when v_policy.min_price is not null or v_policy.max_price is not null then format('GUARD %s~%s', coalesce(v_policy.min_price::text, '-'), coalesce(v_policy.max_price::text, '-')) end,
      format('ROUND %s/%s = %s', v_policy.rounding_mode, v_policy.rounding_unit, greatest(v_final, 0))
    ), to_jsonb(v_policy);
end;
$$;

create or replace function public.save_operations_hub_price_policy(
  p_source text,
  p_policy_name text,
  p_is_active boolean,
  p_replace_price numeric,
  p_modify_type text,
  p_modify_value numeric,
  p_min_price numeric,
  p_max_price numeric,
  p_rounding_unit numeric,
  p_rounding_mode text,
  p_updated_by text default 'operations-hub'
)
returns public.operations_hub_price_policies
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_before public.operations_hub_price_policies%rowtype;
  v_after public.operations_hub_price_policies%rowtype;
begin
  if p_source not in ('smartstore','makeshop','ably') then raise exception '지원하지 않는 판매처입니다.'; end if;
  if p_modify_type not in ('none','add','percent') then raise exception '지원하지 않는 가격 조정 방식입니다.'; end if;
  if p_rounding_mode not in ('nearest','up','down') or coalesce(p_rounding_unit, 0) <= 0 then raise exception '반올림 설정을 확인해주세요.'; end if;
  if p_replace_price < 0 or p_min_price < 0 or p_max_price < 0 then raise exception '가격은 0 이상이어야 합니다.'; end if;
  if p_min_price is not null and p_max_price is not null and p_min_price > p_max_price then raise exception '최저가는 최고가보다 클 수 없습니다.'; end if;

  select * into v_before from public.operations_hub_price_policies where source_channel = p_source;
  insert into public.operations_hub_price_policies (
    source_channel, policy_name, is_active, replace_price, modify_type, modify_value,
    min_price, max_price, rounding_unit, rounding_mode, updated_by, updated_at
  ) values (
    p_source, coalesce(nullif(btrim(p_policy_name), ''), concat(p_source, ' 공통 가격정책')),
    coalesce(p_is_active, false), p_replace_price, p_modify_type, coalesce(p_modify_value, 0),
    p_min_price, p_max_price, p_rounding_unit, p_rounding_mode,
    coalesce(nullif(btrim(p_updated_by), ''), 'operations-hub'), now()
  )
  on conflict (source_channel) do update set
    policy_name = excluded.policy_name,
    is_active = excluded.is_active,
    replace_price = excluded.replace_price,
    modify_type = excluded.modify_type,
    modify_value = excluded.modify_value,
    min_price = excluded.min_price,
    max_price = excluded.max_price,
    rounding_unit = excluded.rounding_unit,
    rounding_mode = excluded.rounding_mode,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at
  returning * into v_after;

  insert into public.operations_hub_price_policy_events(source_channel, before_policy, after_policy, changed_by)
  values (p_source, case when v_before.source_channel is null then null else to_jsonb(v_before) end, to_jsonb(v_after), v_after.updated_by);
  return v_after;
end;
$$;

revoke all on function public.preview_operations_hub_price_policy(text, text) from public;
revoke all on function public.save_operations_hub_price_policy(text, text, boolean, numeric, text, numeric, numeric, numeric, numeric, text, text) from public;
grant execute on function public.preview_operations_hub_price_policy(text, text) to anon, authenticated;
grant execute on function public.save_operations_hub_price_policy(text, text, boolean, numeric, text, numeric, numeric, numeric, numeric, text, text) to anon, authenticated;

comment on table public.operations_hub_price_policies is 'One structured BASE-REPLACE-MODIFY-GUARD-ROUND price policy per seller channel.';
comment on function public.preview_operations_hub_price_policy(text, text) is 'Previews a structured seller price policy without creating a seller change draft.';
