-- The browser Data API applies an interactive statement timeout unless the
-- function defines its own bounded timeout. A 23k-row Sellpia patch merge was
-- finishing all row inserts but being cancelled during this final merge.
alter function public.finalize_operations_hub_sellpia_patch(uuid, jsonb)
  set statement_timeout = '60s';

alter function public.finalize_operations_hub_sellpia_patch(uuid, jsonb)
  set lock_timeout = '3s';

create or replace function public.operations_hub_sellpia_patch_price_affected_skus(
  p_patch_snapshot_id uuid,
  p_selected_fields jsonb default '{}'::jsonb
)
returns text[]
language sql
stable
set statement_timeout = '60s'
set search_path = public, pg_temp
as $$
  with patch as (
    select snapshot_id, created_at
    from public.sellpia_stock_snapshots
    where snapshot_id = p_patch_snapshot_id
      and upload_status = 'uploading'
  ), base as (
    select snapshot.snapshot_id
    from public.sellpia_stock_snapshots snapshot
    cross join patch
    where snapshot.upload_status = 'ready'
      and snapshot.snapshot_id <> patch.snapshot_id
      and snapshot.created_at < patch.created_at
    order by snapshot.created_at desc
    limit 1
  )
  select coalesce(array_agg(patch_row.sellpia_sku_code order by patch_row.sellpia_sku_code), array[]::text[])
  from patch
  cross join base
  join public.sellpia_stock_snapshot_rows patch_row on patch_row.snapshot_id = patch.snapshot_id
  left join public.sellpia_stock_snapshot_rows base_row
    on base_row.snapshot_id = base.snapshot_id
   and base_row.sellpia_sku_code = patch_row.sellpia_sku_code
  where (
    coalesce((p_selected_fields ->> 'basePrice')::boolean,(p_selected_fields ->> 'price')::boolean,false)
    and (
      patch_row.raw_payload -> 'base_price' is distinct from base_row.raw_payload -> 'base_price'
      or patch_row.raw_payload -> 'sell_price' is distinct from base_row.raw_payload -> 'sell_price'
    )
  ) or (
    coalesce((p_selected_fields ->> 'purchasePrice')::boolean,(p_selected_fields ->> 'price')::boolean,false)
    and (
      patch_row.purchase_price is distinct from base_row.purchase_price
      or patch_row.raw_payload -> 'commission' is distinct from base_row.raw_payload -> 'commission'
      or patch_row.raw_payload -> 'purchase_vat' is distinct from base_row.raw_payload -> 'purchase_vat'
    )
  );
$$;

revoke all on function public.operations_hub_sellpia_patch_price_affected_skus(uuid, jsonb) from public;
grant execute on function public.operations_hub_sellpia_patch_price_affected_skus(uuid, jsonb) to anon, authenticated;

comment on function public.finalize_operations_hub_sellpia_patch(uuid, jsonb) is
  'Merges a validated Sellpia patch into the latest ready snapshot. Uses a bounded 60s Data API timeout for full-catalog merges.';

comment on function public.operations_hub_sellpia_patch_price_affected_skus(uuid, jsonb) is
  'Returns only Sellpia SKUs whose selected price inputs differ from the preceding ready snapshot.';
