create or replace function public.save_operations_hub_seller_product_discount_mode_v1(
  p_source text,
  p_product_code text,
  p_anchor_sku text default null,
  p_discount_terms jsonb default '[]'::jsonb,
  p_rule_code text default null,
  p_calculation_mode text default 'forward',
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
set statement_timeout = '45s'
as $$
declare
  v_source text := lower(btrim(coalesce(p_source, '')));
  v_product_code text := btrim(coalesce(p_product_code, ''));
  v_rule_code text := upper(btrim(coalesce(p_rule_code, '')));
  v_mode text := lower(btrim(coalesce(p_calculation_mode, 'forward')));
  v_terms jsonb := coalesce(p_discount_terms, '[]'::jsonb);
  v_batch_id uuid := coalesce(p_batch_id, gen_random_uuid());
  v_count integer;
  v_item record;
  v_saved record;
  v_period_value numeric;
  v_rounding_unit integer;
begin
  if v_source not in ('smartstore', 'makeshop') then
    raise exception '상품 단위 할인편집은 스마트스토어와 메이크샵만 지원합니다.';
  end if;
  if v_product_code = '' then raise exception '판매처 상품코드를 확인해주세요.'; end if;
  if v_mode not in ('forward', 'reverse-base') then
    raise exception '가격 계산 방식은 forward 또는 reverse-base여야 합니다.';
  end if;
  if jsonb_typeof(v_terms) <> 'array' then raise exception '할인조건은 JSON 배열이어야 합니다.'; end if;

  if v_source = 'smartstore' then
    if nullif(v_rule_code, '') is not null then
      raise exception '스마트스토어 기본할인에는 할인코드를 사용하지 않습니다.';
    end if;
    if exists (
      select 1
      from jsonb_array_elements(v_terms) term
      where term ->> 'term_key' = 'basic'
        and (term ->> 'unit' <> 'amount' or coalesce(nullif(term ->> 'value', '')::numeric, -1) < 0)
    ) then raise exception '스마트스토어 기본할인은 0원 이상의 금액할인만 저장할 수 있습니다.'; end if;
    if (select count(*) from jsonb_array_elements(v_terms) term where term ->> 'term_key' = 'basic') > 1 then
      raise exception '스마트스토어 기본할인은 하나만 저장할 수 있습니다.';
    end if;
  else
    if v_rule_code not in ('NONE', 'M10', 'M15', 'M20') then
      raise exception '메이크샵 할인코드는 NONE, M10, M15, M20 중 하나여야 합니다.';
    end if;
    v_terms := coalesce((
      select jsonb_agg(term order by ordinal)
      from jsonb_array_elements(v_terms) with ordinality terms(term, ordinal)
      where term ->> 'term_key' <> 'period'
    ), '[]'::jsonb);
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

  select count(distinct matrix.sellpia_sku_code)::integer
  into v_count
  from public.operations_hub_matrix_cached matrix
  where case v_source
    when 'smartstore' then matrix.smartstore_product_code
    when 'makeshop' then matrix.makeshop_product_code
  end = v_product_code;
  if v_count = 0 then
    raise exception '같은 판매처 상품코드에 연결된 SKU를 찾지 못했습니다: %', v_product_code;
  end if;

  for v_item in
    select distinct matrix.sellpia_sku_code
    from public.operations_hub_matrix_cached matrix
    where case v_source
      when 'smartstore' then matrix.smartstore_product_code
      when 'makeshop' then matrix.makeshop_product_code
    end = v_product_code
    order by matrix.sellpia_sku_code
  loop
    select * into strict v_saved
    from public.save_operations_hub_seller_discount_draft(
      v_item.sellpia_sku_code,
      v_source,
      v_terms,
      case when v_mode = 'reverse-base' then 'discount_anchor' else 'option' end,
      null,
      null,
      v_batch_id
    );

    if v_saved.change_id is not null then
      update public.operations_hub_change_queue queue
      set status_message = case
            when v_mode = 'reverse-base' then 'DB 저장됨 · 최종구매가 유지 · 판매가 역산'
            else 'DB 저장됨 · 판매가 유지 · 최종구매가 재계산'
          end,
          updated_at = now()
      where queue.change_id = v_saved.change_id;
    end if;

    return query select
      v_item.sellpia_sku_code::text,
      v_saved.change_id::bigint,
      v_saved.draft_status::text,
      v_saved.cancelled_count::integer,
      v_saved.change_batch_id::uuid,
      v_saved.source_base_price::numeric,
      v_saved.source_discounted_base_price::numeric,
      v_saved.source_option_price::numeric,
      v_saved.source_final_price::numeric,
      v_saved.draft_base_price::numeric,
      v_saved.draft_discounted_base_price::numeric,
      v_saved.draft_option_price::numeric,
      v_saved.draft_final_price::numeric,
      v_saved.saved_input_mode::text,
      v_saved.saved_at::timestamptz,
      v_saved.draft_discount_terms::jsonb,
      v_count,
      nullif(v_rule_code, '');
  end loop;
end;
$$;

comment on function public.save_operations_hub_seller_product_discount_mode_v1(text,text,text,jsonb,text,text,uuid)
  is 'Atomically applies one product discount in forward mode or preserves each current/draft final price by reverse-calculating the shared seller base price.';

revoke all on function public.save_operations_hub_seller_product_discount_mode_v1(text,text,text,jsonb,text,text,uuid) from public;
grant execute on function public.save_operations_hub_seller_product_discount_mode_v1(text,text,text,jsonb,text,text,uuid) to anon, authenticated;

notify pgrst, 'reload schema';
