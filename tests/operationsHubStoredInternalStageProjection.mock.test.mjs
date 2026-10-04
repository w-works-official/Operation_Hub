import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('../mockups/operations-hub/data-service.js',import.meta.url),'utf8');

assert.match(source,/fields:\['actual_inbound_cost','basis_sku_price','calculated_base_price'\]/,'matrix projection must load every persisted internal calculation stage');
assert.match(source,/internalBySku\.get\(sku\)\[stored\.field\]/,'internal results must be grouped by SKU and field instead of overwriting one another');
assert.match(source,/generationId:stored\.generation_id,calculatedAt:stored\.calculated_at/,'projection keeps the generation identity needed to distinguish stale internal results');
assert.doesNotMatch(source,/assigned_tag_ids/,'the existing calculation-results RPC only permits discount_terms in result_details');
assert.match(source,/if\(!formulaTags\.length\)delete projected\.actual_inbound_cost/,'a removed formula tag must not leave its stored actual-inbound result visible');
assert.match(source,/formulaTags=profileTags\.filter\(tag=>cleanText\(tag\?\.tag_group\)\.includes\('수식'\)\)/,'legacy stage rows are shown only while a formula tag is still assigned');

console.log('PASS stored internal stage projection: derived stages retain generation identity, remain RPC-compatible, and hide actual-inbound results after formula-tag removal.');
