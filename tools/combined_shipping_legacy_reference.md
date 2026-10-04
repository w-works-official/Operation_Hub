# Legacy combined-shipping preview reference

The paused, display-only preview is intentionally preserved unchanged in the
separate local worktree:

`C:\Users\hihi0\Documents\Codex\System_V3\tools\combined_shipping_front_mock.html`

Its hard-coded `combinedPreview=1` implementation is not copied into the live
application. The following ideas were extracted into the persistent feature:

- one package card containing multiple original orders;
- a visible member strip and representative-invoice choice;
- per-item source order/invoice identity;
- release back to the original order cards;
- an explicit Sellpia synchronization status.

The replacement implementation lives in:

- `src/domain/shipmentGroups.mjs` for pure grouping and identity preservation;
- `src/adapters/shipmentGroupAdapter.mjs` for Supabase reads/RPC calls;
- `supabase/migrations/20260811132803_create_shipment_groups.sql` for durable
  membership, audit events, and atomic create/change/release operations.

Do not revive the legacy hard-coded customer/order constants in
`src/app/pickingApp.mjs`.
