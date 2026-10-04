-- Production price rules inferred from the latest Smartstore and MakeShop
-- originals. Assignments are internal calculation metadata only: this migration
-- does not create seller price drafts or export items.
--
-- Discount policy after this migration:
--   * every option in a seller product has one active price rule -> preserve the
--     rule-calculated customer price and gross up the seller base price;
--   * no option has a price rule -> keep the effective seller base/option prices
--     and allow the customer price to move with the edited discount;
--   * partial or mixed rule assignment -> reject the product edit atomically.

insert into public.operations_hub_price_rule_tags (
  tag_code, tag_name, color, replace_price, modify_type, modify_value,
  min_price, max_price, rounding_unit, rounding_mode, note, updated_by
) values
  ('PROD_BASE_SAME', '기준가 그대로', '#2563EB', null, 'none', 0, null, null, 1, 'nearest', '셀피아 판매가를 판매처 최종구매가로 사용', 'production-price-analysis-20260824'),
  ('PROD_ADD_200', '기준가 +200원', '#0891B2', null, 'add', 200, null, null, 1, 'nearest', '셀피아 판매가에 200원 추가', 'production-price-analysis-20260824'),
  ('PROD_ADD_500', '기준가 +500원', '#0D9488', null, 'add', 500, null, null, 1, 'nearest', '셀피아 판매가에 500원 추가', 'production-price-analysis-20260824'),
  ('PROD_ADD_600', '기준가 +600원', '#16A34A', null, 'add', 600, null, null, 1, 'nearest', '셀피아 판매가에 600원 추가', 'production-price-analysis-20260824'),
  ('PROD_ADD_700', '기준가 +700원', '#65A30D', null, 'add', 700, null, null, 1, 'nearest', '셀피아 판매가에 700원 추가', 'production-price-analysis-20260824'),
  ('PROD_ADD_800', '기준가 +800원', '#CA8A04', null, 'add', 800, null, null, 1, 'nearest', '셀피아 판매가에 800원 추가', 'production-price-analysis-20260824'),
  ('PROD_ADD_1000_REVIEW', '기준가 +1,000원 · 개별검토', '#EA580C', null, 'add', 1000, null, null, 1, 'nearest', '자동배정하지 않는 개별검토용 가격 규칙', 'production-price-analysis-20260824'),
  ('PROD_ADD_4000', '기준가 +4,000원', '#DC2626', null, 'add', 4000, null, null, 1, 'nearest', '스마트스토어 14K 반복 패턴용', 'production-price-analysis-20260824')
on conflict (tag_code) do update set
  tag_name=excluded.tag_name,
  color=excluded.color,
  replace_price=excluded.replace_price,
  modify_type=excluded.modify_type,
  modify_value=excluded.modify_value,
  min_price=excluded.min_price,
  max_price=excluded.max_price,
  rounding_unit=excluded.rounding_unit,
  rounding_mode=excluded.rounding_mode,
  note=excluded.note,
  is_active=true,
  updated_by=excluded.updated_by,
  updated_at=now();

insert into public.operations_hub_price_rule_sets (
  set_code, set_name, color, is_active, note, updated_by
) values
  ('PROD_SET_SAME', '기준가 그대로', '#2563EB', true, '스마트스토어·메이크샵 공통 생산 규칙', 'production-price-analysis-20260824'),
  ('PROD_SET_ADD_200', '기준가 +200원', '#0891B2', true, '스마트스토어·메이크샵 공통 생산 규칙', 'production-price-analysis-20260824'),
  ('PROD_SET_ADD_500', '기준가 +500원', '#0D9488', true, '스마트스토어·메이크샵 공통 생산 규칙', 'production-price-analysis-20260824'),
  ('PROD_SET_ADD_600', '기준가 +600원', '#16A34A', true, '메이크샵 생산 규칙', 'production-price-analysis-20260824'),
  ('PROD_SET_ADD_700', '기준가 +700원', '#65A30D', true, '스마트스토어·메이크샵 공통 생산 규칙', 'production-price-analysis-20260824'),
  ('PROD_SET_ADD_800', '기준가 +800원', '#CA8A04', true, '메이크샵 생산 규칙', 'production-price-analysis-20260824'),
  ('PROD_SET_ADD_1000_REVIEW', '기준가 +1,000원 · 개별검토', '#EA580C', true, '자동배정하지 않는 개별검토용 규칙', 'production-price-analysis-20260824'),
  ('PROD_SET_SMART_14K_ADD_4000', '스마트스토어 14K +4,000원', '#DC2626', true, '스마트스토어의 수동매칭·상품전체 균일 +4,000원 패턴', 'production-price-analysis-20260824')
on conflict (set_code) do update set
  set_name=excluded.set_name,
  color=excluded.color,
  is_active=true,
  note=excluded.note,
  updated_by=excluded.updated_by,
  updated_at=now();

delete from public.operations_hub_price_rule_set_items item
using public.operations_hub_price_rule_sets rule_set
where item.price_rule_set_id=rule_set.price_rule_set_id
  and rule_set.set_code like 'PROD_SET_%';

insert into public.operations_hub_price_rule_set_items (
  price_rule_set_id, price_rule_tag_id, sort_order, is_active
)
select rule_set.price_rule_set_id, tag.price_rule_tag_id, 1, true
from (values
  ('PROD_SET_SAME','PROD_BASE_SAME'),
  ('PROD_SET_ADD_200','PROD_ADD_200'),
  ('PROD_SET_ADD_500','PROD_ADD_500'),
  ('PROD_SET_ADD_600','PROD_ADD_600'),
  ('PROD_SET_ADD_700','PROD_ADD_700'),
  ('PROD_SET_ADD_800','PROD_ADD_800'),
  ('PROD_SET_ADD_1000_REVIEW','PROD_ADD_1000_REVIEW'),
  ('PROD_SET_SMART_14K_ADD_4000','PROD_ADD_4000')
) seed(set_code, tag_code)
join public.operations_hub_price_rule_sets rule_set on rule_set.set_code=seed.set_code
join public.operations_hub_price_rule_tags tag on tag.tag_code=seed.tag_code;

-- Keep the virtual QA calculator available, but make its records visibly test-only
-- and remove its five live-SKU assignments from the operational calculation path.
update public.operations_hub_price_rule_sets
set set_name=case when set_name like '[테스트] %' then set_name else '[테스트] ' || set_name end,
    note=concat_ws(' · ', nullif(note,''), '운영 자동배정 제외'),
    updated_by='production-price-analysis-20260824',
    updated_at=now()
where set_code like 'QA_%';

update public.operations_hub_price_rule_tags
set tag_name=case when tag_name like '[테스트] %' then tag_name else '[테스트] ' || tag_name end,
    note=concat_ws(' · ', nullif(note,''), '운영 자동배정 제외'),
    updated_by='production-price-analysis-20260824',
    updated_at=now()
where tag_code like 'QA_%';

update public.operations_hub_price_rule_assignments assignment
set is_active=false,
    updated_by='production-price-analysis-20260824',
    updated_at=now()
from public.operations_hub_price_rule_sets rule_set
where assignment.price_rule_set_id=rule_set.price_rule_set_id
  and assignment.is_active
  and rule_set.set_code like 'QA_%';

-- Automatic assignment evidence boundary:
--   latest ready seller original + MANUAL_LINKED on every product option + one
--   uniform final-price difference for the entire seller product.
with latest as (
  select distinct on (source_channel) source_channel, snapshot_id
  from public.seller_inventory_snapshots
  where source_channel in ('smartstore','makeshop') and upload_status='ready'
  order by source_channel, completed_at desc nulls last, created_at desc
), price_rows as (
  select 'smartstore'::text source_channel,
         matrix.sellpia_sku_code,
         matrix.smartstore_product_code product_code,
         matrix.smartstore_match_tier match_tier,
         source_row.final_price-matrix.sellpia_sale_price difference
  from public.operations_hub_matrix_cached matrix
  join latest on latest.source_channel='smartstore'
  join public.seller_inventory_snapshot_rows source_row
    on source_row.snapshot_id=latest.snapshot_id
   and source_row.product_code=matrix.smartstore_product_code
   and coalesce(source_row.option_code,'')=coalesce(matrix.smartstore_option_code,'')
  where matrix.sellpia_sale_price>0 and source_row.final_price>0
  union all
  select 'makeshop', matrix.sellpia_sku_code, matrix.makeshop_product_code,
         matrix.makeshop_match_tier,
         source_row.final_price-matrix.sellpia_sale_price
  from public.operations_hub_matrix_cached matrix
  join latest on latest.source_channel='makeshop'
  join public.seller_inventory_snapshot_rows source_row
    on source_row.snapshot_id=latest.snapshot_id
   and source_row.product_code=matrix.makeshop_product_code
   and coalesce(source_row.option_code,'')=coalesce(matrix.makeshop_option_code,'')
  where matrix.sellpia_sale_price>0 and source_row.final_price>0
), product_evidence as (
  select source_channel, product_code,
         min(difference) min_difference,
         max(difference) max_difference,
         bool_and(match_tier='MANUAL_LINKED') all_manual
  from price_rows
  group by source_channel, product_code
), eligible as (
  select price_rows.source_channel, price_rows.sellpia_sku_code,
    case
      when price_rows.difference=0 then 'PROD_SET_SAME'
      when price_rows.difference=200 then 'PROD_SET_ADD_200'
      when price_rows.difference=500 then 'PROD_SET_ADD_500'
      when price_rows.difference=600 then 'PROD_SET_ADD_600'
      when price_rows.difference=700 then 'PROD_SET_ADD_700'
      when price_rows.difference=800 then 'PROD_SET_ADD_800'
      when price_rows.source_channel='smartstore' and price_rows.difference=4000
        then 'PROD_SET_SMART_14K_ADD_4000'
    end set_code
  from price_rows
  join product_evidence using (source_channel, product_code)
  where product_evidence.all_manual
    and product_evidence.min_difference=product_evidence.max_difference
    and (
      (price_rows.source_channel='smartstore' and price_rows.difference in (0,200,500,700,4000))
      or (price_rows.source_channel='makeshop' and price_rows.difference in (0,200,500,600,700,800))
    )
), resolved as (
  select source_channel, sellpia_sku_code, min(set_code) set_code
  from eligible
  group by source_channel, sellpia_sku_code
  having count(distinct set_code)=1
)
insert into public.operations_hub_price_rule_assignments (
  source_channel, target_type, sellpia_sku_code, price_rule_set_id,
  is_active, updated_by
)
select resolved.source_channel, 'sellpia_sku', resolved.sellpia_sku_code,
       rule_set.price_rule_set_id, true, 'production-price-analysis-20260824'
from resolved
join public.operations_hub_price_rule_sets rule_set on rule_set.set_code=resolved.set_code
on conflict (source_channel, sellpia_sku_code)
  where target_type='sellpia_sku' and is_active
do update set
  price_rule_set_id=excluded.price_rule_set_id,
  updated_by=excluded.updated_by,
  updated_at=now();

create or replace function public.save_operations_hub_seller_product_discount_draft_v2(
  p_source text,
  p_product_code text,
  p_anchor_sku text default null,
  p_discount_terms jsonb default '[]'::jsonb,
  p_rule_code text default null,
  p_batch_id uuid default null
)
returns table(
  sellpia_sku_code text,
  change_id bigint,
  draft_status text,
  cancelled_count integer,
  change_batch_id uuid,
  source_base_price numeric,
  source_discounted_base_price numeric,
  source_option_price numeric,
  source_final_price numeric,
  draft_base_price numeric,
  draft_discounted_base_price numeric,
  draft_option_price numeric,
  draft_final_price numeric,
  saved_input_mode text,
  saved_at timestamptz,
  draft_discount_terms jsonb,
  affected_sku_count integer,
  rule_code text
)
language plpgsql
security invoker
set search_path = public, operations_private, pg_temp
as $$
declare
  v_source text := lower(btrim(coalesce(p_source, '')));
  v_product_code text := btrim(coalesce(p_product_code, ''));
  v_anchor_sku text := btrim(coalesce(p_anchor_sku, ''));
  v_rule_code text := upper(btrim(coalesce(p_rule_code, '')));
  v_terms jsonb := coalesce(p_discount_terms, '[]'::jsonb);
  v_batch_id uuid := coalesce(p_batch_id, gen_random_uuid());
  v_count integer;
  v_valid_count integer;
  v_snapshot_id uuid;
  v_assignment_count integer;
  v_assignment_rule_count integer;
  v_rule_set_id bigint;
  v_has_price_rule boolean := false;
  v_anchor_final numeric;
  v_anchor_option numeric;
  v_anchor_discounted numeric;
  v_target_final numeric;
  v_item record;
  v_calc record;
  v_saved record;
  v_period_value numeric;
  v_rounding_unit integer;
begin
  if v_source not in ('smartstore', 'makeshop') then raise exception '상품 단위 할인편집은 스마트스토어와 메이크샵만 지원합니다.'; end if;
  if v_product_code = '' then raise exception '판매처 상품코드를 확인해주세요.'; end if;
  if jsonb_typeof(v_terms) <> 'array' then raise exception '할인조건은 JSON 배열이어야 합니다.'; end if;

  if v_source = 'smartstore' then
    if nullif(v_rule_code, '') is not null then raise exception '스마트스토어 기본할인에는 할인코드를 사용하지 않습니다.'; end if;
    if exists (
      select 1 from jsonb_array_elements(v_terms) term
      where term ->> 'term_key' = 'basic'
        and (term ->> 'unit' <> 'amount' or coalesce(nullif(term ->> 'value', '')::numeric, -1) < 0)
    ) then raise exception '스마트스토어 기본할인은 0원 이상의 금액할인만 저장할 수 있습니다.'; end if;
    if (select count(*) from jsonb_array_elements(v_terms) term where term ->> 'term_key' = 'basic') > 1 then
      raise exception '스마트스토어 기본할인은 하나만 저장할 수 있습니다.';
    end if;
  else
    if v_rule_code not in ('NONE', 'M10', 'M15', 'M20') then raise exception '메이크샵 할인코드는 NONE, M10, M15, M20 중 하나여야 합니다.'; end if;
    v_terms := coalesce((select jsonb_agg(term order by ordinal) from jsonb_array_elements(v_terms) with ordinality terms(term, ordinal) where term ->> 'term_key' <> 'period'), '[]'::jsonb);
    if v_rule_code <> 'NONE' then
      v_period_value := case v_rule_code when 'M10' then 10 when 'M15' then 15 when 'M20' then 20 end;
      v_rounding_unit := case v_rule_code when 'M20' then 100 else 10 end;
      v_terms := v_terms || jsonb_build_array(jsonb_build_object(
        'term_key','period','term_type','period','title','기간 할인','rule_code',v_rule_code,
        'unit','percent','value',v_period_value,'is_baseline',true,
        'rounding_mode','down','rounding_unit',v_rounding_unit
      ));
    end if;
  end if;

  select count(distinct matrix.sellpia_sku_code)::integer into v_count
  from public.operations_hub_matrix_cached matrix
  where case v_source when 'smartstore' then matrix.smartstore_product_code when 'makeshop' then matrix.makeshop_product_code end = v_product_code;
  if v_count = 0 then raise exception '같은 판매처 상품코드에 연결된 SKU를 찾지 못했습니다: %', v_product_code; end if;

  select snapshot.snapshot_id into v_snapshot_id
  from public.seller_inventory_snapshots snapshot
  where snapshot.source_channel=v_source and snapshot.upload_status='ready'
  order by snapshot.completed_at desc nulls last, snapshot.created_at desc limit 1;
  if v_snapshot_id is null then raise exception '최신 % 원본이 없습니다. 판매처 원본을 먼저 업로드해주세요.', v_source; end if;

  select count(distinct matrix.sellpia_sku_code)::integer into v_valid_count
  from public.operations_hub_matrix_cached matrix
  join public.seller_inventory_snapshot_rows source_row
    on source_row.snapshot_id=v_snapshot_id
   and source_row.product_code=v_product_code
   and source_row.option_code=case v_source when 'smartstore' then coalesce(matrix.smartstore_option_code,'') when 'makeshop' then coalesce(matrix.makeshop_option_code,'') end
  where case v_source when 'smartstore' then matrix.smartstore_product_code when 'makeshop' then matrix.makeshop_product_code end = v_product_code;

  if v_valid_count = 0 then
    if not exists (select 1 from public.seller_inventory_snapshot_rows source_row where source_row.snapshot_id=v_snapshot_id and source_row.product_code=v_product_code) then
      raise exception '최신 % 원본에 상품코드 %가 없습니다. 원본을 갱신한 뒤 할인정보를 수정해주세요.', v_source, v_product_code;
    end if;
    raise exception '최신 % 원본과 매트릭스의 옵션코드가 일치하지 않습니다: 상품 %', v_source, v_product_code
      using hint = '상품매칭에서 옵션 연결을 먼저 확인해주세요.';
  end if;
  if v_valid_count <> v_count then
    raise exception '연결된 SKU %개 중 %개만 최신 % 원본과 일치합니다: 상품 %', v_count, v_valid_count, v_source, v_product_code
      using hint = '일부 옵션만 저장하지 않도록 전체 상품을 롤백했습니다. 옵션 연결을 먼저 확인해주세요.';
  end if;

  select count(*)::integer, count(distinct assignment.price_rule_set_id)::integer,
         min(assignment.price_rule_set_id)
  into v_assignment_count, v_assignment_rule_count, v_rule_set_id
  from (
    select distinct matrix.sellpia_sku_code
    from public.operations_hub_matrix_cached matrix
    where case v_source when 'smartstore' then matrix.smartstore_product_code when 'makeshop' then matrix.makeshop_product_code end = v_product_code
  ) product_sku
  join public.operations_hub_price_rule_assignments assignment
    on assignment.target_type='sellpia_sku'
   and assignment.source_channel=v_source
   and assignment.sellpia_sku_code=product_sku.sellpia_sku_code
   and assignment.is_active;

  if v_assignment_count not in (0, v_count) then
    raise exception '같은 판매처 상품의 가격 태그가 일부 옵션에만 배정되어 있습니다: % / %개', v_assignment_count, v_count
      using hint = '상품의 모든 옵션에 같은 가격 태그를 배정하거나 모두 해제해주세요.';
  end if;
  if v_assignment_rule_count > 1 then
    raise exception '같은 판매처 상품의 옵션에 서로 다른 가격 태그가 배정되어 있습니다.'
      using hint = '상품의 모든 옵션 가격 태그를 하나로 통일해주세요.';
  end if;
  v_has_price_rule := v_assignment_count=v_count and v_count>0;

  if v_anchor_sku = '' then
    select matrix.sellpia_sku_code into v_anchor_sku
    from public.operations_hub_matrix_cached matrix
    where case v_source when 'smartstore' then matrix.smartstore_product_code when 'makeshop' then matrix.makeshop_product_code end = v_product_code
    order by matrix.sellpia_sku_code limit 1;
  end if;

  if v_has_price_rule then
    select calc.final_price,
           coalesce(active_draft.price_option_after, source_row.option_price, nullif(source_row.raw_payload ->> 'option_price','')::numeric, 0)
    into v_anchor_final, v_anchor_option
    from public.operations_hub_matrix_cached matrix
    join public.seller_inventory_snapshot_rows source_row
      on source_row.snapshot_id=v_snapshot_id
     and source_row.product_code=v_product_code
     and source_row.option_code=case v_source when 'smartstore' then coalesce(matrix.smartstore_option_code,'') when 'makeshop' then coalesce(matrix.makeshop_option_code,'') end
    cross join lateral public.calculate_operations_hub_price_rule_set(matrix.sellpia_sale_price, v_rule_set_id) calc
    left join lateral (
      select queue.price_option_after
      from public.operations_hub_change_queue queue
      where queue.sellpia_sku_code=matrix.sellpia_sku_code
        and queue.source_channel=v_source
        and queue.field_key='sellpia_sale_price'
        and queue.status in ('pending','validated','processing','exported','failed')
      order by queue.updated_at desc, queue.change_id desc limit 1
    ) active_draft on true
    where matrix.sellpia_sku_code=v_anchor_sku
      and case v_source when 'smartstore' then matrix.smartstore_product_code when 'makeshop' then matrix.makeshop_product_code end = v_product_code
    limit 1;
    if v_anchor_final is null then raise exception '기준 SKU %의 가격 태그 계산값을 찾지 못했습니다.', v_anchor_sku; end if;
    v_anchor_discounted := v_anchor_final-v_anchor_option;
    if v_anchor_discounted < 0 then raise exception '가격 태그 목표가보다 현재 옵션가가 커서 할인 적용 판매가가 음수가 됩니다.'; end if;
  end if;

  for v_item in
    select distinct matrix.sellpia_sku_code, matrix.sellpia_sale_price
    from public.operations_hub_matrix_cached matrix
    where case v_source when 'smartstore' then matrix.smartstore_product_code when 'makeshop' then matrix.makeshop_product_code end = v_product_code
    order by matrix.sellpia_sku_code
  loop
    if v_has_price_rule then
      select * into strict v_calc
      from public.calculate_operations_hub_price_rule_set(v_item.sellpia_sale_price, v_rule_set_id);
      v_target_final := v_calc.final_price;
    else
      v_target_final := null;
    end if;

    select * into strict v_saved
    from public.save_operations_hub_seller_discount_draft(
      v_item.sellpia_sku_code,
      v_source,
      v_terms,
      case when v_has_price_rule then 'discount_anchor' else 'option' end,
      case when v_has_price_rule then v_target_final-v_anchor_discounted else null end,
      v_target_final,
      v_batch_id
    );

    if v_saved.change_id is not null then
      update public.operations_hub_change_queue queue
      set price_rule_set_id=case when v_has_price_rule then v_rule_set_id else null end,
          base_price_source=case
            when v_has_price_rule then 'tag'
            when queue.base_price_source='tag' then 'manual'
            else queue.base_price_source
          end,
          pricing_input_mode=case when v_has_price_rule then 'discount_anchor' else 'option' end,
          status_message=case
            when v_has_price_rule then 'DB 저장됨 · 가격 태그 목표가 유지'
            else 'DB 저장됨 · 가격 태그 없음 · 판매가 유지'
          end,
          updated_at=now()
      where queue.change_id=v_saved.change_id;
    end if;

    return query select
      v_item.sellpia_sku_code::text,v_saved.change_id::bigint,v_saved.draft_status::text,
      v_saved.cancelled_count::integer,v_saved.change_batch_id::uuid,
      v_saved.source_base_price::numeric,v_saved.source_discounted_base_price::numeric,
      v_saved.source_option_price::numeric,v_saved.source_final_price::numeric,
      v_saved.draft_base_price::numeric,v_saved.draft_discounted_base_price::numeric,
      v_saved.draft_option_price::numeric,v_saved.draft_final_price::numeric,
      v_saved.saved_input_mode::text,v_saved.saved_at::timestamptz,
      v_saved.draft_discount_terms::jsonb,v_count,nullif(v_rule_code,'');
  end loop;
end;
$$;

comment on function public.save_operations_hub_seller_product_discount_draft_v2(text,text,text,jsonb,text,uuid)
  is 'Atomically edits Smartstore or MakeShop discounts. A uniform active product price tag preserves its calculated customer price; without a tag, effective seller base and option prices stay unchanged.';

revoke all on function public.save_operations_hub_seller_product_discount_draft_v2(text,text,text,jsonb,text,uuid) from public;
grant execute on function public.save_operations_hub_seller_product_discount_draft_v2(text,text,text,jsonb,text,uuid) to anon, authenticated;

notify pgrst, 'reload schema';
