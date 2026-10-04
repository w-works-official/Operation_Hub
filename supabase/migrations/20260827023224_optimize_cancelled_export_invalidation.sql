-- Keep cancellation O(number of exported items for the changed edit).
-- The batch remains an immutable fact that a file was generated; only the
-- affected items become stale when their source edit is cancelled/replaced.
create or replace function public.invalidate_operations_hub_cancelled_exports()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'cancelled' and old.status is distinct from new.status then
    update public.operations_hub_export_items
    set status = 'cancelled',
        blocking_reason = coalesce(
          blocking_reason,
          '연결된 수정내역이 취소되어 이 파일은 최신 반영본이 아닙니다.'
        ),
        updated_at = now()
    where change_id = new.change_id
      and status = 'exported';
  end if;
  return new;
end;
$$;

revoke all on function public.invalidate_operations_hub_cancelled_exports() from public;

comment on function public.invalidate_operations_hub_cancelled_exports() is
  'Marks only the affected exported items stale; the historical export batch remains immutable.';

notify pgrst, 'reload schema';
