-- Additive search API: keep V2 and its legacy mapping precedence unchanged.
-- The migration runner applies this file in one transaction. Contended writes
-- or an unexpected index build duration abort the whole additive change.
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- The snapshot primary key already indexes (snapshot_id, product_code, option_code).
-- Separate exact option/listing paths avoid a full latest-snapshot ILIKE scan.
create index if not exists seller_inventory_rows_search_option_v3_idx
  on public.seller_inventory_snapshot_rows (snapshot_id, option_code, product_code);

create index if not exists seller_inventory_rows_search_listing_v3_idx
  on public.seller_inventory_snapshot_rows
  (snapshot_id, (case when option_code = '' then product_code else product_code || '-' || option_code end));

-- Each lookup is performed only for the selected result page, using one identity.
create index if not exists operations_hub_matrix_core_smartstore_identity_v3_idx
  on operations_private.operations_hub_matrix_core (smartstore_product_code, (coalesce(smartstore_option_code, '')))
  include (sellpia_sku_code) where smartstore_product_code is not null;
create index if not exists operations_hub_matrix_core_makeshop_identity_v3_idx
  on operations_private.operations_hub_matrix_core (makeshop_product_code, (coalesce(makeshop_option_code, '')))
  include (sellpia_sku_code) where makeshop_product_code is not null;
create index if not exists operations_hub_matrix_core_ably_identity_v3_idx
  on operations_private.operations_hub_matrix_core (ably_product_code, (coalesce(ably_option_code, '')))
  include (sellpia_sku_code) where ably_product_code is not null;

create or replace function public.search_operations_hub_seller_items_v3(
  p_source text,
  p_query text default '',
  p_page integer default 1,
  p_page_size integer default 24,
  p_match_mode text default 'auto'
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
stable
security invoker
set search_path = public, operations_private, pg_temp
as $$
  with terms as materialized (
    select lower(btrim(p_source)) as source,
           btrim(coalesce(p_query, '')) as raw_query,
           lower(btrim(coalesce(p_match_mode, 'auto'))) as match_mode,
           case when strpos(coalesce(p_query, ''), '/') > 0
                then btrim(split_part(p_query, '/', 1)) else null end as product_term,
           case when strpos(coalesce(p_query, ''), '/') > 0
                then btrim(substr(p_query, strpos(p_query, '/') + 1)) else null end as option_term,
           greatest(1, least(coalesce(p_page_size, 24), 100)) as page_size,
           (greatest(1, coalesce(p_page, 1))::bigint - 1)
             * greatest(1, least(coalesce(p_page_size, 24), 100)) as page_offset
  ), latest_snapshot as materialized (
    select snapshot.snapshot_id, snapshot.source_channel, snapshot.completed_at
    from public.seller_inventory_snapshots snapshot
    cross join terms
    where snapshot.source_channel = terms.source
      and snapshot.upload_status = 'ready'
    order by snapshot.completed_at desc nulls last, snapshot.created_at desc
    limit 1
  ), exact_keys as materialized (
    select row_item.product_code, row_item.option_code
    from latest_snapshot snapshot
    join public.seller_inventory_snapshot_rows row_item on row_item.snapshot_id = snapshot.snapshot_id
    cross join terms
    where terms.match_mode in ('auto', 'product')
      and terms.raw_query <> '' and row_item.product_code = terms.raw_query
    union
    select row_item.product_code, row_item.option_code
    from latest_snapshot snapshot
    join public.seller_inventory_snapshot_rows row_item on row_item.snapshot_id = snapshot.snapshot_id
    cross join terms
    where terms.match_mode = 'auto'
      and terms.raw_query <> '' and row_item.option_code = terms.raw_query
    union
    select row_item.product_code, row_item.option_code
    from latest_snapshot snapshot
    join public.seller_inventory_snapshot_rows row_item on row_item.snapshot_id = snapshot.snapshot_id
    cross join terms
    where terms.match_mode = 'auto' and terms.raw_query <> ''
      and (case when row_item.option_code = '' then row_item.product_code
                else row_item.product_code || '-' || row_item.option_code end) = terms.raw_query
  ), candidate_keys as materialized (
    select exact.product_code, exact.option_code from exact_keys exact
    union all
    select row_item.product_code, row_item.option_code
    from latest_snapshot snapshot
    join public.seller_inventory_snapshot_rows row_item on row_item.snapshot_id = snapshot.snapshot_id
    cross join terms
    where terms.match_mode = 'auto'
      and not exists (select 1 from exact_keys)
      and (
        (nullif(terms.product_term, '') is not null and nullif(terms.option_term, '') is not null
         and coalesce(row_item.product_name, '') ilike '%' || terms.product_term || '%'
         and coalesce(row_item.option_name, '') ilike '%' || terms.option_term || '%')
        or
        ((nullif(terms.product_term, '') is null or nullif(terms.option_term, '') is null)
         and (nullif(terms.raw_query, '') is null
           or (case when row_item.option_code = '' then row_item.product_code
                    else row_item.product_code || '-' || row_item.option_code end) ilike '%' || terms.raw_query || '%'
           or row_item.product_code ilike '%' || terms.raw_query || '%'
           or row_item.option_code ilike '%' || terms.raw_query || '%'
           or coalesce(row_item.product_name, '') ilike '%' || terms.raw_query || '%'
           or coalesce(row_item.option_name, '') ilike '%' || terms.raw_query || '%'
           or coalesce(row_item.seller_code, '') ilike '%' || terms.raw_query || '%'))
      )
  ), page_keys as materialized (
    select item.product_code, item.option_code, count(*) over () as total_count,
           case when (case when item.option_code = '' then item.product_code
                           else item.product_code || '-' || item.option_code end) = terms.raw_query then 0
                when item.product_code = terms.raw_query then 1
                when item.option_code = terms.raw_query then 2 else 3 end as match_rank
    from candidate_keys item cross join terms
    order by match_rank, item.product_code, item.option_code
    limit (select page_size from terms)
    offset (select page_offset from terms)
  )
  select snapshot.source_channel, item.product_code, item.option_code,
         item.product_name, item.option_name, item.stock, item.price, item.sale_status,
         snapshot.completed_at as snapshot_completed_at,
         coalesce(linked.linked_skus, '{}'::text[]) as linked_skus, page.total_count
  from page_keys page
  cross join latest_snapshot snapshot
  join public.seller_inventory_snapshot_rows item
    on item.snapshot_id = snapshot.snapshot_id
   and item.product_code = page.product_code and item.option_code = page.option_code
  left join lateral (
    select array_agg(distinct link.sellpia_sku_code order by link.sellpia_sku_code) as linked_skus
    from (
      select manual.sellpia_sku_code
      from public.operations_hub_manual_links manual
      where manual.source_channel = snapshot.source_channel
        and manual.product_code = item.product_code and manual.option_code = item.option_code
      union all
      select matrix.sellpia_sku_code
      from operations_private.operations_hub_matrix_core matrix
      where snapshot.source_channel = 'smartstore'
        and matrix.smartstore_product_code = item.product_code
        and coalesce(matrix.smartstore_option_code, '') = item.option_code
        and not exists (select 1 from public.operations_hub_manual_links manual
                        where manual.source_channel = 'smartstore' and manual.sellpia_sku_code = matrix.sellpia_sku_code)
      union all
      select matrix.sellpia_sku_code
      from operations_private.operations_hub_matrix_core matrix
      where snapshot.source_channel = 'makeshop'
        and matrix.makeshop_product_code = item.product_code
        and coalesce(matrix.makeshop_option_code, '') = item.option_code
        and not exists (select 1 from public.operations_hub_manual_links manual
                        where manual.source_channel = 'makeshop' and manual.sellpia_sku_code = matrix.sellpia_sku_code)
      union all
      select matrix.sellpia_sku_code
      from operations_private.operations_hub_matrix_core matrix
      where snapshot.source_channel = 'ably'
        and matrix.ably_product_code = item.product_code
        and coalesce(matrix.ably_option_code, '') = item.option_code
        and not exists (select 1 from public.operations_hub_manual_links manual
                        where manual.source_channel = 'ably' and manual.sellpia_sku_code = matrix.sellpia_sku_code)
    ) link
  ) linked on true
  order by page.match_rank, page.product_code, page.option_code;
$$;

revoke all on function public.search_operations_hub_seller_items_v3(text, text, integer, integer, text) from public;
grant execute on function public.search_operations_hub_seller_items_v3(text, text, integer, integer, text) to anon, authenticated;

notify pgrst, 'reload schema';
