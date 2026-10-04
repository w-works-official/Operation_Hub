-- Enrich the existing export preparation pipeline without replacing it.
-- The current prepare RPC inserts export_items by change_id; this trigger
-- copies V2 discount metadata and blocks drafts whose source price/discount
-- changed after the operator reviewed them.

create or replace function public.hydrate_operations_hub_export_price_v2()
returns trigger
language plpgsql
security invoker
set search_path = public, operations_private, pg_temp
as $$
declare
  v_queue public.operations_hub_change_queue%rowtype;
  v_latest_snapshot uuid;
  v_source_row public.seller_inventory_snapshot_rows%rowtype;
  v_source_base numeric;
  v_source_option numeric;
  v_source_final numeric;
begin
  if new.change_id is null or new.field_key <> 'sellpia_sale_price' then
    return new;
  end if;

  select * into v_queue
  from public.operations_hub_change_queue queue
  where queue.change_id = new.change_id;
  if not found then return new; end if;

  new.target_discounted_base_price := coalesce(
    v_queue.price_discounted_base_after,
    new.target_base_price
  );
  new.price_calculation_version := coalesce(v_queue.price_calculation_version, 1);
  new.pricing_input_mode := coalesce(v_queue.pricing_input_mode, 'legacy_final');
  new.base_price_source := v_queue.base_price_source;
  new.source_snapshot_id := v_queue.source_snapshot_id;
  new.source_discount_fingerprint := v_queue.source_discount_fingerprint;

  if new.price_calculation_version <> 2 then return new; end if;

  select snapshot.snapshot_id into v_latest_snapshot
  from public.seller_inventory_snapshots snapshot
  where snapshot.source_channel = new.source_channel
    and snapshot.upload_status = 'ready'
  order by snapshot.completed_at desc nulls last, snapshot.created_at desc
  limit 1;

  select * into v_source_row
  from public.seller_inventory_snapshot_rows row_item
  where row_item.snapshot_id = v_latest_snapshot
    and row_item.product_code = new.seller_product_code
    and row_item.option_code = coalesce(new.seller_option_code, '');

  if not found then
    new.blocking_reason := coalesce(new.blocking_reason, '최신 판매처 원본에서 가격 검증 대상을 찾지 못했습니다.');
    return new;
  end if;

  v_source_base := coalesce(v_source_row.base_price, nullif(v_source_row.raw_payload ->> 'base_price', '')::numeric, v_source_row.price);
  v_source_option := coalesce(v_source_row.option_price, nullif(v_source_row.raw_payload ->> 'option_price', '')::numeric, 0);
  v_source_final := coalesce(v_source_row.final_price, v_source_row.price, v_source_row.discounted_base_price + v_source_option);

  if v_queue.source_discount_fingerprint is distinct from v_source_row.source_discount_fingerprint
     or v_queue.price_base_before is distinct from v_source_base
     or v_queue.price_option_before is distinct from v_source_option
     or v_queue.price_final_before is distinct from v_source_final then
    new.blocking_reason := coalesce(
      new.blocking_reason,
      '가격 수정안을 저장한 뒤 판매처 원본의 판매가·할인·옵션가가 변경되었습니다. 최신 원본에서 다시 검토해주세요.'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists hydrate_operations_hub_export_price_v2_trigger
  on public.operations_hub_export_items;
create trigger hydrate_operations_hub_export_price_v2_trigger
before insert or update of change_id, target_base_price, target_option_price, target_final_price
on public.operations_hub_export_items
for each row execute function public.hydrate_operations_hub_export_price_v2();

comment on function public.hydrate_operations_hub_export_price_v2() is
  'Bridges V2 seller price drafts into the existing export pipeline and blocks stale native-discount assumptions.';

notify pgrst, 'reload schema';
