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
  queue.updated_at
from public.operations_hub_change_queue queue
where queue.source_channel in ('smartstore', 'makeshop', 'ably')
  and queue.field_key in ('sellpia_current_stock', 'sellpia_sale_price')
  and queue.status in ('pending', 'validated', 'processing', 'exported', 'failed')
order by
  queue.sellpia_sku_code,
  queue.source_channel,
  queue.field_key,
  queue.updated_at desc,
  queue.change_id desc;

revoke all on public.operations_hub_active_seller_drafts from public;
grant select on public.operations_hub_active_seller_drafts to anon, authenticated;

create or replace function public.search_operations_hub_seller_items_v2(
  p_source text,
  p_query text default '',
  p_page integer default 1,
  p_page_size integer default 24
)
returns table (
  source_channel text,
  product_code text,
  option_code text,
  product_name text,
  option_name text,
  stock integer,
  price numeric,
  sale_status text,
  snapshot_completed_at timestamptz,
  linked_skus text[],
  total_count bigint
)
language sql
security invoker
set search_path = public, operations_private, pg_temp
as $$
  with effective_links as (
    select 'smartstore'::text as source_channel,
           matrix.sellpia_sku_code,
           matrix.smartstore_product_code as product_code,
           coalesce(matrix.smartstore_option_code, '') as option_code
    from operations_private.operations_hub_matrix_core matrix
    where matrix.smartstore_product_code is not null
      and not exists (
        select 1 from public.operations_hub_manual_links manual
        where manual.source_channel = 'smartstore'
          and manual.sellpia_sku_code = matrix.sellpia_sku_code
      )
    union all
    select 'makeshop', matrix.sellpia_sku_code, matrix.makeshop_product_code, coalesce(matrix.makeshop_option_code, '')
    from operations_private.operations_hub_matrix_core matrix
    where matrix.makeshop_product_code is not null
      and not exists (
        select 1 from public.operations_hub_manual_links manual
        where manual.source_channel = 'makeshop'
          and manual.sellpia_sku_code = matrix.sellpia_sku_code
      )
    union all
    select 'ably', matrix.sellpia_sku_code, matrix.ably_product_code, coalesce(matrix.ably_option_code, '')
    from operations_private.operations_hub_matrix_core matrix
    where matrix.ably_product_code is not null
      and not exists (
        select 1 from public.operations_hub_manual_links manual
        where manual.source_channel = 'ably'
          and manual.sellpia_sku_code = matrix.sellpia_sku_code
      )
    union all
    select manual.source_channel, manual.sellpia_sku_code, manual.product_code, manual.option_code
    from public.operations_hub_manual_links manual
  ), linked as (
    select link.source_channel, link.product_code, link.option_code,
           array_agg(distinct link.sellpia_sku_code order by link.sellpia_sku_code) as linked_skus
    from effective_links link
    group by link.source_channel, link.product_code, link.option_code
  ), terms as (
    select
      btrim(coalesce(p_query, '')) as raw_query,
      case when strpos(coalesce(p_query, ''), '/') > 0
           then btrim(split_part(p_query, '/', 1)) else null end as product_term,
      case when strpos(coalesce(p_query, ''), '/') > 0
           then btrim(substr(p_query, strpos(p_query, '/') + 1)) else null end as option_term
  ), searched as (
    select item.*,
           case when item.option_code = '' then item.product_code
                else item.product_code || '-' || item.option_code end as listing_code
    from public.seller_inventory_latest item
    where item.source_channel = lower(btrim(p_source))
  ), filtered as (
    select item.*
    from searched item
    cross join terms
    where
      (nullif(terms.product_term, '') is not null and nullif(terms.option_term, '') is not null
       and coalesce(item.product_name, '') ilike '%' || terms.product_term || '%'
       and coalesce(item.option_name, '') ilike '%' || terms.option_term || '%')
      or
      ((nullif(terms.product_term, '') is null or nullif(terms.option_term, '') is null)
       and (
         nullif(terms.raw_query, '') is null
         or item.listing_code ilike '%' || terms.raw_query || '%'
         or item.product_code ilike '%' || terms.raw_query || '%'
         or item.option_code ilike '%' || terms.raw_query || '%'
         or coalesce(item.product_name, '') ilike '%' || terms.raw_query || '%'
         or coalesce(item.option_name, '') ilike '%' || terms.raw_query || '%'
         or coalesce(item.seller_code, '') ilike '%' || terms.raw_query || '%'
       ))
  )
  select item.source_channel,
         item.product_code,
         item.option_code,
         item.product_name,
         item.option_name,
         item.stock,
         item.price,
         item.sale_status,
         item.snapshot_completed_at,
         coalesce(linked.linked_skus, '{}'::text[]) as linked_skus,
         count(*) over () as total_count
  from filtered item
  left join linked
    on linked.source_channel = item.source_channel
   and linked.product_code = item.product_code
   and linked.option_code = item.option_code
  cross join terms
  order by
    case when item.listing_code = terms.raw_query then 0
         when item.product_code = terms.raw_query then 1
         when item.option_code = terms.raw_query then 2
         else 3 end,
    item.product_code,
    item.option_code
  limit greatest(1, least(coalesce(p_page_size, 24), 100))
  offset (greatest(1, coalesce(p_page, 1)) - 1) * greatest(1, least(coalesce(p_page_size, 24), 100));
$$;

revoke all on function public.search_operations_hub_seller_items_v2(text, text, integer, integer) from public;
grant execute on function public.search_operations_hub_seller_items_v2(text, text, integer, integer) to anon, authenticated;

create or replace view public.operations_hub_dashboard_metrics
with (security_invoker = true)
as
with projected as (
  select
    matrix.*,
    coalesce(nullif(regexp_replace(smart.after_value #>> '{}', '[^0-9.-]', '', 'g'), '')::numeric, matrix.smartstore_stock) as projected_smartstore_stock,
    coalesce(nullif(regexp_replace(make.after_value #>> '{}', '[^0-9.-]', '', 'g'), '')::numeric, matrix.makeshop_stock) as projected_makeshop_stock,
    coalesce(nullif(regexp_replace(ably.after_value #>> '{}', '[^0-9.-]', '', 'g'), '')::numeric, matrix.ably_stock) as projected_ably_stock,
    ((smart.change_id is not null)::integer + (make.change_id is not null)::integer + (ably.change_id is not null)::integer) as inventory_draft_cells
  from public.operations_hub_matrix_live matrix
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
        (projected_smartstore_stock is not null and projected_smartstore_stock <> sellpia_current_stock)
        or (projected_makeshop_stock is not null and projected_makeshop_stock <> sellpia_current_stock)
        or (projected_ably_stock is not null and projected_ably_stock <> sellpia_current_stock)
      )
  )::integer as projected_inventory_mismatch_sku,
  sum(inventory_draft_cells)::integer as inventory_draft_cells
from projected;

revoke all on public.operations_hub_dashboard_metrics from public;
grant select on public.operations_hub_dashboard_metrics to anon, authenticated;
