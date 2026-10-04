-- Journal access is exclusively through verified operator RPCs.
-- Explicit deny policies document the closed direct-table boundary.
create policy inventory_actions_deny_direct on operations_private.inventory_actions
 for all to anon,authenticated using (false) with check (false);
create policy inventory_movements_deny_direct on operations_private.inventory_movements
 for all to anon,authenticated using (false) with check (false);
