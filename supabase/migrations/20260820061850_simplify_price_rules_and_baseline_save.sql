-- Sellpia price edits define the internal base price only. Seller prices must
-- be staged explicitly after each channel's price rule has been reviewed.
update public.operations_hub_change_queue queue
set status = 'cancelled',
    cancelled_at = now(),
    cancelled_by = 'system_price_rule_migration',
    status_message = '셀피아 기준가 저장으로 전환 · 판매처 가격 규칙 적용 필요',
    updated_at = now()
where queue.field_key = 'sellpia_sale_price'
  and queue.source_channel is null
  and queue.status in ('pending', 'validated', 'failed');

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

    -- Stock keeps the existing explicit seller-sync queue behavior. Price is
    -- saved as a DB-only base value so each seller rule can calculate and
    -- stage its own final price without a conflicting raw-price change.
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
  end loop;

  return query select v_saved, v_queued, v_saved_at, v_batch_id;
end;
$$;

comment on function public.apply_operations_hub_sellpia_changes(text, jsonb, uuid) is
  'Saves Sellpia operational overrides. Stock can queue seller sync; price is a DB-only base and requires explicit per-channel price-rule staging.';

revoke all on function public.apply_operations_hub_sellpia_changes(text, jsonb, uuid) from public;
grant execute on function public.apply_operations_hub_sellpia_changes(text, jsonb, uuid) to anon, authenticated;
