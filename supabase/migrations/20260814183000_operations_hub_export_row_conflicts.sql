create or replace function public.complete_operations_hub_export(
  p_export_batch_id uuid,
  p_success boolean,
  p_file_manifest jsonb,
  p_error_message text,
  p_skipped_items jsonb
)
returns table(exported_count integer, failed_count integer)
language plpgsql
security invoker
set search_path = public, pg_temp
set statement_timeout = '45s'
as $$
declare
  v_exported integer := 0;
  v_failed integer := 0;
  v_skipped integer := 0;
  v_total_failed integer := 0;
begin
  if jsonb_typeof(coalesce(p_file_manifest, '[]'::jsonb)) <> 'array' then
    raise exception '파일 목록은 배열이어야 합니다.';
  end if;
  if jsonb_typeof(coalesce(p_skipped_items, '[]'::jsonb)) <> 'array' then
    raise exception '제외 항목 목록은 배열이어야 합니다.';
  end if;

  with skipped as materialized (
    select export_item_id, nullif(btrim(reason), '') as reason
    from jsonb_to_recordset(coalesce(p_skipped_items, '[]'::jsonb))
      as value(export_item_id bigint, reason text)
    where export_item_id is not null
  )
  update public.operations_hub_export_items item
  set blocking_reason = coalesce(skipped.reason, '보관 원본과 DB 스냅샷 값 불일치'),
      status = 'failed',
      updated_at = now()
  from skipped
  where item.export_batch_id = p_export_batch_id
    and item.export_item_id = skipped.export_item_id
    and item.status = 'prepared';
  get diagnostics v_skipped = row_count;

  if p_success and not exists (
    select 1
    from public.operations_hub_export_items
    where export_batch_id = p_export_batch_id
      and status = 'prepared'
      and blocking_reason is null
  ) then
    raise exception '내보낼 수 있는 정상 항목이 없습니다.';
  end if;

  update public.operations_hub_export_items
  set status = case when p_success and blocking_reason is null then 'exported' else 'failed' end,
      updated_at = now()
  where export_batch_id = p_export_batch_id
    and status = 'prepared';

  select count(*) filter (where status = 'failed')::integer
  into v_total_failed
  from public.operations_hub_export_items
  where export_batch_id = p_export_batch_id;

  update public.operations_hub_export_batches
  set status = case when p_success then 'exported' else 'failed' end,
      file_manifest = coalesce(p_file_manifest, '[]'::jsonb),
      error_message = case
        when p_success and v_total_failed > 0 then v_total_failed || '건을 원본 검증 충돌로 제외했습니다.'
        when p_success then null
        else coalesce(nullif(btrim(p_error_message), ''), '파일 생성 실패')
      end,
      exported_at = case when p_success then now() else exported_at end,
      updated_at = now()
  where export_batch_id = p_export_batch_id
    and status in ('prepared', 'failed');
  if not found then
    raise exception '완료할 내보내기 배치를 찾지 못했습니다.';
  end if;

  with change_state as materialized (
    select change_id,
           bool_or(status = 'failed') as has_failure,
           string_agg(distinct blocking_reason, ' / ') filter (where blocking_reason is not null) as reasons
    from public.operations_hub_export_items
    where export_batch_id = p_export_batch_id
      and change_id is not null
    group by change_id
  )
  update public.operations_hub_change_queue queue
  set status = case
        when not p_success or change_state.has_failure then 'failed'
        else 'exported'
      end,
      processed_at = case
        when p_success and not change_state.has_failure then now()
        else queue.processed_at
      end,
      error_message = case
        when not p_success then coalesce(nullif(btrim(p_error_message), ''), '파일 생성 실패')
        when change_state.has_failure then coalesce(change_state.reasons, '원본 검증 충돌')
        else null
      end,
      status_message = case
        when not p_success then '원본 파일 생성 실패'
        when change_state.has_failure then '일부 원본 검증 충돌로 내보내기 제외'
        else '원본 파일 생성 완료 · 판매처 업로드 확인 대기'
      end,
      updated_at = now()
  from change_state
  where queue.change_id = change_state.change_id
    and queue.status in ('processing', 'failed');

  select count(*) filter (where status = 'exported')::integer,
         count(*) filter (where status = 'failed')::integer
  into v_exported, v_failed
  from public.operations_hub_export_items
  where export_batch_id = p_export_batch_id;

  return query select v_exported, v_failed;
end;
$$;

revoke all on function public.complete_operations_hub_export(uuid, boolean, jsonb, text, jsonb) from public;
grant execute on function public.complete_operations_hub_export(uuid, boolean, jsonb, text, jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
