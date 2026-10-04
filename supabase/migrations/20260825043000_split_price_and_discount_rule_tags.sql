-- Split composite pricing rules into two explicit layers:
--   1. price tags calculate the marketplace gross sale price from Sellpia;
--   2. discount tags calculate marketplace-native discounts from that gross price.
-- Uploaded seller snapshots remain immutable. Drafts continue to be written to
-- operations_hub_change_queue and are only exported after review.

alter table public.operations_hub_price_rule_tags
  add column if not exists tag_role text not null default 'price',
  add column if not exists discount_source_channel text,
  add column if not exists discount_rule_code text;

alter table public.operations_hub_price_rule_tags
  drop constraint if exists operations_hub_price_rule_tags_role_check,
  add constraint operations_hub_price_rule_tags_role_check
    check (tag_role in ('price', 'discount')),
  drop constraint if exists operations_hub_price_rule_tags_discount_source_check,
  add constraint operations_hub_price_rule_tags_discount_source_check
    check (discount_source_channel is null or discount_source_channel in ('smartstore', 'makeshop')),
  drop constraint if exists operations_hub_price_rule_tags_discount_shape_check,
  add constraint operations_hub_price_rule_tags_discount_shape_check
    check (
      tag_role = 'price'
      or (
        discount_source_channel in ('smartstore', 'makeshop')
        and replace_price is null
        and modify_type in ('add', 'percent')
        and modify_value <= 0
      )
    );

comment on column public.operations_hub_price_rule_tags.tag_role is
  'price calculates the gross marketplace sale price; discount creates a marketplace-native discount independently.';
comment on column public.operations_hub_price_rule_tags.discount_source_channel is
  'Marketplace whose native discount format this discount tag targets.';

create or replace view public.operations_hub_price_rule_set_live
with (security_invoker = true)
as
select
  rule_set.price_rule_set_id,
  rule_set.set_code,
  rule_set.set_name,
  rule_set.color,
  rule_set.note,
  rule_set.updated_at,
  jsonb_agg(jsonb_build_object(
    'tag_id', tag.price_rule_tag_id,
    'tag_code', tag.tag_code,
    'tag_name', tag.tag_name,
    'color', tag.color,
    'order', item.sort_order,
    'tag_role', tag.tag_role,
    'discount_source_channel', tag.discount_source_channel,
    'discount_rule_code', tag.discount_rule_code,
    'replace_price', tag.replace_price,
    'modify_type', tag.modify_type,
    'modify_value', tag.modify_value,
    'min_price', tag.min_price,
    'max_price', tag.max_price,
    'rounding_unit', tag.rounding_unit,
    'rounding_mode', tag.rounding_mode
  ) order by item.sort_order) as tags
from public.operations_hub_price_rule_sets rule_set
join public.operations_hub_price_rule_set_items item
  on item.price_rule_set_id = rule_set.price_rule_set_id and item.is_active
join public.operations_hub_price_rule_tags tag
  on tag.price_rule_tag_id = item.price_rule_tag_id and tag.is_active
where rule_set.is_active
group by rule_set.price_rule_set_id;

grant select on public.operations_hub_price_rule_set_live to anon, authenticated;

create or replace function public.calculate_operations_hub_price_rule_set(
  p_base_price numeric,
  p_rule_set_id bigint
)
returns table(final_price numeric, steps jsonb)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_item record;
  v_calc record;
  v_current numeric := p_base_price;
  v_steps jsonb := '[]'::jsonb;
  v_total_count integer := 0;
begin
  if not exists (
    select 1 from public.operations_hub_price_rule_sets rule_set
    where rule_set.price_rule_set_id = p_rule_set_id and rule_set.is_active
  ) then
    raise exception '활성 조합 태그를 찾을 수 없습니다: %', p_rule_set_id;
  end if;

  select count(*)::integer into v_total_count
  from public.operations_hub_price_rule_set_items link
  join public.operations_hub_price_rule_tags tag
    on tag.price_rule_tag_id = link.price_rule_tag_id and tag.is_active
  where link.price_rule_set_id = p_rule_set_id and link.is_active;
  if v_total_count = 0 then raise exception '조합 태그에 활성 단계가 없습니다.'; end if;

  for v_item in
    select link.sort_order, tag.*
    from public.operations_hub_price_rule_set_items link
    join public.operations_hub_price_rule_tags tag
      on tag.price_rule_tag_id = link.price_rule_tag_id and tag.is_active
    where link.price_rule_set_id = p_rule_set_id
      and link.is_active
      and tag.tag_role = 'price'
    order by link.sort_order
  loop
    select * into v_calc from public.calculate_operations_hub_price_rule(
      v_current, v_item.replace_price, v_item.modify_type, v_item.modify_value,
      v_item.min_price, v_item.max_price, v_item.rounding_unit, v_item.rounding_mode
    );
    v_steps := v_steps || jsonb_build_array(jsonb_build_object(
      'order', v_item.sort_order,
      'role', 'price',
      'tag_id', v_item.price_rule_tag_id,
      'tag_code', v_item.tag_code,
      'tag_name', v_item.tag_name,
      'before', v_current,
      'after', v_calc.final_price
    ));
    v_current := v_calc.final_price;
  end loop;

  return query select v_current, v_steps;
end;
$$;

comment on function public.calculate_operations_hub_price_rule_set(numeric,bigint) is
  'Calculates only gross sale-price tags. Discount tags are resolved separately by calculate_operations_hub_price_rule_plan.';

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
          'term_key', 'basic',
          'term_type', 'basic',
          'title', '기본할인',
          'unit', v_unit,
          'value', v_value,
          'is_baseline', true,
          'rounding_mode', v_tag.rounding_mode,
          'rounding_unit', v_tag.rounding_unit,
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
        'term_key', 'period',
        'term_type', 'period',
        'title', '기간 할인',
        'rule_code', v_rule_code,
        'unit', 'percent',
        'value', v_value,
        'is_baseline', true,
        'rounding_mode', v_tag.rounding_mode,
        'rounding_unit', v_tag.rounding_unit,
        'price_rule_tag_id', v_tag.price_rule_tag_id
      ));
    end if;

    v_before := v_price.final_price;
    v_after := operations_private.calculate_operations_hub_discounted_base(
      v_source, v_price.final_price, v_terms, null
    );
    v_discount_steps := jsonb_build_array(jsonb_build_object(
      'order', v_tag.sort_order,
      'role', 'discount',
      'source', v_source,
      'tag_id', v_tag.price_rule_tag_id,
      'tag_code', v_tag.tag_code,
      'tag_name', v_tag.tag_name,
      'before', v_before,
      'after', v_after
    ));
  else
    v_after := operations_private.calculate_operations_hub_discounted_base(
      v_source, v_price.final_price, v_terms, null
    );
  end if;

  return query select
    v_price.final_price,
    v_after,
    v_terms,
    coalesce(v_price.steps, '[]'::jsonb),
    v_discount_steps,
    (v_discount_count = 1);
end;
$$;

comment on function public.calculate_operations_hub_price_rule_plan(numeric,bigint,text,jsonb) is
  'Returns gross sale price and independent native discount terms without inverse pricing. Existing source discounts are preserved when a set has no matching discount tag.';

revoke all on function public.calculate_operations_hub_price_rule_plan(numeric,bigint,text,jsonb) from public;
grant execute on function public.calculate_operations_hub_price_rule_plan(numeric,bigint,text,jsonb) to anon, authenticated;

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
  if nullif(btrim(p_tag_name), '') is null then raise exception '작은 태그 이름이 필요합니다.'; end if;
  if coalesce(p_modify_type, 'none') not in ('none', 'add', 'percent') then raise exception '지원하지 않는 가격 조정 방식입니다.'; end if;
  if v_role not in ('price', 'discount') then raise exception '태그 역할은 판매가 또는 할인이어야 합니다.'; end if;
  if v_role = 'discount' then
    if v_source not in ('smartstore', 'makeshop') then raise exception '할인 태그의 판매처가 필요합니다.'; end if;
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
    if not found then raise exception '작은 태그를 찾을 수 없습니다: %', p_tag_id; end if;
  end if;
  return v_saved;
end;
$$;

revoke all on function public.save_operations_hub_price_rule_tag(bigint,text,text,numeric,text,numeric,numeric,numeric,numeric,text,text,text,text,text) from public;
grant execute on function public.save_operations_hub_price_rule_tag(bigint,text,text,numeric,text,numeric,numeric,numeric,numeric,text,text,text,text,text) to anon, authenticated;

-- Keep the legacy inverse helper for audit/rollback, but remove it from every
-- active call path. Existing callers using discount_anchor are transparently
-- converted to fixed-base discount edits.
alter function public.save_operations_hub_seller_discount_draft(text,text,jsonb,text,numeric,numeric,uuid)
  rename to save_operations_hub_seller_discount_draft_inverse_legacy;

revoke all on function public.save_operations_hub_seller_discount_draft_inverse_legacy(text,text,jsonb,text,numeric,numeric,uuid) from public;

create function public.save_operations_hub_seller_discount_draft(
  p_sku text,
  p_source text,
  p_discount_terms jsonb,
  p_input_mode text default 'option',
  p_option_price numeric default null,
  p_target_final_price numeric default null,
  p_batch_id uuid default null
)
returns table(
  change_id bigint, draft_status text, cancelled_count integer, change_batch_id uuid,
  source_base_price numeric, source_discounted_base_price numeric,
  source_option_price numeric, source_final_price numeric,
  draft_base_price numeric, draft_discounted_base_price numeric,
  draft_option_price numeric, draft_final_price numeric,
  saved_input_mode text, saved_at timestamptz, draft_discount_terms jsonb
)
language sql
security invoker
set search_path = public, operations_private, pg_temp
as $$
  select *
  from public.save_operations_hub_seller_discount_draft_inverse_legacy(
    p_sku,
    p_source,
    p_discount_terms,
    case when lower(btrim(coalesce(p_input_mode, 'option'))) = 'discount_anchor' then 'option' else p_input_mode end,
    case when lower(btrim(coalesce(p_input_mode, 'option'))) = 'discount_anchor' then null else p_option_price end,
    case when lower(btrim(coalesce(p_input_mode, 'option'))) = 'discount_anchor' then null else p_target_final_price end,
    p_batch_id
  );
$$;

comment on function public.save_operations_hub_seller_discount_draft(text,text,jsonb,text,numeric,numeric,uuid) is
  'Saves discounts without gross-price inversion. Legacy discount_anchor requests now keep the effective base and option prices fixed.';
revoke all on function public.save_operations_hub_seller_discount_draft(text,text,jsonb,text,numeric,numeric,uuid) from public;
grant execute on function public.save_operations_hub_seller_discount_draft(text,text,jsonb,text,numeric,numeric,uuid) to anon, authenticated;

alter table public.operations_hub_change_queue
  drop constraint if exists operations_hub_change_queue_pricing_input_mode_check;
alter table public.operations_hub_change_queue
  add constraint operations_hub_change_queue_pricing_input_mode_check
    check (pricing_input_mode is null or pricing_input_mode in ('legacy_final','option','final','discount_anchor','rule_tags'));

alter table public.operations_hub_export_items
  drop constraint if exists operations_hub_export_items_pricing_input_mode_check;
alter table public.operations_hub_export_items
  add constraint operations_hub_export_items_pricing_input_mode_check
    check (pricing_input_mode is null or pricing_input_mode in ('legacy_final','option','final','discount_anchor','rule_tags'));

alter table public.operations_hub_change_queue
  drop constraint if exists operations_hub_change_queue_price_version_check;
alter table public.operations_hub_change_queue
  add constraint operations_hub_change_queue_price_version_check
    check (price_calculation_version in (1, 2, 3));

alter table public.operations_hub_export_items
  drop constraint if exists operations_hub_export_items_price_version_check;
alter table public.operations_hub_export_items
  add constraint operations_hub_export_items_price_version_check
    check (price_calculation_version in (1, 2, 3));

create or replace function public.save_operations_hub_seller_rule_draft(
  p_sku text,
  p_source text,
  p_target_base_price numeric,
  p_target_discount_terms jsonb,
  p_target_option_price numeric,
  p_price_rule_set_id bigint,
  p_batch_id uuid default null
)
returns table(
  change_id bigint,
  draft_status text,
  cancelled_count integer,
  change_batch_id uuid,
  draft_base_price numeric,
  draft_discounted_base_price numeric,
  draft_option_price numeric,
  draft_final_price numeric,
  saved_at timestamptz
)
language plpgsql
security invoker
set search_path = public, operations_private, pg_temp
as $$
declare
  v_sku text := btrim(coalesce(p_sku, ''));
  v_source text := lower(btrim(coalesce(p_source, '')));
  v_terms jsonb := coalesce(p_target_discount_terms, '[]'::jsonb);
  v_matrix public.operations_hub_matrix_cached%rowtype;
  v_snapshot_id uuid;
  v_source_row public.seller_inventory_snapshot_rows%rowtype;
  v_product_code text;
  v_option_code text;
  v_source_base numeric;
  v_source_discounted numeric;
  v_source_option numeric;
  v_source_final numeric;
  v_target_discounted numeric;
  v_target_final numeric;
  v_batch_id uuid := coalesce(p_batch_id, gen_random_uuid());
  v_saved_at timestamptz := now();
  v_cancelled integer := 0;
  v_change_id bigint;
begin
  if v_sku = '' then raise exception '셀피아 SKU가 필요합니다.'; end if;
  if v_source not in ('smartstore','makeshop','ably') then raise exception '지원하지 않는 판매처입니다: %', v_source; end if;
  if p_target_base_price is null or p_target_base_price < 0 then raise exception '태그 계산 판매가는 0원 이상이어야 합니다.'; end if;
  if p_target_option_price is null then raise exception '태그 계산 옵션가가 필요합니다.'; end if;
  if jsonb_typeof(v_terms) <> 'array' then raise exception '할인조건은 JSON 배열이어야 합니다.'; end if;

  select * into v_matrix
  from public.operations_hub_matrix_cached matrix
  where matrix.sellpia_sku_code = v_sku;
  if not found then raise exception '매트릭스에 없는 셀피아 SKU입니다: %', v_sku; end if;

  v_product_code := case v_source
    when 'smartstore' then v_matrix.smartstore_product_code
    when 'makeshop' then v_matrix.makeshop_product_code
    when 'ably' then v_matrix.ably_product_code
  end;
  v_option_code := case v_source
    when 'smartstore' then coalesce(v_matrix.smartstore_option_code, '')
    when 'makeshop' then coalesce(v_matrix.makeshop_option_code, '')
    when 'ably' then coalesce(v_matrix.ably_option_code, '')
  end;
  if nullif(btrim(v_product_code), '') is null then raise exception '판매처 연결 상품코드가 없습니다.'; end if;

  select snapshot.snapshot_id into v_snapshot_id
  from public.seller_inventory_snapshots snapshot
  where snapshot.source_channel = v_source and snapshot.upload_status = 'ready'
  order by snapshot.completed_at desc nulls last, snapshot.created_at desc
  limit 1;
  if v_snapshot_id is null then raise exception '최신 % 원본이 없습니다.', v_source; end if;

  select * into v_source_row
  from public.seller_inventory_snapshot_rows source_row
  where source_row.snapshot_id = v_snapshot_id
    and source_row.product_code = v_product_code
    and source_row.option_code = coalesce(v_option_code, '');
  if not found then
    raise exception '최신 % 원본에서 상품·옵션코드를 찾지 못했습니다: % / %', v_source, v_product_code, coalesce(v_option_code, '');
  end if;

  v_source_base := coalesce(v_source_row.base_price, nullif(v_source_row.raw_payload ->> 'base_price', '')::numeric, v_source_row.price);
  v_source_discounted := coalesce(
    v_source_row.discounted_base_price,
    operations_private.calculate_operations_hub_discounted_base(v_source, v_source_base, coalesce(v_source_row.discount_terms, '[]'::jsonb), null)
  );
  v_source_option := coalesce(v_source_row.option_price, nullif(v_source_row.raw_payload ->> 'option_price', '')::numeric, 0);
  v_source_final := coalesce(v_source_row.final_price, v_source_row.price, v_source_discounted + v_source_option);
  v_target_discounted := operations_private.calculate_operations_hub_discounted_base(v_source, p_target_base_price, v_terms, null);
  v_target_final := v_target_discounted + p_target_option_price;
  if v_target_final < 0 then raise exception '태그 계산 최종구매가는 0원 이상이어야 합니다.'; end if;

  update public.operations_hub_change_queue queue
  set status = 'cancelled', cancelled_at = v_saved_at,
      cancelled_by = 'operations_hub_frontend',
      status_message = '더 최신 가격·할인 태그 수정안으로 대체됨',
      updated_at = v_saved_at
  where queue.sellpia_sku_code = v_sku
    and queue.source_channel = v_source
    and queue.field_key = 'sellpia_sale_price'
    and queue.status in ('pending','validated','failed');
  get diagnostics v_cancelled = row_count;

  if v_source_base is not distinct from p_target_base_price
     and v_source_discounted is not distinct from v_target_discounted
     and v_source_option is not distinct from p_target_option_price
     and v_source_final is not distinct from v_target_final
     and coalesce(v_source_row.discount_terms, '[]'::jsonb) = v_terms then
    return query select null::bigint, 'unchanged'::text, v_cancelled, v_batch_id,
      p_target_base_price, v_target_discounted, p_target_option_price, v_target_final, v_saved_at;
    return;
  end if;

  insert into public.operations_hub_change_queue(
    change_batch_id, sellpia_sku_code, field_key, before_value, after_value,
    target_channels, status, requested_by, requested_at, updated_at,
    source_channel, seller_product_code, seller_option_code, status_message,
    price_base_before, price_base_after,
    price_discounted_base_before, price_discounted_base_after,
    price_option_before, price_option_after,
    price_final_before, price_final_after,
    option_price_source, base_price_source, price_rule_set_id,
    price_calculation_version, pricing_input_mode,
    source_snapshot_id, source_discount_fingerprint,
    price_discount_terms_before, price_discount_terms_after
  ) values (
    v_batch_id, v_sku, 'sellpia_sale_price', to_jsonb(v_source_final), to_jsonb(v_target_final),
    array[v_source], 'pending', 'operations_hub_frontend', v_saved_at, v_saved_at,
    v_source, v_product_code, coalesce(v_option_code, ''),
    'DB 저장됨 · 판매가 태그 + 할인 태그 독립 계산',
    v_source_base, p_target_base_price,
    v_source_discounted, v_target_discounted,
    v_source_option, p_target_option_price,
    v_source_final, v_target_final,
    'tag', 'tag', p_price_rule_set_id,
    3, 'rule_tags',
    v_snapshot_id, v_source_row.source_discount_fingerprint,
    coalesce(v_source_row.discount_terms, '[]'::jsonb), v_terms
  ) returning operations_hub_change_queue.change_id into v_change_id;

  return query select v_change_id, 'pending'::text, v_cancelled, v_batch_id,
    p_target_base_price, v_target_discounted, p_target_option_price, v_target_final, v_saved_at;
end;
$$;

revoke all on function public.save_operations_hub_seller_rule_draft(text,text,numeric,jsonb,numeric,bigint,uuid) from public;
grant execute on function public.save_operations_hub_seller_rule_draft(text,text,numeric,jsonb,numeric,bigint,uuid) to anon, authenticated;

create or replace function public.stage_operations_hub_assigned_price_drafts_bulk(
  p_skus text[],
  p_sources text[],
  p_batch_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, operations_private, pg_temp
as $$
declare
  v_target record;
  v_item record;
  v_anchor record;
  v_plan record;
  v_calc record;
  v_saved record;
  v_product_count integer;
  v_assignment_count integer;
  v_rule_count integer;
  v_discount_signature_count integer;
  v_snapshot_id uuid;
  v_requested_skus integer := 0;
  v_assignment_rows integer := 0;
  v_pending integer := 0;
  v_unchanged integer := 0;
  v_failed integer := 0;
  v_errors jsonb := '[]'::jsonb;
  v_batch_id uuid := coalesce(p_batch_id, gen_random_uuid());
begin
  if coalesce(cardinality(p_skus), 0) = 0 then raise exception '가격 수정안을 만들 셀피아 SKU가 필요합니다.'; end if;
  if coalesce(cardinality(p_sources), 0) = 0 then raise exception '가격 수정안을 만들 판매처가 필요합니다.'; end if;
  if exists (select 1 from unnest(p_sources) source_name where lower(btrim(source_name)) not in ('smartstore','makeshop','ably')) then
    raise exception '지원하지 않는 판매처가 포함되어 있습니다.';
  end if;

  select count(*)::integer into v_requested_skus
  from (select distinct nullif(btrim(sku), '') sku from unnest(p_skus) sku) requested
  where requested.sku is not null;

  for v_target in
    with requested as (
      select distinct nullif(btrim(sku), '') sku from unnest(p_skus) sku
    ), sources as (
      select distinct lower(btrim(source_name)) source_name from unnest(p_sources) source_name
    )
    select distinct
      assignment.source_channel,
      assignment.price_rule_set_id,
      case assignment.source_channel
        when 'smartstore' then matrix.smartstore_product_code
        when 'makeshop' then matrix.makeshop_product_code
        when 'ably' then matrix.ably_product_code
      end as product_code
    from public.operations_hub_price_rule_assignments assignment
    join requested on requested.sku = assignment.sellpia_sku_code
    join sources on sources.source_name = assignment.source_channel
    join public.operations_hub_matrix_live matrix on matrix.sellpia_sku_code = assignment.sellpia_sku_code
    where assignment.target_type = 'sellpia_sku'
      and assignment.is_active
      and nullif(btrim(case assignment.source_channel
        when 'smartstore' then matrix.smartstore_product_code
        when 'makeshop' then matrix.makeshop_product_code
        when 'ably' then matrix.ably_product_code
      end), '') is not null
    order by assignment.source_channel, product_code
  loop
    begin
      select count(distinct matrix.sellpia_sku_code)::integer
      into v_product_count
      from public.operations_hub_matrix_live matrix
      where case v_target.source_channel
        when 'smartstore' then matrix.smartstore_product_code
        when 'makeshop' then matrix.makeshop_product_code
        when 'ably' then matrix.ably_product_code
      end = v_target.product_code;

      select count(*)::integer, count(distinct assignment.price_rule_set_id)::integer
      into v_assignment_count, v_rule_count
      from (
        select distinct matrix.sellpia_sku_code
        from public.operations_hub_matrix_live matrix
        where case v_target.source_channel
          when 'smartstore' then matrix.smartstore_product_code
          when 'makeshop' then matrix.makeshop_product_code
          when 'ably' then matrix.ably_product_code
        end = v_target.product_code
      ) product_sku
      join public.operations_hub_price_rule_assignments assignment
        on assignment.target_type = 'sellpia_sku'
       and assignment.source_channel = v_target.source_channel
       and assignment.sellpia_sku_code = product_sku.sellpia_sku_code
       and assignment.is_active;

      if v_assignment_count <> v_product_count or v_rule_count <> 1 then
        raise exception '같은 판매처 상품의 모든 옵션에 동일한 가격·할인 태그가 필요합니다: % / %', v_target.source_channel, v_target.product_code;
      end if;
      if exists (
        select 1
        from public.operations_hub_change_queue queue
        join public.operations_hub_matrix_live matrix on matrix.sellpia_sku_code = queue.sellpia_sku_code
        where queue.source_channel = v_target.source_channel
          and queue.field_key = 'sellpia_sale_price'
          and queue.status in ('processing','exported')
          and case v_target.source_channel
            when 'smartstore' then matrix.smartstore_product_code
            when 'makeshop' then matrix.makeshop_product_code
            when 'ably' then matrix.ably_product_code
          end = v_target.product_code
      ) then
        raise exception '반영 진행 중이거나 이미 내보낸 가격 수정안이 있습니다: % / %', v_target.source_channel, v_target.product_code;
      end if;

      select snapshot.snapshot_id into v_snapshot_id
      from public.seller_inventory_snapshots snapshot
      where snapshot.source_channel = v_target.source_channel
        and snapshot.upload_status = 'ready'
      order by snapshot.completed_at desc nulls last, snapshot.created_at desc
      limit 1;
      if v_snapshot_id is null then raise exception '최신 % 원본이 없습니다.', v_target.source_channel; end if;

      select
        matrix.sellpia_sku_code,
        matrix.sellpia_sale_price,
        coalesce(source_row.discount_terms, '[]'::jsonb) as discount_terms
      into v_anchor
      from public.operations_hub_matrix_live matrix
      join public.seller_inventory_snapshot_rows source_row
        on source_row.snapshot_id = v_snapshot_id
       and source_row.product_code = v_target.product_code
       and source_row.option_code = case v_target.source_channel
         when 'smartstore' then coalesce(matrix.smartstore_option_code, '')
         when 'makeshop' then coalesce(matrix.makeshop_option_code, '')
         when 'ably' then coalesce(matrix.ably_option_code, '')
       end
      where case v_target.source_channel
        when 'smartstore' then matrix.smartstore_product_code
        when 'makeshop' then matrix.makeshop_product_code
        when 'ably' then matrix.ably_product_code
      end = v_target.product_code
      order by abs(coalesce(source_row.option_price, 0)), matrix.sellpia_sku_code
      limit 1;
      if v_anchor.sellpia_sku_code is null then raise exception '최신 판매처 원본과 연결된 기준 SKU를 찾지 못했습니다.'; end if;

      select * into strict v_plan
      from public.calculate_operations_hub_price_rule_plan(
        v_anchor.sellpia_sale_price,
        v_target.price_rule_set_id,
        v_target.source_channel,
        v_anchor.discount_terms
      );

      if not v_plan.has_discount_tag then
        select count(distinct md5(coalesce(source_row.discount_terms, '[]'::jsonb)::text))::integer
        into v_discount_signature_count
        from public.operations_hub_matrix_live matrix
        join public.seller_inventory_snapshot_rows source_row
          on source_row.snapshot_id = v_snapshot_id
         and source_row.product_code = v_target.product_code
         and source_row.option_code = case v_target.source_channel
           when 'smartstore' then coalesce(matrix.smartstore_option_code, '')
           when 'makeshop' then coalesce(matrix.makeshop_option_code, '')
           when 'ably' then coalesce(matrix.ably_option_code, '')
         end
        where case v_target.source_channel
          when 'smartstore' then matrix.smartstore_product_code
          when 'makeshop' then matrix.makeshop_product_code
          when 'ably' then matrix.ably_product_code
        end = v_target.product_code;
        if v_discount_signature_count <> 1 then
          raise exception '할인 태그가 없는데 같은 상품의 옵션별 원본 할인조건이 서로 다릅니다: % / %', v_target.source_channel, v_target.product_code;
        end if;
      end if;

      for v_item in
        select distinct matrix.sellpia_sku_code, matrix.sellpia_sale_price
        from public.operations_hub_matrix_live matrix
        where case v_target.source_channel
          when 'smartstore' then matrix.smartstore_product_code
          when 'makeshop' then matrix.makeshop_product_code
          when 'ably' then matrix.ably_product_code
        end = v_target.product_code
        order by matrix.sellpia_sku_code
      loop
        select * into strict v_calc
        from public.calculate_operations_hub_price_rule_set(v_item.sellpia_sale_price, v_target.price_rule_set_id);
        select * into strict v_saved
        from public.save_operations_hub_seller_rule_draft(
          v_item.sellpia_sku_code,
          v_target.source_channel,
          v_plan.gross_price,
          v_plan.discount_terms,
          v_calc.final_price - v_plan.gross_price,
          v_target.price_rule_set_id,
          v_batch_id
        );
        v_assignment_rows := v_assignment_rows + 1;
        if v_saved.draft_status = 'pending' then v_pending := v_pending + 1;
        else v_unchanged := v_unchanged + 1;
        end if;
      end loop;
    exception when others then
      v_failed := v_failed + 1;
      if jsonb_array_length(v_errors) < 20 then
        v_errors := v_errors || jsonb_build_array(jsonb_build_object(
          'source', v_target.source_channel,
          'product_code', v_target.product_code,
          'message', sqlerrm
        ));
      end if;
    end;
  end loop;

  return jsonb_build_object(
    'batch_id', v_batch_id,
    'requested_skus', v_requested_skus,
    'assignment_rows', v_assignment_rows,
    'pending_drafts', v_pending,
    'unchanged_drafts', v_unchanged,
    'failed_rows', v_failed,
    'unassigned_rows', greatest(v_requested_skus * (
      select count(*) from (select distinct lower(btrim(source_name)) from unnest(p_sources) source_name) source_count
    ) - v_assignment_rows, 0),
    'errors', v_errors
  );
end;
$$;

comment on function public.stage_operations_hub_assigned_price_drafts_bulk(text[],text[],uuid) is
  'Stages product-wide seller drafts from gross price tags plus independent native discount tags. No discount inversion is used.';

create or replace function public.reprice_operations_hub_sellpia_price_change(
  p_sku text,
  p_batch_id uuid default null
)
returns table(
  source_channel text,
  seller_product_code text,
  sellpia_sku_code text,
  change_id bigint,
  draft_status text,
  change_batch_id uuid,
  draft_base_price numeric,
  draft_discounted_base_price numeric,
  draft_option_price numeric,
  draft_final_price numeric,
  price_rule_set_id bigint
)
language plpgsql
security invoker
set search_path = public, operations_private, pg_temp
as $$
declare
  v_sku text := btrim(coalesce(p_sku, ''));
  v_batch_id uuid := coalesce(p_batch_id, gen_random_uuid());
  v_sources text[];
  v_result jsonb;
begin
  if v_sku = '' then raise exception '셀피아 SKU가 필요합니다.'; end if;
  select array_agg(distinct assignment.source_channel order by assignment.source_channel)
  into v_sources
  from public.operations_hub_price_rule_assignments assignment
  where assignment.target_type = 'sellpia_sku'
    and assignment.sellpia_sku_code = v_sku
    and assignment.source_channel in ('smartstore','makeshop')
    and assignment.is_active;
  if coalesce(cardinality(v_sources), 0) = 0 then return; end if;

  v_result := public.stage_operations_hub_assigned_price_drafts_bulk(array[v_sku], v_sources, v_batch_id);
  if coalesce((v_result ->> 'failed_rows')::integer, 0) > 0 then
    raise exception '셀피아 가격 변경 후 가격·할인 태그 재계산에 실패했습니다: %', v_result -> 'errors';
  end if;

  return query
  select
    queue.source_channel,
    queue.seller_product_code,
    queue.sellpia_sku_code,
    queue.change_id,
    queue.status,
    queue.change_batch_id,
    queue.price_base_after,
    queue.price_discounted_base_after,
    queue.price_option_after,
    queue.price_final_after,
    queue.price_rule_set_id
  from public.operations_hub_change_queue queue
  where queue.change_batch_id = v_batch_id
    and queue.source_channel = any(v_sources)
    and queue.field_key = 'sellpia_sale_price'
    and queue.status in ('pending','validated','failed')
  order by queue.source_channel, queue.sellpia_sku_code;
end;
$$;

comment on function public.reprice_operations_hub_sellpia_price_change(text,uuid) is
  'Restages Smartstore and MakeShop products from independent gross-price and discount tags after a Sellpia price edit.';

revoke all on function public.reprice_operations_hub_sellpia_price_change(text,uuid) from public;
grant execute on function public.reprice_operations_hub_sellpia_price_change(text,uuid) to anon, authenticated;

notify pgrst, 'reload schema';
