alter table public.seller_inventory_snapshots
  add column if not exists upload_mode text not null default 'full',
  add column if not exists base_snapshot_id uuid references public.seller_inventory_snapshots(snapshot_id);

alter table public.seller_inventory_snapshots
  drop constraint if exists seller_inventory_snapshots_upload_mode_check;

alter table public.seller_inventory_snapshots
  add constraint seller_inventory_snapshots_upload_mode_check
  check (upload_mode in ('full', 'patch'));

comment on column public.seller_inventory_snapshots.upload_mode is
  'full replaces the seller snapshot; patch overlays uploaded product and option keys onto the previous ready snapshot.';

comment on column public.seller_inventory_snapshots.base_snapshot_id is
  'Previous ready snapshot used as the unchanged-row base for a patch upload.';

create or replace function public.finalize_seller_inventory_snapshot(p_snapshot_id uuid)
returns table(snapshot_id uuid, source_channel text, row_count integer, completed_at timestamptz)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_source text;
  v_selected jsonb;
  v_upload_mode text;
  v_previous uuid;
  v_completed timestamptz := now();
  v_input_row_count integer := 0;
  v_row_count integer := 0;
begin
  select snapshot.source_channel, snapshot.selected_fields, snapshot.upload_mode
    into v_source, v_selected, v_upload_mode
  from public.seller_inventory_snapshots snapshot
  where snapshot.snapshot_id = p_snapshot_id
    and snapshot.uploaded_by = 'operations_hub_frontend'
    and snapshot.upload_status = 'uploading'
  for update;

  if not found then
    raise exception '업로드 중인 판매처 스냅샷을 찾을 수 없습니다.';
  end if;

  select count(*)::integer
    into v_input_row_count
  from public.seller_inventory_snapshot_rows row_item
  where row_item.snapshot_id = p_snapshot_id;

  select snapshot.snapshot_id
    into v_previous
  from public.seller_inventory_snapshots snapshot
  where snapshot.source_channel = v_source
    and snapshot.upload_status = 'ready'
    and snapshot.snapshot_id <> p_snapshot_id
  order by snapshot.completed_at desc nulls last, snapshot.created_at desc
  limit 1;

  if v_upload_mode = 'patch' and v_previous is null then
    raise exception '부분 갱신의 기준이 될 이전 판매처 원본이 없습니다. 최초 1회는 전체 교체로 업로드해주세요.';
  end if;

  if v_upload_mode = 'patch' then
    update public.seller_inventory_snapshots snapshot
    set base_snapshot_id = v_previous
    where snapshot.snapshot_id = p_snapshot_id;

    insert into public.seller_inventory_snapshot_rows (
      snapshot_id, product_code, option_code, seller_code, product_name,
      option_name, stock, price, sale_status, source_row_no, raw_payload
    )
    select
      p_snapshot_id,
      previous_row.product_code,
      previous_row.option_code,
      previous_row.seller_code,
      previous_row.product_name,
      previous_row.option_name,
      previous_row.stock,
      previous_row.price,
      previous_row.sale_status,
      previous_row.source_row_no,
      previous_row.raw_payload || jsonb_build_object(
        '_patch_preserved', true,
        '_patch_preserved_from_snapshot_id', v_previous
      )
    from public.seller_inventory_snapshot_rows previous_row
    where previous_row.snapshot_id = v_previous
      and not exists (
        select 1
        from public.seller_inventory_snapshot_rows current_row
        where current_row.snapshot_id = p_snapshot_id
          and current_row.product_code = previous_row.product_code
          and current_row.option_code = previous_row.option_code
      );
  end if;

  if v_previous is not null then
    update public.seller_inventory_snapshot_rows current_row
    set
      seller_code = case when coalesce((v_selected ->> 'basic')::boolean, false) then current_row.seller_code else previous_row.seller_code end,
      product_name = case when coalesce((v_selected ->> 'basic')::boolean, false) then current_row.product_name else previous_row.product_name end,
      option_name = case when coalesce((v_selected ->> 'basic')::boolean, false) then current_row.option_name else previous_row.option_name end,
      stock = case when coalesce((v_selected ->> 'inventory')::boolean, false) then current_row.stock else previous_row.stock end,
      price = case when coalesce((v_selected ->> 'price')::boolean, false) then current_row.price else previous_row.price end,
      sale_status = case when coalesce((v_selected ->> 'status')::boolean, false) then current_row.sale_status else previous_row.sale_status end
    from public.seller_inventory_snapshot_rows previous_row
    where current_row.snapshot_id = p_snapshot_id
      and previous_row.snapshot_id = v_previous
      and previous_row.product_code = current_row.product_code
      and previous_row.option_code = current_row.option_code;
  end if;

  select count(*)::integer
    into v_row_count
  from public.seller_inventory_snapshot_rows row_item
  where row_item.snapshot_id = p_snapshot_id;

  update public.seller_inventory_snapshots snapshot
  set valid_row_count = v_row_count,
      invalid_row_count = greatest(snapshot.source_row_count - v_input_row_count, 0),
      upload_status = 'ready',
      completed_at = v_completed,
      metadata = snapshot.metadata || jsonb_build_object(
        'upload_mode', v_upload_mode,
        'base_snapshot_id', v_previous,
        'uploaded_row_count', v_input_row_count,
        'effective_row_count', v_row_count,
        'preserved_row_count', greatest(v_row_count - v_input_row_count, 0)
      )
  where snapshot.snapshot_id = p_snapshot_id;

  return query select p_snapshot_id, v_source, v_row_count, v_completed;
end;
$$;

create or replace function operations_private.calculate_operations_hub_policy_price(
  p_base_price numeric,
  p_replace_price numeric,
  p_modify_type text,
  p_modify_value numeric,
  p_min_price numeric,
  p_max_price numeric,
  p_rounding_unit numeric,
  p_rounding_mode text
)
returns numeric
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_price numeric;
  v_unit numeric := greatest(coalesce(p_rounding_unit, 1), 1);
begin
  v_price := coalesce(p_replace_price, p_base_price);
  if v_price is null then return null; end if;

  v_price := case p_modify_type
    when 'add' then v_price + coalesce(p_modify_value, 0)
    when 'percent' then v_price * (1 + coalesce(p_modify_value, 0) / 100.0)
    else v_price
  end;
  v_price := greatest(coalesce(p_min_price, v_price), v_price);
  v_price := least(coalesce(p_max_price, v_price), v_price);
  v_price := case p_rounding_mode
    when 'up' then ceil(v_price / v_unit) * v_unit
    when 'down' then floor(v_price / v_unit) * v_unit
    else round(v_price / v_unit) * v_unit
  end;
  return greatest(v_price, 0);
end;
$$;

create or replace view public.operations_hub_matrix_cached
with (security_invoker = true)
as
select
  matrix.*,
  case when smartstore_policy.is_active then operations_private.calculate_operations_hub_policy_price(
    matrix.sellpia_sale_price, smartstore_policy.replace_price, smartstore_policy.modify_type,
    smartstore_policy.modify_value, smartstore_policy.min_price, smartstore_policy.max_price,
    smartstore_policy.rounding_unit, smartstore_policy.rounding_mode
  ) end as smartstore_policy_price,
  coalesce(smartstore_policy.is_active, false) as smartstore_policy_active,
  smartstore_policy.policy_name as smartstore_policy_name,
  case when makeshop_policy.is_active then operations_private.calculate_operations_hub_policy_price(
    matrix.sellpia_sale_price, makeshop_policy.replace_price, makeshop_policy.modify_type,
    makeshop_policy.modify_value, makeshop_policy.min_price, makeshop_policy.max_price,
    makeshop_policy.rounding_unit, makeshop_policy.rounding_mode
  ) end as makeshop_policy_price,
  coalesce(makeshop_policy.is_active, false) as makeshop_policy_active,
  makeshop_policy.policy_name as makeshop_policy_name,
  case when ably_policy.is_active then operations_private.calculate_operations_hub_policy_price(
    matrix.sellpia_sale_price, ably_policy.replace_price, ably_policy.modify_type,
    ably_policy.modify_value, ably_policy.min_price, ably_policy.max_price,
    ably_policy.rounding_unit, ably_policy.rounding_mode
  ) end as ably_policy_price,
  coalesce(ably_policy.is_active, false) as ably_policy_active,
  ably_policy.policy_name as ably_policy_name
from operations_private.operations_hub_matrix_export_cache matrix
left join public.operations_hub_price_policies smartstore_policy
  on smartstore_policy.source_channel = 'smartstore'
left join public.operations_hub_price_policies makeshop_policy
  on makeshop_policy.source_channel = 'makeshop'
left join public.operations_hub_price_policies ably_policy
  on ably_policy.source_channel = 'ably';

comment on view public.operations_hub_matrix_cached is
  'Non-blocking frontend read model with seller-specific policy prices calculated from the Sellpia sale price without overwriting seller source prices.';

revoke all on function operations_private.calculate_operations_hub_policy_price(numeric, numeric, text, numeric, numeric, numeric, numeric, text) from public;
grant execute on function operations_private.calculate_operations_hub_policy_price(numeric, numeric, text, numeric, numeric, numeric, numeric, text) to anon, authenticated;
grant select on public.operations_hub_matrix_cached to anon, authenticated;

notify pgrst, 'reload schema';
