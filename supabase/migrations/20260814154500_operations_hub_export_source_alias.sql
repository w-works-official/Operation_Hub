create or replace function public.prepare_operations_hub_export(
  p_export_batch_id uuid,
  p_export_mode text,
  p_change_ids bigint[] default null,
  p_sources text[] default array['smartstore','makeshop','ably']::text[]
)
returns setof public.operations_hub_export_items
language plpgsql security invoker set search_path = public, operations_private, pg_temp as $$
declare v_count integer; v_blocked integer; v_sources text[];
begin
  if p_export_batch_id is null then raise exception '내보내기 배치 ID가 필요합니다.'; end if;
  if p_export_mode not in ('change_queue','inventory_match') then raise exception '지원하지 않는 내보내기 모드입니다.'; end if;
  select coalesce(array_agg(distinct lower(btrim(source))), '{}'::text[]) into v_sources
  from unnest(coalesce(p_sources,'{}'::text[])) source where lower(btrim(source)) in ('smartstore','makeshop','ably');
  if cardinality(v_sources)=0 then raise exception '판매처를 하나 이상 선택해주세요.'; end if;

  if exists(select 1 from public.operations_hub_export_batches where export_batch_id=p_export_batch_id) then
    return query select * from public.operations_hub_export_items where export_batch_id=p_export_batch_id order by source_channel,source_file_name,source_row_no,export_item_id;
    return;
  end if;

  update public.operations_hub_export_batches set status='failed',error_message='30분 이상 완료되지 않아 자동 종료',updated_at=now()
  where status='prepared' and created_at < now()-interval '30 minutes';
  update public.operations_hub_change_queue q set status='failed',error_message='원본 내보내기 작업 시간 초과',status_message='내보내기 실패',updated_at=now()
  where q.status='processing' and q.last_attempt_at < now()-interval '30 minutes';

  insert into public.operations_hub_export_batches(export_batch_id,export_mode,source_channels)
  values(p_export_batch_id,p_export_mode,v_sources);

  if p_export_mode='change_queue' then
    with latest_snapshot as (
      select distinct on (source_channel) snapshot_id,source_channel
      from public.seller_inventory_snapshots where upload_status='ready'
      order by source_channel,completed_at desc nulls last,created_at desc
    ), current_rows as (
      select latest.source_channel,row_item.* from latest_snapshot latest
      join public.seller_inventory_snapshot_rows row_item using(snapshot_id)
    ), expanded as (
      select q.*, source.source_channel as export_source_channel
      from public.operations_hub_change_queue q
      cross join lateral unnest(case when q.source_channel is not null then array[q.source_channel] else q.target_channels end) source(source_channel)
      where q.status='validated' and source.source_channel=any(v_sources)
        and (p_change_ids is null or cardinality(p_change_ids)=0 or q.change_id=any(p_change_ids))
    ), resolved as (
      select q.*, case q.export_source_channel
        when 'smartstore' then coalesce(q.seller_product_code,m.smartstore_product_code)
        when 'makeshop' then coalesce(q.seller_product_code,m.makeshop_product_code)
        when 'ably' then coalesce(q.seller_product_code,m.ably_product_code) end product_code,
        case q.export_source_channel when 'smartstore' then coalesce(q.seller_option_code,m.smartstore_option_code,'')
        when 'makeshop' then coalesce(q.seller_option_code,m.makeshop_option_code,'')
        when 'ably' then coalesce(q.seller_option_code,m.ably_option_code,'') end option_code
      from expanded q left join public.operations_hub_matrix_live m using(sellpia_sku_code)
    )
    insert into public.operations_hub_export_items(
      export_batch_id,change_id,sellpia_sku_code,source_channel,field_key,before_value,after_value,
      seller_product_code,seller_option_code,source_file_name,source_row_no,expected_source_value,base_price,option_price,blocking_reason)
    select p_export_batch_id,r.change_id,r.sellpia_sku_code,r.export_source_channel,r.field_key,r.before_value,r.after_value,
      r.product_code,coalesce(r.option_code,''),row_item.raw_payload->>'source_file_name',row_item.source_row_no,
      case r.field_key when 'sellpia_current_stock' then to_jsonb(row_item.stock)
        when 'sellpia_sale_price' then to_jsonb(row_item.price)
        when 'seller_product_name' then to_jsonb(row_item.product_name)
        when 'seller_option_name' then to_jsonb(row_item.option_name) end,
      nullif(row_item.raw_payload->>'base_price','')::numeric,nullif(row_item.raw_payload->>'option_price','')::numeric,
      case when r.product_code is null then '판매처 연결 코드가 없습니다.'
        when row_item.product_code is null then '최신 판매처 원본에서 상품·옵션 코드를 찾지 못했습니다.'
        when row_item.raw_payload->>'source_file_name' is null then '원본 파일명이 기록되지 않았습니다.'
        when row_item.source_row_no is null then '원본 행번호가 기록되지 않았습니다.' end
    from resolved r left join current_rows row_item on row_item.source_channel=r.export_source_channel
      and row_item.product_code=r.product_code and row_item.option_code=coalesce(r.option_code,'')
    on conflict do nothing;
  else
    with latest_snapshot as (
      select distinct on (source_channel) snapshot_id,source_channel from public.seller_inventory_snapshots
      where upload_status='ready' order by source_channel,completed_at desc nulls last,created_at desc
    ), current_rows as (
      select latest.source_channel,row_item.* from latest_snapshot latest join public.seller_inventory_snapshot_rows row_item using(snapshot_id)
    ), targets as (
      select m.sellpia_sku_code, source.source_channel, m.sellpia_current_stock,
        case source.source_channel when 'smartstore' then m.smartstore_product_code when 'makeshop' then m.makeshop_product_code when 'ably' then m.ably_product_code end product_code,
        case source.source_channel when 'smartstore' then coalesce(m.smartstore_option_code,'') when 'makeshop' then coalesce(m.makeshop_option_code,'') when 'ably' then coalesce(m.ably_option_code,'') end option_code,
        case source.source_channel when 'smartstore' then m.smartstore_stock when 'makeshop' then m.makeshop_stock when 'ably' then m.ably_stock end seller_stock
      from public.operations_hub_matrix_live m cross join lateral unnest(v_sources) source(source_channel)
    )
    insert into public.operations_hub_export_items(export_batch_id,sellpia_sku_code,source_channel,field_key,before_value,after_value,
      seller_product_code,seller_option_code,source_file_name,source_row_no,expected_source_value,base_price,option_price,blocking_reason)
    select p_export_batch_id,t.sellpia_sku_code,t.source_channel,'sellpia_current_stock',to_jsonb(t.seller_stock),to_jsonb(t.sellpia_current_stock),
      t.product_code,coalesce(t.option_code,''),row_item.raw_payload->>'source_file_name',row_item.source_row_no,to_jsonb(row_item.stock),
      nullif(row_item.raw_payload->>'base_price','')::numeric,nullif(row_item.raw_payload->>'option_price','')::numeric,
      case when t.product_code is null then '판매처 연결 코드가 없습니다.' when row_item.product_code is null then '최신 판매처 원본에서 상품·옵션 코드를 찾지 못했습니다.'
        when row_item.raw_payload->>'source_file_name' is null then '원본 파일명이 기록되지 않았습니다.' when row_item.source_row_no is null then '원본 행번호가 기록되지 않았습니다.' end
    from targets t left join current_rows row_item on row_item.source_channel=t.source_channel and row_item.product_code=t.product_code and row_item.option_code=coalesce(t.option_code,'')
    where t.sellpia_current_stock is not null and t.product_code is not null and t.sellpia_current_stock is distinct from t.seller_stock
    on conflict do nothing;
  end if;

  select count(*),count(*) filter(where blocking_reason is not null) into v_count,v_blocked
  from public.operations_hub_export_items where export_batch_id=p_export_batch_id;
  if v_count=0 then raise exception '내보낼 변경사항이 없습니다.'; end if;
  update public.operations_hub_export_batches set item_count=v_count,status=case when v_blocked>0 then 'failed' else 'prepared' end,
    error_message=case when v_blocked>0 then v_blocked||'건의 원본 위치를 확인할 수 없습니다.' end,updated_at=now()
  where export_batch_id=p_export_batch_id;
  if p_export_mode='change_queue' then
    update public.operations_hub_change_queue q set status=case when blocked.change_id is null then 'processing' else 'failed' end,
      last_attempt_at=now(),error_message=case when blocked.change_id is null then null else '원본 내보내기 위치 검증 실패' end,
      status_message=case when blocked.change_id is null then '원본 파일 생성 중' else '내보내기 검증 실패' end,updated_at=now()
    from (select distinct change_id from public.operations_hub_export_items where export_batch_id=p_export_batch_id) chosen
    left join (select distinct change_id from public.operations_hub_export_items where export_batch_id=p_export_batch_id and blocking_reason is not null) blocked using(change_id)
    where q.change_id=chosen.change_id and q.status='validated';
  end if;
  return query select * from public.operations_hub_export_items where export_batch_id=p_export_batch_id order by source_channel,source_file_name,source_row_no,export_item_id;
end; $$;

revoke all on function public.prepare_operations_hub_export(uuid,text,bigint[],text[]) from public;
grant execute on function public.prepare_operations_hub_export(uuid,text,bigint[],text[]) to anon,authenticated;
