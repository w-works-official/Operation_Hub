create index if not exists operations_hub_change_queue_listing_inventory_active_idx
  on public.operations_hub_change_queue (
    source_channel,
    seller_product_code,
    seller_option_code,
    change_id desc
  )
  where field_key = 'sellpia_current_stock'
    and status in ('pending', 'validated', 'failed');

create or replace function public.list_operations_hub_listing_graph(
  p_source text default 'all',
  p_relation_type text default 'all',
  p_search text default '',
  p_page integer default 1,
  p_page_size integer default 50
)
returns jsonb
language sql
security invoker
set search_path = public
as $$
  with filtered as (
    select graph.*
    from public.operations_hub_listing_graph_live graph
    where (p_source = 'all' or graph.source_channel = p_source)
      and (
        p_relation_type = 'all'
        or (p_relation_type = 'complex' and graph.relation_type <> 'single')
        or graph.relation_type = p_relation_type
      )
      and (
        btrim(coalesce(p_search, '')) = ''
        or graph.product_code ilike '%' || btrim(p_search) || '%'
        or graph.option_code ilike '%' || btrim(p_search) || '%'
        or coalesce(graph.product_name, '') ilike '%' || btrim(p_search) || '%'
        or coalesce(graph.option_name, '') ilike '%' || btrim(p_search) || '%'
        or exists (
          select 1
          from jsonb_array_elements(graph.components) component
          where component ->> 'sku' ilike '%' || btrim(p_search) || '%'
             or component ->> 'ownCode' ilike '%' || btrim(p_search) || '%'
             or component ->> 'productName' ilike '%' || btrim(p_search) || '%'
             or component ->> 'optionName' ilike '%' || btrim(p_search) || '%'
        )
      )
  ), paged as (
    select *
    from filtered
    order by source_channel, product_code, option_code
    offset (greatest(coalesce(p_page, 1), 1) - 1) * least(greatest(coalesce(p_page_size, 50), 1), 100)
    limit least(greatest(coalesce(p_page_size, 50), 1), 100)
  ), enriched as (
    select
      paged.*,
      seller.stock as seller_stock,
      seller.snapshot_completed_at as seller_inventory_at,
      draft.change_id as inventory_change_id,
      draft.status as inventory_draft_status,
      draft.after_value #>> '{}' as inventory_draft_stock
    from paged
    left join lateral (
      select latest.stock, latest.snapshot_completed_at
      from public.seller_inventory_latest latest
      where latest.source_channel = paged.source_channel
        and latest.product_code = paged.product_code
        and latest.option_code = paged.option_code
      order by latest.snapshot_completed_at desc nulls last
      limit 1
    ) seller on true
    left join lateral (
      select queue.change_id, queue.status, queue.after_value
      from public.operations_hub_change_queue queue
      where queue.source_channel = paged.source_channel
        and queue.seller_product_code = paged.product_code
        and coalesce(queue.seller_option_code, '') = paged.option_code
        and queue.field_key = 'sellpia_current_stock'
        and queue.status in ('pending', 'validated', 'failed')
      order by queue.change_id desc
      limit 1
    ) draft on true
  )
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(to_jsonb(enriched)) from enriched), '[]'::jsonb),
    'count', (select count(*) from filtered),
    'page', greatest(coalesce(p_page, 1), 1),
    'pageSize', least(greatest(coalesce(p_page_size, 50), 1), 100)
  );
$$;

create or replace function public.stage_operations_hub_listing_inventory_draft(
  p_source text,
  p_product_code text,
  p_option_code text default '',
  p_batch_id uuid default null
)
returns table (
  change_id bigint,
  draft_status text,
  cancelled_count integer,
  representative_sku text,
  current_stock integer,
  calculated_stock integer,
  component_count integer,
  change_batch_id uuid
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_source text := lower(btrim(coalesce(p_source, '')));
  v_product_code text := btrim(coalesce(p_product_code, ''));
  v_option_code text := btrim(coalesce(p_option_code, ''));
  v_batch_id uuid := coalesce(p_batch_id, gen_random_uuid());
  v_listing_id bigint;
  v_representative_sku text;
  v_current_stock integer;
  v_calculated_stock integer;
  v_component_count integer;
  v_cancelled integer := 0;
  v_change_id bigint;
begin
  if v_source not in ('smartstore', 'makeshop', 'ably') then
    raise exception '지원하지 않는 판매처입니다.';
  end if;
  if v_product_code = '' then
    raise exception '판매처 상품코드가 필요합니다.';
  end if;

  select
    listing.listing_id,
    count(component.component_id)::integer,
    case
      when count(matrix.sellpia_available_stock) = count(component.component_id) then
        min(floor(matrix.sellpia_available_stock::numeric / component.component_qty))::integer
      else null
    end,
    (array_agg(
      component.sellpia_sku_code
      order by case component.component_role when 'primary' then 0 else 1 end,
               component.component_id
    ))[1]
  into
    v_listing_id,
    v_component_count,
    v_calculated_stock,
    v_representative_sku
  from public.operations_hub_seller_listings listing
  join public.operations_hub_listing_components component
    on component.listing_id = listing.listing_id
   and component.is_active
  left join public.operations_hub_matrix_live matrix
    on matrix.sellpia_sku_code = component.sellpia_sku_code
  where listing.is_active
    and listing.source_channel = v_source
    and listing.product_code = v_product_code
    and listing.option_code = v_option_code
  group by listing.listing_id;

  if v_listing_id is null then
    raise exception '재고 수정안을 만들려면 먼저 판매처 옵션의 구성을 저장해주세요.';
  end if;
  if v_component_count = 0 then
    raise exception '활성 구성 SKU가 없습니다.';
  end if;
  if v_calculated_stock is null then
    raise exception '구성 SKU 중 가용재고를 확인할 수 없는 항목이 있습니다.';
  end if;

  select latest.stock
  into v_current_stock
  from public.seller_inventory_latest latest
  where latest.source_channel = v_source
    and latest.product_code = v_product_code
    and latest.option_code = v_option_code
  order by latest.snapshot_completed_at desc nulls last
  limit 1;

  if not found or v_current_stock is null then
    raise exception '최신 판매처 원본에서 현재 재고를 확인할 수 없습니다.';
  end if;

  update public.operations_hub_change_queue queue
  set status = 'cancelled',
      cancelled_at = now(),
      cancelled_by = 'operations_hub_frontend',
      status_message = '최신 조합 계산재고 수정안으로 대체됨',
      updated_at = now()
  where queue.source_channel = v_source
    and queue.seller_product_code = v_product_code
    and coalesce(queue.seller_option_code, '') = v_option_code
    and queue.field_key = 'sellpia_current_stock'
    and queue.status in ('pending', 'validated', 'failed');
  get diagnostics v_cancelled = row_count;

  if v_current_stock is distinct from v_calculated_stock then
    insert into public.operations_hub_change_queue (
      change_batch_id,
      sellpia_sku_code,
      field_key,
      before_value,
      after_value,
      target_channels,
      status,
      requested_by,
      requested_at,
      updated_at,
      source_channel,
      seller_product_code,
      seller_option_code,
      status_message
    ) values (
      v_batch_id,
      v_representative_sku,
      'sellpia_current_stock',
      to_jsonb(v_current_stock),
      to_jsonb(v_calculated_stock),
      array[v_source],
      'pending',
      'operations_hub_frontend',
      now(),
      now(),
      v_source,
      v_product_code,
      v_option_code,
      format('조합 계산재고 · 구성 %s SKU · 검토 대기', v_component_count)
    )
    on conflict do nothing
    returning operations_hub_change_queue.change_id into v_change_id;

    if v_change_id is null then
      select queue.change_id
      into v_change_id
      from public.operations_hub_change_queue queue
      where queue.change_batch_id = v_batch_id
        and queue.sellpia_sku_code = v_representative_sku
        and queue.field_key = 'sellpia_current_stock'
        and queue.source_channel = v_source
        and queue.seller_product_code = v_product_code
        and coalesce(queue.seller_option_code, '') = v_option_code
      order by queue.change_id desc
      limit 1;
    end if;
  end if;

  return query
  select
    v_change_id,
    case when v_change_id is null then 'unchanged'::text else 'pending'::text end,
    v_cancelled,
    v_representative_sku,
    v_current_stock,
    v_calculated_stock,
    v_component_count,
    v_batch_id;
end;
$$;

revoke all on function public.list_operations_hub_listing_graph(text, text, text, integer, integer) from public;
revoke all on function public.stage_operations_hub_listing_inventory_draft(text, text, text, uuid) from public;
grant execute on function public.list_operations_hub_listing_graph(text, text, text, integer, integer) to anon, authenticated;
grant execute on function public.stage_operations_hub_listing_inventory_draft(text, text, text, uuid) to anon, authenticated;

notify pgrst, 'reload schema';
