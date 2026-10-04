create index if not exists seller_inventory_snapshots_base_snapshot_idx
  on public.seller_inventory_snapshots(base_snapshot_id)
  where base_snapshot_id is not null;
