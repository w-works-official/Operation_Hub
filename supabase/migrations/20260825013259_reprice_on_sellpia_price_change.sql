-- Recalculate reviewable Smartstore and MakeShop seller-price drafts whenever
-- a tagged Sellpia base price changes. The Sellpia override and every affected
-- seller draft are written in one invoker transaction; Ably remains untouched.

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
  v_assignment record;
  v_product_code text;
  v_snapshot_id uuid;
  v_product_count integer;
  v_valid_count integer;
  v_assignment_count integer;
  v_assignment_rule_count integer;
  v_discount_signature_count integer;
  v_anchor_final numeric;
  v_anchor_option numeric;
  v_anchor_discounted numeric;
  v_item record;
  v_saved record;
begin
  if v_sku = '' then raise exception '셀피아 SKU가 필요합니다.'; end if;

  for v_assignment in
    select assignment.source_channel, assignment.price_rule_set_id
    from public.operations_hub_price_rule_assignments assignment
    where assignment.target_type = 'sellpia_sku'
      and assignment.sellpia_sku_code = v_sku
      and assignment.source_channel in ('smartstore', 'makeshop')
      and assignment.is_active
    order by assignment.source_channel
  loop
    select case v_assignment.source_channel
      when 'smartstore' then matrix.smartstore_product_code
      when 'makeshop' then matrix.makeshop_product_code
    end
    into v_product_code
    from public.operations_hub_matrix_live matrix
    where matrix.sellpia_sku_code = v_sku;

    if nullif(btrim(v_product_code), '') is null then
      raise exception '가격규칙이 있지만 % 연결 상품코드가 없습니다: %', v_assignment.source_channel, v_sku;
    end if;

    select count(distinct matrix.sellpia_sku_code)::integer
    into v_product_count
    from public.operations_hub_matrix_live matrix
    where case v_assignment.source_channel
      when 'smartstore' then matrix.smartstore_product_code
      when 'makeshop' then matrix.makeshop_product_code
    end = v_product_code;

    select count(*)::integer, count(distinct assignment.price_rule_set_id)::integer
    into v_assignment_count, v_assignment_rule_count
    from (
      select distinct matrix.sellpia_sku_code
      from public.operations_hub_matrix_live matrix
      where case v_assignment.source_channel
        when 'smartstore' then matrix.smartstore_product_code
        when 'makeshop' then matrix.makeshop_product_code
      end = v_product_code
    ) product_sku
    join public.operations_hub_price_rule_assignments assignment
      on assignment.target_type = 'sellpia_sku'
     and assignment.source_channel = v_assignment.source_channel
     and assignment.sellpia_sku_code = product_sku.sellpia_sku_code
     and assignment.is_active;

    if v_assignment_count <> v_product_count or v_assignment_rule_count <> 1 then
      raise exception '같은 판매처 상품의 모든 옵션에 동일한 가격규칙이 필요합니다: % / %',
        v_assignment.source_channel, v_product_code
        using hint = '일부 옵션만 자동 재계산하지 않도록 셀피아 가격 저장을 함께 롤백했습니다.';
    end if;

    if exists (
      select 1
      from public.operations_hub_change_queue queue
      join public.operations_hub_matrix_live matrix
        on matrix.sellpia_sku_code = queue.sellpia_sku_code
      where queue.source_channel = v_assignment.source_channel
        and queue.field_key = 'sellpia_sale_price'
        and queue.status in ('processing', 'exported')
        and case v_assignment.source_channel
          when 'smartstore' then matrix.smartstore_product_code
          when 'makeshop' then matrix.makeshop_product_code
        end = v_product_code
    ) then
      raise exception '반영 진행 중이거나 이미 내보낸 가격 수정안이 있어 셀피아 가격을 자동 재계산할 수 없습니다: % / %',
        v_assignment.source_channel, v_product_code
        using hint = '기존 수정안의 판매처 반영 상태를 먼저 확인해주세요.';
    end if;

    select snapshot.snapshot_id
    into v_snapshot_id
    from public.seller_inventory_snapshots snapshot
    where snapshot.source_channel = v_assignment.source_channel
      and snapshot.upload_status = 'ready'
    order by snapshot.completed_at desc nulls last, snapshot.created_at desc
    limit 1;
    if v_snapshot_id is null then
      raise exception '최신 % 원본이 없어 가격규칙을 다시 계산할 수 없습니다.', v_assignment.source_channel;
    end if;

    select
      count(distinct matrix.sellpia_sku_code)::integer,
      count(distinct md5(coalesce(source_row.discount_terms, '[]'::jsonb)::text))::integer
    into v_valid_count, v_discount_signature_count
    from public.operations_hub_matrix_live matrix
    join public.seller_inventory_snapshot_rows source_row
      on source_row.snapshot_id = v_snapshot_id
     and source_row.product_code = v_product_code
     and source_row.option_code = case v_assignment.source_channel
       when 'smartstore' then coalesce(matrix.smartstore_option_code, '')
       when 'makeshop' then coalesce(matrix.makeshop_option_code, '')
     end
    where case v_assignment.source_channel
      when 'smartstore' then matrix.smartstore_product_code
      when 'makeshop' then matrix.makeshop_product_code
    end = v_product_code;

    if v_valid_count <> v_product_count then
      raise exception '최신 % 원본과 연결된 옵션 수가 다릅니다: % / %개',
        v_assignment.source_channel, v_valid_count, v_product_count
        using hint = '일부 옵션만 재계산하지 않도록 셀피아 가격 저장을 함께 롤백했습니다.';
    end if;
    if v_discount_signature_count <> 1 then
      raise exception '같은 판매처 상품의 옵션별 할인조건이 서로 달라 자동 재계산할 수 없습니다: % / %',
        v_assignment.source_channel, v_product_code;
    end if;

    select
      calculated.final_price,
      coalesce(active_draft.price_option_after, source_row.option_price,
        nullif(source_row.raw_payload ->> 'option_price', '')::numeric, 0)
    into v_anchor_final, v_anchor_option
    from public.operations_hub_matrix_live matrix
    join public.seller_inventory_snapshot_rows source_row
      on source_row.snapshot_id = v_snapshot_id
     and source_row.product_code = v_product_code
     and source_row.option_code = case v_assignment.source_channel
       when 'smartstore' then coalesce(matrix.smartstore_option_code, '')
       when 'makeshop' then coalesce(matrix.makeshop_option_code, '')
     end
    cross join lateral public.calculate_operations_hub_price_rule_set(
      matrix.sellpia_sale_price,
      v_assignment.price_rule_set_id
    ) calculated
    left join lateral (
      select queue.price_option_after
      from public.operations_hub_change_queue queue
      where queue.sellpia_sku_code = matrix.sellpia_sku_code
        and queue.source_channel = v_assignment.source_channel
        and queue.field_key = 'sellpia_sale_price'
        and queue.status in ('pending', 'validated', 'failed')
      order by queue.updated_at desc, queue.change_id desc
      limit 1
    ) active_draft on true
    where matrix.sellpia_sku_code = v_sku
      and case v_assignment.source_channel
        when 'smartstore' then matrix.smartstore_product_code
        when 'makeshop' then matrix.makeshop_product_code
      end = v_product_code
    limit 1;

    if v_anchor_final is null then
      raise exception '변경한 셀피아 가격의 가격규칙 계산값을 찾지 못했습니다: % / %',
        v_assignment.source_channel, v_sku;
    end if;
    v_anchor_discounted := v_anchor_final - v_anchor_option;
    if v_anchor_discounted < 0 then
      raise exception '가격규칙 목표가보다 현재 옵션가가 커서 자동 재계산할 수 없습니다: % / %',
        v_assignment.source_channel, v_sku;
    end if;

    for v_item in
      select distinct on (matrix.sellpia_sku_code)
        matrix.sellpia_sku_code,
        source_row.discount_terms,
        calculated.final_price as target_final_price
      from public.operations_hub_matrix_live matrix
      join public.seller_inventory_snapshot_rows source_row
        on source_row.snapshot_id = v_snapshot_id
       and source_row.product_code = v_product_code
       and source_row.option_code = case v_assignment.source_channel
         when 'smartstore' then coalesce(matrix.smartstore_option_code, '')
         when 'makeshop' then coalesce(matrix.makeshop_option_code, '')
       end
      cross join lateral public.calculate_operations_hub_price_rule_set(
        matrix.sellpia_sale_price,
        v_assignment.price_rule_set_id
      ) calculated
      where case v_assignment.source_channel
        when 'smartstore' then matrix.smartstore_product_code
        when 'makeshop' then matrix.makeshop_product_code
      end = v_product_code
      order by matrix.sellpia_sku_code
    loop
      select * into strict v_saved
      from public.save_operations_hub_seller_discount_draft(
        v_item.sellpia_sku_code,
        v_assignment.source_channel,
        coalesce(v_item.discount_terms, '[]'::jsonb),
        'discount_anchor',
        v_item.target_final_price - v_anchor_discounted,
        v_item.target_final_price,
        v_batch_id
      );

      if v_saved.change_id is not null then
        update public.operations_hub_change_queue queue
        set price_rule_set_id = v_assignment.price_rule_set_id,
            base_price_source = 'tag',
            pricing_input_mode = 'discount_anchor',
            status_message = 'DB 저장됨 · 셀피아 기준가 변경으로 가격규칙 자동 재계산',
            updated_at = now()
        where queue.change_id = v_saved.change_id;
      end if;

      return query select
        v_assignment.source_channel::text,
        v_product_code::text,
        v_item.sellpia_sku_code::text,
        v_saved.change_id::bigint,
        v_saved.draft_status::text,
        v_saved.change_batch_id::uuid,
        v_saved.draft_base_price::numeric,
        v_saved.draft_discounted_base_price::numeric,
        v_saved.draft_option_price::numeric,
        v_saved.draft_final_price::numeric,
        v_assignment.price_rule_set_id::bigint;
    end loop;
  end loop;
end;
$$;

comment on function public.reprice_operations_hub_sellpia_price_change(text,uuid) is
  'Atomically restages Smartstore and MakeShop seller prices from active SKU rules after a Sellpia price change. Ably is intentionally excluded.';

revoke all on function public.reprice_operations_hub_sellpia_price_change(text,uuid) from public;
grant execute on function public.reprice_operations_hub_sellpia_price_change(text,uuid) to anon, authenticated;

create or replace function public.apply_operations_hub_sellpia_changes(
  p_sku text,
  p_changes jsonb,
  p_batch_id uuid default null
)
returns table(saved_count integer, queued_count integer, saved_at timestamptz, change_batch_id uuid)
language plpgsql
security invoker
set search_path to public, operations_private, pg_temp
as $$
declare
  v_change jsonb;
  v_field text;
  v_after text;
  v_targets text[];
  v_status text;
  v_saved integer := 0;
  v_queued integer := 0;
  v_inserted integer := 0;
  v_saved_at timestamptz := now();
  v_batch_id uuid := coalesce(p_batch_id, gen_random_uuid());
  v_has_price_change boolean := false;
  v_reprice record;
begin
  p_sku := btrim(p_sku);
  if nullif(p_sku, '') is null then raise exception '셀피아 SKU가 필요합니다.'; end if;
  if not exists (
    select 1 from operations_private.operations_hub_matrix_core matrix
    where matrix.sellpia_sku_code = p_sku
  ) then raise exception '매트릭스에 없는 셀피아 SKU입니다: %', p_sku; end if;
  if jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) = 0 then
    raise exception '저장할 변경사항이 없습니다.';
  end if;

  select array_remove(array[
    case when matrix.smartstore_product_code is not null then 'smartstore' end,
    case when matrix.makeshop_product_code is not null then 'makeshop' end,
    case when matrix.ably_product_code is not null then 'ably' end
  ], null)
  into v_targets
  from operations_private.operations_hub_matrix_core matrix
  where matrix.sellpia_sku_code = p_sku;

  for v_change in select value from jsonb_array_elements(p_changes)
  loop
    v_field := v_change ->> 'field_key';
    v_after := v_change ->> 'after';
    if v_field not in (
      'sellpia_own_code', 'sellpia_product_name', 'sellpia_option_name',
      'sellpia_current_stock', 'sellpia_sale_price', 'sellpia_image'
    ) then raise exception '지원하지 않는 셀피아 필드입니다: %', v_field; end if;
    if v_field in ('sellpia_current_stock', 'sellpia_sale_price')
       and (v_after !~ '^\d+(\.\d+)?$' or v_after::numeric < 0) then
      raise exception '재고와 판매가는 0 이상의 숫자여야 합니다.';
    end if;
    if v_field = 'sellpia_image' and v_after !~ '^sellpia/[0-9A-Za-z._-]+[.]jpg$' then
      raise exception '이미지 저장 경로가 올바르지 않습니다.';
    end if;

    insert into public.operations_hub_sellpia_overrides (
      sellpia_sku_code, own_code, product_name, option_name,
      current_stock, sale_price, image_storage_path, updated_by, updated_at
    ) values (
      p_sku,
      case when v_field = 'sellpia_own_code' then nullif(v_after, '') end,
      case when v_field = 'sellpia_product_name' then nullif(v_after, '') end,
      case when v_field = 'sellpia_option_name' then nullif(v_after, '') end,
      case when v_field = 'sellpia_current_stock' then v_after::integer end,
      case when v_field = 'sellpia_sale_price' then v_after::numeric end,
      case when v_field = 'sellpia_image' then v_after end,
      'operations_hub_frontend', v_saved_at
    )
    on conflict (sellpia_sku_code) do update set
      own_code = case when v_field = 'sellpia_own_code' then nullif(v_after, '') else operations_hub_sellpia_overrides.own_code end,
      product_name = case when v_field = 'sellpia_product_name' then nullif(v_after, '') else operations_hub_sellpia_overrides.product_name end,
      option_name = case when v_field = 'sellpia_option_name' then nullif(v_after, '') else operations_hub_sellpia_overrides.option_name end,
      current_stock = case when v_field = 'sellpia_current_stock' then v_after::integer else operations_hub_sellpia_overrides.current_stock end,
      sale_price = case when v_field = 'sellpia_sale_price' then v_after::numeric else operations_hub_sellpia_overrides.sale_price end,
      image_storage_path = case when v_field = 'sellpia_image' then v_after else operations_hub_sellpia_overrides.image_storage_path end,
      updated_by = 'operations_hub_frontend',
      updated_at = v_saved_at;

    v_status := case
      when v_field = 'sellpia_current_stock'
       and cardinality(coalesce(v_targets, '{}'::text[])) > 0 then 'pending'
      else 'saved'
    end;

    if v_status = 'pending' then
      update public.operations_hub_change_queue queue
      set status = 'cancelled', cancelled_at = v_saved_at, cancelled_by = 'operations_hub_frontend',
          status_message = '더 최신 변경으로 대체됨', updated_at = v_saved_at
      where queue.sellpia_sku_code = p_sku
        and queue.field_key = v_field
        and queue.source_channel is null
        and queue.status in ('pending', 'validated', 'failed')
        and queue.change_batch_id <> v_batch_id;
    end if;

    insert into public.operations_hub_change_queue (
      change_batch_id, sellpia_sku_code, field_key, before_value, after_value,
      target_channels, status, requested_by, requested_at, updated_at
    ) values (
      v_batch_id, p_sku, v_field, v_change -> 'before', to_jsonb(v_after),
      case when v_status = 'pending' then coalesce(v_targets, '{}'::text[]) else '{}'::text[] end,
      v_status, 'operations_hub_frontend', v_saved_at, v_saved_at
    ) on conflict do nothing;
    get diagnostics v_inserted = row_count;
    v_saved := v_saved + 1;
    if v_status = 'pending' then v_queued := v_queued + v_inserted; end if;
    if v_field = 'sellpia_sale_price' then v_has_price_change := true; end if;
  end loop;

  if v_has_price_change then
    for v_reprice in
      select * from public.reprice_operations_hub_sellpia_price_change(p_sku, v_batch_id)
    loop
      if v_reprice.change_id is not null then v_queued := v_queued + 1; end if;
    end loop;
  end if;

  return query select v_saved, v_queued, v_saved_at, v_batch_id;
end;
$$;

comment on function public.apply_operations_hub_sellpia_changes(text,jsonb,uuid) is
  'Saves Sellpia operational overrides. Stock queues seller sync; tagged Smartstore and MakeShop prices are restaged atomically from the changed Sellpia base.';

revoke all on function public.apply_operations_hub_sellpia_changes(text,jsonb,uuid) from public;
grant execute on function public.apply_operations_hub_sellpia_changes(text,jsonb,uuid) to anon, authenticated;

notify pgrst, 'reload schema';
