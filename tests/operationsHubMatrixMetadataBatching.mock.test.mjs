import assert from 'node:assert/strict';
import fs from 'node:fs';

const data = fs.readFileSync(new URL('../mockups/operations-hub/data-service.js', import.meta.url), 'utf8');

assert.match(data, /db\.rpc\(fullMatrixReadContext\?'load_operations_hub_matrix_metadata_batch_v1':'load_operations_hub_matrix_metadata_v1', \{p_skus:skus\}\)/, 'ordinary reads retain their bounded metadata RPC; full reads use the equivalent read wrapper');
assert.match(data, /const steps = \[[\s\S]*?attachInboundCostDetails[\s\S]*?attachSystemOperationalDetails[\s\S]*?attachProductLinkDrafts[\s\S]*?attachManualLinks[\s\S]*?attachProductProfiles[\s\S]*?attachLinkBadges[\s\S]*?attachSellerPriceComponents[\s\S]*?attachSellerDrafts[\s\S]*?attachPriceRuleAssignments[\s\S]*?attachLinkSuppressions/, 'the established metadata projection order must be preserved after bundling');
assert.match(data, /for \(const \[attach, prefetched\] of steps\)[\s\S]*?products = await attach\(products, signal, prefetched\)/, 'the bundled rows must pass through the existing projection logic');
assert.match(data, /async function attachManualLinks\(rows, signal, prefetched = null\)[\s\S]*?Array\.isArray\(prefetched\)[\s\S]*?operations_hub_manual_links/, 'projection helpers must retain their direct-query fallback for non-matrix callers');
assert.match(data, /attachPriceRuleAssignments, \{[\s\S]*?assignments:metadata\.price_rule_assignments[\s\S]*?ruleSets:metadata\.price_rule_sets/, 'price assignments and rule labels must remain paired');
assert.match(data, /\[attachLinkSuppressions, metadata\.link_suppressions\][\s\S]*?for \(const \[attach, prefetched\] of steps\)/, 'link suppression must remain the final projection so disconnected seller data cannot reappear');

console.log('operations hub matrix metadata batching contract tests passed');
