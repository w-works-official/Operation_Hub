-- Promote seller source prices from a single effective value to explicit
-- base / option / final components. Existing `price` and `sellpia_sale_price`
-- fields remain as compatibility aliases for the final customer price.

alter table public.seller_inventory_snapshot_rows
  add column if not exists base_price numeric,
  add column if not exists option_price numeric,
  add column if not exists final_price numeric;

update public.seller_inventory_snapshot_rows row_item
set
  base_price = coalesce(
    row_item.base_price,
    nullif(row_item.raw_payload ->> 'base_price', '')::numeric,
    row_item.price
  ),
  option_price = coalesce(
    row_item.option_price,
    nullif(row_item.raw_payload ->> 'option_price', '')::numeric,
    0
  ),
  final_price = coalesce(row_item.final_price, row_item.price)
where row_item.base_price is null
   or row_item.option_price is null
   or row_item.final_price is null;

comment on column public.seller_inventory_snapshot_rows.base_price is
  'Seller product base sale price before an option adjustment.';
comment on column public.seller_inventory_snapshot_rows.option_price is
  'Seller option adjustment. Negative values are allowed.';
comment on column public.seller_inventory_snapshot_rows.final_price is
  'Effective customer price. Compatibility column price mirrors this value.';

alter table public.operations_hub_change_queue
  add column if not exists price_base_before numeric,
  add column if not exists price_base_after numeric,
  add column if not exists price_option_before numeric,
  add column if not exists price_option_after numeric,
  add column if not exists price_final_before numeric,
  add column if not exists price_final_after numeric,
  add column if not exists option_price_source text,
  add column if not exists price_rule_set_id bigint references public.operations_hub_price_rule_sets(price_rule_set_id) on delete set null;

alter table public.operations_hub_change_queue
  drop constraint if exists operations_hub_change_queue_option_price_source_check;
alter table public.operations_hub_change_queue
  add constraint operations_hub_change_queue_option_price_source_check
  check (option_price_source is null or option_price_source in ('original', 'manual', 'tag'));

alter table public.operations_hub_export_items
  add column if not exists target_base_price numeric,
  add column if not exists target_option_price numeric,
  add column if not exists target_final_price numeric,
  add column if not exists option_price_source text,
  add column if not exists price_rule_set_id bigint references public.operations_hub_price_rule_sets(price_rule_set_id) on delete set null;

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

  select count(*)::integer into v_input_row_count
  from public.seller_inventory_snapshot_rows row_item
  where row_item.snapshot_id = p_snapshot_id;

  select snapshot.snapshot_id into v_previous
  from public.seller_inventory_snapshots snapshot
  where snapshot.source_channel = v_source
    and snapshot.upload_status = 'ready'
    and snapshot.snapshot_id <> p_snapshot_id
  order by snapshot.completed_at desc nulls last, snapshot.created_at desc
  limit 1;

  if v_upload_mode = 'patch' and v_previous is null then
    raise exception '부분 갱신의 기준이 되는 이전 판매처 원본이 없습니다. 최초 1회는 전체 교체로 업로드해주세요.';
  end if;

  if v_upload_mode = 'patch' then
    update public.seller_inventory_snapshots snapshot
    set base_snapshot_id = v_previous
    where snapshot.snapshot_id = p_snapshot_id;

    insert into public.seller_inventory_snapshot_rows (
      snapshot_id, product_code, option_code, seller_code, product_name,
      option_name, stock, price, base_price, option_price, final_price,
      sale_status, source_row_no, raw_payload
    )
    select
      p_snapshot_id, previous_row.product_code, previous_row.option_code,
      previous_row.seller_code, previous_row.product_name, previous_row.option_name,
      previous_row.stock, previous_row.price, previous_row.base_price,
      previous_row.option_price, previous_row.final_price, previous_row.sale_status,
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
      base_price = case when coalesce((v_selected ->> 'price')::boolean, false) then current_row.base_price else previous_row.base_price end,
      option_price = case when coalesce((v_selected ->> 'price')::boolean, false) then current_row.option_price else previous_row.option_price end,
      final_price = case when coalesce((v_selected ->> 'price')::boolean, false) then current_row.final_price else previous_row.final_price end,
      sale_status = case when coalesce((v_selected ->> 'status')::boolean, false) then current_row.sale_status else previous_row.sale_status end
    from public.seller_inventory_snapshot_rows previous_row
    where current_row.snapshot_id = p_snapshot_id
      and previous_row.snapshot_id = v_previous
      and previous_row.product_code = current_row.product_code
      and previous_row.option_code = current_row.option_code;
  end if;

  update public.seller_inventory_snapshot_rows row_item
  set
    base_price = coalesce(row_item.base_price, nullif(row_item.raw_payload ->> 'base_price', '')::numeric, row_item.price),
    option_price = coalesce(row_item.option_price, nullif(row_item.raw_payload ->> 'option_price', '')::numeric, 0),
    final_price = coalesce(row_item.final_price, row_item.price),
    price = coalesce(row_item.final_price, row_item.price)
  where row_item.snapshot_id = p_snapshot_id;

  select count(*)::integer into v_row_count
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
        'preserved_row_count', greatest(v_row_count - v_input_row_count, 0),
        'price_components', true
      )
  where snapshot.snapshot_id = p_snapshot_id;

  return query select p_snapshot_id, v_source, v_row_count, v_completed;
end;
$$;

create or replace view public.operations_hub_active_seller_drafts
with (security_invoker = true)
as
select distinct on (queue.sellpia_sku_code, queue.source_channel, queue.field_key)
  queue.change_id,
  queue.sellpia_sku_code,
  queue.source_channel,
  queue.field_key,
  queue.before_value,
  queue.after_value,
  queue.status,
  queue.updated_at,
  queue.price_base_before,
  queue.price_base_after,
  queue.price_option_before,
  queue.price_option_after,
  queue.price_final_before,
  queue.price_final_after,
  queue.option_price_source,
  queue.price_rule_set_id
from public.operations_hub_change_queue queue
where queue.source_channel in ('smartstore','makeshop','ably')
  and queue.field_key in ('sellpia_current_stock','sellpia_sale_price')
  and queue.status in ('pending','validated','processing','exported','failed')
order by queue.sellpia_sku_code, queue.source_channel, queue.field_key,
         queue.updated_at desc, queue.change_id desc;

grant select on public.operations_hub_active_seller_drafts to anon, authenticated;

create or replace function public.load_operations_hub_seller_price_components(p_skus text[])
returns table(
  sellpia_sku_code text,
  source_channel text,
  seller_product_code text,
  seller_option_code text,
  source_base_price numeric,
  source_option_price numeric,
  source_final_price numeric,
  draft_base_price numeric,
  draft_option_price numeric,
  draft_final_price numeric,
  option_price_source text,
  price_rule_set_id bigint,
  draft_change_id bigint,
  draft_status text,
  draft_updated_at timestamptz
)
language sql
stable
security invoker
set search_path = public, operations_private, pg_temp
as $$
  with requested as materialized (
    select distinct btrim(sku) as sellpia_sku_code
    from unnest(coalesce(p_skus, '{}'::text[])) sku
    where nullif(btrim(sku), '') is not null
  ),
  latest_snapshot as materialized (
    select distinct on (snapshot.source_channel)
      snapshot.source_channel,
      snapshot.snapshot_id
    from public.seller_inventory_snapshots snapshot
    where snapshot.upload_status = 'ready'
      and snapshot.source_channel in ('smartstore','makeshop','ably')
    order by snapshot.source_channel,
             snapshot.completed_at desc nulls last,
             snapshot.created_at desc
  ),
  mapped as materialized (
    select matrix.sellpia_sku_code, source.source_channel,
      case source.source_channel
        when 'smartstore' then matrix.smartstore_product_code
        when 'makeshop' then matrix.makeshop_product_code
        when 'ably' then matrix.ably_product_code
      end as seller_product_code,
      case source.source_channel
        when 'smartstore' then coalesce(matrix.smartstore_option_code, '')
        when 'makeshop' then coalesce(matrix.makeshop_option_code, '')
        when 'ably' then coalesce(matrix.ably_option_code, '')
      end as seller_option_code
    from public.operations_hub_matrix_cached matrix
    join requested using (sellpia_sku_code)
    cross join lateral unnest(array['smartstore','makeshop','ably']::text[]) source(source_channel)
  )
  select
    mapped.sellpia_sku_code,
    mapped.source_channel,
    mapped.seller_product_code,
    mapped.seller_option_code,
    coalesce(source_row.base_price, nullif(source_row.raw_payload ->> 'base_price', '')::numeric, source_row.price),
    coalesce(source_row.option_price, nullif(source_row.raw_payload ->> 'option_price', '')::numeric, 0),
    coalesce(source_row.final_price, source_row.price),
    draft.price_base_after,
    draft.price_option_after,
    coalesce(draft.price_final_after, nullif(draft.after_value #>> '{}', '')::numeric),
    draft.option_price_source,
    draft.price_rule_set_id,
    draft.change_id,
    draft.status,
    draft.updated_at
  from mapped
  left join latest_snapshot snapshot using (source_channel)
  left join public.seller_inventory_snapshot_rows source_row
    on source_row.snapshot_id = snapshot.snapshot_id
   and source_row.product_code = mapped.seller_product_code
   and source_row.option_code = mapped.seller_option_code
  left join public.operations_hub_active_seller_drafts draft
    on draft.sellpia_sku_code = mapped.sellpia_sku_code
   and draft.source_channel = mapped.source_channel
   and draft.field_key = 'sellpia_sale_price';
$$;

create or replace function public.save_operations_hub_seller_price_draft(
  p_sku text,
  p_source text,
  p_target_final_price numeric,
  p_option_price numeric default null,
  p_option_price_source text default 'original',
  p_price_rule_set_id bigint default null,
  p_batch_id uuid default null
)
returns table(
  change_id bigint,
  draft_status text,
  cancelled_count integer,
  change_batch_id uuid,
  source_base_price numeric,
  source_option_price numeric,
  source_final_price numeric,
  draft_base_price numeric,
  draft_option_price numeric,
  draft_final_price numeric,
  saved_option_price_source text,
  saved_price_rule_set_id bigint,
  saved_at timestamptz
)
language plpgsql
security invoker
set search_path = public, operations_private, pg_temp
as $$
declare
  v_matrix public.operations_hub_matrix_cached%rowtype;
  v_snapshot_id uuid;
  v_source_row public.seller_inventory_snapshot_rows%rowtype;
  v_product_code text;
  v_option_code text;
  v_source_base numeric;
  v_source_option numeric;
  v_source_final numeric;
  v_target_option numeric;
  v_target_base numeric;
  v_cancelled integer := 0;
  v_change_id bigint;
  v_batch_id uuid := coalesce(p_batch_id, gen_random_uuid());
  v_saved_at timestamptz := now();
begin
  p_sku := btrim(p_sku);
  p_source := lower(btrim(p_source));
  p_option_price_source := lower(coalesce(nullif(btrim(p_option_price_source), ''), 'original'));

  if p_source not in ('smartstore','makeshop','ably') then
    raise exception '지원하지 않는 판매처입니다: %', p_source;
  end if;
  if p_option_price_source not in ('original','manual','tag') then
    raise exception '옵션가 출처는 original, manual, tag 중 하나여야 합니다.';
  end if;
  if p_target_final_price is null or p_target_final_price < 0 then
    raise exception '목표 최종판가는 0 이상의 숫자여야 합니다.';
  end if;

  select * into v_matrix
  from public.operations_hub_matrix_cached matrix
  where matrix.sellpia_sku_code = p_sku;
  if not found then
    raise exception '매트릭스에 없는 셀피아 SKU입니다: %', p_sku;
  end if;

  v_product_code := case p_source
    when 'smartstore' then v_matrix.smartstore_product_code
    when 'makeshop' then v_matrix.makeshop_product_code
    when 'ably' then v_matrix.ably_product_code
  end;
  v_option_code := case p_source
    when 'smartstore' then coalesce(v_matrix.smartstore_option_code, '')
    when 'makeshop' then coalesce(v_matrix.makeshop_option_code, '')
    when 'ably' then coalesce(v_matrix.ably_option_code, '')
  end;

  if nullif(btrim(v_product_code), '') is null then
    raise exception '판매처에 연결된 상품코드가 없습니다.';
  end if;

  select snapshot.snapshot_id into v_snapshot_id
  from public.seller_inventory_snapshots snapshot
  where snapshot.source_channel = p_source
    and snapshot.upload_status = 'ready'
  order by snapshot.completed_at desc nulls last, snapshot.created_at desc
  limit 1;

  select * into v_source_row
  from public.seller_inventory_snapshot_rows row_item
  where row_item.snapshot_id = v_snapshot_id
    and row_item.product_code = v_product_code
    and row_item.option_code = coalesce(v_option_code, '');
  if not found then
    raise exception '최신 판매처 원본에서 상품·옵션 코드를 찾지 못했습니다.';
  end if;

  v_source_base := coalesce(v_source_row.base_price, nullif(v_source_row.raw_payload ->> 'base_price', '')::numeric, v_source_row.price);
  v_source_option := coalesce(v_source_row.option_price, nullif(v_source_row.raw_payload ->> 'option_price', '')::numeric, 0);
  v_source_final := coalesce(v_source_row.final_price, v_source_row.price, v_source_base + v_source_option);
  v_target_option := coalesce(p_option_price, v_source_option, 0);
  v_target_base := p_target_final_price - v_target_option;

  if v_source_final is null or v_source_base is null then
    raise exception '최신 판매처 원본에 가격 구성값이 없습니다.';
  end if;
  if v_target_base < 0 then
    raise exception '목표 최종판가보다 옵션가가 커서 기본 판매가가 음수가 됩니다.';
  end if;
  if p_price_rule_set_id is not null and not exists (
    select 1 from public.operations_hub_price_rule_sets rule_set
    where rule_set.price_rule_set_id = p_price_rule_set_id and rule_set.is_active
  ) then
    raise exception '활성 가격 조합 태그를 찾을 수 없습니다: %', p_price_rule_set_id;
  end if;

  update public.operations_hub_change_queue queue
  set status = 'cancelled',
      cancelled_at = v_saved_at,
      cancelled_by = 'operations_hub_frontend',
      status_message = '더 최신 판매처 가격 수정안으로 대체됨',
      updated_at = v_saved_at
  where queue.sellpia_sku_code = p_sku
    and queue.source_channel = p_source
    and queue.field_key = 'sellpia_sale_price'
    and queue.status in ('pending','validated','failed');
  get diagnostics v_cancelled = row_count;

  if v_source_base is not distinct from v_target_base
     and v_source_option is not distinct from v_target_option
     and v_source_final is not distinct from p_target_final_price then
    return query select
      null::bigint, 'unchanged'::text, v_cancelled, v_batch_id,
      v_source_base, v_source_option, v_source_final,
      v_target_base, v_target_option, p_target_final_price,
      p_option_price_source, p_price_rule_set_id, v_saved_at;
    return;
  end if;

  insert into public.operations_hub_change_queue (
    change_batch_id, sellpia_sku_code, field_key, before_value, after_value,
    target_channels, status, requested_by, requested_at, updated_at,
    source_channel, seller_product_code, seller_option_code, status_message,
    price_base_before, price_base_after,
    price_option_before, price_option_after,
    price_final_before, price_final_after,
    option_price_source, price_rule_set_id
  ) values (
    v_batch_id, p_sku, 'sellpia_sale_price', to_jsonb(v_source_final), to_jsonb(p_target_final_price),
    array[p_source], 'pending', 'operations_hub_frontend', v_saved_at, v_saved_at,
    p_source, v_product_code, coalesce(v_option_code, ''), 'DB 저장됨 · 판매처 원본 반영 대기',
    v_source_base, v_target_base,
    v_source_option, v_target_option,
    v_source_final, p_target_final_price,
    p_option_price_source, p_price_rule_set_id
  ) returning operations_hub_change_queue.change_id into v_change_id;

  return query select
    v_change_id, 'pending'::text, v_cancelled, v_batch_id,
    v_source_base, v_source_option, v_source_final,
    v_target_base, v_target_option, p_target_final_price,
    p_option_price_source, p_price_rule_set_id, v_saved_at;
end;
$$;

comment on function public.save_operations_hub_seller_price_draft(text,text,numeric,numeric,text,bigint,uuid) is
  'Atomically stores one seller price proposal. Base price is always derived as target final price minus the effective option price.';

revoke all on function public.load_operations_hub_seller_price_components(text[]) from public;
revoke all on function public.save_operations_hub_seller_price_draft(text,text,numeric,numeric,text,bigint,uuid) from public;
grant execute on function public.load_operations_hub_seller_price_components(text[]) to anon, authenticated;
grant execute on function public.save_operations_hub_seller_price_draft(text,text,numeric,numeric,text,bigint,uuid) to anon, authenticated;

notify pgrst, 'reload schema';
