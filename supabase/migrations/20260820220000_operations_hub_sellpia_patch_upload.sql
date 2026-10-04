-- Merge a small Sellpia upload into the latest complete Sellpia snapshot.
-- The patch snapshot stays in `uploading` until every omitted SKU and every
-- unselected field has been carried forward from the previous ready snapshot.

grant update on table public.sellpia_stock_snapshot_rows to anon, authenticated;

drop policy if exists "sellpia stock rows patchable while uploading" on public.sellpia_stock_snapshot_rows;
create policy "sellpia stock rows patchable while uploading"
on public.sellpia_stock_snapshot_rows
for update
to anon, authenticated
using (
  exists (
    select 1
    from public.sellpia_stock_snapshots snapshot
    where snapshot.snapshot_id = sellpia_stock_snapshot_rows.snapshot_id
      and snapshot.uploaded_by in ('system_v1_frontend', 'review_frontend')
      and snapshot.upload_status = 'uploading'
  )
)
with check (
  exists (
    select 1
    from public.sellpia_stock_snapshots snapshot
    where snapshot.snapshot_id = sellpia_stock_snapshot_rows.snapshot_id
      and snapshot.uploaded_by in ('system_v1_frontend', 'review_frontend')
      and snapshot.upload_status = 'uploading'
  )
);

create or replace function public.finalize_operations_hub_sellpia_patch(
  p_patch_snapshot_id uuid,
  p_selected_fields jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_patch public.sellpia_stock_snapshots%rowtype;
  v_base_snapshot_id uuid;
  v_inventory boolean := coalesce((p_selected_fields ->> 'inventory')::boolean, false);
  v_price boolean := coalesce((p_selected_fields ->> 'price')::boolean, false);
  v_basic boolean := coalesce((p_selected_fields ->> 'basic')::boolean, false);
  v_status boolean := coalesce((p_selected_fields ->> 'status')::boolean, false);
  v_uploaded_count integer;
  v_preserved_count integer;
  v_final_count integer;
begin
  if p_patch_snapshot_id is null then
    raise exception '부분 갱신 스냅샷 ID가 필요합니다.';
  end if;
  if not (v_inventory or v_price or v_basic or v_status) then
    raise exception '부분 갱신할 항목을 하나 이상 선택해주세요.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('operations_hub_sellpia_patch', 0));

  select *
  into v_patch
  from public.sellpia_stock_snapshots
  where snapshot_id = p_patch_snapshot_id
  for update;

  if not found or v_patch.upload_status <> 'uploading' then
    raise exception '처리 가능한 셀피아 부분 갱신 스냅샷이 아닙니다.';
  end if;

  select snapshot_id
  into v_base_snapshot_id
  from public.sellpia_stock_snapshots
  where upload_status = 'ready'
    and snapshot_id <> p_patch_snapshot_id
  order by created_at desc
  limit 1;

  if v_base_snapshot_id is null then
    raise exception '부분 갱신의 기준이 될 이전 셀피아 원본이 없습니다. 최초 1회는 전체 교체로 업로드해주세요.';
  end if;

  select count(*)::integer
  into v_uploaded_count
  from public.sellpia_stock_snapshot_rows
  where snapshot_id = p_patch_snapshot_id;

  if v_uploaded_count = 0 then
    raise exception '부분 갱신할 셀피아 SKU가 없습니다.';
  end if;

  -- For SKUs present in both snapshots, only the checked field groups change.
  update public.sellpia_stock_snapshot_rows patch_row
  set
    sellpia_product_code = case when v_basic then patch_row.sellpia_product_code else base_row.sellpia_product_code end,
    sellpia_product_name = case when v_basic then patch_row.sellpia_product_name else base_row.sellpia_product_name end,
    sellpia_option_name = case when v_basic then patch_row.sellpia_option_name else base_row.sellpia_option_name end,
    own_sku = case when v_basic then patch_row.own_sku else base_row.own_sku end,
    stock = case when v_inventory then patch_row.stock else base_row.stock end,
    available_stock = case when v_inventory then patch_row.available_stock else base_row.available_stock end,
    integrated_available_stock = case when v_inventory then patch_row.integrated_available_stock else base_row.integrated_available_stock end,
    safety_stock = case when v_inventory then patch_row.safety_stock else base_row.safety_stock end,
    source_row_no = coalesce(patch_row.source_row_no, base_row.source_row_no),
    supplier_code = case when v_basic then patch_row.supplier_code else base_row.supplier_code end,
    supplier_name = case when v_basic then patch_row.supplier_name else base_row.supplier_name end,
    supplier_group = case when v_basic then patch_row.supplier_group else base_row.supplier_group end,
    supplier_address = case when v_basic then patch_row.supplier_address else base_row.supplier_address end,
    supplier_market_name = case when v_basic then patch_row.supplier_market_name else base_row.supplier_market_name end,
    supplier_phone = case when v_basic then patch_row.supplier_phone else base_row.supplier_phone end,
    purchase_product_name = case when v_basic then patch_row.purchase_product_name else base_row.purchase_product_name end,
    purchase_option_name = case when v_basic then patch_row.purchase_option_name else base_row.purchase_option_name end,
    raw_payload = coalesce(base_row.raw_payload, '{}'::jsonb)
      || case when v_price then jsonb_build_object(
        'base_price', patch_row.raw_payload -> 'base_price',
        'sell_price', patch_row.raw_payload -> 'sell_price',
        'purchase_price', patch_row.raw_payload -> 'purchase_price',
        'commission', patch_row.raw_payload -> 'commission',
        'purchase_vat', patch_row.raw_payload -> 'purchase_vat'
      ) else '{}'::jsonb end
      || case when v_status then jsonb_build_object(
        'sale_status', patch_row.raw_payload -> 'sale_status'
      ) else '{}'::jsonb end
      || jsonb_build_object(
        'source_file_name', patch_row.raw_payload -> 'source_file_name',
        'patch_snapshot_id', p_patch_snapshot_id
      )
  from public.sellpia_stock_snapshot_rows base_row
  where patch_row.snapshot_id = p_patch_snapshot_id
    and base_row.snapshot_id = v_base_snapshot_id
    and base_row.sellpia_sku_code = patch_row.sellpia_sku_code;

  -- SKUs omitted from the patch remain active by copying the previous row.
  insert into public.sellpia_stock_snapshot_rows (
    snapshot_id,
    sellpia_sku_code,
    sellpia_product_code,
    sellpia_product_name,
    sellpia_option_name,
    own_sku,
    stock,
    available_stock,
    integrated_available_stock,
    safety_stock,
    source_row_no,
    raw_payload,
    supplier_code,
    supplier_name,
    supplier_group,
    supplier_address,
    supplier_market_name,
    supplier_phone,
    purchase_product_name,
    purchase_option_name
  )
  select
    p_patch_snapshot_id,
    base_row.sellpia_sku_code,
    base_row.sellpia_product_code,
    base_row.sellpia_product_name,
    base_row.sellpia_option_name,
    base_row.own_sku,
    base_row.stock,
    base_row.available_stock,
    base_row.integrated_available_stock,
    base_row.safety_stock,
    base_row.source_row_no,
    base_row.raw_payload || jsonb_build_object('preserved_from_snapshot_id', v_base_snapshot_id),
    base_row.supplier_code,
    base_row.supplier_name,
    base_row.supplier_group,
    base_row.supplier_address,
    base_row.supplier_market_name,
    base_row.supplier_phone,
    base_row.purchase_product_name,
    base_row.purchase_option_name
  from public.sellpia_stock_snapshot_rows base_row
  where base_row.snapshot_id = v_base_snapshot_id
    and not exists (
      select 1
      from public.sellpia_stock_snapshot_rows patch_row
      where patch_row.snapshot_id = p_patch_snapshot_id
        and patch_row.sellpia_sku_code = base_row.sellpia_sku_code
    );

  get diagnostics v_preserved_count = row_count;

  select count(*)::integer
  into v_final_count
  from public.sellpia_stock_snapshot_rows
  where snapshot_id = p_patch_snapshot_id;

  update public.sellpia_stock_snapshots
  set
    valid_row_count = v_final_count,
    invalid_row_count = 0,
    upload_status = 'ready',
    upload_note = format('부분 갱신 %s개 SKU · 기존 %s개 SKU 유지', v_uploaded_count, v_preserved_count),
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'upload_mode', 'patch',
      'base_snapshot_id', v_base_snapshot_id,
      'uploaded_row_count', v_uploaded_count,
      'preserved_row_count', v_preserved_count,
      'final_row_count', v_final_count,
      'selected_fields', p_selected_fields
    ),
    completed_at = clock_timestamp()
  where snapshot_id = p_patch_snapshot_id;

  return jsonb_build_object(
    'snapshot_id', p_patch_snapshot_id,
    'base_snapshot_id', v_base_snapshot_id,
    'upload_mode', 'patch',
    'uploaded_row_count', v_uploaded_count,
    'preserved_row_count', v_preserved_count,
    'row_count', v_final_count
  );
end;
$$;

revoke all on function public.finalize_operations_hub_sellpia_patch(uuid, jsonb) from public;
grant execute on function public.finalize_operations_hub_sellpia_patch(uuid, jsonb) to anon, authenticated;

comment on function public.finalize_operations_hub_sellpia_patch(uuid, jsonb) is
  'Merges uploaded Sellpia patch rows with the latest ready full row set while preserving unchecked fields and omitted SKUs.';

notify pgrst, 'reload schema';
