create index if not exists operations_hub_matrix_export_cache_status_idx
  on operations_private.operations_hub_matrix_export_cache (overall_status, sellpia_sku_code);

create or replace view public.operations_hub_matrix_cached
with (security_invoker = true)
as
select *
from operations_private.operations_hub_matrix_export_cache;

comment on view public.operations_hub_matrix_cached is
  'Non-blocking frontend read model. Refreshed concurrently from the live matrix once per minute.';

revoke all on public.operations_hub_matrix_cached from public;
grant select on public.operations_hub_matrix_cached to anon, authenticated;

do $$
declare
  v_signature regprocedure;
  v_definition text;
  v_rewritten text;
begin
  foreach v_signature in array array[
    'public.load_operations_hub_matrix_filtered_fast(integer,integer,text,text[],text,text,jsonb,text[])'::regprocedure,
    'public.load_operations_hub_matrix_filtered_with_profiles(integer,integer,text,text[],text,text,jsonb,text[])'::regprocedure
  ]
  loop
    v_definition := pg_get_functiondef(v_signature);
    v_rewritten := replace(
      v_definition,
      'public.operations_hub_matrix_live matrix',
      'public.operations_hub_matrix_cached matrix'
    );
    if v_rewritten <> v_definition then
      execute v_rewritten;
    end if;
  end loop;
end;
$$;

create or replace view public.operations_hub_dashboard_metrics
with (security_invoker = true)
as
with projected as (
  select
    matrix.*,
    coalesce(
      case when smart.status <> 'failed'
        then nullif(regexp_replace(smart.after_value #>> '{}', '[^0-9.-]', '', 'g'), '')::numeric
      end,
      matrix.smartstore_stock::numeric
    ) as projected_smartstore_stock,
    coalesce(
      case when make.status <> 'failed'
        then nullif(regexp_replace(make.after_value #>> '{}', '[^0-9.-]', '', 'g'), '')::numeric
      end,
      matrix.makeshop_stock::numeric
    ) as projected_makeshop_stock,
    coalesce(
      case when ably.status <> 'failed'
        then nullif(regexp_replace(ably.after_value #>> '{}', '[^0-9.-]', '', 'g'), '')::numeric
      end,
      matrix.ably_stock::numeric
    ) as projected_ably_stock,
    (smart.change_id is not null)::integer
      + (make.change_id is not null)::integer
      + (ably.change_id is not null)::integer as inventory_draft_cells,
    (smart.status = 'failed')::integer
      + (make.status = 'failed')::integer
      + (ably.status = 'failed')::integer as inventory_failed_cells
  from public.operations_hub_matrix_cached matrix
  left join public.operations_hub_active_seller_drafts smart
    on smart.sellpia_sku_code = matrix.sellpia_sku_code
   and smart.source_channel = 'smartstore'
   and smart.field_key = 'sellpia_current_stock'
  left join public.operations_hub_active_seller_drafts make
    on make.sellpia_sku_code = matrix.sellpia_sku_code
   and make.source_channel = 'makeshop'
   and make.field_key = 'sellpia_current_stock'
  left join public.operations_hub_active_seller_drafts ably
    on ably.sellpia_sku_code = matrix.sellpia_sku_code
   and ably.source_channel = 'ably'
   and ably.field_key = 'sellpia_current_stock'
)
select
  count(*)::integer as total_sku,
  count(*) filter (where overall_status <> 'unmatched')::integer as connected_sku,
  count(*) filter (where overall_status = 'unmatched')::integer as unmatched_sku,
  count(*) filter (
    where sellpia_current_stock is not null
      and (
        (smartstore_stock is not null and smartstore_stock <> sellpia_current_stock)
        or (makeshop_stock is not null and makeshop_stock <> sellpia_current_stock)
        or (ably_stock is not null and ably_stock <> sellpia_current_stock)
      )
  )::integer as inventory_mismatch_sku,
  max(greatest(
    coalesce(sellpia_inventory_at, '-infinity'::timestamptz),
    coalesce(smartstore_inventory_at, '-infinity'::timestamptz),
    coalesce(makeshop_inventory_at, '-infinity'::timestamptz),
    coalesce(ably_inventory_at, '-infinity'::timestamptz),
    coalesce(sellpia_override_updated_at, '-infinity'::timestamptz)
  )) as latest_sync_at,
  null::integer as today_picked,
  null::integer as shortage_drawer_qty,
  count(*) filter (
    where sellpia_current_stock is not null
      and (
        (projected_smartstore_stock is not null and projected_smartstore_stock <> sellpia_current_stock::numeric)
        or (projected_makeshop_stock is not null and projected_makeshop_stock <> sellpia_current_stock::numeric)
        or (projected_ably_stock is not null and projected_ably_stock <> sellpia_current_stock::numeric)
      )
  )::integer as projected_inventory_mismatch_sku,
  coalesce(sum(inventory_draft_cells), 0)::integer as inventory_draft_cells,
  coalesce(sum(inventory_failed_cells), 0)::integer as inventory_failed_cells
from projected;

revoke all on public.operations_hub_dashboard_metrics from public;
grant select on public.operations_hub_dashboard_metrics to anon, authenticated;

do $$
declare
  v_source_snapshot_id uuid;
  v_corrected_snapshot_id uuid := gen_random_uuid();
  v_source public.sellpia_stock_snapshots%rowtype;
  v_corrupt_count integer;
  v_recovered_count integer;
  v_collision_count integer;
  v_inserted_count integer;
begin
  select *
  into v_source
  from public.sellpia_stock_snapshots
  where upload_status = 'ready'
  order by created_at desc
  limit 1;

  if not found then
    return;
  end if;
  v_source_snapshot_id := v_source.snapshot_id;

  select
    count(*) filter (where sellpia_sku_code ~ '^\d+([.]\d+)?$')::integer,
    count(*) filter (where sellpia_sku_code ~ '^\d+-\d+$')::integer
  into v_corrupt_count, v_recovered_count
  from public.sellpia_stock_snapshot_rows
  where snapshot_id = v_source_snapshot_id;

  if v_corrupt_count = 0 then
    return;
  end if;
  if v_corrupt_count + v_recovered_count <> v_source.valid_row_count then
    raise exception 'Latest Sellpia snapshot contains unsupported SKU formats; correction aborted.';
  end if;

  with recovered as (
    select
      extract(year from (date '1899-12-30' + floor(sellpia_sku_code::numeric)::integer))::integer::text
        || '-' ||
      extract(month from (date '1899-12-30' + floor(sellpia_sku_code::numeric)::integer))::integer::text as recovered_sku
    from public.sellpia_stock_snapshot_rows
    where snapshot_id = v_source_snapshot_id
      and sellpia_sku_code ~ '^\d+([.]\d+)?$'
  ), all_keys as (
    select recovered_sku as sku from recovered
    union all
    select sellpia_sku_code
    from public.sellpia_stock_snapshot_rows
    where snapshot_id = v_source_snapshot_id
      and sellpia_sku_code ~ '^\d+-\d+$'
  )
  select count(*)::integer
  into v_collision_count
  from (
    select sku from all_keys group by sku having count(*) > 1
  ) duplicates;

  if v_collision_count > 0 then
    raise exception 'Recovered Sellpia SKUs collide with existing keys; correction aborted.';
  end if;

  insert into public.sellpia_stock_snapshots (
    snapshot_id, source_file_name, source_file_size, source_row_count,
    valid_row_count, invalid_row_count, upload_status, uploaded_by,
    upload_note, metadata, created_at, completed_at
  ) values (
    v_corrected_snapshot_id,
    v_source.source_file_name || ' [SKU corrected]',
    v_source.source_file_size,
    v_source.source_row_count,
    v_source.valid_row_count,
    v_source.invalid_row_count,
    'ready',
    'operations_hub_repair',
    'Recovered Excel date-serial SKU values without altering the uploaded source snapshot.',
    v_source.metadata || jsonb_build_object(
      'parser_version', 'operations-hub-sellpia-2026.08.20-v3-repair',
      'corrected_from_snapshot_id', v_source_snapshot_id,
      'repair_kind', 'excel_date_serial_sku_v1',
      'repaired_sku_count', v_corrupt_count,
      'repaired_at', clock_timestamp()
    ),
    clock_timestamp(),
    clock_timestamp()
  );

  insert into public.sellpia_stock_snapshot_rows (
    snapshot_id, sellpia_sku_code, sellpia_product_code,
    sellpia_product_name, sellpia_option_name, own_sku,
    stock, available_stock, integrated_available_stock, safety_stock,
    source_row_no, raw_payload, created_at,
    supplier_code, supplier_name, supplier_group, supplier_address,
    supplier_market_name, supplier_phone, purchase_product_name, purchase_option_name
  )
  select
    v_corrected_snapshot_id,
    corrected.corrected_sku,
    regexp_replace(corrected.corrected_sku, '-\d+$', ''),
    row_item.sellpia_product_name,
    row_item.sellpia_option_name,
    row_item.own_sku,
    row_item.stock,
    row_item.available_stock,
    row_item.integrated_available_stock,
    row_item.safety_stock,
    row_item.source_row_no,
    case when row_item.sellpia_sku_code ~ '^\d+([.]\d+)?$' then
      row_item.raw_payload || jsonb_build_object(
        '_sku_repair', jsonb_build_object(
          'from', row_item.sellpia_sku_code,
          'to', corrected.corrected_sku,
          'kind', 'excel_date_serial_sku_v1'
        )
      )
    else row_item.raw_payload end,
    row_item.created_at,
    row_item.supplier_code,
    row_item.supplier_name,
    row_item.supplier_group,
    row_item.supplier_address,
    row_item.supplier_market_name,
    row_item.supplier_phone,
    row_item.purchase_product_name,
    row_item.purchase_option_name
  from public.sellpia_stock_snapshot_rows row_item
  cross join lateral (
    select case
      when row_item.sellpia_sku_code ~ '^\d+([.]\d+)?$' then
        extract(year from (date '1899-12-30' + floor(row_item.sellpia_sku_code::numeric)::integer))::integer::text
          || '-' ||
        extract(month from (date '1899-12-30' + floor(row_item.sellpia_sku_code::numeric)::integer))::integer::text
      else row_item.sellpia_sku_code
    end as corrected_sku
  ) corrected
  where row_item.snapshot_id = v_source_snapshot_id;

  get diagnostics v_inserted_count = row_count;
  if v_inserted_count <> v_source.valid_row_count then
    raise exception 'Corrected Sellpia snapshot row count mismatch; correction aborted.';
  end if;
end;
$$;

notify pgrst, 'reload schema';
