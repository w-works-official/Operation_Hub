import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const inventorySource=fs.readFileSync(new URL('../mockups/operations-hub/sellpia-inventory-count.js',import.meta.url),'utf8');
const exportSource=fs.readFileSync(new URL('../mockups/operations-hub/current-price-export.js',import.meta.url),'utf8');
const context=vm.createContext({console,Date});context.globalThis=context;context.window=context;
context.SystemV3DiscountPriceMath={matrixVisibleValues:()=>({priceVisible:true,priceOrigin:'calculated',effectiveBasePrice:20000,effectiveDiscountedBasePrice:20000,effectiveOptionPrice:5000,effectiveFinalPrice:25000,effectiveDiscountTerms:[]})};
vm.runInContext(inventorySource,context,{filename:'sellpia-inventory-count.js'});
vm.runInContext(exportSource,context,{filename:'current-price-export.js'});
const api=context.HubCurrentPriceExport;

const carrier=[{product_code:'P1',option_code:'O1',source_row_no:2,stock:7,base_price:10000,discounted_base_price:10000,option_price:1000,final_price:11000,discount_terms:[],raw_payload:{source_file_name:'carrier.xlsx'}}];
function snapshot(overrides={}){
 return [{sku:'1000-1',product_code:'P1',option_code:'O1',seller_stock:7,source_stock:7,sellpia_current_stock:9,sellpia_available_stock:-3,active_price_rule:true,current_effective_price:{platformBase:20000,platformDiscount:20000,platformOption:5000,platformFinal:25000,platformTerms:[]},...overrides}];
}

test('available-stock projection preserves DB negative value but exports zero',()=>{
 assert.equal(context.SystemV3SellpiaInventoryCount.resolveExportStock(snapshot()[0],'available_stock'),0);
 assert.equal(snapshot()[0].sellpia_available_stock,-3);
 const plan=api.prepareCarrierItems('smartstore','carrier.xlsx',carrier,snapshot(),{includePrice:false,includeStock:true,stockSource:'available_stock'});
 assert.equal(plan.operations.length,1);
 assert.equal(plan.operations[0].field_key,'sellpia_current_stock');
 assert.equal(plan.operations[0].after_value,0);
 assert.equal(plan.preview[0].diff.stock.source_raw,-3);
 assert.equal(plan.preview[0].diff.stock.clamped_to_zero,true);
});

test('physical-stock projection does not clamp a negative value',()=>{
 const row=snapshot({sellpia_current_stock:-4,sellpia_available_stock:-3});
 assert.equal(context.SystemV3SellpiaInventoryCount.resolveExportStock(row[0],'stock'),-4);
 const plan=api.prepareCarrierItems('makeshop','carrier.xlsx',carrier,row,{includePrice:false,includeStock:true,stockSource:'stock'});
 assert.equal(plan.operations.length,1);
 assert.equal(plan.operations[0].after_value,-4);
 assert.equal(plan.preview[0].diff.stock.source_raw,-4);
 assert.equal(plan.preview[0].diff.stock.clamped_to_zero,false);
});

test('stock-only plan emits no price operation even when an active Rule would change price',()=>{
 const plan=api.prepareCarrierItems('makeshop','carrier.xlsx',carrier,snapshot(),{includePrice:false,includeStock:true,stockSource:'stock'});
 assert.deepEqual(Array.from(plan.operations,item=>item.field_key),['sellpia_current_stock']);
 assert.equal(plan.preview[0].diff.price.changed,false);
 assert.deepEqual(JSON.parse(JSON.stringify(plan.preview[0].diff.price.before)),JSON.parse(JSON.stringify(plan.preview[0].diff.price.after)));
 assert.equal(plan.include_price,false);
 assert.equal(plan.stock_source,'stock');
});

test('price-only plan changes price fields and preserves seller stock',()=>{
 const plan=api.prepareCarrierItems('smartstore','carrier.xlsx',carrier,snapshot({seller_stock:9}),{includePrice:true,includeStock:false});
 assert.deepEqual(Array.from(plan.operations,item=>item.field_key),['sellpia_sale_price']);
 assert.equal(plan.include_price,true);
 assert.equal(plan.include_stock,false);
 assert.equal(plan.preview[0].diff.stock.changed,false);
 assert.equal(plan.preview[0].diff.stock.after,carrier[0].stock);
});

test('price plus stock legacy mode emits only the two selected field families',()=>{
 const plan=api.prepareCarrierItems('makeshop','carrier.xlsx',carrier,snapshot({seller_stock:9}),{includePrice:true,includeStock:true});
 assert.deepEqual(new Set(Array.from(plan.operations,item=>item.field_key)),new Set(['sellpia_current_stock','sellpia_sale_price']));
 assert.equal(plan.include_price,true);
 assert.equal(plan.include_stock,true);
});

test('stock source participates in the preview/generate version token',()=>{
 const row=snapshot({sellpia_current_stock:0,sellpia_available_stock:0});
 const physical=api.prepareCarrierItems('smartstore','carrier.xlsx',carrier,row,{includePrice:false,includeStock:true,stockSource:'stock'});
 const available=api.prepareCarrierItems('smartstore','carrier.xlsx',carrier,row,{includePrice:false,includeStock:true,stockSource:'available_stock'});
 assert.notEqual(physical.version_token,available.version_token);
});

test('legacy call remains legacy-compatible when no explicit stock source is supplied',()=>{
 const plan=api.prepareCarrierItems('smartstore','carrier.xlsx',carrier,snapshot({seller_stock:8}),{includePrice:false,includeStock:true});
 assert.equal(plan.operations[0].after_value,8,'legacy seller/source stock fallback remains unchanged');
 assert.equal(plan.stock_source,null);
});

console.log('operations hub stock-only export projection tests passed');
