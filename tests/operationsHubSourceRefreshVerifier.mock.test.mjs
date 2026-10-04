import test from 'node:test';
import assert from 'node:assert/strict';

await import(new URL('../mockups/operations-hub/source-refresh-verifier.js', import.meta.url));
const verifier = globalThis.SystemV3SourceRefreshVerifier;

test('source refresh verifier accepts system, seller stock, and price values only after reread', () => {
  const rows = [{
    sellpia_sku_code:'100-1',
    system_stock:5,
    smartstore_stock:3,
    __sellerDrafts:{
      'smartstore:sellpia_current_stock':{after_value:7}
    },
    __sellerPriceComponents:{
      smartstore:{source_base_price:1000,draft_base_price:1200,source_option_price:0,source_final_price:1000}
    }
  }];
  const result = verifier.verifySourceRefreshTargets([
    {kind:'system',sku:'100-1',fieldKey:'system_stock',after:'5'},
    {kind:'seller_stock',sku:'100-1',source:'smartstore',fieldKey:'sellpia_current_stock',after:'7'},
    {kind:'seller_price',sku:'100-1',source:'smartstore',fieldKey:'sellpia_sale_price',priceComponent:'base',after:'1200'}
  ], rows);
  assert.equal(result.verifiedCount, 3);
  assert.deepEqual(result.failures, []);
});

test('source refresh verifier compares discount terms independent of object and row ordering', () => {
  const sourceTerms = [
    {term_key:'mobile',value:10,unit:'percent'},
    {term_key:'basic',value:500,unit:'amount'}
  ];
  const rows = [{
    sellpia_sku_code:'200-1',
    __sellerPriceComponents:{smartstore:{source_discount_terms:sourceTerms}},
    __sellerDrafts:{
      'smartstore:sellpia_sale_price':{
        price_discount_terms_after:[
          {unit:'amount',value:500,term_key:'basic'},
          {value:10,term_key:'mobile',unit:'percent'}
        ]
      }
    }
  }];
  const result = verifier.verifySourceRefreshTargets([{
    kind:'seller_discount',sku:'200-1',source:'smartstore',fieldKey:'sellpia_sale_price',sourceTerms
  }], rows);
  assert.equal(result.verifiedCount, 1);
  assert.deepEqual(result.failures, []);
});

test('source refresh verifier reports missing rows and mismatched reread values', () => {
  const result = verifier.verifySourceRefreshTargets([
    {kind:'system',sku:'missing-1',fieldKey:'system_stock',after:'5'},
    {kind:'seller_price',sku:'300-1',source:'makeshop',fieldKey:'sellpia_sale_price',priceComponent:'final',after:'5000'}
  ], [{
    sellpia_sku_code:'300-1',
    __sellerPriceComponents:{makeshop:{source_final_price:4500}}
  }]);
  assert.equal(result.verifiedCount, 0);
  assert.deepEqual(result.failures.map(item => item.reason), ['missing_sku','value_mismatch']);
});

test('grouped targets are deduplicated by SKU and component before counting success', () => {
  const target = {kind:'seller_price',sku:'400-1',source:'smartstore',fieldKey:'sellpia_sale_price',priceComponent:'base',after:'9000'};
  const rows = [{
    sellpia_sku_code:'400-1',
    __sellerPriceComponents:{smartstore:{source_base_price:9000}}
  }];
  const result = verifier.verifySourceRefreshTargets([target, {...target}], rows);
  assert.equal(result.requestedCount, 1);
  assert.equal(result.verifiedCount, 1);
});
