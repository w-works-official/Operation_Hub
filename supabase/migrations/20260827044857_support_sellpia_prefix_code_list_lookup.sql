-- Expand a Sellpia product prefix such as 1254 to its 1254-* option SKUs.
-- Exact SKU matches keep priority, and prefix matching requires a literal hyphen
-- boundary so 1254 never matches 12540-*.

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
             when input.source_channel = 'sellpia' and exists (
               select 1 from operations_private.operations_hub_matrix_core matrix
               where left(matrix.sellpia_sku_code, char_length(input.input_code) + 1) = input.input_code || '-'
             ) then 'prefix'
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
     and (
       (input.match_scope = 'sku' and matrix.sellpia_sku_code = input.input_code)
       or (input.match_scope = 'prefix' and
           left(matrix.sellpia_sku_code, char_length(input.input_code) + 1) = input.input_code || '-')
     )
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
