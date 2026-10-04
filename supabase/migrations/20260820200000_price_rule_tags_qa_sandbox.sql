-- Atomic price tags, ordered composite tags, and an isolated virtual-option QA sandbox.
-- QA records use QA-* codes and never join the live matrix, change queue, or export pipeline.

create table public.operations_hub_price_rule_tags (
  price_rule_tag_id bigint generated always as identity primary key,
  tag_code text not null unique check (length(btrim(tag_code)) > 0),
  tag_name text not null check (length(btrim(tag_name)) > 0),
  color text not null default '#2f6fd1' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  replace_price numeric,
  modify_type text not null default 'none' check (modify_type in ('none', 'add', 'percent')),
  modify_value numeric not null default 0,
  min_price numeric,
  max_price numeric,
  rounding_unit numeric not null default 1 check (rounding_unit > 0),
  rounding_mode text not null default 'nearest' check (rounding_mode in ('nearest', 'up', 'down')),
  is_active boolean not null default true,
  note text,
  updated_by text not null default 'operations-hub',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint operations_hub_price_rule_tags_guard_range check (
    (replace_price is null or replace_price >= 0)
    and (min_price is null or min_price >= 0)
    and (max_price is null or max_price >= 0)
    and (min_price is null or max_price is null or min_price <= max_price)
  )
);

create table public.operations_hub_price_rule_sets (
  price_rule_set_id bigint generated always as identity primary key,
  set_code text not null unique check (length(btrim(set_code)) > 0),
  set_name text not null check (length(btrim(set_name)) > 0),
  color text not null default '#1558c0' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  is_active boolean not null default true,
  note text,
  updated_by text not null default 'operations-hub',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.operations_hub_price_rule_set_items (
  price_rule_set_id bigint not null references public.operations_hub_price_rule_sets(price_rule_set_id) on delete cascade,
  price_rule_tag_id bigint not null references public.operations_hub_price_rule_tags(price_rule_tag_id) on delete restrict,
  sort_order integer not null check (sort_order > 0),
  is_active boolean not null default true,
  primary key (price_rule_set_id, price_rule_tag_id),
  unique (price_rule_set_id, sort_order)
);

create table public.operations_hub_price_rule_qa_cases (
  qa_case_id bigint generated always as identity primary key,
  case_code text not null unique check (length(btrim(case_code)) > 0),
  case_name text not null check (length(btrim(case_name)) > 0),
  scenario_type text not null default 'single' check (scenario_type in ('single', 'bundle')),
  source_channel text not null check (source_channel in ('smartstore', 'makeshop', 'ably')),
  virtual_product_code text not null check (virtual_product_code like 'QA-%'),
  virtual_option_code text not null check (virtual_option_code like 'QA-%'),
  seller_original_price numeric not null check (seller_original_price >= 0),
  price_rule_set_id bigint not null references public.operations_hub_price_rule_sets(price_rule_set_id) on delete restrict,
  expected_final_price numeric not null check (expected_final_price >= 0),
  is_active boolean not null default true,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.operations_hub_price_rule_qa_components (
  qa_component_id bigint generated always as identity primary key,
  qa_case_id bigint not null references public.operations_hub_price_rule_qa_cases(qa_case_id) on delete cascade,
  virtual_sku_code text not null check (virtual_sku_code like 'QA-%'),
  component_name text not null,
  component_qty integer not null default 1 check (component_qty > 0),
  unit_base_price numeric not null check (unit_base_price >= 0),
  unique (qa_case_id, virtual_sku_code)
);

-- Future operational assignment target. It is intentionally not consumed by the
-- live preview/export flow until composite tags pass QA and the assignment UI ships.
create table public.operations_hub_price_rule_assignments (
  price_rule_assignment_id bigint generated always as identity primary key,
  source_channel text not null check (source_channel in ('smartstore', 'makeshop', 'ably')),
  target_type text not null check (target_type in ('sellpia_sku', 'seller_listing')),
  sellpia_sku_code text,
  listing_id bigint references public.operations_hub_seller_listings(listing_id) on delete restrict,
  price_rule_set_id bigint not null references public.operations_hub_price_rule_sets(price_rule_set_id) on delete restrict,
  is_active boolean not null default true,
  updated_by text not null default 'operations-hub',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint operations_hub_price_rule_assignment_target check (
    (target_type = 'sellpia_sku' and nullif(btrim(sellpia_sku_code), '') is not null and listing_id is null)
    or (target_type = 'seller_listing' and sellpia_sku_code is null and listing_id is not null)
  )
);

create unique index operations_hub_price_rule_assignments_sku_uidx
  on public.operations_hub_price_rule_assignments (source_channel, sellpia_sku_code)
  where target_type = 'sellpia_sku' and is_active;
create unique index operations_hub_price_rule_assignments_listing_uidx
  on public.operations_hub_price_rule_assignments (listing_id)
  where target_type = 'seller_listing' and is_active;
create index operations_hub_price_rule_qa_cases_set_idx
  on public.operations_hub_price_rule_qa_cases (price_rule_set_id, qa_case_id) where is_active;
create index operations_hub_price_rule_qa_components_case_idx
  on public.operations_hub_price_rule_qa_components (qa_case_id, qa_component_id);

alter table public.operations_hub_price_rule_tags enable row level security;
alter table public.operations_hub_price_rule_sets enable row level security;
alter table public.operations_hub_price_rule_set_items enable row level security;
alter table public.operations_hub_price_rule_qa_cases enable row level security;
alter table public.operations_hub_price_rule_qa_components enable row level security;
alter table public.operations_hub_price_rule_assignments enable row level security;

create policy "operations hub price rule tags all" on public.operations_hub_price_rule_tags
  for all to anon, authenticated using (true) with check (true);
create policy "operations hub price rule sets all" on public.operations_hub_price_rule_sets
  for all to anon, authenticated using (true) with check (true);
create policy "operations hub price rule set items all" on public.operations_hub_price_rule_set_items
  for all to anon, authenticated using (true) with check (true);
create policy "operations hub price qa cases readable" on public.operations_hub_price_rule_qa_cases
  for select to anon, authenticated using (true);
create policy "operations hub price qa components readable" on public.operations_hub_price_rule_qa_components
  for select to anon, authenticated using (true);
create policy "operations hub price rule assignments all" on public.operations_hub_price_rule_assignments
  for all to anon, authenticated using (true) with check (true);

grant select, insert, update on public.operations_hub_price_rule_tags to anon, authenticated;
grant select, insert, update on public.operations_hub_price_rule_sets to anon, authenticated;
grant select, insert, update, delete on public.operations_hub_price_rule_set_items to anon, authenticated;
grant select on public.operations_hub_price_rule_qa_cases to anon, authenticated;
grant select on public.operations_hub_price_rule_qa_components to anon, authenticated;
grant select, insert, update on public.operations_hub_price_rule_assignments to anon, authenticated;
do $$
declare
  v_sequence text;
begin
  foreach v_sequence in array array[
    pg_get_serial_sequence('public.operations_hub_price_rule_tags', 'price_rule_tag_id'),
    pg_get_serial_sequence('public.operations_hub_price_rule_sets', 'price_rule_set_id'),
    pg_get_serial_sequence('public.operations_hub_price_rule_assignments', 'price_rule_assignment_id')
  ]
  loop
    execute format('grant usage, select on sequence %s to anon, authenticated', v_sequence);
  end loop;
end;
$$;

create function public.calculate_operations_hub_price_rule(
  p_base_price numeric,
  p_replace_price numeric,
  p_modify_type text,
  p_modify_value numeric,
  p_min_price numeric,
  p_max_price numeric,
  p_rounding_unit numeric,
  p_rounding_mode text
)
returns table (replaced_price numeric, modified_price numeric, guarded_price numeric, final_price numeric)
language plpgsql immutable security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  v_replaced numeric;
  v_modified numeric;
  v_guarded numeric;
  v_final numeric;
  v_unit numeric := coalesce(p_rounding_unit, 1);
begin
  if p_base_price is null then
    return query select null::numeric, null::numeric, null::numeric, null::numeric;
    return;
  end if;
  if coalesce(p_modify_type, 'none') not in ('none', 'add', 'percent') then
    raise exception '지원하지 않는 가격 조정 방식입니다: %', p_modify_type;
  end if;
  if coalesce(p_rounding_mode, 'nearest') not in ('nearest', 'up', 'down') or v_unit <= 0 then
    raise exception '끝자리 처리 설정이 올바르지 않습니다.';
  end if;
  v_replaced := coalesce(p_replace_price, p_base_price);
  v_modified := case coalesce(p_modify_type, 'none')
    when 'add' then v_replaced + coalesce(p_modify_value, 0)
    when 'percent' then v_replaced * (1 + coalesce(p_modify_value, 0) / 100.0)
    else v_replaced
  end;
  v_guarded := greatest(coalesce(p_min_price, v_modified), v_modified);
  v_guarded := least(coalesce(p_max_price, v_guarded), v_guarded);
  v_final := case coalesce(p_rounding_mode, 'nearest')
    when 'up' then ceil(v_guarded / v_unit) * v_unit
    when 'down' then floor(v_guarded / v_unit) * v_unit
    else round(v_guarded / v_unit) * v_unit
  end;
  return query select v_replaced, v_modified, v_guarded, greatest(v_final, 0);
end;
$$;

create function public.calculate_operations_hub_price_rule_set(
  p_base_price numeric,
  p_rule_set_id bigint
)
returns table (final_price numeric, steps jsonb)
language plpgsql stable security invoker
set search_path = public, pg_temp
as $$
declare
  v_item record;
  v_calc record;
  v_current numeric := p_base_price;
  v_steps jsonb := '[]'::jsonb;
  v_count integer := 0;
begin
  if not exists (
    select 1 from public.operations_hub_price_rule_sets rule_set
    where rule_set.price_rule_set_id = p_rule_set_id and rule_set.is_active
  ) then raise exception '활성 조합 태그를 찾을 수 없습니다: %', p_rule_set_id; end if;

  for v_item in
    select link.sort_order, tag.*
    from public.operations_hub_price_rule_set_items link
    join public.operations_hub_price_rule_tags tag
      on tag.price_rule_tag_id = link.price_rule_tag_id and tag.is_active
    where link.price_rule_set_id = p_rule_set_id and link.is_active
    order by link.sort_order
  loop
    select * into v_calc from public.calculate_operations_hub_price_rule(
      v_current, v_item.replace_price, v_item.modify_type, v_item.modify_value,
      v_item.min_price, v_item.max_price, v_item.rounding_unit, v_item.rounding_mode
    );
    v_steps := v_steps || jsonb_build_array(jsonb_build_object(
      'order', v_item.sort_order, 'tag_id', v_item.price_rule_tag_id,
      'tag_code', v_item.tag_code, 'tag_name', v_item.tag_name,
      'before', v_current, 'after', v_calc.final_price
    ));
    v_current := v_calc.final_price;
    v_count := v_count + 1;
  end loop;
  if v_count = 0 then raise exception '조합 태그에 활성 단계가 없습니다.'; end if;
  return query select v_current, v_steps;
end;
$$;

-- The live one-policy preview now shares the same atomic calculator used by QA.
create or replace function public.preview_operations_hub_price_policy(p_sku text, p_source text)
returns table (
  sellpia_sku_code text, source_channel text, policy_name text,
  is_configured boolean, is_active boolean, base_price numeric,
  replaced_price numeric, modified_price numeric, guarded_price numeric,
  final_price numeric, formula_summary text, policy jsonb
)
language plpgsql security invoker
set search_path = public, pg_temp
as $$
declare
  v_matrix public.operations_hub_matrix_live%rowtype;
  v_policy public.operations_hub_price_policies%rowtype;
  v_configured boolean := false;
  v_calc record;
begin
  if nullif(btrim(p_sku), '') is null then raise exception '셀피아 SKU가 필요합니다.'; end if;
  if p_source not in ('smartstore','makeshop','ably') then raise exception '지원하지 않는 판매처입니다.'; end if;
  select row_value.* into v_matrix from public.operations_hub_matrix_live row_value
  where row_value.sellpia_sku_code = btrim(p_sku) limit 1;
  if not found then raise exception '셀피아 SKU를 찾을 수 없습니다: %', p_sku; end if;
  select policy_row.* into v_policy from public.operations_hub_price_policies policy_row
  where policy_row.source_channel = p_source;
  v_configured := found;
  select * into v_calc from public.calculate_operations_hub_price_rule(
    v_matrix.sellpia_sale_price,
    case when v_configured and coalesce(v_policy.is_active, false) then v_policy.replace_price end,
    case when v_configured and coalesce(v_policy.is_active, false) then v_policy.modify_type else 'none' end,
    case when v_configured and coalesce(v_policy.is_active, false) then v_policy.modify_value else 0 end,
    case when v_configured and coalesce(v_policy.is_active, false) then v_policy.min_price end,
    case when v_configured and coalesce(v_policy.is_active, false) then v_policy.max_price end,
    case when v_configured and coalesce(v_policy.is_active, false) then v_policy.rounding_unit else 1 end,
    case when v_configured and coalesce(v_policy.is_active, false) then v_policy.rounding_mode else 'nearest' end
  );
  return query select btrim(p_sku), p_source, coalesce(v_policy.policy_name, '정책 미설정'),
    v_configured, v_configured and coalesce(v_policy.is_active, false), v_matrix.sellpia_sale_price,
    v_calc.replaced_price, v_calc.modified_price, v_calc.guarded_price, v_calc.final_price,
    case when not (v_configured and coalesce(v_policy.is_active, false)) then '셀피아 기준가 그대로'
      else concat_ws(' · ',
        case when v_policy.replace_price is not null then format('최종가 %s원 지정', v_policy.replace_price) end,
        case when v_policy.modify_type = 'percent' and v_policy.modify_value < 0 then format('%s%% 할인', abs(v_policy.modify_value)) end,
        case when v_policy.modify_type = 'percent' and v_policy.modify_value >= 0 then format('%s%% 인상', v_policy.modify_value) end,
        case when v_policy.modify_type = 'add' and v_policy.modify_value < 0 then format('%s원 할인', abs(v_policy.modify_value)) end,
        case when v_policy.modify_type = 'add' and v_policy.modify_value >= 0 then format('%s원 추가', v_policy.modify_value) end,
        format('최종 %s원', v_calc.final_price)
      ) end,
    case when v_configured then to_jsonb(v_policy) else null::jsonb end;
end;
$$;

create function public.save_operations_hub_price_rule_tag(
  p_tag_id bigint, p_tag_name text, p_color text, p_replace_price numeric,
  p_modify_type text, p_modify_value numeric, p_min_price numeric, p_max_price numeric,
  p_rounding_unit numeric, p_rounding_mode text, p_note text default null
)
returns public.operations_hub_price_rule_tags
language plpgsql security invoker
set search_path = public, pg_temp
as $$
declare v_saved public.operations_hub_price_rule_tags%rowtype;
begin
  if nullif(btrim(p_tag_name), '') is null then raise exception '작은 태그 이름이 필요합니다.'; end if;
  if coalesce(p_modify_type, 'none') not in ('none', 'add', 'percent') then raise exception '지원하지 않는 가격 조정 방식입니다.'; end if;
  if p_tag_id is null then
    insert into public.operations_hub_price_rule_tags (
      tag_code, tag_name, color, replace_price, modify_type, modify_value,
      min_price, max_price, rounding_unit, rounding_mode, note
    ) values (
      'USR_' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)), btrim(p_tag_name),
      coalesce(nullif(btrim(p_color), ''), '#2f6fd1'), p_replace_price,
      coalesce(p_modify_type, 'none'), coalesce(p_modify_value, 0), p_min_price, p_max_price,
      coalesce(p_rounding_unit, 1), coalesce(p_rounding_mode, 'nearest'), nullif(btrim(p_note), '')
    ) returning * into v_saved;
  else
    update public.operations_hub_price_rule_tags tag set
      tag_name=btrim(p_tag_name), color=coalesce(nullif(btrim(p_color), ''), tag.color),
      replace_price=p_replace_price, modify_type=coalesce(p_modify_type, 'none'),
      modify_value=coalesce(p_modify_value, 0), min_price=p_min_price, max_price=p_max_price,
      rounding_unit=coalesce(p_rounding_unit, 1), rounding_mode=coalesce(p_rounding_mode, 'nearest'),
      note=nullif(btrim(p_note), ''), updated_at=now()
    where tag.price_rule_tag_id=p_tag_id returning * into v_saved;
    if not found then raise exception '작은 태그를 찾을 수 없습니다: %', p_tag_id; end if;
  end if;
  return v_saved;
end;
$$;

create function public.save_operations_hub_price_rule_set(
  p_rule_set_id bigint, p_set_name text, p_color text, p_tag_ids bigint[], p_note text default null
)
returns public.operations_hub_price_rule_sets
language plpgsql security invoker
set search_path = public, pg_temp
as $$
declare
  v_saved public.operations_hub_price_rule_sets%rowtype;
  v_expected integer := coalesce(array_length(p_tag_ids, 1), 0);
  v_actual integer;
begin
  if nullif(btrim(p_set_name), '') is null then raise exception '조합 태그 이름이 필요합니다.'; end if;
  if v_expected = 0 then raise exception '조합 태그에는 작은 태그가 하나 이상 필요합니다.'; end if;
  select count(distinct tag_id)::integer into v_actual from unnest(p_tag_ids) item(tag_id);
  if v_actual <> v_expected then raise exception '같은 작은 태그를 조합 태그에 중복으로 넣을 수 없습니다.'; end if;
  select count(*)::integer into v_actual from public.operations_hub_price_rule_tags tag
  where tag.price_rule_tag_id = any(p_tag_ids) and tag.is_active;
  if v_actual <> v_expected then raise exception '비활성 또는 존재하지 않는 작은 태그가 포함되어 있습니다.'; end if;

  if p_rule_set_id is null then
    insert into public.operations_hub_price_rule_sets (set_code, set_name, color, note)
    values ('SET_' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)), btrim(p_set_name),
      coalesce(nullif(btrim(p_color), ''), '#1558c0'), nullif(btrim(p_note), ''))
    returning * into v_saved;
  else
    update public.operations_hub_price_rule_sets rule_set set
      set_name=btrim(p_set_name), color=coalesce(nullif(btrim(p_color), ''), rule_set.color),
      note=nullif(btrim(p_note), ''), updated_at=now()
    where rule_set.price_rule_set_id=p_rule_set_id returning * into v_saved;
    if not found then raise exception '조합 태그를 찾을 수 없습니다: %', p_rule_set_id; end if;
    delete from public.operations_hub_price_rule_set_items item where item.price_rule_set_id=p_rule_set_id;
  end if;
  insert into public.operations_hub_price_rule_set_items (price_rule_set_id, price_rule_tag_id, sort_order)
  select v_saved.price_rule_set_id, item.tag_id, item.ordinality::integer
  from unnest(p_tag_ids) with ordinality item(tag_id, ordinality);
  return v_saved;
end;
$$;

insert into public.operations_hub_price_rule_tags (
  tag_code, tag_name, color, replace_price, modify_type, modify_value,
  min_price, max_price, rounding_unit, rounding_mode, note
) values
  ('QA_SAME', '기준가 그대로', '#64748b', null, 'none', 0, null, null, 1, 'nearest', '기본가 통과'),
  ('QA_DISCOUNT_10', '10% 할인', '#2f6fd1', null, 'percent', -10, null, null, 1, 'nearest', '퍼센트 할인'),
  ('QA_MARKUP_15', '15% 인상', '#7c3aed', null, 'percent', 15, null, null, 1, 'nearest', '퍼센트 인상'),
  ('QA_ADD_3000', '배송비 +3,000원', '#0891b2', null, 'add', 3000, null, null, 1, 'nearest', '금액 추가'),
  ('QA_FIXED_19900', '가격 19,900원 고정', '#ea580c', 19900, 'none', 0, null, null, 1, 'nearest', '고정 가격'),
  ('QA_GUARD_ROUND', '10% 할인 · 최저 18,000 · 100원 반올림', '#16a34a', null, 'percent', -10, 18000, null, 100, 'nearest', '최저가와 끝자리')
on conflict (tag_code) do update set tag_name=excluded.tag_name, color=excluded.color,
  replace_price=excluded.replace_price, modify_type=excluded.modify_type, modify_value=excluded.modify_value,
  min_price=excluded.min_price, max_price=excluded.max_price, rounding_unit=excluded.rounding_unit,
  rounding_mode=excluded.rounding_mode, note=excluded.note, updated_at=now();

insert into public.operations_hub_price_rule_sets (set_code, set_name, color, note) values
  ('QA_SET_SAME', '기준가 그대로', '#64748b', '단일 단계 조합'),
  ('QA_SET_DISCOUNT_10', '10% 할인형', '#2f6fd1', '단일 단계 조합'),
  ('QA_SET_MARKUP_15', '15% 인상형', '#7c3aed', '단일 단계 조합'),
  ('QA_SET_ADD_3000', '배송비 3,000원형', '#0891b2', '단일 단계 조합'),
  ('QA_SET_FIXED_19900', '19,900원 고정형', '#ea580c', '단일 단계 조합'),
  ('QA_SET_GUARD_ROUND', '최저가·끝자리형', '#16a34a', '단일 단계 조합'),
  ('QA_SET_STACKED', '10% 할인 → 19,900 고정 → 배송비 3,000', '#be123c', '다중 단계 조합')
on conflict (set_code) do update set set_name=excluded.set_name, color=excluded.color,
  note=excluded.note, updated_at=now();

insert into public.operations_hub_price_rule_set_items (price_rule_set_id, price_rule_tag_id, sort_order)
select rule_set.price_rule_set_id, tag.price_rule_tag_id, seed.sort_order
from (values
  ('QA_SET_SAME','QA_SAME',1), ('QA_SET_DISCOUNT_10','QA_DISCOUNT_10',1),
  ('QA_SET_MARKUP_15','QA_MARKUP_15',1), ('QA_SET_ADD_3000','QA_ADD_3000',1),
  ('QA_SET_FIXED_19900','QA_FIXED_19900',1), ('QA_SET_GUARD_ROUND','QA_GUARD_ROUND',1),
  ('QA_SET_STACKED','QA_DISCOUNT_10',1), ('QA_SET_STACKED','QA_FIXED_19900',2),
  ('QA_SET_STACKED','QA_ADD_3000',3)
) seed(set_code,tag_code,sort_order)
join public.operations_hub_price_rule_sets rule_set on rule_set.set_code=seed.set_code
join public.operations_hub_price_rule_tags tag on tag.tag_code=seed.tag_code
on conflict (price_rule_set_id, price_rule_tag_id) do update set sort_order=excluded.sort_order, is_active=true;

insert into public.operations_hub_price_rule_qa_cases (
  case_code, case_name, scenario_type, source_channel, virtual_product_code, virtual_option_code,
  seller_original_price, price_rule_set_id, expected_final_price, note
)
select seed.case_code, seed.case_name, seed.scenario_type, seed.source_channel,
  seed.product_code, seed.option_code, seed.original_price, rule_set.price_rule_set_id,
  seed.expected_price, seed.note
from (values
  ('QA_CASE_DISCOUNT','1:1 · 10% 할인','single','smartstore','QA-SMART-P001','QA-SMART-O001',21500::numeric,'QA_SET_DISCOUNT_10',18000::numeric,'기준가 20,000원'),
  ('QA_CASE_MARKUP','1:1 · 15% 인상','single','makeshop','QA-MAKE-P001','QA-MAKE-O001',9800::numeric,'QA_SET_MARKUP_15',11500::numeric,'기준가 10,000원'),
  ('QA_CASE_ADD','1:1 · 배송비 추가','single','ably','QA-ABLY-P001','QA-ABLY-O001',12500::numeric,'QA_SET_ADD_3000',15000::numeric,'기준가 12,000원'),
  ('QA_CASE_FIXED','1:1 · 가격 고정','single','smartstore','QA-SMART-P002','QA-SMART-O002',27000::numeric,'QA_SET_FIXED_19900',19900::numeric,'기준가와 무관'),
  ('QA_CASE_GUARD','최저가·끝자리 처리','single','makeshop','QA-MAKE-P002','QA-MAKE-O002',14900::numeric,'QA_SET_GUARD_ROUND',18000::numeric,'13,500원 계산 후 최저가'),
  ('QA_CASE_BUNDLE','1+1 조합 · 10% 할인','bundle','ably','QA-ABLY-P002','QA-ABLY-O002',22000::numeric,'QA_SET_DISCOUNT_10',18000::numeric,'12,000원 + 8,000원'),
  ('QA_CASE_STACKED','다중 태그 · 할인→고정→배송비','single','smartstore','QA-SMART-P003','QA-SMART-O003',21000::numeric,'QA_SET_STACKED',22900::numeric,'20,000 → 18,000 → 19,900 → 22,900')
) seed(case_code,case_name,scenario_type,source_channel,product_code,option_code,original_price,set_code,expected_price,note)
join public.operations_hub_price_rule_sets rule_set on rule_set.set_code=seed.set_code
on conflict (case_code) do update set case_name=excluded.case_name, scenario_type=excluded.scenario_type,
  source_channel=excluded.source_channel, virtual_product_code=excluded.virtual_product_code,
  virtual_option_code=excluded.virtual_option_code, seller_original_price=excluded.seller_original_price,
  price_rule_set_id=excluded.price_rule_set_id, expected_final_price=excluded.expected_final_price,
  note=excluded.note, updated_at=now();

insert into public.operations_hub_price_rule_qa_components (
  qa_case_id, virtual_sku_code, component_name, component_qty, unit_base_price
)
select qa.qa_case_id, seed.sku, seed.component_name, seed.qty, seed.price
from (values
  ('QA_CASE_DISCOUNT','QA-SKU-20000','가상 기본 옵션',1,20000::numeric),
  ('QA_CASE_MARKUP','QA-SKU-10000','가상 인상 옵션',1,10000::numeric),
  ('QA_CASE_ADD','QA-SKU-12000','가상 배송비 옵션',1,12000::numeric),
  ('QA_CASE_FIXED','QA-SKU-28000','가상 고정가 옵션',1,28000::numeric),
  ('QA_CASE_GUARD','QA-SKU-15000','가상 최저가 옵션',1,15000::numeric),
  ('QA_CASE_BUNDLE','QA-SKU-BUNDLE-A','1+1 구성 A',1,12000::numeric),
  ('QA_CASE_BUNDLE','QA-SKU-BUNDLE-B','1+1 구성 B',1,8000::numeric),
  ('QA_CASE_STACKED','QA-SKU-STACKED','다중 태그 가상 옵션',1,20000::numeric)
) seed(case_code,sku,component_name,qty,price)
join public.operations_hub_price_rule_qa_cases qa on qa.case_code=seed.case_code
on conflict (qa_case_id,virtual_sku_code) do update set component_name=excluded.component_name,
  component_qty=excluded.component_qty, unit_base_price=excluded.unit_base_price;

create view public.operations_hub_price_rule_set_live with (security_invoker=true) as
select rule_set.price_rule_set_id, rule_set.set_code, rule_set.set_name, rule_set.color,
  rule_set.note, rule_set.updated_at,
  jsonb_agg(jsonb_build_object(
    'tag_id',tag.price_rule_tag_id,'tag_code',tag.tag_code,'tag_name',tag.tag_name,
    'color',tag.color,'order',item.sort_order,'replace_price',tag.replace_price,
    'modify_type',tag.modify_type,'modify_value',tag.modify_value,'min_price',tag.min_price,
    'max_price',tag.max_price,'rounding_unit',tag.rounding_unit,'rounding_mode',tag.rounding_mode
  ) order by item.sort_order) as tags
from public.operations_hub_price_rule_sets rule_set
join public.operations_hub_price_rule_set_items item
  on item.price_rule_set_id=rule_set.price_rule_set_id and item.is_active
join public.operations_hub_price_rule_tags tag
  on tag.price_rule_tag_id=item.price_rule_tag_id and tag.is_active
where rule_set.is_active
group by rule_set.price_rule_set_id;

create view public.operations_hub_price_rule_qa_live with (security_invoker=true) as
with component_rollup as (
  select component.qa_case_id,
    sum(component.unit_base_price * component.component_qty) as base_price,
    jsonb_agg(jsonb_build_object('sku',component.virtual_sku_code,'name',component.component_name,
      'qty',component.component_qty,'unit_price',component.unit_base_price)
      order by component.qa_component_id) as components
  from public.operations_hub_price_rule_qa_components component group by component.qa_case_id
)
select qa.qa_case_id, qa.case_code, qa.case_name, qa.scenario_type, qa.source_channel,
  qa.virtual_product_code, qa.virtual_option_code, qa.seller_original_price,
  rule_set.price_rule_set_id, rule_set.set_code, rule_set.set_name, rule_set.color,
  rollup.base_price, qa.expected_final_price, calc.final_price as calculated_final_price,
  calc.final_price=qa.expected_final_price as passed, calc.steps, rollup.components,
  qa.note, qa.updated_at
from public.operations_hub_price_rule_qa_cases qa
join public.operations_hub_price_rule_sets rule_set
  on rule_set.price_rule_set_id=qa.price_rule_set_id and rule_set.is_active
join component_rollup rollup on rollup.qa_case_id=qa.qa_case_id
cross join lateral public.calculate_operations_hub_price_rule_set(rollup.base_price,qa.price_rule_set_id) calc
where qa.is_active;

comment on table public.operations_hub_price_rule_tags is 'Small atomic price steps such as 10 percent discount, fixed price, or shipping addition.';
comment on table public.operations_hub_price_rule_sets is 'Large reusable composite tags containing ordered atomic price tags.';
comment on table public.operations_hub_price_rule_qa_cases is 'Isolated QA-* seller options. They never enter the live matrix, queue, or export.';
comment on table public.operations_hub_price_rule_assignments is 'Future operational composite-tag assignment target; not yet consumed by exports.';
comment on view public.operations_hub_price_rule_qa_live is 'Expected-versus-calculated virtual-option QA using the live atomic calculator.';

grant select on public.operations_hub_price_rule_set_live to anon, authenticated;
grant select on public.operations_hub_price_rule_qa_live to anon, authenticated;
revoke all on function public.calculate_operations_hub_price_rule(numeric,numeric,text,numeric,numeric,numeric,numeric,text) from public;
revoke all on function public.calculate_operations_hub_price_rule_set(numeric,bigint) from public;
revoke all on function public.save_operations_hub_price_rule_tag(bigint,text,text,numeric,text,numeric,numeric,numeric,numeric,text,text) from public;
revoke all on function public.save_operations_hub_price_rule_set(bigint,text,text,bigint[],text) from public;
grant execute on function public.calculate_operations_hub_price_rule(numeric,numeric,text,numeric,numeric,numeric,numeric,text) to anon, authenticated;
grant execute on function public.calculate_operations_hub_price_rule_set(numeric,bigint) to anon, authenticated;
grant execute on function public.save_operations_hub_price_rule_tag(bigint,text,text,numeric,text,numeric,numeric,numeric,numeric,text,text) to anon, authenticated;
grant execute on function public.save_operations_hub_price_rule_set(bigint,text,text,bigint[],text) to anon, authenticated;
grant execute on function public.preview_operations_hub_price_policy(text,text) to anon, authenticated;
