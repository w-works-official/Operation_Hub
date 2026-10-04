# Operations Hub relation groups V1

## Scope

This change introduces an additive relation-management model. It must not change
existing seller mappings, inventory calculations, price rules, drafts, exports,
or marketplace values.

## Ownership boundaries

- `operations_hub_relation_folders`: user-managed visual organization only.
- `operations_hub_relation_groups`: one named relation context such as a
  collection, exhibition, set, 1+1 group, or custom group.
- `operations_hub_relation_nodes`: reusable global identities. A node does not
  own a folder or a single business meaning in V1.
- `operations_hub_relation_group_memberships`: many-to-many membership between
  relation groups and reusable nodes.
- `operations_hub_relation_group_edges`: typed, display/search-only edges inside
  one group.
- `operations_hub_seller_listings` and
  `operations_hub_listing_components`: authoritative seller-listing mapping and
  existing listing-level BOM. V1 does not replace or update them.
- Price, inbound-cost, inventory, queue, and export tables are read-only from
  the perspective of relation-groups V1.

## Invariants

1. One SKU node may belong to multiple groups and folders through group
   membership.
2. A group edge may only connect active members of the same active group.
3. Self edges and directed cycles are rejected.
4. Relation-group writes are soft-state changes with audit events.
5. Batch writes are bounded and idempotent by request ID and payload hash.
6. Generic relation-group edges do not contain component quantity and never
   drive price or inventory calculations.
7. Existing relation nodes/edges remain readable during the additive rollout.

## Rollout gates

1. Add the schema and contract tests without changing existing reads.
2. Exercise only fixtures or isolated test records.
3. Add UI reads behind an explicit feature flag.
4. Compare old and new relation context in shadow mode.
5. Request approval before applying a migration to the linked Supabase project,
   backfilling production data, or deploying GitHub Pages.

## Baseline

- Local branch at design start: `feat/inline-price-tag-composer-20260820`.
- Local commit at design start: `19e06c380f999b191f9096fa91738cbddbefb57b`.
- Remote `main` at design start: `46a8d1eb16a5a1ba3832ff32bd6d37abbcd65737`.
- The live GitHub Pages Operations Hub asset did not byte-match the local
  `mockups/operations-hub/app.js`; deployment parity must be rechecked before
  release.
- The linked Supabase migration state was not queried because this checkout has
  no local project link/configuration. No remote schema change was attempted.
