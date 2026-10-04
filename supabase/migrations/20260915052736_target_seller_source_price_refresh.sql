create or replace function public.operations_hub_seller_snapshot_price_affected_skus(
  p_snapshot_id uuid
)
returns text[]
language sql
stable
set statement_timeout = '60s'
set search_path = public, pg_temp
as $$
  with target as (
    select snapshot.snapshot_id, snapshot.source_channel, snapshot.selected_fields,
      nullif(snapshot.metadata ->> 'base_snapshot_id','')::uuid as base_snapshot_id
    from public.seller_inventory_snapshots snapshot
    where snapshot.snapshot_id = p_snapshot_id and snapshot.upload_status = 'ready'
  ), changed as (
    select target.source_channel, current_row.product_code, coalesce(current_row.option_code,'') as option_code
    from target
    join public.seller_inventory_snapshot_rows current_row on current_row.snapshot_id = target.snapshot_id
    left join public.seller_inventory_snapshot_rows base_row
      on base_row.snapshot_id = target.base_snapshot_id
     and base_row.product_code = current_row.product_code
     and coalesce(base_row.option_code,'') = coalesce(current_row.option_code,'')
    where (
      coalesce((target.selected_fields ->> 'price')::boolean,false)
      and (
        current_row.price is distinct from base_row.price
        or current_row.base_price is distinct from base_row.base_price
        or current_row.option_price is distinct from base_row.option_price
        or current_row.final_price is distinct from base_row.final_price
      )
    ) or (
      coalesce((target.selected_fields ->> 'discount')::boolean,false)
      and (
        current_row.discounted_base_price is distinct from base_row.discounted_base_price
        or current_row.reported_final_price is distinct from base_row.reported_final_price
        or current_row.discount_calculation_status is distinct from base_row.discount_calculation_status
        or current_row.discount_terms is distinct from base_row.discount_terms
        or current_row.source_discount_fingerprint is distinct from base_row.source_discount_fingerprint
      )
    )
  )
  select coalesce(array_agg(distinct component.sellpia_sku_code order by component.sellpia_sku_code),array[]::text[])
  from changed
  join public.operations_hub_listing_component_projection component
    on component.source_channel = changed.source_channel
   and component.product_code = changed.product_code
   and component.option_code = changed.option_code;
$$;

revoke all on function public.operations_hub_seller_snapshot_price_affected_skus(uuid) from public;
grant execute on function public.operations_hub_seller_snapshot_price_affected_skus(uuid) to anon, authenticated;

comment on function public.operations_hub_seller_snapshot_price_affected_skus(uuid) is
  'Returns mapped Sellpia SKUs only for seller price inputs changed from the snapshot base.';
