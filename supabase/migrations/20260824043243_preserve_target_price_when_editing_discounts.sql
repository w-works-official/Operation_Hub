-- Preserve the effective target customer price when marketplace discounts change.
--
-- Priority for the target price is:
--   1. the latest active seller price draft (formula or manual),
--   2. the latest uploaded seller source price.
-- The marketplace base price is grossed up so the new native discount lands on
-- the same discounted base price. Products absent from the latest seller source
-- remain non-editable because they cannot be exported safely.

alter table public.operations_hub_change_queue
  drop constraint if exists operations_hub_change_queue_pricing_input_mode_check,
  drop constraint if exists operations_hub_change_queue_base_price_source_check,
  drop constraint if exists operations_hub_change_queue_option_price_source_check;

alter table public.operations_hub_change_queue
  add constraint operations_hub_change_queue_pricing_input_mode_check
    check (pricing_input_mode is null or pricing_input_mode in ('legacy_final','option','final','discount_anchor')),
  add constraint operations_hub_change_queue_base_price_source_check
    check (base_price_source is null or base_price_source in ('source','tag','manual','discount')),
  add constraint operations_hub_change_queue_option_price_source_check
    check (option_price_source is null or option_price_source in ('original','manual','tag','discount'));

alter table public.operations_hub_export_items
  drop constraint if exists operations_hub_export_items_pricing_input_mode_check;

alter table public.operations_hub_export_items
  add constraint operations_hub_export_items_pricing_input_mode_check
    check (pricing_input_mode is null or pricing_input_mode in ('legacy_final','option','final','discount_anchor'));

create or replace function operations_private.gross_operations_hub_discount_base(
  p_source text,
  p_target_discounted_price numeric,
  p_discount_terms jsonb
)
returns numeric
language plpgsql
immutable
security invoker
set search_path = operations_private, pg_catalog, pg_temp
as $$
declare
  v_target numeric := p_target_discounted_price;
  v_terms jsonb := coalesce(p_discount_terms, '[]'::jsonb);
  v_low bigint := 0;
  v_high bigint;
  v_mid bigint;
  v_result numeric;
  v_steps integer := 0;
begin
  if v_target is null or v_target < 0 then
    raise exception '유지할 할인 적용 판매가는 0원 이상이어야 합니다.';
  end if;
  if trunc(v_target) <> v_target then
    raise exception '원 단위가 아닌 목표 판매가는 할인 역산할 수 없습니다: %', v_target;
  end if;
  if jsonb_typeof(v_terms) <> 'array' then
    raise exception '할인조건은 JSON 배열이어야 합니다.';
  end if;

  v_high := greatest(1, ceil(v_target)::bigint);
  while operations_private.calculate_operations_hub_discounted_base(p_source, v_high, v_terms, null) < v_target loop
    v_high := v_high * 2;
    v_steps := v_steps + 1;
    if v_high > 1000000000000 or v_steps > 64 then
      raise exception '할인 적용 판매가 %원을 만들 판매가를 찾지 못했습니다.', v_target;
    end if;
  end loop;

  while v_low < v_high loop
    v_mid := (v_low + v_high) / 2;
    if operations_private.calculate_operations_hub_discounted_base(p_source, v_mid, v_terms, null) < v_target then
      v_low := v_mid + 1;
    else
      v_high := v_mid;
    end if;
  end loop;

  v_result := operations_private.calculate_operations_hub_discounted_base(p_source, v_low, v_terms, null);
  if v_result <> v_target then
    raise exception '현재 할인율·절사 단위로 목표 할인 적용 판매가 %원을 정확히 만들 수 없습니다.', v_target
      using hint = '목표가격 또는 할인코드의 절사 단위를 확인해주세요.';
  end if;
  return v_low;
end;
$$;

comment on function operations_private.gross_operations_hub_discount_base(text,numeric,jsonb)
  is 'Finds the smallest whole-won seller base price whose native discount result exactly equals the anchored discounted price.';

revoke all on function operations_private.gross_operations_hub_discount_base(text,numeric,jsonb) from public;
grant execute on function operations_private.gross_operations_hub_discount_base(text,numeric,jsonb) to anon, authenticated;

create or replace function public.save_operations_hub_seller_discount_draft(
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
  saved_input_mode text, saved_at timestamptz,
  draft_discount_terms jsonb
)
language plpgsql
security invoker
set search_path = public, operations_private, pg_temp
as $$
declare
  v_matrix public.operations_hub_matrix_cached%rowtype;
  v_snapshot_id uuid;
  v_source_row public.seller_inventory_snapshot_rows%rowtype;
  v_existing public.operations_hub_change_queue%rowtype;
  v_product_code text;
  v_option_code text;
  v_source_base numeric;
  v_source_discounted numeric;
  v_source_option numeric;
  v_source_final numeric;
  v_target_base numeric;
  v_target_discounted numeric;
  v_target_option numeric;
  v_target_final numeric;
  v_anchor_discounted numeric;
  v_cancelled integer := 0;
  v_change_id bigint;
  v_batch_id uuid := coalesce(p_batch_id, gen_random_uuid());
  v_saved_at timestamptz := now();
begin
  p_sku := btrim(coalesce(p_sku, ''));
  p_source := lower(btrim(coalesce(p_source, '')));
  p_input_mode := lower(btrim(coalesce(p_input_mode, 'option')));
  p_discount_terms := coalesce(p_discount_terms, '[]'::jsonb);
  if p_source not in ('smartstore','makeshop','ably') then raise exception '지원하지 않는 판매처입니다.'; end if;
  if p_input_mode not in ('option','final','discount_anchor') then raise exception '입력 방식은 option, final 또는 discount_anchor여야 합니다.'; end if;
  if jsonb_typeof(p_discount_terms) <> 'array' then raise exception '할인조건은 JSON 배열이어야 합니다.'; end if;
  if exists (
    select 1 from jsonb_array_elements(p_discount_terms) term
    where nullif(term ->> 'value', '') is not null
      and ((term ->> 'value')::numeric < 0 or term ->> 'unit' not in ('percent','amount'))
  ) then raise exception '할인값과 단위를 확인해주세요.'; end if;

  select * into v_matrix from public.operations_hub_matrix_cached matrix where matrix.sellpia_sku_code = p_sku;
  if not found then raise exception '매트릭스에 없는 셀피아 SKU입니다: %', p_sku; end if;
  v_product_code := case p_source when 'smartstore' then v_matrix.smartstore_product_code when 'makeshop' then v_matrix.makeshop_product_code when 'ably' then v_matrix.ably_product_code end;
  v_option_code := case p_source when 'smartstore' then coalesce(v_matrix.smartstore_option_code, '') when 'makeshop' then coalesce(v_matrix.makeshop_option_code, '') when 'ably' then coalesce(v_matrix.ably_option_code, '') end;
  if nullif(btrim(v_product_code), '') is null then raise exception '판매처 연결 상품코드가 없습니다.'; end if;

  select snapshot.snapshot_id into v_snapshot_id
  from public.seller_inventory_snapshots snapshot
  where snapshot.source_channel = p_source and snapshot.upload_status = 'ready'
  order by snapshot.completed_at desc nulls last, snapshot.created_at desc limit 1;
  select * into v_source_row from public.seller_inventory_snapshot_rows row_item
  where row_item.snapshot_id = v_snapshot_id and row_item.product_code = v_product_code
    and row_item.option_code = coalesce(v_option_code, '');
  if not found then
    raise exception '최신 % 원본에서 상품·옵션코드를 찾지 못했습니다: % / %', p_source, v_product_code, coalesce(v_option_code, '')
      using hint = '판매처 원본을 다시 업로드하거나 상품·옵션 연결을 먼저 확인해주세요.';
  end if;

  select * into v_existing from public.operations_hub_change_queue queue
  where queue.sellpia_sku_code = p_sku and queue.source_channel = p_source
    and queue.field_key = 'sellpia_sale_price'
    and queue.status in ('pending','validated','processing','exported','failed')
  order by queue.updated_at desc, queue.change_id desc limit 1;

  v_source_base := coalesce(v_source_row.base_price, nullif(v_source_row.raw_payload ->> 'base_price', '')::numeric, v_source_row.price);
  v_source_discounted := coalesce(v_source_row.discounted_base_price, v_source_base);
  v_source_option := coalesce(v_source_row.option_price, nullif(v_source_row.raw_payload ->> 'option_price', '')::numeric, 0);
  v_source_final := coalesce(v_source_row.final_price, v_source_row.price, v_source_discounted + v_source_option);

  if p_input_mode = 'discount_anchor' then
    v_target_option := coalesce(p_option_price, v_existing.price_option_after, v_source_option, 0);
    v_target_final := coalesce(p_target_final_price, v_existing.price_final_after, v_source_final);
    v_anchor_discounted := v_target_final - v_target_option;
    if v_anchor_discounted < 0 then raise exception '목표 최종구매가보다 옵션가가 커서 할인 적용 판매가가 음수가 됩니다.'; end if;
    v_target_base := operations_private.gross_operations_hub_discount_base(p_source, v_anchor_discounted, p_discount_terms);
    v_target_discounted := operations_private.calculate_operations_hub_discounted_base(p_source, v_target_base, p_discount_terms, null);
  else
    v_target_base := coalesce(v_existing.price_base_after, v_source_base);
    v_target_discounted := operations_private.calculate_operations_hub_discounted_base(p_source, v_target_base, p_discount_terms, null);
    if p_input_mode = 'final' then
      v_target_final := coalesce(p_target_final_price, v_existing.price_final_after, v_source_final);
      v_target_option := v_target_final - v_target_discounted;
    else
      v_target_option := coalesce(p_option_price, v_existing.price_option_after, v_source_option, 0);
      v_target_final := v_target_discounted + v_target_option;
    end if;
  end if;
  if v_target_final < 0 then raise exception '최종구매가는 0 이상이어야 합니다.'; end if;

  update public.operations_hub_change_queue queue
  set status='cancelled', cancelled_at=v_saved_at, cancelled_by='operations_hub_frontend',
      status_message='더 최신인 할인조건 수정으로 대체됨', updated_at=v_saved_at
  where queue.sellpia_sku_code=p_sku and queue.source_channel=p_source
    and queue.field_key='sellpia_sale_price' and queue.status in ('pending','validated','failed');
  get diagnostics v_cancelled = row_count;

  if v_source_base is not distinct from v_target_base
     and v_source_option is not distinct from v_target_option
     and v_source_final is not distinct from v_target_final
     and coalesce(v_source_row.discount_terms, '[]'::jsonb) = p_discount_terms then
    return query select null::bigint, 'unchanged'::text, v_cancelled, v_batch_id,
      v_source_base, v_source_discounted, v_source_option, v_source_final,
      v_target_base, v_target_discounted, v_target_option, v_target_final,
      p_input_mode, v_saved_at, p_discount_terms;
    return;
  end if;

  insert into public.operations_hub_change_queue(
    change_batch_id,sellpia_sku_code,field_key,before_value,after_value,target_channels,status,
    requested_by,requested_at,updated_at,source_channel,seller_product_code,seller_option_code,status_message,
    price_base_before,price_base_after,price_discounted_base_before,price_discounted_base_after,
    price_option_before,price_option_after,price_final_before,price_final_after,
    option_price_source,base_price_source,price_rule_set_id,price_calculation_version,pricing_input_mode,
    source_snapshot_id,source_discount_fingerprint,price_discount_terms_before,price_discount_terms_after
  ) values (
    v_batch_id,p_sku,'sellpia_sale_price',to_jsonb(v_source_final),to_jsonb(v_target_final),array[p_source],'pending',
    'operations_hub_frontend',v_saved_at,v_saved_at,p_source,v_product_code,coalesce(v_option_code,''),'DB 저장됨 · 할인 적용 후 목표가 유지',
    v_source_base,v_target_base,v_source_discounted,v_target_discounted,
    v_source_option,v_target_option,v_source_final,v_target_final,
    case
      when p_input_mode='discount_anchor'
       and p_option_price is not null
       and p_option_price is distinct from coalesce(v_existing.price_option_after,v_source_option,0)
        then 'discount'
      else coalesce(v_existing.option_price_source,'original')
    end,
    case when p_input_mode='discount_anchor' then 'discount' else coalesce(v_existing.base_price_source,'source') end,
    v_existing.price_rule_set_id,2,p_input_mode,
    v_snapshot_id,v_source_row.source_discount_fingerprint,coalesce(v_source_row.discount_terms,'[]'::jsonb),p_discount_terms
  ) returning operations_hub_change_queue.change_id into v_change_id;

  return query select v_change_id,'pending'::text,v_cancelled,v_batch_id,
    v_source_base,v_source_discounted,v_source_option,v_source_final,
    v_target_base,v_target_discounted,v_target_option,v_target_final,
    p_input_mode,v_saved_at,p_discount_terms;
end;
$$;

revoke all on function public.save_operations_hub_seller_discount_draft(text,text,jsonb,text,numeric,numeric,uuid) from public;
grant execute on function public.save_operations_hub_seller_discount_draft(text,text,jsonb,text,numeric,numeric,uuid) to anon, authenticated;

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
  v_anchor_final numeric;
  v_anchor_option numeric;
  v_anchor_discounted numeric;
  v_item record;
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

  if v_anchor_sku = '' then
    select matrix.sellpia_sku_code into v_anchor_sku
    from public.operations_hub_matrix_cached matrix
    where case v_source when 'smartstore' then matrix.smartstore_product_code when 'makeshop' then matrix.makeshop_product_code end = v_product_code
    order by matrix.sellpia_sku_code
    limit 1;
  end if;

  select
    coalesce(active_draft.price_final_after, source_row.final_price, source_row.price),
    coalesce(active_draft.price_option_after, source_row.option_price, nullif(source_row.raw_payload ->> 'option_price','')::numeric, 0)
  into v_anchor_final, v_anchor_option
  from public.operations_hub_matrix_cached matrix
  join public.seller_inventory_snapshot_rows source_row
    on source_row.snapshot_id=v_snapshot_id
   and source_row.product_code=v_product_code
   and source_row.option_code=case v_source when 'smartstore' then coalesce(matrix.smartstore_option_code,'') when 'makeshop' then coalesce(matrix.makeshop_option_code,'') end
  left join lateral (
    select queue.price_final_after, queue.price_option_after
    from public.operations_hub_change_queue queue
    where queue.sellpia_sku_code=matrix.sellpia_sku_code
      and queue.source_channel=v_source
      and queue.field_key='sellpia_sale_price'
      and queue.status in ('pending','validated','processing','exported','failed')
    order by queue.updated_at desc, queue.change_id desc
    limit 1
  ) active_draft on true
  where matrix.sellpia_sku_code=v_anchor_sku
    and case v_source when 'smartstore' then matrix.smartstore_product_code when 'makeshop' then matrix.makeshop_product_code end = v_product_code
  limit 1;
  if v_anchor_final is null then
    raise exception '기준 SKU %의 최신 가격을 찾지 못했습니다. 상품·옵션 연결을 확인해주세요.', v_anchor_sku;
  end if;
  v_anchor_discounted := v_anchor_final - v_anchor_option;
  if v_anchor_discounted < 0 then raise exception '기준 SKU의 최종구매가보다 옵션가가 커서 할인 적용 판매가가 음수가 됩니다.'; end if;

  for v_item in
    select distinct on (matrix.sellpia_sku_code)
      matrix.sellpia_sku_code,
      coalesce(active_draft.price_final_after, source_row.final_price, source_row.price) as target_final_price
    from public.operations_hub_matrix_cached matrix
    join public.seller_inventory_snapshot_rows source_row
      on source_row.snapshot_id=v_snapshot_id
     and source_row.product_code=v_product_code
     and source_row.option_code=case v_source when 'smartstore' then coalesce(matrix.smartstore_option_code,'') when 'makeshop' then coalesce(matrix.makeshop_option_code,'') end
    left join lateral (
      select queue.price_final_after
      from public.operations_hub_change_queue queue
      where queue.sellpia_sku_code=matrix.sellpia_sku_code
        and queue.source_channel=v_source
        and queue.field_key='sellpia_sale_price'
        and queue.status in ('pending','validated','processing','exported','failed')
      order by queue.updated_at desc, queue.change_id desc
      limit 1
    ) active_draft on true
    where case v_source when 'smartstore' then matrix.smartstore_product_code when 'makeshop' then matrix.makeshop_product_code end = v_product_code
    order by matrix.sellpia_sku_code
  loop
    select * into strict v_saved
    from public.save_operations_hub_seller_discount_draft(
      v_item.sellpia_sku_code, v_source, v_terms, 'discount_anchor',
      v_item.target_final_price - v_anchor_discounted,
      v_item.target_final_price,
      v_batch_id
    );
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
  is 'Atomically edits a current Smartstore or MakeShop product discount. The clicked option anchors one shared discounted base; option adjustments preserve every SKU target final price.';

revoke all on function public.save_operations_hub_seller_product_discount_draft_v2(text,text,text,jsonb,text,uuid) from public;
grant execute on function public.save_operations_hub_seller_product_discount_draft_v2(text,text,text,jsonb,text,uuid) to anon, authenticated;

create or replace function public.save_operations_hub_seller_product_discount_draft(
  p_source text,
  p_product_code text,
  p_discount_terms jsonb default '[]'::jsonb,
  p_rule_code text default null,
  p_batch_id uuid default null
)
returns table(
  sellpia_sku_code text, change_id bigint, draft_status text, cancelled_count integer,
  change_batch_id uuid, source_base_price numeric, source_discounted_base_price numeric,
  source_option_price numeric, source_final_price numeric, draft_base_price numeric,
  draft_discounted_base_price numeric, draft_option_price numeric, draft_final_price numeric,
  saved_input_mode text, saved_at timestamptz, draft_discount_terms jsonb,
  affected_sku_count integer, rule_code text
)
language sql
security invoker
set search_path = public, operations_private, pg_temp
as $$
  select *
  from public.save_operations_hub_seller_product_discount_draft_v2(
    p_source, p_product_code, null, p_discount_terms, p_rule_code, p_batch_id
  );
$$;

comment on function public.save_operations_hub_seller_product_discount_draft(text,text,jsonb,text,uuid)
  is 'Compatibility wrapper for product discount editing. New clients pass an explicit anchor SKU to the V2 function.';

revoke all on function public.save_operations_hub_seller_product_discount_draft(text,text,jsonb,text,uuid) from public;
grant execute on function public.save_operations_hub_seller_product_discount_draft(text,text,jsonb,text,uuid) to anon, authenticated;

notify pgrst, 'reload schema';
