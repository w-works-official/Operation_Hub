create or replace function public.complete_operations_hub_export(
  p_export_batch_id uuid,
  p_success boolean,
  p_file_manifest jsonb default '[]'::jsonb,
  p_error_message text default null
)
returns table(exported_count integer,failed_count integer)
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_exported integer:=0; v_failed integer:=0;
begin
  if jsonb_typeof(coalesce(p_file_manifest,'[]'::jsonb))<>'array' then
    raise exception '파일 목록은 배열이어야 합니다.';
  end if;
  update public.operations_hub_export_batches
  set status=case when p_success then 'exported' else 'failed' end,
    file_manifest=coalesce(p_file_manifest,'[]'::jsonb),
    error_message=case when p_success then null else coalesce(nullif(btrim(p_error_message),''),'파일 생성 실패') end,
    exported_at=case when p_success then now() else exported_at end,
    updated_at=now()
  where export_batch_id=p_export_batch_id
    and (status='prepared' or (status='failed' and not p_success));
  if not found then raise exception '완료할 내보내기 배치를 찾지 못했습니다.'; end if;

  update public.operations_hub_export_items
  set status=case when p_success then 'exported' else 'failed' end,updated_at=now()
  where export_batch_id=p_export_batch_id and status='prepared';

  update public.operations_hub_change_queue q
  set status=case when p_success then 'exported' else 'failed' end,
    processed_at=case when p_success then now() else processed_at end,
    error_message=case when p_success then null else coalesce(nullif(btrim(p_error_message),''),'파일 생성 실패') end,
    status_message=case when p_success then '원본 파일 생성 완료 · 판매처 업로드 확인 대기' else '원본 파일 생성 실패' end,
    updated_at=now()
  where q.change_id in (
      select change_id from public.operations_hub_export_items
      where export_batch_id=p_export_batch_id and change_id is not null
    ) and (q.status='processing' or (q.status='failed' and not p_success));
  get diagnostics v_exported=row_count;
  if not p_success then v_failed:=v_exported; v_exported:=0; end if;
  return query select v_exported,v_failed;
end; $$;

revoke all on function public.complete_operations_hub_export(uuid,boolean,jsonb,text) from public;
grant execute on function public.complete_operations_hub_export(uuid,boolean,jsonb,text) to anon,authenticated;

notify pgrst,'reload schema';
