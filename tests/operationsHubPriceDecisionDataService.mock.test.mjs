import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../mockups/operations-hub/data-service.js', import.meta.url), 'utf8');

function createService(rpcHandler) {
  const calls = [];
  const db = {
    rpc(name, args) {
      calls.push({ name, args });
      return Promise.resolve(rpcHandler(name, args, calls.length - 1));
    },
    from() { throw new Error('Unexpected table query in this test'); }
  };
  const win = {
    supabase: { createClient: () => db },
    SystemV3SellerParsers: {},
    crypto: { randomUUID: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    CustomEvent: class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    dispatchEvent() {},
    fetch: async () => { throw new Error('Unexpected fetch in this test'); }
  };
  const context = vm.createContext({
    window: win,
    URL,
    TextEncoder,
    TextDecoder,
    CustomEvent: win.CustomEvent,
    AbortController,
    AbortSignal,
    Blob,
    File: globalThis.File,
    performance,
    crypto: win.crypto,
    console,
    setTimeout,
    clearTimeout,
    structuredClone,
    Buffer
  });
  vm.runInContext(source, context, { filename: 'data-service.js' });
  win.SystemV3Data.setOperationsHubSessionToken('test-session');
  return { api: win.SystemV3Data, calls };
}

function target(sku, option, final) {
  return {
    sku,
    member_skus: [sku],
    seller_option_code: `OPT-${sku}`,
    price: { base: 10000, discounted: 9000, option, final, terms: [] },
    current_state: { price: { base: 10000, discounted: 9000, option, final, terms: [] } }
  };
}

function priceContext() {
  return {
    rows: [],
    groups: [{
      seller_product_code: 'PRODUCT-1',
      revision: 7,
      mapping_fingerprint: 'mapping-v7',
      input_fingerprints: { SKU1: 'fp-1', SKU2: 'fp-2' },
      snapshot_id: 'snapshot-1',
      sellpia_snapshot_id: 'sellpia-snapshot-1',
      targets: [target('SKU1', 0, 9000), target('SKU2', 500, 9500)]
    }]
  };
}

test('manual Matrix save uses one atomic price-decision RPC and keeps returned decision metadata', async () => {
  let applyBody;
  const { api, calls } = createService((name, args) => {
    if (name !== 'hub_price_decision_apply_v1') return { data: null, error: new Error(`Unexpected RPC ${name}`) };
    applyBody = args.p_body;
    return { data: {
      request_id: args.p_request_id,
      rows: [{ sku: 'SKU1', source_channel: 'smartstore', revision: 8, decision_source: 'matrix_manual', base: 10500 }],
      items: [{ sku: 'SKU1', result: { final: 10500, status: 'accepted' } }]
    }, error: null };
  });

  const result = await api.saveSellerPriceDraft({
    sku: 'SKU1', source: 'smartstore', targetBasePrice: 10500, inputMode: 'option', optionPrice: 0,
    basePriceSource: 'manual', decisionContext: priceContext(), requestId: 'manual-request'
  });

  assert.equal(calls.length, 1, 'the wrapper performs one single-transaction apply call');
  assert.equal(calls[0].name, 'hub_price_decision_apply_v1');
  assert.equal(calls.some(call => /save_operations_hub_seller_.*draft/.test(call.name)), false);
  assert.equal(applyBody.decision_source, 'matrix_manual');
  assert.equal(applyBody.groups.length, 1);
  assert.equal(applyBody.groups[0].expected_revision, 7);
  assert.equal(applyBody.groups[0].targets.length, 2, 'group context retains all options');
  assert.equal(applyBody.manual_actions.length, 2, 'a manual product base is expanded to every option');
  assert.equal(applyBody.manual_actions.every(action => action.target_base_price === 10500), true);
  assert.equal(result.final, 10500, 'legacy wrapper return value remains the item result');
  assert.equal(result.decision.revision, 8, 'apply metadata is attached to the legacy result shape');
  assert.deepEqual(Array.from(result.affected_skus), ['SKU1']);
});

test('group base draft returns its legacy shape and sends every option in one atomic group', async () => {
  let applyBody;
  const { api, calls } = createService((name, args) => {
    if (name !== 'hub_price_decision_apply_v1') return { data: null, error: new Error(`Unexpected RPC ${name}`) };
    applyBody = args.p_body;
    return { data: {
      request_id: args.p_request_id,
      rows: [
        { sku: 'SKU1', revision: 8, decision_source: 'matrix_manual' },
        { sku: 'SKU2', revision: 8, decision_source: 'matrix_manual' }
      ],
      items: [
        { sku: 'SKU1', result: { final: 12500, status: 'accepted' } },
        { sku: 'SKU2', result: { final: 13000, status: 'accepted' } }
      ]
    }, error: null };
  });

  const result = await api.saveSellerProductBaseDrafts({
    source: 'smartstore', productCode: 'PRODUCT-1', targetBasePrice: 12500,
    decisionContext: priceContext(), requestId: 'group-base-request'
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'hub_price_decision_apply_v1');
  assert.equal(applyBody.groups.length, 1);
  assert.equal(applyBody.groups[0].seller_product_code, 'PRODUCT-1');
  assert.equal(applyBody.groups[0].targets.length, 2);
  assert.equal(applyBody.manual_actions.length, 2);
  assert.deepEqual(Array.from(applyBody.manual_actions, action => action.sku), ['SKU1', 'SKU2']);
  assert.equal(result.source, 'smartstore');
  assert.equal(result.productCode, 'PRODUCT-1');
  assert.equal(result.savedCount, 2);
  assert.equal(result.atomic, undefined, 'preserves this wrapper’s pre-existing return contract');
  assert.equal(result.items[0].result.decision.revision, 8);
});

test('targeted Matrix rows attach current decisions in bounded 2000-SKU reads without history scans', async () => {
  const seenBatchSizes = [];
  const { api, calls } = createService((name, args) => {
    if (name === 'hub_matrix_grid_rows_v5') {
      const skus = args.p_skus;
      return { data: {
        contract_version: 5, requested: skus.length, loaded: skus.length,
        dataset_version: 'matrix-v1', rows: skus.map(sku => [sku]), missing_skus: [], link_badges: []
      }, error: null };
    }
    if (name === 'hub_price_decision_matrix_read_v1') {
      seenBatchSizes.push(args.p_skus.length);
      return { data: { rows: args.p_skus.map(sku => ({
        sku, source_channel: 'smartstore', seller_product_code: 'PRODUCT-1', revision: 12,
        decision_source: 'pricing_rule', base: 20000, discounted: 18900, option: 0, final: 18900
      })) }, error: null };
    }
    return { data: null, error: new Error(`Unexpected RPC ${name}`) };
  });

  const skus = Array.from({ length: 2001 }, (_, index) => `SKU${index + 1}`);
  const rows = await api.loadMatrixGridRowsBySkus(skus);
  assert.equal(rows.length, 2001);
  assert.deepEqual(seenBatchSizes, [2000, 1]);
  assert.equal(rows[0].__priceDecisions.smartstore[0].final, 18900);
  assert.equal(calls.some(call => call.name === 'hub_price_decision_history_v1'), false);
  assert.equal(calls.filter(call => call.name === 'hub_price_decision_matrix_read_v1').length, 2);
});
