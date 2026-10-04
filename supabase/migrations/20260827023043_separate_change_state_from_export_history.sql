-- Change lifecycle and file-export lifecycle are deliberately separate.
-- A downloaded file is an audit fact, not a terminal state of the saved edit.

alter table public.operations_hub_change_queue
  drop constraint if exists operations_hub_change_queue_status_check;

-- Preserve every historical export item/batch, while returning legacy queue
-- rows to the active reviewed-edit state. Do not create 12k synthetic change
-- events for this one-time status normalization.
alter table public.operations_hub_change_queue
  disable trigger operations_hub_change_queue_event_trigger;

update public.operations_hub_change_queue
set status = 'validated',
    status_message = case
      when status = 'exported' then '수정 저장됨 · 기존 내보내기 이력 보존'
      else '수정 저장됨 · 미완료 내보내기 이력 확인 필요'
    end,
    error_message = null
where status in ('processing', 'exported');

alter table public.operations_hub_change_queue
  enable trigger operations_hub_change_queue_event_trigger;

alter table public.operations_hub_change_queue
  add constraint operations_hub_change_queue_status_check check (
    status in ('pending', 'validated', 'applied', 'failed', 'saved', 'cancelled')
  );

-- Compatibility guard for any older caller or stored function that still
-- attempts to write processing/exported to the queue. Export progress remains
-- exclusively on operations_hub_export_batches/items.
create or replace function public.normalize_operations_hub_change_status()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.status in ('processing', 'exported') then
    new.status := 'validated';
    new.error_message := null;
    new.status_message := case
      when new.status_message ilike '%완료%' then '수정 저장됨 · 내보내기 이력 별도 보존'
      else '수정 저장됨 · 내보내기 진행상태 별도 관리'
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists operations_hub_change_queue_status_normalizer on public.operations_hub_change_queue;
create trigger operations_hub_change_queue_status_normalizer
before insert or update of status on public.operations_hub_change_queue
for each row execute function public.normalize_operations_hub_change_status();

revoke all on function public.normalize_operations_hub_change_status() from public;

-- Cancelling/replacing/restoring an edit makes any file generated from that
-- edit stale. Keep the file audit row, but mark it cancelled so it cannot be
-- mistaken for the current upload candidate.
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

    update public.operations_hub_export_batches batch
    set status = 'cancelled',
        error_message = coalesce(
          batch.error_message,
          '연결된 수정내역이 취소되어 내보내기 파일이 만료되었습니다.'
        ),
        updated_at = now()
    where batch.status = 'exported'
      and exists (
        select 1
        from public.operations_hub_export_items item
        where item.export_batch_id = batch.export_batch_id
          and item.change_id = new.change_id
          and item.status = 'cancelled'
      )
      and not exists (
        select 1
        from public.operations_hub_export_items item
        where item.export_batch_id = batch.export_batch_id
          and item.status = 'exported'
      );
  end if;
  return new;
end;
$$;

drop trigger if exists operations_hub_change_queue_cancelled_export_trigger on public.operations_hub_change_queue;
create trigger operations_hub_change_queue_cancelled_export_trigger
after update of status on public.operations_hub_change_queue
for each row execute function public.invalidate_operations_hub_cancelled_exports();

revoke all on function public.invalidate_operations_hub_cancelled_exports() from public;

-- Only current edits project into the matrix. File generation no longer owns
-- a queue status, so processing/exported are intentionally absent.
create or replace view public.operations_hub_active_seller_drafts
with (security_invoker = true)
as
select distinct on (queue.sellpia_sku_code, queue.source_channel, queue.field_key)
  queue.change_id, queue.sellpia_sku_code, queue.source_channel, queue.field_key,
  queue.before_value, queue.after_value, queue.status, queue.updated_at,
  queue.price_base_before, queue.price_base_after,
  queue.price_option_before, queue.price_option_after,
  queue.price_final_before, queue.price_final_after,
  queue.option_price_source, queue.price_rule_set_id,
  queue.price_discounted_base_before, queue.price_discounted_base_after,
  queue.base_price_source, queue.price_calculation_version,
  queue.pricing_input_mode, queue.source_snapshot_id,
  queue.source_discount_fingerprint,
  queue.price_discount_terms_before, queue.price_discount_terms_after
from public.operations_hub_change_queue queue
where queue.source_channel in ('smartstore','makeshop','ably')
  and queue.field_key in ('sellpia_current_stock','sellpia_sale_price')
  and queue.status in ('pending','validated','failed')
order by queue.sellpia_sku_code, queue.source_channel, queue.field_key,
         queue.updated_at desc, queue.change_id desc;

grant select on public.operations_hub_active_seller_drafts to anon, authenticated;

-- Manual marketplace-apply confirmation is the only path that closes an
-- exported edit. Eligibility is derived from export_items, never queue.status.
create or replace function public.confirm_operations_hub_changes_applied(p_change_ids bigint[])
returns table(applied_count integer)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
  v_ids bigint[];
begin
  select coalesce(array_agg(queue.change_id), '{}'::bigint[])
  into v_ids
  from public.operations_hub_change_queue queue
  where queue.change_id = any(coalesce(p_change_ids, '{}'::bigint[]))
    and queue.status = 'validated'
    and exists (
      select 1
      from public.operations_hub_export_items item
      where item.change_id = queue.change_id
        and item.status = 'exported'
    );

  update public.operations_hub_change_queue
  set status = 'applied',
      processed_at = now(),
      error_message = null,
      status_message = '판매처 업로드 완료 확인',
      updated_at = now()
  where change_id = any(v_ids)
    and status = 'validated';
  get diagnostics v_count = row_count;

  update public.operations_hub_export_items
  set status = 'applied', updated_at = now()
  where change_id = any(v_ids)
    and status = 'exported';

  update public.operations_hub_export_batches batch
  set status = 'applied', applied_at = now(), updated_at = now()
  where batch.status = 'exported'
    and batch.export_mode = 'change_queue'
    and exists (
      select 1 from public.operations_hub_export_items item
      where item.export_batch_id = batch.export_batch_id
        and item.status = 'applied'
    )
    and not exists (
      select 1 from public.operations_hub_export_items item
      where item.export_batch_id = batch.export_batch_id
        and item.status in ('prepared', 'exported')
    );

  return query select v_count;
end;
$$;

revoke all on function public.confirm_operations_hub_changes_applied(bigint[]) from public;
grant execute on function public.confirm_operations_hub_changes_applied(bigint[]) to anon, authenticated;

comment on function public.normalize_operations_hub_change_status() is
  'Keeps file processing/export statuses out of the durable change lifecycle.';
comment on function public.invalidate_operations_hub_cancelled_exports() is
  'Marks downloaded-file audit rows stale when their source edit is cancelled or replaced.';
comment on function public.confirm_operations_hub_changes_applied(bigint[]) is
  'Closes validated edits only after a separate exported-file audit item exists.';

notify pgrst, 'reload schema';
