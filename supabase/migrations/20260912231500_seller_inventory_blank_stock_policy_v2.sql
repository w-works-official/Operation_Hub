create or replace function public.stage_operations_hub_seller_inventory_match_batch_v2(
  p_session_token text,
  p_sources text[],
  p_skus text[] default null::text[],
  p_batch_id uuid default null::uuid,
  p_after_sku text default null::text,
  p_batch_size integer default 500,
  p_overwrite_blank boolean default false
)
returns table(
  processed_count integer,
  total_count integer,
  staged_count integer,
  cancelled_count integer,
  next_cursor text,
  has_more boolean,
  change_batch_id uuid,
  blank_preserved_count integer,
  blank_overwrite_count integer
)
language plpgsql
security definer
set search_path=pg_catalog
set statement_timeout='45s'
set lock_timeout='5s'
as $$
declare
  v_result record;
  v_started_at timestamptz := clock_timestamp();
  v_blank_count integer := 0;
begin
  select * into v_result
  from public.stage_operations_hub_seller_inventory_match_batch(
    p_session_token,p_sources,p_skus,p_batch_id,p_after_sku,p_batch_size
  );

  if v_result.change_batch_id is null then
    return query select
      coalesce(v_result.processed_count,0),coalesce(v_result.total_count,0),coalesce(v_result.staged_count,0),
      coalesce(v_result.cancelled_count,0),v_result.next_cursor,coalesce(v_result.has_more,false),v_result.change_batch_id,0,0;
    return;
  end if;

  if coalesce(p_overwrite_blank,false) then
    update public.operations_hub_change_queue q
    set status='pending',
        target_safety_state='ready',
        error_message=null,
        validation_errors='[]'::jsonb,
        status_message='판매처 원본 빈 재고셀 덮어쓰기 · 검토 대기',
        target_safety_details=coalesce(q.target_safety_details,'{}'::jsonb) || jsonb_build_object(
          'reason','blank_seller_stock_overwrite_enabled','overwriteBlank',true
        ),
        updated_at=clock_timestamp()
    where q.change_batch_id=v_result.change_batch_id
      and q.requested_at >= v_started_at
      and q.field_key='sellpia_current_stock'
      and q.target_safety_state='incomplete'
      and coalesce((q.target_safety_details->>'knownStockCount')::integer,-1)=coalesce((q.target_safety_details->>'componentCount')::integer,-2)
      and q.target_safety_details ? 'sellerStock'
      and q.target_safety_details->'sellerStock'='null'::jsonb
      and q.target_safety_details ? 'calculatedStock'
      and q.target_safety_details->'calculatedStock'<>'null'::jsonb;
    get diagnostics v_blank_count=row_count;

    return query select
      coalesce(v_result.processed_count,0),coalesce(v_result.total_count,0),coalesce(v_result.staged_count,0),
      coalesce(v_result.cancelled_count,0),v_result.next_cursor,coalesce(v_result.has_more,false),v_result.change_batch_id,
      0,v_blank_count;
  else
    update public.operations_hub_change_queue q
    set status='cancelled',
        cancelled_at=clock_timestamp(),
        cancelled_by='operations_hub_frontend',
        target_safety_state='preserved_blank',
        error_message=null,
        validation_errors='[]'::jsonb,
        status_message='판매처 원본 빈 재고셀 유지 · 변경하지 않음',
        target_safety_details=coalesce(q.target_safety_details,'{}'::jsonb) || jsonb_build_object(
          'reason','blank_seller_stock_preserved','overwriteBlank',false
        ),
        updated_at=clock_timestamp()
    where q.change_batch_id=v_result.change_batch_id
      and q.requested_at >= v_started_at
      and q.field_key='sellpia_current_stock'
      and q.target_safety_state='incomplete'
      and coalesce((q.target_safety_details->>'knownStockCount')::integer,-1)=coalesce((q.target_safety_details->>'componentCount')::integer,-2)
      and q.target_safety_details ? 'sellerStock'
      and q.target_safety_details->'sellerStock'='null'::jsonb
      and q.target_safety_details ? 'calculatedStock'
      and q.target_safety_details->'calculatedStock'<>'null'::jsonb;
    get diagnostics v_blank_count=row_count;

    return query select
      coalesce(v_result.processed_count,0),coalesce(v_result.total_count,0),greatest(0,coalesce(v_result.staged_count,0)-v_blank_count),
      coalesce(v_result.cancelled_count,0)+v_blank_count,v_result.next_cursor,coalesce(v_result.has_more,false),v_result.change_batch_id,
      v_blank_count,0;
  end if;
end;
$$;

revoke all on function public.stage_operations_hub_seller_inventory_match_batch_v2(text,text[],text[],uuid,text,integer,boolean) from public;
grant execute on function public.stage_operations_hub_seller_inventory_match_batch_v2(text,text[],text[],uuid,text,integer,boolean) to anon,authenticated;
notify pgrst,'reload schema';
