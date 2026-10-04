# Adapters

Adapters convert external names into the internal domain model.

Planned adapters:

- Supabase current DB adapter: `currentDbPickingAdapter.mjs`
- Workflow event read adapter: `workflowEventAdapter.mjs`
- Sellpia grid row adapter
- Sellpia memo updater adapter
- Label export adapter
- Product image storage adapter

## Operations Hub mapping writes

`operationsHubMappingAdapter.mjs` is the backend-only entry point for new
automatic, manual, or imported mapping jobs. Pass it a Supabase client created
with the service-role key; never bundle that client or key into the GitHub Pages
frontend.

The adapter validates and splits mappings into at most 500 rows, reuses one
request UUID across network retries, and calls
`apply_operations_hub_mapping_workflow`. The final chunk asks the database to
refresh the legacy matrix core only when a `review.*` mapping changed. Callers
that need restart-safe idempotency should provide a deterministic
`requestIdFactory` and persist those UUIDs with their job record.

The DB can stay unchanged while code uses stable internal names.

`workflowEventAdapter.mjs` intentionally does not start from the selected UI
date. It loads workflow events, derives the affected `order_group_no` values,
then hydrates original `orders` and `order_items` for shortage picking and
inspection queues.
