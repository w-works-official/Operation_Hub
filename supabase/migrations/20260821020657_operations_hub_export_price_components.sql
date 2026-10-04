create or replace function public.prepare_operations_hub_change_export(
  p_export_batch_id uuid,
  p_change_ids bigint[],
  p_sources text[] default array['smartstore','makeshop','ably']::text[]
)
returns table(item_count integer, blocked_count integer, batch_status text)
language plpgsql
security invoker
set search_path = public, operations_private, pg_temp
set statement_timeout = '45s'
as $$
declare
  v_count integer := 0;
  v_blocked integer := 0;
  v_sources text[];
  v_status text;
begin
  if p_export_batch_id is null then raise exception '내보내기 배치 ID가 필요합니다.'; end if;
  if p_change_ids is null or cardinality(p_change_ids) = 0 then raise exception '내보낼 변경사항을 선택해주세요.'; end if;

  select coalesce(array_agg(distinct lower(btrim(source))), '{}'::text[])
  into v_sources
  from unnest(coalesce(p_sources, '{}'::text[])) source
  where lower(btrim(source)) in ('smartstore','makeshop','ably');
  if cardinality(v_sources) = 0 then raise exception '판매처를 하나 이상 선택해주세요.'; end if;

  select batch.item_count,
         count(item.export_item_id) filter (where item.blocking_reason is not null)::integer,
         batch.status
  into v_count, v_blocked, v_status
  from public.operations_hub_export_batches batch
  left join public.operations_hub_export_items item using (export_batch_id)
  where batch.export_batch_id = p_export_batch_id
  group by batch.item_count, batch.status;
  if found then
    return query select v_count, coalesce(v_blocked, 0), v_status;
    return;
  end if;

  update public.operations_hub_export_batches
  set status = 'failed', error_message = '30분 이상 완료되지 않아 자동 종료', updated_at = now()
  where status = 'prepared' and created_at < now() - interval '30 minutes';

  update public.operations_hub_change_queue queue
  set status = 'failed', error_message = '원본 내보내기 작업 시간 초과', status_message = '내보내기 실패', updated_at = now()
  where queue.status = 'processing' and queue.last_attempt_at < now() - interval '30 minutes';

  insert into public.operations_hub_export_batches (export_batch_id, export_mode, source_channels)
  values (p_export_batch_id, 'change_queue', v_sources);

  with source_specific as materialized (
    select queue.change_id, queue.sellpia_sku_code,
      queue.source_channel as export_source_channel, queue.field_key,
      queue.before_value, queue.after_value,
      nullif(btrim(queue.seller_product_code), '') as product_code,
      coalesce(queue.seller_option_code, '') as option_code,
      queue.price_base_after, queue.price_option_after, queue.price_final_after,
      queue.option_price_source, queue.price_rule_set_id
    from public.operations_hub_change_queue queue
    where queue.change_id = any(p_change_ids)
      and queue.status = 'validated'
      and queue.source_channel = any(v_sources)
  ),
  global_changes as materialized (
    select queue.change_id, queue.sellpia_sku_code,
      source.source_channel as export_source_channel, queue.field_key,
      queue.before_value, queue.after_value,
      case source.source_channel
        when 'smartstore' then matrix.smartstore_product_code
        when 'makeshop' then matrix.makeshop_product_code
        when 'ably' then matrix.ably_product_code
      end as product_code,
      case source.source_channel
        when 'smartstore' then coalesce(matrix.smartstore_option_code, '')
        when 'makeshop' then coalesce(matrix.makeshop_option_code, '')
        when 'ably' then coalesce(matrix.ably_option_code, '')
      end as option_code,
      null::numeric as price_base_after, null::numeric as price_option_after,
      null::numeric as price_final_after, null::text as option_price_source,
      null::bigint as price_rule_set_id
    from public.operations_hub_change_queue queue
    cross join lateral unnest(queue.target_channels) source(source_channel)
    left join public.operations_hub_matrix_live matrix using (sellpia_sku_code)
    where queue.change_id = any(p_change_ids)
      and queue.status = 'validated'
      and queue.source_channel is null
      and source.source_channel = any(v_sources)
  ),
  selected_changes as materialized (
    select * from source_specific
    union all
    select * from global_changes
  ),
  latest_snapshot as materialized (
    select distinct on (snapshot.source_channel) snapshot.snapshot_id, snapshot.source_channel
    from public.seller_inventory_snapshots snapshot
    where snapshot.upload_status = 'ready' and snapshot.source_channel = any(v_sources)
    order by snapshot.source_channel, snapshot.completed_at desc nulls last, snapshot.created_at desc
  )
  insert into public.operations_hub_export_items (
    export_batch_id, change_id, sellpia_sku_code, source_channel, field_key,
    before_value, after_value, seller_product_code, seller_option_code,
    source_file_name, source_row_no, expected_source_value,
    base_price, option_price, target_base_price, target_option_price,
    target_final_price, option_price_source, price_rule_set_id, blocking_reason
  )
  select p_export_batch_id, change.change_id, change.sellpia_sku_code,
    change.export_source_channel, change.field_key, change.before_value, change.after_value,
    change.product_code, coalesce(change.option_code, ''),
    source_row.raw_payload ->> 'source_file_name', source_row.source_row_no,
    case change.field_key
      when 'sellpia_current_stock' then to_jsonb(source_row.stock)
      when 'sellpia_sale_price' then to_jsonb(coalesce(source_row.final_price, source_row.price))
      when 'seller_product_name' then to_jsonb(source_row.product_name)
      when 'seller_option_name' then to_jsonb(source_row.option_name)
    end,
    coalesce(source_row.base_price, nullif(source_row.raw_payload ->> 'base_price', '')::numeric, source_row.price),
    coalesce(source_row.option_price, nullif(source_row.raw_payload ->> 'option_price', '')::numeric, 0),
    case when change.field_key = 'sellpia_sale_price' then change.price_base_after end,
    case when change.field_key = 'sellpia_sale_price' then change.price_option_after end,
    case when change.field_key = 'sellpia_sale_price' then coalesce(change.price_final_after, (change.after_value #>> '{}')::numeric) end,
    change.option_price_source, change.price_rule_set_id,
    case
      when change.product_code is null then '판매처 연결 코드가 없습니다.'
      when source_row.product_code is null then '최신 판매처 원본에서 상품·옵션 코드를 찾지 못했습니다.'
      when source_row.raw_payload ->> 'source_file_name' is null then '원본 파일명이 기록되지 않았습니다.'
      when source_row.source_row_no is null then '원본 행번호가 기록되지 않았습니다.'
      when change.field_key = 'sellpia_sale_price' and change.price_base_after is null then '목표 판매가 계산값이 없습니다.'
      when change.field_key = 'sellpia_sale_price' and change.price_option_after is null then '목표 옵션가 계산값이 없습니다.'
    end
  from selected_changes change
  left join latest_snapshot snapshot on snapshot.source_channel = change.export_source_channel
  left join public.seller_inventory_snapshot_rows source_row
    on source_row.snapshot_id = snapshot.snapshot_id
   and source_row.product_code = change.product_code
   and source_row.option_code = coalesce(change.option_code, '')
  on conflict do nothing;

  with latest_snapshot as materialized (
    select distinct on (snapshot.source_channel) snapshot.snapshot_id, snapshot.source_channel
    from public.seller_inventory_snapshots snapshot
    where snapshot.upload_status = 'ready' and snapshot.source_channel = any(v_sources)
    order by snapshot.source_channel, snapshot.completed_at desc nulls last, snapshot.created_at desc
  ),
  product_source_count as materialized (
    select row_item.source_channel, row_item.product_code,
      count(distinct coalesce(row_item.option_code, ''))::integer as source_option_count
    from public.seller_inventory_snapshot_rows row_item
    join latest_snapshot snapshot on snapshot.snapshot_id = row_item.snapshot_id
    group by row_item.source_channel, row_item.product_code
  ),
  price_group as materialized (
    select item.source_channel, item.seller_product_code,
      count(distinct coalesce(item.seller_option_code, ''))::integer as selected_option_count,
      count(distinct item.target_base_price)::integer as target_base_count,
      bool_or(item.target_base_price is distinct from item.base_price) as changes_shared_base
    from public.operations_hub_export_items item
    where item.export_batch_id = p_export_batch_id
      and item.field_key = 'sellpia_sale_price'
      and item.source_channel in ('smartstore','makeshop')
    group by item.source_channel, item.seller_product_code
  )
  update public.operations_hub_export_items item
  set blocking_reason = coalesce(item.blocking_reason,
    case
      when price_group.target_base_count > 1 then '같은 상품의 옵션별 목표 판매가가 서로 다릅니다.'
      when price_group.changes_shared_base and price_group.selected_option_count < source_count.source_option_count
        then '공유 판매가를 변경하려면 같은 상품의 모든 옵션 가격을 함께 검토해야 합니다.'
    end)
  from price_group
  join product_source_count source_count
    on source_count.source_channel = price_group.source_channel
   and source_count.product_code = price_group.seller_product_code
  where item.export_batch_id = p_export_batch_id
    and item.source_channel = price_group.source_channel
    and item.seller_product_code = price_group.seller_product_code
    and item.field_key = 'sellpia_sale_price';

  select count(*)::integer, count(*) filter (where blocking_reason is not null)::integer
  into v_count, v_blocked
  from public.operations_hub_export_items where export_batch_id = p_export_batch_id;
  if v_count = 0 then raise exception '내보낼 변경사항이 없습니다.'; end if;

  v_status := case when v_blocked > 0 then 'failed' else 'prepared' end;
  update public.operations_hub_export_batches
  set item_count = v_count, status = v_status,
      error_message = case when v_blocked > 0 then v_blocked || '건의 원본 위치·가격 구성을 확인할 수 없습니다.' end,
      updated_at = now()
  where export_batch_id = p_export_batch_id;

  with item_state as materialized (
    select item.change_id, bool_or(item.blocking_reason is not null) as is_blocked
    from public.operations_hub_export_items item
    where item.export_batch_id = p_export_batch_id and item.change_id is not null
    group by item.change_id
  )
  update public.operations_hub_change_queue queue
  set status = case when item_state.is_blocked then 'failed' else 'processing' end,
      last_attempt_at = now(),
      error_message = case when item_state.is_blocked then '원본 내보내기 위치·가격 구성 검증 실패' end,
      status_message = case when item_state.is_blocked then '내보내기 검증 실패' else '원본 파일 생성 중' end,
      updated_at = now()
  from item_state
  where queue.change_id = item_state.change_id and queue.status = 'validated';

  return query select v_count, v_blocked, v_status;
end;
$$;

comment on function public.prepare_operations_hub_change_export(uuid,bigint[],text[]) is
  'Builds export items with explicit seller base, option, and final price targets and blocks unsafe shared-base changes.';

revoke all on function public.prepare_operations_hub_change_export(uuid,bigint[],text[]) from public;
grant execute on function public.prepare_operations_hub_change_export(uuid,bigint[],text[]) to anon, authenticated;

notify pgrst, 'reload schema';
