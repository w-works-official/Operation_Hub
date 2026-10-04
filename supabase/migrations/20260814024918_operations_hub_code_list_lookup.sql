create or replace function public.search_operations_hub_seller_items(
  p_source text,
  p_query text default '',
  p_limit integer default 20
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
  linked_skus text[]
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
  ), searched as (
    select item.*,
           case when item.option_code = '' then item.product_code
                else item.product_code || '-' || item.option_code end as listing_code
    from public.seller_inventory_latest item
    where item.source_channel = p_source
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
         coalesce(linked.linked_skus, '{}'::text[]) as linked_skus
  from searched item
  left join linked
    on linked.source_channel = item.source_channel
   and linked.product_code = item.product_code
   and linked.option_code = item.option_code
  where nullif(btrim(p_query), '') is null
     or item.listing_code ilike '%' || btrim(p_query) || '%'
     or item.product_code ilike '%' || btrim(p_query) || '%'
     or item.option_code ilike '%' || btrim(p_query) || '%'
     or coalesce(item.product_name, '') ilike '%' || btrim(p_query) || '%'
     or coalesce(item.option_name, '') ilike '%' || btrim(p_query) || '%'
     or coalesce(item.seller_code, '') ilike '%' || btrim(p_query) || '%'
  order by
    case when item.listing_code = btrim(p_query) then 0
         when item.product_code = btrim(p_query) then 1
         when item.option_code = btrim(p_query) then 2
         else 3 end,
    item.product_code,
    item.option_code
  limit greatest(1, least(coalesce(p_limit, 20), 50));
$$;

revoke all on function public.search_operations_hub_seller_items(text, text, integer) from public;
grant execute on function public.search_operations_hub_seller_items(text, text, integer) to anon, authenticated;

create or replace function public.find_operations_hub_listing_skus(
  p_query text,
  p_limit integer default 500
)
returns table (sellpia_sku_code text)
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
  )
  select distinct link.sellpia_sku_code
  from effective_links link
  where case when link.option_code = '' then link.product_code
             else link.product_code || '-' || link.option_code end = btrim(p_query)
  order by link.sellpia_sku_code
  limit greatest(1, least(coalesce(p_limit, 500), 2000));
$$;

revoke all on function public.find_operations_hub_listing_skus(text, integer) from public;
grant execute on function public.find_operations_hub_listing_skus(text, integer) to anon, authenticated;

create or replace function public.resolve_operations_hub_code_entries(p_entries jsonb)
returns table (
  input_row integer,
  source_channel text,
  input_code text,
  match_scope text,
  match_status text,
  sellpia_sku_code text,
  product_code text,
  option_code text
)
language sql
security invoker
set search_path = public, operations_private, pg_temp
as $$
  with inputs as (
    select greatest(1, coalesce(entry.row_no, entry.ordinality::integer)) as input_row,
           lower(btrim(entry.source)) as source_channel,
           btrim(entry.code) as input_code,
           entry.ordinality
    from rows from (
      jsonb_to_recordset(coalesce(p_entries, '[]'::jsonb))
        as (row_no integer, source text, code text)
    ) with ordinality as entry(row_no, source, code, ordinality)
    where nullif(btrim(entry.code), '') is not null
  ), effective_links as (
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
  ), classified as (
    select input.*,
           case
             when input.source_channel = 'sellpia' and exists (
               select 1 from operations_private.operations_hub_matrix_core matrix
               where matrix.sellpia_sku_code = input.input_code
             ) then 'sku'
             when input.source_channel in ('smartstore', 'makeshop', 'ably') and exists (
               select 1 from public.seller_inventory_latest item
               where item.source_channel = input.source_channel
                 and case when item.option_code = '' then item.product_code
                          else item.product_code || '-' || item.option_code end = input.input_code
             ) then 'option'
             when input.source_channel in ('smartstore', 'makeshop', 'ably') and exists (
               select 1 from public.seller_inventory_latest item
               where item.source_channel = input.source_channel
                 and item.product_code = input.input_code
             ) then 'product'
             else 'none'
           end as match_scope
    from inputs input
  ), matched as (
    select input.input_row,
           input.ordinality,
           input.source_channel,
           input.input_code,
           input.match_scope,
           matrix.sellpia_sku_code,
           null::text as product_code,
           null::text as option_code
    from classified input
    join operations_private.operations_hub_matrix_core matrix
      on input.source_channel = 'sellpia'
     and input.match_scope = 'sku'
     and matrix.sellpia_sku_code = input.input_code
    union all
    select input.input_row,
           input.ordinality,
           input.source_channel,
           input.input_code,
           input.match_scope,
           link.sellpia_sku_code,
           link.product_code,
           link.option_code
    from classified input
    join effective_links link
      on link.source_channel = input.source_channel
     and (
       (input.match_scope = 'option' and
        case when link.option_code = '' then link.product_code
             else link.product_code || '-' || link.option_code end = input.input_code)
       or (input.match_scope = 'product' and link.product_code = input.input_code)
     )
  ), resolved as (
    select match.input_row,
           match.ordinality,
           match.source_channel,
           match.input_code,
           match.match_scope,
           'matched'::text as match_status,
           match.sellpia_sku_code,
           match.product_code,
           match.option_code
    from matched match
    union all
    select input.input_row,
           input.ordinality,
           input.source_channel,
           input.input_code,
           input.match_scope,
           case when input.source_channel not in ('sellpia', 'smartstore', 'makeshop', 'ably') then 'invalid_source'
                when input.match_scope = 'none' then 'not_found'
                else 'unmapped' end::text as match_status,
           null::text,
           null::text,
           null::text
    from classified input
    where not exists (
      select 1 from matched match
      where match.ordinality = input.ordinality
    )
  )
  select resolved.input_row,
         resolved.source_channel,
         resolved.input_code,
         resolved.match_scope,
         resolved.match_status,
         resolved.sellpia_sku_code,
         resolved.product_code,
         resolved.option_code
  from resolved
  order by resolved.ordinality, resolved.sellpia_sku_code nulls last;
$$;

revoke all on function public.resolve_operations_hub_code_entries(jsonb) from public;
grant execute on function public.resolve_operations_hub_code_entries(jsonb) to anon, authenticated;

create or replace function public.load_operations_hub_code_list(
  p_skus text[],
  p_page integer default 1,
  p_page_size integer default 50,
  p_status text default 'all',
  p_sort text default 'input_order'
)
returns jsonb
language sql
security invoker
set search_path = public, pg_temp
as $$
  with requested as (
    select sku, min(ordinality)::bigint as input_order
    from unnest(coalesce(p_skus, '{}'::text[])) with ordinality as requested(sku, ordinality)
    where nullif(btrim(sku), '') is not null
    group by sku
  ), filtered as (
    select matrix.*, requested.input_order
    from requested
    join public.operations_hub_matrix_live matrix
      on matrix.sellpia_sku_code = requested.sku
    where coalesce(p_status, 'all') = 'all'
       or (p_status = 'attention' and matrix.overall_status in ('review', 'unmatched'))
       or matrix.overall_status = p_status
  ), ranked as (
    select filtered.*,
           row_number() over (
             order by
               case when p_sort = 'input_order' then filtered.input_order end asc,
               case when p_sort = 'stock_desc' then filtered.sellpia_current_stock end desc nulls last,
               case when p_sort = 'price_desc' then filtered.sellpia_sale_price end desc nulls last,
               case when p_sort = 'updated_desc' then filtered.updated_at end desc nulls last,
               filtered.sellpia_sku_code asc
           ) as result_order
    from filtered
  ), paged as (
    select *
    from ranked
    where result_order > (greatest(1, coalesce(p_page, 1)) - 1) * greatest(1, least(coalesce(p_page_size, 50), 100))
      and result_order <= greatest(1, coalesce(p_page, 1)) * greatest(1, least(coalesce(p_page_size, 50), 100))
    order by result_order
  )
  select jsonb_build_object(
    'rows', coalesce((
      select jsonb_agg(to_jsonb(paged) - 'input_order' - 'result_order' order by paged.result_order)
      from paged
    ), '[]'::jsonb),
    'count', (select count(*) from filtered),
    'page', greatest(1, coalesce(p_page, 1)),
    'pageSize', greatest(1, least(coalesce(p_page_size, 50), 100))
  );
$$;

revoke all on function public.load_operations_hub_code_list(text[], integer, integer, text, text) from public;
grant execute on function public.load_operations_hub_code_list(text[], integer, integer, text, text) to anon, authenticated;
