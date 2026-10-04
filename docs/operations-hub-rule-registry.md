# Shared rule workspace

Price definitions live in `operations_private.hub_rules`; SKU assignments contain only a rule ID, stage, scope and version. Generic relationship edges remain separate from `hub_field_references`, which describe parent source field, child target field and assignment. Removing an assignment removes its field reference and preserves its generic relation.

Public `hub_rule_registry_v1` and `hub_rule_assign_v1` require the existing Operations Hub operator session. Private tables have RLS enabled and no direct client privileges. Assignment batches are atomic and request-ID idempotent. Same-slot conflicts, absent SKUs, self references, multiple parents and field graph cycles fail without partial writes. Different stages coexist.

`rule-registry.js` is the common evaluator. Source/reference selection is independent from ordered `config.steps`, including rounding. Explicit upstream assignments propagate through unassigned inbound/basis/base stages. Platform stages are scoped. `platform_option_input` and `platform_final_input` describe computed inputs; they cannot be assignment targets. `resolvedValues` supplies completed group stages to the shared evaluator. Reverse calculation selects the smallest nonnegative integer input reproducing the requested output through the forward operations.

`platform-rule-service.js` loads fresh registry, assignments, references, platform configuration and original data for each generation. Central platform settings store rule IDs in `registry-platform:<source>` work documents. Same-product options are expanded before anchoring; conflicting same-stage default and SKU rules fail. Option/final assignments use the common evaluator. Source-specific serialization emits Smartstore basic and Makeshop period discounts, preserving unrelated conditional discounts. Generated source files retain their original format: Smartstore/Makeshop XLSX and Ably seller CSV. Ably combination XLSX is a separate 35-column template.

Both the dedicated export and the existing queue export recalculate before file creation. Export history includes rule versions and actual emitted item snapshots. No rule approval/stale-release step or direct marketplace synchronization is added. Unmapped options affected by shared product price changes and ambiguous multiple-SKU mappings are rejected before writing.

The price page is one desktop workspace with registry/editor/preview, shared assignment drawer, dependency drawer/import, platform configuration and export. Existing app shell and density controls remain. Formula editing uses ordered operations and an independent input selector.

Combination documents preserve the row's seller code, Q connection, source row positions and original workbook bytes. The imported card and saved card share one editor/state. Save verifies DB `get` and `list` before leaving the editor. Incomplete Q can be saved as a draft; individual export requires resolvable Q and current stocks. Mixed-prefix automatic seller-code generation fails explicitly pending a real data rule; imported/manual codes remain unchanged.

## Validation

Run `node --test tests/operationsHubRuleRegistryEngine.test.mjs tests/operationsHubRuleRegistryDatabase.test.mjs` for evaluator and actual isolated PostgreSQL RPC tests (`@electric-sql/pglite` is needed for the latter). Browser tests use Playwright with Edge and pinned XLSX 0.18.5; set `XLSX_BROWSER_SCRIPT` if the local script is not at the default scratch path.

Focused browser/integration tests: `operationsHubAblyWorkspaceFlow.ui.test.mjs`, `operationsHubRegressionRuleWorkspace.ui.test.mjs`, `operationsHubRegressionFreshPlatformFlow.mock.test.mjs`, `operationsHubPlatformSerializedDiscount.ui.test.mjs`, `operationsHubRegressionXlsxRoundtrip.ui.test.mjs`.

Tests using fixture adapters establish local flow behavior, not production persistence. Live save/reopen and deployed-asset checks must be recorded separately.
