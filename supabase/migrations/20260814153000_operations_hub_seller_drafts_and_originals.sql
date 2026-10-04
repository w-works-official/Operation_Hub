alter table public.seller_inventory_snapshots
  add column if not exists source_storage_files jsonb not null default '[]'::jsonb;

alter table public.seller_inventory_snapshots
  drop constraint if exists seller_inventory_snapshots_storage_files_check;

alter table public.seller_inventory_snapshots
  add constraint seller_inventory_snapshots_storage_files_check
  check (jsonb_typeof(source_storage_files) = 'array');

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'seller-originals',
  'seller-originals',
  false,
  104857600,
  array[
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'text/csv',
    'text/plain',
    'application/octet-stream'
  ]::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "seller originals readable" on storage.objects;
create policy "seller originals readable"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'seller-originals');

drop policy if exists "seller originals insertable" on storage.objects;
create policy "seller originals insertable"
  on storage.objects for insert
  to anon, authenticated
  with check (
    bucket_id = 'seller-originals'
    and (storage.foldername(name))[1] in ('smartstore', 'makeshop', 'ably')
  );

create or replace function public.save_operations_hub_seller_value_draft(
  p_sku text,
  p_source text,
  p_field_key text,
  p_after numeric,
  p_batch_id uuid default null
)
returns table(change_id bigint, draft_status text, cancelled_count integer, change_batch_id uuid)
language plpgsql
security invoker
set search_path = public, operations_private, pg_temp
as $$
declare
  v_matrix public.operations_hub_matrix_live%rowtype;
  v_before numeric;
  v_product_code text;
  v_option_code text;
  v_cancelled integer := 0;
  v_change_id bigint;
  v_batch_id uuid := coalesce(p_batch_id, gen_random_uuid());
begin
  p_sku := btrim(p_sku);
  p_source := lower(btrim(p_source));
  p_field_key := btrim(p_field_key);

  if p_source not in ('smartstore', 'makeshop', 'ably') then
    raise exception '지원하지 않는 판매처입니다: %', p_source;
  end if;
  if p_field_key not in ('sellpia_current_stock', 'sellpia_sale_price') then
    raise exception '재고와 판매가만 판매처 수정안으로 저장할 수 있습니다.';
  end if;
  if p_after is null or p_after < 0 then
    raise exception '재고와 판매가는 0 이상의 숫자여야 합니다.';
  end if;
  if p_field_key = 'sellpia_current_stock' and p_after <> trunc(p_after) then
    raise exception '재고는 정수로 입력해주세요.';
  end if;

  select * into v_matrix
  from public.operations_hub_matrix_live matrix
  where matrix.sellpia_sku_code = p_sku;
  if not found then raise exception '매트릭스에 없는 셀피아 SKU입니다: %', p_sku; end if;

  v_before := case p_source
    when 'smartstore' then case p_field_key when 'sellpia_current_stock' then v_matrix.smartstore_stock else v_matrix.smartstore_price end
    when 'makeshop' then case p_field_key when 'sellpia_current_stock' then v_matrix.makeshop_stock else v_matrix.makeshop_price end
    when 'ably' then case p_field_key when 'sellpia_current_stock' then v_matrix.ably_stock else v_matrix.ably_price end
  end;
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
  if v_before is null then
    raise exception '최신 판매처 원본에 현재 값이 없습니다.';
  end if;

  update public.operations_hub_change_queue queue
  set status = 'cancelled',
      cancelled_at = now(),
      cancelled_by = 'operations_hub_frontend',
      status_message = '더 최신 판매처 수정안으로 대체됨',
      updated_at = now()
  where queue.sellpia_sku_code = p_sku
    and queue.source_channel = p_source
    and queue.field_key = p_field_key
    and queue.status in ('pending', 'validated', 'failed');
  get diagnostics v_cancelled = row_count;

  if v_before is not distinct from p_after then
    return query select null::bigint, 'unchanged'::text, v_cancelled, v_batch_id;
    return;
  end if;

  insert into public.operations_hub_change_queue (
    change_batch_id, sellpia_sku_code, field_key, before_value, after_value,
    target_channels, status, requested_by, requested_at, updated_at,
    source_channel, seller_product_code, seller_option_code, status_message
  ) values (
    v_batch_id, p_sku, p_field_key, to_jsonb(v_before), to_jsonb(p_after),
    array[p_source], 'pending', 'operations_hub_frontend', now(), now(),
    p_source, v_product_code, coalesce(v_option_code, ''), '매트릭스 검토 대기'
  ) returning operations_hub_change_queue.change_id into v_change_id;

  return query select v_change_id, 'pending'::text, v_cancelled, v_batch_id;
end;
$$;

create or replace function public.stage_operations_hub_seller_inventory_match(
  p_sources text[],
  p_skus text[] default null,
  p_batch_id uuid default null
)
returns table(staged_count integer, cancelled_count integer, change_batch_id uuid)
language plpgsql
security invoker
set search_path = public, operations_private, pg_temp
as $$
declare
  v_sources text[];
  v_batch_id uuid := coalesce(p_batch_id, gen_random_uuid());
  v_staged integer := 0;
  v_cancelled integer := 0;
begin
  select coalesce(array_agg(distinct lower(btrim(source))), '{}'::text[])
  into v_sources
  from unnest(coalesce(p_sources, '{}'::text[])) source
  where lower(btrim(source)) in ('smartstore', 'makeshop', 'ably');

  if cardinality(v_sources) = 0 then
    raise exception '판매처를 하나 이상 선택해주세요.';
  end if;

  with targets as (
    select matrix.sellpia_sku_code, source.source_channel
    from public.operations_hub_matrix_live matrix
    cross join lateral unnest(v_sources) source(source_channel)
    where (p_skus is null or cardinality(p_skus) = 0 or matrix.sellpia_sku_code = any(p_skus))
      and matrix.sellpia_current_stock is not null
      and case source.source_channel
        when 'smartstore' then matrix.smartstore_product_code is not null and matrix.smartstore_stock is distinct from matrix.sellpia_current_stock
        when 'makeshop' then matrix.makeshop_product_code is not null and matrix.makeshop_stock is distinct from matrix.sellpia_current_stock
        when 'ably' then matrix.ably_product_code is not null and matrix.ably_stock is distinct from matrix.sellpia_current_stock
      end
  )
  update public.operations_hub_change_queue queue
  set status = 'cancelled',
      cancelled_at = now(),
      cancelled_by = 'operations_hub_frontend',
      status_message = '셀피아 기준 재고 수정안으로 대체됨',
      updated_at = now()
  where queue.field_key = 'sellpia_current_stock'
    and queue.status in ('pending', 'validated', 'failed')
    and exists (
      select 1 from targets
      where targets.sellpia_sku_code = queue.sellpia_sku_code
        and targets.source_channel = queue.source_channel
    );
  get diagnostics v_cancelled = row_count;

  insert into public.operations_hub_change_queue (
    change_batch_id, sellpia_sku_code, field_key, before_value, after_value,
    target_channels, status, requested_by, requested_at, updated_at,
    source_channel, seller_product_code, seller_option_code, status_message
  )
  select
    v_batch_id,
    matrix.sellpia_sku_code,
    'sellpia_current_stock',
    to_jsonb(case source.source_channel
      when 'smartstore' then matrix.smartstore_stock
      when 'makeshop' then matrix.makeshop_stock
      when 'ably' then matrix.ably_stock
    end),
    to_jsonb(matrix.sellpia_current_stock),
    array[source.source_channel],
    'pending',
    'operations_hub_frontend',
    now(),
    now(),
    source.source_channel,
    case source.source_channel
      when 'smartstore' then matrix.smartstore_product_code
      when 'makeshop' then matrix.makeshop_product_code
      when 'ably' then matrix.ably_product_code
    end,
    case source.source_channel
      when 'smartstore' then coalesce(matrix.smartstore_option_code, '')
      when 'makeshop' then coalesce(matrix.makeshop_option_code, '')
      when 'ably' then coalesce(matrix.ably_option_code, '')
    end,
    '셀피아 기준 재고 · 매트릭스 검토 대기'
  from public.operations_hub_matrix_live matrix
  cross join lateral unnest(v_sources) source(source_channel)
  where (p_skus is null or cardinality(p_skus) = 0 or matrix.sellpia_sku_code = any(p_skus))
    and matrix.sellpia_current_stock is not null
    and case source.source_channel
      when 'smartstore' then matrix.smartstore_product_code is not null and matrix.smartstore_stock is distinct from matrix.sellpia_current_stock
      when 'makeshop' then matrix.makeshop_product_code is not null and matrix.makeshop_stock is distinct from matrix.sellpia_current_stock
      when 'ably' then matrix.ably_product_code is not null and matrix.ably_stock is distinct from matrix.sellpia_current_stock
    end
  on conflict do nothing;
  get diagnostics v_staged = row_count;

  return query select v_staged, v_cancelled, v_batch_id;
end;
$$;

revoke all on function public.save_operations_hub_seller_value_draft(text, text, text, numeric, uuid) from public;
revoke all on function public.stage_operations_hub_seller_inventory_match(text[], text[], uuid) from public;
grant execute on function public.save_operations_hub_seller_value_draft(text, text, text, numeric, uuid) to anon, authenticated;
grant execute on function public.stage_operations_hub_seller_inventory_match(text[], text[], uuid) to anon, authenticated;
