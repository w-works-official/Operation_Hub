create index if not exists operations_hub_change_queue_inventory_active_idx
  on public.operations_hub_change_queue (sellpia_sku_code, source_channel, change_id desc)
  where field_key = 'sellpia_current_stock'
    and status in ('pending', 'validated', 'failed');

create or replace function public.stage_operations_hub_seller_inventory_match_batch(
  p_sources text[],
  p_skus text[] default null,
  p_batch_id uuid default null,
  p_after_sku text default null,
  p_batch_size integer default 500
)
returns table(
  processed_count integer,
  total_count integer,
  staged_count integer,
  cancelled_count integer,
  next_cursor text,
  has_more boolean,
  change_batch_id uuid
)
language plpgsql
security invoker
set search_path = public, operations_private, pg_temp
as $$
declare
  v_sources text[];
  v_batch_id uuid := coalesce(p_batch_id, gen_random_uuid());
  v_batch_size integer := greatest(25, least(coalesce(p_batch_size, 500), 500));
begin
  select coalesce(array_agg(distinct lower(btrim(source))), '{}'::text[])
  into v_sources
  from unnest(coalesce(p_sources, '{}'::text[])) source
  where lower(btrim(source)) in ('smartstore', 'makeshop', 'ably');

  if cardinality(v_sources) = 0 then
    raise exception '판매처를 하나 이상 선택해주세요.';
  end if;

  return query
  with candidates as materialized (
    select
      matrix.sellpia_sku_code,
      matrix.sellpia_current_stock,
      matrix.smartstore_product_code,
      matrix.smartstore_option_code,
      matrix.smartstore_stock,
      matrix.makeshop_product_code,
      matrix.makeshop_option_code,
      matrix.makeshop_stock,
      matrix.ably_product_code,
      matrix.ably_option_code,
      matrix.ably_stock,
      count(*) over ()::integer as available_count
    from public.operations_hub_matrix_live matrix
    where (p_skus is null or cardinality(p_skus) = 0 or matrix.sellpia_sku_code = any(p_skus))
      and (p_after_sku is null or matrix.sellpia_sku_code > p_after_sku)
      and matrix.sellpia_current_stock is not null
  ),
  sku_page as materialized (
    select *
    from candidates
    order by sellpia_sku_code
    limit v_batch_size
  ),
  targets as materialized (
    select
      matrix.sellpia_sku_code,
      source.source_channel,
      case source.source_channel
        when 'smartstore' then matrix.smartstore_stock
        when 'makeshop' then matrix.makeshop_stock
        when 'ably' then matrix.ably_stock
      end as before_stock,
      matrix.sellpia_current_stock as after_stock,
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
    from sku_page matrix
    cross join lateral unnest(v_sources) source(source_channel)
    where case source.source_channel
      when 'smartstore' then matrix.smartstore_product_code is not null and matrix.smartstore_stock is distinct from matrix.sellpia_current_stock
      when 'makeshop' then matrix.makeshop_product_code is not null and matrix.makeshop_stock is distinct from matrix.sellpia_current_stock
      when 'ably' then matrix.ably_product_code is not null and matrix.ably_stock is distinct from matrix.sellpia_current_stock
    end
  ),
  cancelled as (
    update public.operations_hub_change_queue queue
    set status = 'cancelled',
        cancelled_at = now(),
        cancelled_by = 'operations_hub_frontend',
        status_message = '돌아온 기준 재고 수정안으로 대체됨',
        updated_at = now()
    from targets
    where queue.field_key = 'sellpia_current_stock'
      and queue.status in ('pending', 'validated', 'failed')
      and queue.sellpia_sku_code = targets.sellpia_sku_code
      and queue.source_channel = targets.source_channel
    returning queue.change_id
  ),
  inserted as (
    insert into public.operations_hub_change_queue (
      change_batch_id, sellpia_sku_code, field_key, before_value, after_value,
      target_channels, status, requested_by, requested_at, updated_at,
      source_channel, seller_product_code, seller_option_code, status_message
    )
    select
      v_batch_id,
      targets.sellpia_sku_code,
      'sellpia_current_stock',
      to_jsonb(targets.before_stock),
      to_jsonb(targets.after_stock),
      array[targets.source_channel],
      'pending',
      'operations_hub_frontend',
      now(),
      now(),
      targets.source_channel,
      targets.seller_product_code,
      targets.seller_option_code,
      '돌아온 기준 재고 · 매트릭스 검토 대기'
    from targets
    on conflict do nothing
    returning operations_hub_change_queue.change_id
  ),
  batch_stats as (
    select
      (select count(*)::integer from sku_page) as processed_count,
      coalesce((select max(available_count) from sku_page), 0)::integer as total_count,
      (select count(*)::integer from inserted) as staged_count,
      (select count(*)::integer from cancelled) as cancelled_count,
      (select max(sellpia_sku_code) from sku_page) as next_cursor
  )
  select
    batch_stats.processed_count,
    batch_stats.total_count,
    batch_stats.staged_count,
    batch_stats.cancelled_count,
    batch_stats.next_cursor,
    batch_stats.processed_count < batch_stats.total_count,
    v_batch_id
  from batch_stats;
end;
$$;

revoke all on function public.stage_operations_hub_seller_inventory_match_batch(text[], text[], uuid, text, integer) from public;
grant execute on function public.stage_operations_hub_seller_inventory_match_batch(text[], text[], uuid, text, integer) to anon, authenticated;

notify pgrst, 'reload schema';
