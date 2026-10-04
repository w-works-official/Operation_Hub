-- Representative-approved calculation tags and named price combinations.
-- Nothing is assigned to products by this migration.

alter table public.operations_hub_price_rule_tags
  drop constraint if exists operations_hub_price_rule_tags_discount_source_check,
  add constraint operations_hub_price_rule_tags_discount_source_check
    check (discount_source_channel is null or discount_source_channel in ('smartstore', 'makeshop', 'ably')),
  drop constraint if exists operations_hub_price_rule_tags_discount_shape_check,
  add constraint operations_hub_price_rule_tags_discount_shape_check
    check (
      tag_role = 'price'
      or (
        discount_source_channel in ('smartstore', 'makeshop', 'ably')
        and replace_price is null
        and modify_type in ('add', 'percent')
        and modify_value <= 0
      )
    );

create or replace function public.save_operations_hub_price_rule_tag(
  p_tag_id bigint,
  p_tag_name text,
  p_color text,
  p_replace_price numeric,
  p_modify_type text,
  p_modify_value numeric,
  p_min_price numeric,
  p_max_price numeric,
  p_rounding_unit numeric,
  p_rounding_mode text,
  p_note text default null,
  p_tag_role text default 'price',
  p_discount_source_channel text default null,
  p_discount_rule_code text default null
)
returns public.operations_hub_price_rule_tags
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_saved public.operations_hub_price_rule_tags%rowtype;
  v_role text := lower(btrim(coalesce(p_tag_role, 'price')));
  v_source text := nullif(lower(btrim(coalesce(p_discount_source_channel, ''))), '');
begin
  if nullif(btrim(p_tag_name), '') is null then raise exception '계산 태그 이름이 필요합니다.'; end if;
  if coalesce(p_modify_type, 'none') not in ('none', 'add', 'percent') then raise exception '지원하지 않는 가격 조정 방식입니다.'; end if;
  if v_role not in ('price', 'discount') then raise exception '태그 역할은 판매가 또는 할인이어야 합니다.'; end if;
  if v_role = 'discount' then
    if v_source not in ('smartstore', 'makeshop', 'ably') then raise exception '할인 태그의 판매처가 필요합니다.'; end if;
    if p_replace_price is not null or p_modify_type not in ('add', 'percent') or coalesce(p_modify_value, 0) > 0 then
      raise exception '할인 태그는 금액 할인 또는 퍼센트 할인만 저장할 수 있습니다.';
    end if;
    if v_source = 'makeshop' and (p_modify_type <> 'percent' or abs(coalesce(p_modify_value, 0)) not in (10, 15, 20)) then
      raise exception '메이크샵 할인 태그는 10%%, 15%%, 20%% 중 하나여야 합니다.';
    end if;
  else
    v_source := null;
    p_discount_rule_code := null;
  end if;

  if p_tag_id is null then
    insert into public.operations_hub_price_rule_tags(
      tag_code, tag_name, color, replace_price, modify_type, modify_value,
      min_price, max_price, rounding_unit, rounding_mode, note,
      tag_role, discount_source_channel, discount_rule_code
    ) values (
      'USR_' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)),
      btrim(p_tag_name), coalesce(nullif(btrim(p_color), ''), '#2f6fd1'),
      p_replace_price, coalesce(p_modify_type, 'none'), coalesce(p_modify_value, 0),
      p_min_price, p_max_price, coalesce(p_rounding_unit, 1),
      coalesce(p_rounding_mode, 'nearest'), nullif(btrim(p_note), ''),
      v_role, v_source, nullif(upper(btrim(coalesce(p_discount_rule_code, ''))), '')
    ) returning * into v_saved;
  else
    update public.operations_hub_price_rule_tags tag set
      tag_name = btrim(p_tag_name),
      color = coalesce(nullif(btrim(p_color), ''), tag.color),
      replace_price = p_replace_price,
      modify_type = coalesce(p_modify_type, 'none'),
      modify_value = coalesce(p_modify_value, 0),
      min_price = p_min_price,
      max_price = p_max_price,
      rounding_unit = coalesce(p_rounding_unit, 1),
      rounding_mode = coalesce(p_rounding_mode, 'nearest'),
      note = nullif(btrim(p_note), ''),
      tag_role = v_role,
      discount_source_channel = v_source,
      discount_rule_code = nullif(upper(btrim(coalesce(p_discount_rule_code, ''))), ''),
      updated_at = now()
    where tag.price_rule_tag_id = p_tag_id
    returning * into v_saved;
    if not found then raise exception '계산 태그를 찾을 수 없습니다: %', p_tag_id; end if;
  end if;
  return v_saved;
end;
$$;

create or replace function public.calculate_operations_hub_price_rule_plan(
  p_base_price numeric,
  p_rule_set_id bigint,
  p_source text,
  p_source_discount_terms jsonb default '[]'::jsonb
)
returns table(
  gross_price numeric,
  discounted_base_price numeric,
  discount_terms jsonb,
  price_steps jsonb,
  discount_steps jsonb,
  has_discount_tag boolean
)
language plpgsql
stable
security invoker
set search_path = public, operations_private, pg_temp
as $$
declare
  v_source text := lower(btrim(coalesce(p_source, '')));
  v_price record;
  v_tag record;
  v_terms jsonb := coalesce(p_source_discount_terms, '[]'::jsonb);
  v_discount_steps jsonb := '[]'::jsonb;
  v_discount_count integer := 0;
  v_before numeric;
  v_after numeric;
  v_unit text;
  v_value numeric;
  v_rule_code text;
begin
  if v_source not in ('smartstore', 'makeshop', 'ably') then
    raise exception '지원하지 않는 판매처입니다: %', v_source;
  end if;
  if jsonb_typeof(v_terms) <> 'array' then raise exception '할인조건은 JSON 배열이어야 합니다.'; end if;

  select * into strict v_price
  from public.calculate_operations_hub_price_rule_set(p_base_price, p_rule_set_id);

  select count(*)::integer into v_discount_count
  from public.operations_hub_price_rule_set_items item
  join public.operations_hub_price_rule_tags tag
    on tag.price_rule_tag_id = item.price_rule_tag_id and tag.is_active
  where item.price_rule_set_id = p_rule_set_id
    and item.is_active
    and tag.tag_role = 'discount'
    and tag.discount_source_channel = v_source;

  if v_discount_count > 1 then
    raise exception '한 판매처에는 할인 태그를 하나만 넣을 수 있습니다: %', v_source;
  end if;

  select item.sort_order, tag.* into v_tag
  from public.operations_hub_price_rule_set_items item
  join public.operations_hub_price_rule_tags tag
    on tag.price_rule_tag_id = item.price_rule_tag_id and tag.is_active
  where item.price_rule_set_id = p_rule_set_id
    and item.is_active
    and tag.tag_role = 'discount'
    and tag.discount_source_channel = v_source
  order by item.sort_order
  limit 1;

  if found then
    if v_tag.modify_type = 'add' and v_tag.modify_value <= 0 then
      v_unit := 'amount';
      v_value := abs(v_tag.modify_value);
    elsif v_tag.modify_type = 'percent' and v_tag.modify_value <= 0 then
      v_unit := 'percent';
      v_value := abs(v_tag.modify_value);
    else
      raise exception '할인 태그는 금액 할인 또는 퍼센트 할인만 사용할 수 있습니다.';
    end if;

    if v_source = 'smartstore' then
      v_terms := coalesce((
        select jsonb_agg(term order by ordinal)
        from jsonb_array_elements(v_terms) with ordinality source_terms(term, ordinal)
        where term ->> 'term_key' <> 'basic'
      ), '[]'::jsonb);
      if v_value > 0 then
        v_terms := v_terms || jsonb_build_array(jsonb_build_object(
          'term_key', 'basic', 'term_type', 'basic', 'title', '기본할인',
          'unit', v_unit, 'value', v_value, 'is_baseline', true,
          'rounding_mode', v_tag.rounding_mode, 'rounding_unit', v_tag.rounding_unit,
          'price_rule_tag_id', v_tag.price_rule_tag_id
        ));
      end if;
    elsif v_source = 'makeshop' then
      if v_unit <> 'percent' or v_value not in (10, 15, 20) then
        raise exception '메이크샵 할인 태그는 10%%, 15%%, 20%% 중 하나여야 합니다.';
      end if;
      v_rule_code := coalesce(nullif(v_tag.discount_rule_code, ''), 'M' || trunc(v_value)::text);
      if v_rule_code not in ('M10', 'M15', 'M20') then raise exception '지원하지 않는 메이크샵 할인코드입니다: %', v_rule_code; end if;
      v_terms := coalesce((
        select jsonb_agg(term order by ordinal)
        from jsonb_array_elements(v_terms) with ordinality source_terms(term, ordinal)
        where term ->> 'term_key' <> 'period'
      ), '[]'::jsonb);
      v_terms := v_terms || jsonb_build_array(jsonb_build_object(
        'term_key', 'period', 'term_type', 'period', 'title', '기간 할인',
        'rule_code', v_rule_code, 'unit', 'percent', 'value', v_value,
        'is_baseline', true, 'rounding_mode', v_tag.rounding_mode,
        'rounding_unit', v_tag.rounding_unit, 'price_rule_tag_id', v_tag.price_rule_tag_id
      ));
    elsif v_source = 'ably' then
      v_terms := coalesce((
        select jsonb_agg(term order by ordinal)
        from jsonb_array_elements(v_terms) with ordinality source_terms(term, ordinal)
        where term ->> 'term_key' not in ('reported_result', 'immediate')
      ), '[]'::jsonb);
      if v_value > 0 then
        v_terms := v_terms || jsonb_build_array(jsonb_build_object(
          'term_key', 'immediate', 'term_type', 'immediate', 'title', '즉시할인',
          'unit', v_unit, 'value', v_value, 'is_baseline', true,
          'rounding_mode', v_tag.rounding_mode, 'rounding_unit', v_tag.rounding_unit,
          'price_rule_tag_id', v_tag.price_rule_tag_id
        ));
      end if;
    end if;

    v_before := v_price.final_price;
    v_after := operations_private.calculate_operations_hub_discounted_base(
      v_source, v_price.final_price, v_terms, null
    );
    v_discount_steps := jsonb_build_array(jsonb_build_object(
      'order', v_tag.sort_order, 'role', 'discount', 'source', v_source,
      'tag_id', v_tag.price_rule_tag_id, 'tag_code', v_tag.tag_code,
      'tag_name', v_tag.tag_name, 'before', v_before, 'after', v_after
    ));
  else
    v_after := operations_private.calculate_operations_hub_discounted_base(
      v_source, v_price.final_price, v_terms, null
    );
  end if;

  return query select
    v_price.final_price, v_after, v_terms,
    coalesce(v_price.steps, '[]'::jsonb), v_discount_steps,
    (v_discount_count = 1);
end;
$$;

with seed(tag_code, tag_name, color, tag_role, discount_source_channel, modify_value, note) as (
  values
    ('REP_PRICE_ADD_2000', '판매가 +2,000원', '#2f6fd1', 'price', null::text, 2000::numeric, '대표님 가격표 · 시스템 기준가격 +2,000원'),
    ('REP_PRICE_ADD_3000', '판매가 +3,000원', '#2f6fd1', 'price', null::text, 3000::numeric, '대표님 가격표 · 시스템 기준가격 +3,000원'),
    ('REP_PRICE_ADD_4000', '판매가 +4,000원', '#2f6fd1', 'price', null::text, 4000::numeric, '대표님 가격표 · 시스템 기준가격 +4,000원'),
    ('REP_PRICE_ADD_5000', '판매가 +5,000원', '#2f6fd1', 'price', null::text, 5000::numeric, '대표님 가격표 · 시스템 기준가격 +5,000원'),
    ('REP_SMART_DISCOUNT_2000', '스마트스토어 즉시할인 -2,000원', '#16a34a', 'discount', 'smartstore', -2000::numeric, '대표님 가격표 · 스마트스토어 즉시할인 -2,000원'),
    ('REP_SMART_DISCOUNT_3000', '스마트스토어 즉시할인 -3,000원', '#16a34a', 'discount', 'smartstore', -3000::numeric, '대표님 가격표 · 스마트스토어 즉시할인 -3,000원'),
    ('REP_SMART_DISCOUNT_4000', '스마트스토어 즉시할인 -4,000원', '#16a34a', 'discount', 'smartstore', -4000::numeric, '대표님 가격표 · 스마트스토어 즉시할인 -4,000원'),
    ('REP_SMART_DISCOUNT_5000', '스마트스토어 즉시할인 -5,000원', '#16a34a', 'discount', 'smartstore', -5000::numeric, '대표님 가격표 · 스마트스토어 즉시할인 -5,000원'),
    ('REP_ABLY_DISCOUNT_1000', '에이블리 즉시할인 -1,000원', '#7c3aed', 'discount', 'ably', -1000::numeric, '대표님 가격표 · 에이블리 즉시할인 -1,000원'),
    ('REP_ABLY_DISCOUNT_2000', '에이블리 즉시할인 -2,000원', '#7c3aed', 'discount', 'ably', -2000::numeric, '대표님 가격표 · 에이블리 즉시할인 -2,000원')
)
insert into public.operations_hub_price_rule_tags(
  tag_code, tag_name, color, replace_price, modify_type, modify_value,
  min_price, max_price, rounding_unit, rounding_mode, is_active, note,
  updated_by, tag_role, discount_source_channel, discount_rule_code
)
select tag_code, tag_name, color, null, 'add', modify_value,
       null, null, 1, 'nearest', true, note,
       'representative-sheet', tag_role, discount_source_channel, null
from seed
on conflict (tag_code) do update set
  tag_name = excluded.tag_name,
  color = excluded.color,
  replace_price = null,
  modify_type = 'add',
  modify_value = excluded.modify_value,
  min_price = null,
  max_price = null,
  rounding_unit = 1,
  rounding_mode = 'nearest',
  is_active = true,
  note = excluded.note,
  updated_by = excluded.updated_by,
  tag_role = excluded.tag_role,
  discount_source_channel = excluded.discount_source_channel,
  discount_rule_code = null,
  updated_at = now();

with seed(set_code, set_name, color, note) as (
  values
    ('REP_SMART_2000', '스스_2000', '#16a34a', '판매가 +2,000원 · 스마트스토어 즉시할인 -2,000원'),
    ('REP_SMART_3000', '스스_3000', '#16a34a', '판매가 +3,000원 · 스마트스토어 즉시할인 -3,000원'),
    ('REP_SMART_4000', '스스_4000', '#16a34a', '판매가 +4,000원 · 스마트스토어 즉시할인 -4,000원'),
    ('REP_SMART_5000', '스스_5000', '#16a34a', '판매가 +5,000원 · 스마트스토어 즉시할인 -5,000원'),
    ('REP_ABLY_1000', '에이블리_1000', '#7c3aed', '판매가 +4,000원 · 에이블리 즉시할인 -1,000원'),
    ('REP_ABLY_2000', '에이블리_2000', '#7c3aed', '판매가 +5,000원 · 에이블리 즉시할인 -2,000원')
)
insert into public.operations_hub_price_rule_sets(set_code, set_name, color, is_active, note, updated_by)
select set_code, set_name, color, true, note, 'representative-sheet'
from seed
on conflict (set_code) do update set
  set_name = excluded.set_name,
  color = excluded.color,
  is_active = true,
  note = excluded.note,
  updated_by = excluded.updated_by,
  updated_at = now();

delete from public.operations_hub_price_rule_set_items item
using public.operations_hub_price_rule_sets rule_set
where item.price_rule_set_id = rule_set.price_rule_set_id
  and rule_set.set_code in (
    'REP_SMART_2000', 'REP_SMART_3000', 'REP_SMART_4000',
    'REP_SMART_5000', 'REP_ABLY_1000', 'REP_ABLY_2000'
  );

with seed(set_code, tag_code, sort_order) as (
  values
    ('REP_SMART_2000', 'REP_PRICE_ADD_2000', 1), ('REP_SMART_2000', 'REP_SMART_DISCOUNT_2000', 2),
    ('REP_SMART_3000', 'REP_PRICE_ADD_3000', 1), ('REP_SMART_3000', 'REP_SMART_DISCOUNT_3000', 2),
    ('REP_SMART_4000', 'REP_PRICE_ADD_4000', 1), ('REP_SMART_4000', 'REP_SMART_DISCOUNT_4000', 2),
    ('REP_SMART_5000', 'REP_PRICE_ADD_5000', 1), ('REP_SMART_5000', 'REP_SMART_DISCOUNT_5000', 2),
    ('REP_ABLY_1000', 'REP_PRICE_ADD_4000', 1), ('REP_ABLY_1000', 'REP_ABLY_DISCOUNT_1000', 2),
    ('REP_ABLY_2000', 'REP_PRICE_ADD_5000', 1), ('REP_ABLY_2000', 'REP_ABLY_DISCOUNT_2000', 2)
)
insert into public.operations_hub_price_rule_set_items(
  price_rule_set_id, price_rule_tag_id, sort_order, is_active
)
select rule_set.price_rule_set_id, tag.price_rule_tag_id, seed.sort_order, true
from seed
join public.operations_hub_price_rule_sets rule_set on rule_set.set_code = seed.set_code
join public.operations_hub_price_rule_tags tag on tag.tag_code = seed.tag_code;

with seed(tag_name, tag_color, multiply_value, divide_value, add_value, description) as (
  values
    ('14K_기본', '#d97706', 1::numeric, 1::numeric, 0::numeric, '대표님 가격표 · 업체 입고가와 동일'),
    ('14K_노블', '#d97706', 1::numeric, 1::numeric, -7500::numeric, '대표님 가격표 · 업체 입고가 -7,500원'),
    ('14K_1/2', '#d97706', 1::numeric, 2::numeric, 0::numeric, '대표님 가격표 · 업체 입고가의 1/2')
)
insert into public.operations_hub_inbound_cost_formula_tags(
  tag_name, tag_color, multiply_value, divide_value, add_value,
  rounding_unit, rounding_mode, is_active, description, created_by
)
select tag_name, tag_color, multiply_value, divide_value, add_value,
       1, 'nearest', true, description, 'representative-sheet'
from seed
on conflict (tag_name) do update set
  tag_color = excluded.tag_color,
  multiply_value = excluded.multiply_value,
  divide_value = excluded.divide_value,
  add_value = excluded.add_value,
  rounding_unit = 1,
  rounding_mode = 'nearest',
  is_active = true,
  description = excluded.description,
  updated_at = now();

notify pgrst, 'reload schema';
