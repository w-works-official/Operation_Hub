import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {after, before, test} from 'node:test';
import {chromium} from 'playwright';

const require = createRequire(import.meta.url);
const root = new URL('../', import.meta.url);
const modulePath = name => fileURLToPath(new URL(`mockups/operations-hub/${name}`, root));
const xlsxSource = await readFile(new URL('vendor/xlsx-0.18.5.full.min.js', import.meta.url), 'utf8');
const zipSource = await readFile(require.resolve('jszip/dist/jszip.min.js'), 'utf8');
let browser;

before(async () => {
  browser = await chromium.launch({headless:true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {})});
});
after(async () => { await browser?.close(); });

async function fixture(t) {
  const page = await browser.newPage();
  const networkRequests = [];
  const errors = [];
  await page.route('**/*', async route => {
    networkRequests.push(route.request().url());
    await route.abort();
  });
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => {
    assert.deepEqual(networkRequests, [], 'synthetic price tests must not request any live endpoint');
    assert.equal(await page.evaluate(() => window.purchaseAudit.networkAttempts), 0);
    assert.deepEqual(errors, []);
    await page.close();
  });
  await page.setContent('<!doctype html><title>Synthetic Matrix purchase price flow</title>');
  await page.evaluate(() => {
    window.purchaseAudit = {purchaseOverride:null, basePrice:80000, stock:9, calls:[], networkAttempts:0};
    const denyNetwork = () => {
      purchaseAudit.networkAttempts++;
      throw Error('Network forbidden in synthetic purchase price regression');
    };
    window.fetch = denyNetwork;
    window.XMLHttpRequest = class { constructor() { denyNetwork(); } };
    window.WebSocket = class { constructor() { denyNetwork(); } };
    window.EventSource = class { constructor() { denyNetwork(); } };
    // Production data-service code uses this in-memory transport only. The
    // save call below cannot contact Supabase or change any production data.
    const db = {
      async rpc(name, args) {
        purchaseAudit.calls.push({name, args:structuredClone(args)});
        if (name === 'save_operations_hub_sku_operational_value') {
          const field = {sellpia_purchase_price:'purchaseOverride', system_base_price:'basePrice', system_stock:'stock'}[args.p_field_key];
          if (!field) throw Error(`Unexpected synthetic save field ${args.p_field_key}`);
          purchaseAudit[field] = args.p_value;
          return {data:[{sellpia_sku_code:'SYNTHETIC-1', [args.p_field_key]:args.p_value}], error:null};
        }
        if (name === 'hub_sellpia_patch_read_v1') {
          return {data:{count:1, rows:[{
            sellpia_sku_code:'SYNTHETIC-1',
            sellpia_source_purchase_price:53500,
            sellpia_purchase_price:purchaseAudit.purchaseOverride ?? 53500,
            system_base_price:purchaseAudit.basePrice,
            system_stock:purchaseAudit.stock,
            sellpia_source_sale_price:67500
          }]}, error:null};
        }
        throw Error(`Unexpected synthetic RPC ${name}`);
      },
      from() { throw Error('Unexpected table access; snapshots must stay immutable'); }
    };
    window.supabase = {createClient:() => db};
    window.SystemV3SellerParsers = {};
    window.HubPriceWorkspaceEnabled = true;
  });
  await page.addScriptTag({content:xlsxSource});
  await page.addScriptTag({content:zipSource});
  for (const name of [
    'data-service.js', 'rule-registry.js', 'discount-price-math.js',
    'platform-rule-service.js', 'seller-export-adapter.js', 'current-price-export.js', 'tag-price-workspace.js'
  ]) await page.addScriptTag({path:modulePath(name)});
  await page.evaluate(() => {
    SystemV3Data.setOperationsHubSessionToken('synthetic-session');
    const sku = 'SYNTHETIC-1';
    const rules = [{
      id:'half', name:'Half', target_field:'actual_inbound_cost', source_field:'purchase_price',
      config:{steps:[{op:'divide', value:2}]}
    }, {
      id:'base', name:'Base2.2ceil500', target_field:'calculated_base_price', source_field:'actual_inbound_cost',
      config:{steps:[{op:'multiply', value:2.2}, {op:'round', unit:500, rounding:'up'}]}
    }].map(rule => ({...rule, scope:'', input_origin:'self', is_active:true, version:1}));
    window.purchaseRegistry = {
      rules,
      assignments:rules.map(rule => ({sku, rule_id:rule.id, target_field:rule.target_field, scope:'', version:1})),
      dependencies:[]
    };
    window.purchaseValues = product => {
      const evaluator = HubRuleRegistry.createEvaluator({...purchaseRegistry, products:{[sku]:product}});
      return {
        input:evaluator.evaluate(sku, 'purchase_price').value,
        actualInbound:evaluator.evaluate(sku, 'actual_inbound_cost').value,
        calculatedBase:evaluator.evaluate(sku, 'calculated_base_price').value
      };
    };
    window.readPurchaseProduct = async () => (await SystemV3Data.loadInternalFormulaProducts([sku], {legacySkus:[]}))[0];
    window.savePurchase = value => SystemV3Data.saveSellpiaChanges([{
      sku, fieldKey:'sellpia_purchase_price', before:purchaseAudit.purchaseOverride, after:value
    }]);
    window.purchaseExportSample = async () => {
      const product = await readPurchaseProduct();
      product.__sellerPriceComponents = {smartstore:{
        seller_product_code:'P-SYNTHETIC', seller_option_code:'A', source_discount_terms:[]
      }};
      const values = purchaseValues(product);
      const calculation = await HubPlatformRules.calculate([sku], 'smartstore', {
        registry:purchaseRegistry,
        config:{body:{source:'smartstore', mode:'forward', anchor:'lowest', registration_rule_id:null, discount_rule_id:null}},
        products:{[sku]:product}, siblings:[sku]
      });
      if (calculation.errors.length) throw Error(JSON.stringify(calculation.errors));
      const current = calculation.rows[0];
      const matrix = Array.from({length:3}, () => Array(112).fill(''));
      matrix[1][5] = 16000;
      matrix[1][15] = 'A';
      matrix[1][17] = '0';
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(matrix), 'Products');
      const originalBytes = XLSX.write(workbook, {type:'array', bookType:'xlsx'});
      const file = new File([originalBytes], 'synthetic-smartstore.xlsx');
      const carrier = [{
        product_code:'P-SYNTHETIC', option_code:'A', base_price:16000,
        discounted_base_price:16000, option_price:0, final_price:16000,
        discount_terms:[], source_row_no:2,
        raw_payload:{
          source_file_name:file.name,
          smartstore_basic_discount_value:null, smartstore_basic_discount_unit:null,
          smartstore_mobile_discount_value:null, smartstore_mobile_discount_unit:null,
          smartstore_reservation_discount_value:null, smartstore_reservation_discount_unit:null,
          smartstore_multi_buy_discount_value:null, smartstore_multi_buy_discount_unit:null
        }
      }];
      // Server SQL and the complete Matrix UI are outside this fixture. Its
      // current_effective_price projection is assembled from the real engine.
      const mapped = [{
        sku, product_code:'P-SYNTHETIC', option_code:'A', source_row_no:2,
        active_price_rule:true, current_effective_price:current
      }];
      const plan = HubCurrentPriceExport.prepareCarrierItems('smartstore', file.name, carrier, mapped, {
        includeStock:false, includePrice:true
      });
      if (plan.items.length !== 1) throw Error('Expected one synthetic current export item');
      const serialized = await SystemV3SellerExport.transformSellerFile(file, plan.items);
      if (serialized.skippedItems.length || serialized.appliedItems.length !== 1) throw Error('Serializer rejected synthetic plan');
      const reparsed = XLSX.read(await serialized.blob.arrayBuffer(), {type:'array', raw:true});
      const rows = XLSX.utils.sheet_to_json(reparsed.Sheets[reparsed.SheetNames[0]], {header:1, raw:true});
      const untouched = XLSX.read(await file.arrayBuffer(), {type:'array', raw:true});
      const originalRows = XLSX.utils.sheet_to_json(untouched.Sheets[untouched.SheetNames[0]], {header:1, raw:true});
      return {
        sourcePurchase:product.sellpia_source_purchase_price,
        matrixPurchase:product.sellpia_purchase_price,
        ...values,
        currentPlatformFinal:current.platformFinal,
        exportPlannedFinal:plan.items[0].target_final_price,
        xlsxBase:Number(rows[1][5]), xlsxOption:Number(rows[1][17]),
        xlsxFinal:Number(rows[1][5]) + Number(rows[1][17]),
        originalXlsxBase:Number(originalRows[1][5])
      };
    };
  });
  return page;
}

test('Matrix purchase save feeds assigned formula, current export target and real SmartStore XLSX without changing the original', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const before = await purchaseExportSample();
    await savePurchase(60000);
    const after = await purchaseExportSample();
    return {before, after, calls:purchaseAudit.calls};
  });
  assert.deepEqual(result.before, {
    sourcePurchase:53500, matrixPurchase:53500, input:53500,
    actualInbound:26750, calculatedBase:59000, currentPlatformFinal:59000,
    exportPlannedFinal:59000, xlsxBase:59000, xlsxOption:0, xlsxFinal:59000, originalXlsxBase:16000
  });
  assert.deepEqual(result.after, {
    sourcePurchase:53500, matrixPurchase:60000, input:60000,
    actualInbound:30000, calculatedBase:66000, currentPlatformFinal:66000,
    exportPlannedFinal:66000, xlsxBase:66000, xlsxOption:0, xlsxFinal:66000, originalXlsxBase:16000
  });
  assert.deepEqual(result.calls.map(call => call.name), [
    'hub_sellpia_patch_read_v1', 'save_operations_hub_sku_operational_value', 'hub_sellpia_patch_read_v1'
  ]);
  assert.equal(result.calls[1].args.p_field_key, 'sellpia_purchase_price');
  assert.equal(result.calls[1].args.p_value, 60000);
});

test('zero Matrix purchase is retained and clearing its override falls back to the immutable source', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    await savePurchase(0);
    const zero = await readPurchaseProduct();
    const zeroValues = purchaseValues(zero);
    await savePurchase(null);
    const cleared = await readPurchaseProduct();
    return {zero, zeroValues, cleared, clearedValues:purchaseValues(cleared)};
  });
  assert.equal(result.zero.sellpia_purchase_price, 0);
  assert.equal(result.zero.sellpia_source_purchase_price, 53500);
  assert.deepEqual(result.zeroValues, {input:0, actualInbound:0, calculatedBase:0});
  assert.equal(result.cleared.sellpia_purchase_price, 53500);
  assert.equal(result.cleared.sellpia_source_purchase_price, 53500);
  assert.deepEqual(result.clearedValues, {input:53500, actualInbound:26750, calculatedBase:59000});
});

test('purchase inputs prefer canonical Matrix values, then legacy inputs, then raw source values', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(() => {
    const inputs = [
      {sellpia_purchase_price:60000, purchase_price:53500, sellpia_source_purchase_price:53500},
      {sellpia_purchase_price:0, purchase_price:60000, sellpia_source_purchase_price:53500},
      {sellpia_purchase_price:null, purchase_price:60000, sellpia_source_purchase_price:53500},
      {sellpia_purchase_price:null, purchase_price:0, sellpia_source_purchase_price:53500},
      {sellpia_purchase_price:null, purchase_price:null, sellpia_source_purchase_price:53500},
      {sellpia_source_purchase_price:0}
    ];
    return inputs.map(product => ({selected:HubRuleRegistry.purchasePrice(product), evaluated:purchaseValues(product).input}));
  });
  assert.deepEqual(result, [60000, 0, 60000, 0, 53500, 0].map(value => ({selected:value, evaluated:value})));
});

test('purchase validation still rejects missing or invalid prices and leaves other operational fields independent', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const invalid = [{}, {sellpia_purchase_price:''}, {sellpia_purchase_price:false}, {sellpia_purchase_price:-1}, {sellpia_purchase_price:'invalid'}];
    const rejected = invalid.map(product => {
      try { purchaseValues({...product, sellpia_source_purchase_price:product.sellpia_source_purchase_price}); return false; }
      catch { return true; }
    });
    await SystemV3Data.saveSellpiaChanges([{sku:'SYNTHETIC-1', fieldKey:'system_stock', before:9, after:17}]);
    const product = await readPurchaseProduct();
    const evaluator = HubRuleRegistry.createEvaluator({products:{'SYNTHETIC-1':product}});
    return {rejected, purchase:purchaseValues(product), fields:{
      base:evaluator.evaluate('SYNTHETIC-1', 'calculated_base_price').value,
      stock:evaluator.evaluate('SYNTHETIC-1', 'system_stock').value,
      sourceBase:evaluator.evaluate('SYNTHETIC-1', 'source_base_price').value
    }};
  });
  assert.deepEqual(result.rejected, [true, true, true, true, true]);
  assert.deepEqual(result.purchase, {input:53500, actualInbound:26750, calculatedBase:59000});
  assert.deepEqual(result.fields, {base:80000, stock:17, sourceBase:67500});
});

test('legacy purchase-based tag formulas share the canonical override, zero and raw fallback semantics', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(() => {
    const formula = {enabled:true, basis:'purchase', multiplier:1.5, add:0, unit:1, rounding:'nearest'};
    return [60000, 0, null].map(value => TagPriceModel.calculate('SYNTHETIC-1', {
      'SYNTHETIC-1':{
        sellpia_purchase_price:value, sellpia_source_purchase_price:53500,
        __profile:{sku_tags:[{tag_id:'legacy-purchase'}]}
      }
    }, {'legacy-purchase':formula}, {}).value);
  });
  assert.deepEqual(result, [90000, 0, 80250]);
});
