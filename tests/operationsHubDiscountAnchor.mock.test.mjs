import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../mockups/operations-hub/discount-price-math.js', import.meta.url), 'utf8');
const context = vm.createContext({console});
vm.runInContext(source, context);
const math = context.SystemV3DiscountPriceMath;

const smartAmount = [{term_key:'basic',unit:'amount',value:500,is_baseline:true,rounding_mode:'nearest',rounding_unit:1}];
const smartResult = math.grossBaseForTarget(3000, smartAmount);
assert.equal(smartResult.exact, true);
assert.equal(smartResult.basePrice, 3500);
assert.equal(smartResult.discountedPrice, 3000);

const noDiscount = math.grossBaseForTarget(3000, []);
assert.equal(noDiscount.exact, true);
assert.equal(noDiscount.basePrice, 3000);

const make10 = [{term_key:'period',unit:'percent',value:10,is_baseline:true,rounding_mode:'down',rounding_unit:10}];
const make10Result = math.grossBaseForTarget(3000, make10);
assert.equal(make10Result.exact, true);
assert.equal(make10Result.basePrice, 3334);
assert.equal(make10Result.discountedPrice, 3000);

const make20 = [{term_key:'period',unit:'percent',value:20,is_baseline:true,rounding_mode:'down',rounding_unit:100}];
const make20Result = math.grossBaseForTarget(3000, make20);
assert.equal(make20Result.exact, true);
assert.equal(make20Result.basePrice, 3750);
assert.equal(make20Result.discountedPrice, 3000);

const impossibleRoundedTarget = math.grossBaseForTarget(3050, make20);
assert.equal(impossibleRoundedTarget.exact, false);
assert.match(impossibleRoundedTarget.reason, /정확히 만들 수 없습니다/);

const conditionalOnly = [{term_key:'coupon',unit:'amount',value:900,is_baseline:false,rounding_mode:'nearest',rounding_unit:1}];
assert.equal(math.grossBaseForTarget(3000, conditionalOnly).basePrice, 3000);

console.log('Operations hub discount target-price anchoring: passed');
