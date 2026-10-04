-- Zero or negative prices are operational placeholders, not usable sale-price
-- anchors. Prefer the lowest positive effective price; retain deterministic SKU
-- fallback only when a group has no positive price at all.

create or replace function public.load_operations_hub_price_basis_v1(
  p_skus text[]
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
set statement_timeout = '5s'
as $$
declare
  v_skus text[];
begin
  select coalesce(array_agg(distinct btrim(item)), '{}'::text[])
  into v_skus
  from unnest(coalesce(p_skus, '{}'::text[])) item
  where nullif(btrim(item), '') is not null;

  if cardinality(v_skus) > 200 then
    raise exception '기준가격 조회는 한 번에 200개 SKU까지 가능합니다.';
  end if;
  if cardinality(v_skus) = 0 then
    return '[]'::jsonb;
  end if;

  return (
    with requested as (
      select
        cache.sellpia_sku_code,
        coalesce(
          nullif(btrim(cache.profile_json ->> 'sellpia_product_code'), ''),
          regexp_replace(cache.sellpia_sku_code, '-[0-9]+$', '')
        ) as sellpia_product_code
      from operations_private.operations_hub_matrix_export_cache cache
      where cache.sellpia_sku_code = any(v_skus)
    ),
    requested_groups as (
      select distinct requested.sellpia_product_code
      from requested
    ),
    candidates as (
      select
        cache.sellpia_sku_code,
        product_group.sellpia_product_code,
        coalesce(master.base_price, cache.sellpia_sale_price) as effective_price
      from operations_private.operations_hub_matrix_export_cache cache
      cross join lateral (
        values (coalesce(
          nullif(btrim(cache.profile_json ->> 'sellpia_product_code'), ''),
          regexp_replace(cache.sellpia_sku_code, '-[0-9]+$', '')
        ))
      ) product_group(sellpia_product_code)
      join requested_groups requested_group
        on requested_group.sellpia_product_code = product_group.sellpia_product_code
      left join public.operations_hub_sku_operational_master master
        on master.sellpia_sku_code = cache.sellpia_sku_code
    ),
    ranked as (
      select
        candidates.*,
        row_number() over (
          partition by candidates.sellpia_product_code
          order by (candidates.effective_price is null or candidates.effective_price <= 0) asc,
                   candidates.effective_price asc nulls last,
                   candidates.sellpia_sku_code collate "C" asc
        ) as price_rank,
        count(*) over (partition by candidates.sellpia_product_code) as candidate_count
      from candidates
    ),
    resolved as (
      select
        requested_group.sellpia_product_code,
        coalesce(manual_candidate.sellpia_sku_code, automatic.sellpia_sku_code) as basis_sku_code,
        coalesce(manual_candidate.effective_price, automatic.effective_price) as basis_price,
        case when manual_candidate.sellpia_sku_code is not null then 'manual' else 'auto_lowest' end as selection_mode,
        automatic.candidate_count,
        selection.updated_at
      from requested_groups requested_group
      join ranked automatic
        on automatic.sellpia_product_code = requested_group.sellpia_product_code
       and automatic.price_rank = 1
      left join operations_private.operations_hub_price_basis_selections selection
        on selection.sellpia_product_code = requested_group.sellpia_product_code
      left join ranked manual_candidate
        on manual_candidate.sellpia_product_code = selection.sellpia_product_code
       and manual_candidate.sellpia_sku_code = selection.basis_sku_code
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'sellpiaSkuCode', requested.sellpia_sku_code,
      'sellpiaProductCode', requested.sellpia_product_code,
      'basisSkuCode', resolved.basis_sku_code,
      'basisPrice', resolved.basis_price,
      'selectionMode', resolved.selection_mode,
      'candidateCount', resolved.candidate_count,
      'updatedAt', resolved.updated_at
    ) order by requested.sellpia_sku_code), '[]'::jsonb)
    from requested
    join resolved using (sellpia_product_code)
  );
end;
$$;

revoke all on function public.load_operations_hub_price_basis_v1(text[]) from public, anon, authenticated;
grant execute on function public.load_operations_hub_price_basis_v1(text[]) to anon, authenticated;

comment on function public.load_operations_hub_price_basis_v1(text[]) is
  'Returns one basis-price SKU per visible Sellpia product group. Manual overrides win; automatic mode chooses the lowest positive effective price before deterministic fallback.';
