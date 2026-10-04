import test from 'node:test';
import assert from 'node:assert/strict';

await import('../mockups/operations-hub/rule-registry.js');
globalThis.SystemV3Data={};
await import('../mockups/operations-hub/platform-rule-service.js');

const makeshopRule=code=>({id:'discount-'+code,tag_id:'tag-'+code,name:'메이크샵 '+code,version:1,is_active:true,target_field:'platform_discount_price',scope:'makeshop',input_origin:'self',source_field:'platform_registration_price',source_scope:'makeshop',config:HubRuleRegistry.makeshopDiscountConfig(code)});

test('legacy 판매가 is labeled as 셀피아 기준가격',()=>{
 assert.equal(HubRuleRegistry.fields.source_base_price,'셀피아 기준가격');
});

test('Makeshop code catalog produces the exact percentage and truncation steps',()=>{
 assert.deepEqual(HubRuleRegistry.makeshopDiscountConfig('NONE').steps,[]);
 assert.deepEqual(HubRuleRegistry.makeshopDiscountConfig('M10').steps,[{op:'multiply',value:.9},{op:'round',unit:10,rounding:'down'}]);
 assert.deepEqual(HubRuleRegistry.makeshopDiscountConfig('M15').steps,[{op:'multiply',value:.85},{op:'round',unit:10,rounding:'down'}]);
 assert.deepEqual(HubRuleRegistry.makeshopDiscountConfig('M20').steps,[{op:'multiply',value:.8},{op:'round',unit:100,rounding:'down'}]);
 assert.throws(()=>HubRuleRegistry.validateRule({...makeshopRule('M10'),config:{steps:[{op:'subtract',value:1000}]}}),/할인코드/);
 assert.throws(()=>HubRuleRegistry.validateRule({...makeshopRule('M10'),scope:'',source_scope:''}),/판매처/);
});

test('Makeshop formula result keeps rule_code in the stored/exported discount terms',async()=>{
 const discount=makeshopRule('M15'),registry={rules:[discount],assignments:[],dependencies:[]};
 const product={sellpia_sku_code:'SKU1',calculated_base_price:12345,system_base_price:12345,__sellerPriceComponents:{makeshop:{seller_product_code:'P1',seller_option_code:'O1',source_discount_terms:[]}}};
 const result=await HubPlatformRules.calculate(['SKU1'],'makeshop',{registry,config:{body:{source:'makeshop',mode:'forward',anchor:'lowest',registration_rule_id:null,discount_rule_id:discount.id}},siblings:[],products:{SKU1:product}});
 assert.equal(result.errors.length,0);
 assert.equal(result.rows[0].platformBase,12345);
 assert.equal(result.rows[0].platformFinal,10490);
 assert.deepEqual(result.rows[0].platformTerms,[{term_key:'period',term_type:'period',title:'메이크샵 M15',rule_code:'M15',input_source:'formula_tag',unit:'percent',value:15,is_baseline:true,rounding_mode:'down',rounding_unit:10}]);
});
