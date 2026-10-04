import assert from 'node:assert/strict';
await import('../mockups/operations-hub/rule-registry.js');
await import('../mockups/operations-hub/discount-price-math.js');
await import('../mockups/operations-hub/platform-rule-service.js');
await import('../mockups/operations-hub/seller-export-adapter.js');
const actualDiscountFingerprint=globalThis.SystemV3SellerExport.discountTermsFingerprint;

// Cross-module integration against an explicit in-memory adapter, not live persistence proof.
const clone = value => structuredClone(value);
const rule = (id, target, source, steps, extra={}) => ({id, name:id, version:1, is_active:true, target_field:target, source_field:source, input_origin:'self', scope:'', config:{steps,unit:1,rounding:'nearest'}, ...extra});
const registry = {
  rules:[
    rule('inbound','actual_inbound_cost','purchase_price',[{op:'multiply',value:1}]),
    rule('basis','calculated_base_price','actual_inbound_cost',[{op:'multiply',value:3}]),
    rule('child','calculated_base_price','calculated_base_price',[{op:'add',value:2000}],{input_origin:'parent'}),
    rule('register','platform_registration_price','calculated_base_price',[{op:'add',value:2000}],{scope:'ably'}),
    rule('discount','platform_discount_price','platform_registration_price',[{op:'subtract',value:2000}],{scope:'ably'}),
  ],
  assignments:[
    {sku:'six',target_field:'actual_inbound_cost',scope:'',rule_id:'inbound',version:1},
    {sku:'six',target_field:'calculated_base_price',scope:'',rule_id:'basis',version:1},
    {sku:'eight',target_field:'calculated_base_price',scope:'',rule_id:'child',version:1},
  ],
  dependencies:[{child_sku:'eight',parent_sku:'six',target_field:'calculated_base_price',source_field:'calculated_base_price',scope:'',rule_id:'child',relation_valid:true}],
};
const platform = {id:'platform-config',version:4,title:'registry-platform:ably',body:{source:'ably',mode:'forward',anchor:'lowest',registration_rule_id:'register',discount_rule_id:'discount'}};
let purchase=5000, productLoads=0, registryLoads=0, latestLoads=0, omitSibling=false, omitOriginal=false, includeHigh=false;
const calls=[], logs=[], exports=[];
globalThis.SystemV3Data = {
  ruleRegistry:async action => {assert.equal(action,'list');registryLoads++;calls.push('registry');return clone(registry);},
  workDocument:async (action,kind,payload) => {
    assert.equal(kind,'formula');
    if(action==='get_title'){assert.equal(payload.title,platform.title);return clone(platform);}
    assert.equal(action,'save');logs.push(clone(payload));return {...payload,version:1};
  },
  loadRulePlatformSiblings:async (skus,source) => {assert.equal(source,'ably');calls.push('siblings');return ['six','eight',...(includeHigh?['high']:[])];},
  loadFormulaProducts:async skus => {
    productLoads++;calls.push('products');
    const products=[{sellpia_sku_code:'six',sellpia_source_purchase_price:purchase},{sellpia_sku_code:'eight',sellpia_source_purchase_price:purchase}];
    if(includeHigh)products.push({sellpia_sku_code:'high',sellpia_source_purchase_price:purchase});
    return products.filter(p => skus.includes(p.sellpia_sku_code)&&(!omitSibling||p.sellpia_sku_code!=='eight')).map(p => ({...p,__sellerPriceComponents:{ably:{seller_product_code:'same-product',seller_option_code:p.sellpia_sku_code,source_discount_terms:[]}}}));
  },
  downloadLatestSellerOriginals:async sources => {assert.deepEqual(sources,['ably']);latestLoads++;calls.push('latest-original');return new Map([['ably',[{name:'latest.xlsx',generation:latestLoads}]]]);},
};
globalThis.SystemV3SellerParsers = {parseSellerFiles:async (source,files) => {
  calls.push('parse-original');assert.equal(files[0].generation,latestLoads);
  return {normalizedRows:['six','eight'].filter(sku => !omitOriginal||sku!=='eight').map((sku,index) => ({product_code:'same-product',option_code:sku,final_price:9000+index,base_price:9000,option_price:index,discount_terms:[],source_row_no:index+2,raw_payload:{source_file_name:'latest.xlsx'}}))};
}};
globalThis.SystemV3SellerExport = {discountTermsFingerprint:actualDiscountFingerprint,buildExportArchive:async (files,items) => {
  calls.push('export');assert.equal(files.get('ably')[0].generation,latestLoads);exports.push(clone(items));return {blob:new Blob(['fixture']),manifest:{items:items.length},skippedItems:[],appliedItems:clone(items)};
}};
const api=globalThis.HubPlatformRules;
const first=await api.calculate(['eight'],'ably');
assert.deepEqual(first.errors,[]);
assert.deepEqual(first.rows.map(r=>[r.sku,r.value,r.platformFinal]),[['eight',17000,17000],['six',15000,15000]]);
assert.equal(first.rows.length,2,'single selected option must include other options of same seller product');
assert.equal(first.rows.find(r=>r.sku==='eight').platformOption,2000);
assert.deepEqual(first.rows.find(r=>r.sku==='eight').trace.map(t=>t.field),['purchase_price','actual_inbound_cost','calculated_base_price','calculated_base_price']);
assert.equal(logs.length,0,'calculation alone must not save');

const percentRegistry=clone(registry);
percentRegistry.rules.find(r=>r.id==='discount').config.steps=[{op:'multiply',value:0.9}];
const percentSettings={...platform.body,registration_rule_id:null};
assert.deepEqual(api.compose([{sku:'six',value:15000},{sku:'eight',value:17000}],percentSettings,percentRegistry).map(r=>r.platformFinal),[13500,15500]);
assert.deepEqual(api.compose([{sku:'six',value:15000},{sku:'eight',value:17000}],{...percentSettings,mode:'reverse'},percentRegistry).map(r=>r.platformFinal),[15000,17000]);
const middle=api.compose([{sku:'high',value:19000},{sku:'low',value:15000},{sku:'mid',value:17000}],{...platform.body,anchor:'middle',registration_rule_id:null,discount_rule_id:null},registry);
assert.deepEqual(middle.map(r=>[r.platformBase,r.platformOption,r.platformFinal]),[[17000,2000,19000],[17000,-2000,15000],[17000,0,17000]],'middle uses sorted option price while preserving original row order');

purchase=6000;
const second=await api.calculate(['eight'],'ably');
assert.deepEqual(second.rows.map(r=>r.platformFinal),[20000,18000],'changed source read must flow through parent and child');
registry.rules.find(r=>r.id==='basis').config.steps[0].value=4;
registry.rules.find(r=>r.id==='basis').version=2;
const output=await api.exportLatest(['eight'],'ably');
assert.deepEqual(output.calculation.rows.map(r=>r.platformFinal),[26000,24000],'export reads newest rule rather than earlier preview');
assert.deepEqual(exports[0].map(r=>r.after_value),[26000,24000]);
assert.equal(exports[0][0].target_base_price,26000);
assert.equal(exports[0][0].target_option_price,2000);
assert.equal(exports[0][0].source_file_name,'latest.xlsx');
assert.equal(logs.length,1);
assert.equal(logs[0].body.rule_versions.find(r=>r.id==='basis').version,2);
assert.equal(logs[0].body.platform_version,4);
assert.equal(logs[0].body.sku_count,2);
assert.ok(calls.indexOf('latest-original')<calls.indexOf('parse-original'));

const registration=registry.rules.find(r=>r.id==='register');
registration.scope='smartstore';
assert.throws(()=>api.compose([{sku:'six',value:1000}],platform.body,registry),/판매처/,'rule from another platform must reject');
registration.scope='ably';
omitOriginal=true;
await assert.rejects(()=>api.exportLatest(['eight'],'ably'),/원본에서/);
assert.equal(logs.length,1,'missing original option must not log successful export');
assert.equal(exports.length,1);
omitOriginal=false;omitSibling=true;
const partialSibling=await api.exportLatest(['six'],'ably');
assert.deepEqual(partialSibling.appliedItems.map(item=>item.sellpia_sku_code),['six'],'a valid matrix row exports without inventing a missing sibling calculation');
assert.equal(logs.length,2);
assert.equal(exports.length,2);
assert.equal(productLoads,5);
assert.equal(registryLoads,5);
assert.equal(latestLoads,3);
omitSibling=false;
registry.rules.push(rule('direct-purchase-registration','platform_registration_price','purchase_price',[{op:'multiply',value:2}],{scope:'ably'}));
registry.assignments.push({sku:'six',rule_id:'direct-purchase-registration',target_field:'platform_registration_price',scope:'ably',version:1});
const conflicting=await api.calculate(['six'],'ably');
assert.match(conflicting.errors.find(r=>r.sku==='six').error,/충돌/,'explicit SKU rule cannot silently override a conflicting platform default');
const partialConflict=await api.exportLatest(['six'],'ably');
assert.deepEqual(partialConflict.appliedItems.map(item=>item.sellpia_sku_code),['eight'],'the conflicted SKU is excluded while its valid matrix sibling remains exportable');
assert.equal(logs.length,3,'partial success records only the valid applied SKU');
assert.deepEqual(logs.at(-1).body.actual_items.map(item=>item.sellpia_sku_code),['eight']);
platform.body.registration_rule_id=null;
const assigned=await api.calculate(['six'],'ably');
assert.deepEqual(assigned.errors,[]);
assert.equal(assigned.rows.find(r=>r.sku==='six').registrationValue,12000,'assigned registration uses independently selected raw purchase');
assert.deepEqual(assigned.rows.map(r=>[r.sku,r.platformFinal]),[['six',10000],['eight',24000]],'assigned registration is transformed once and sibling fallback uses internal basis');
platform.body.registration_rule_id='direct-purchase-registration';
const shared=await api.calculate(['six'],'ably');
assert.deepEqual(shared.rows.map(r=>r.platformFinal),[10000,10000],'default registration also uses its independently selected source field');
registry.assignments=registry.assignments.filter(a=>a.rule_id!=='direct-purchase-registration');
platform.body.registration_rule_id='register';
const stalePrice={export_item_id:41,source_channel:'ably',sellpia_sku_code:'eight',field_key:'sellpia_sale_price',after_value:1};
const retainedStock={export_item_id:42,source_channel:'ably',sellpia_sku_code:'unrelated',field_key:'sellpia_current_stock',after_value:7};
const refreshed=await api.refreshExportItems([stalePrice,retainedStock],new Map([['ably',[{name:'latest.xlsx',generation:latestLoads}]]]));
assert.deepEqual(refreshed.find(r=>r.export_item_id===42),retainedStock,'legacy export refresh preserves unrelated stock changes');
assert.equal(refreshed.find(r=>r.sellpia_sku_code==='eight').after_value,26000,'legacy export refresh replaces stale queued price');
assert.equal(refreshed.find(r=>r.sellpia_sku_code==='eight').export_item_id,41,'existing queue item identity retained');
assert.equal(refreshed.find(r=>r.sellpia_sku_code==='six').after_value,24000,'legacy export refresh includes same-product sibling');
assert.equal(refreshed.find(r=>r.sellpia_sku_code==='six').export_item_id,-2,'new sibling gets a nonqueue identity');
registry.rules.push(
  rule('option-plus','platform_option_price','platform_option_input',[{op:'add',value:100}],{scope:'ably',version:3}),
  rule('final-plus','platform_final_price','platform_final_input',[{op:'add',value:200}],{scope:'ably',version:5}),
);
registry.assignments.push(
  {sku:'six',rule_id:'option-plus',target_field:'platform_option_price',scope:'ably',version:2},
  {sku:'six',rule_id:'final-plus',target_field:'platform_final_price',scope:'ably',version:4},
);
const staged=await api.calculate(['six'],'ably');
assert.deepEqual(staged.errors,[]);
const stagedSix=staged.rows.find(r=>r.sku==='six');
assert.equal(stagedSix.platformFinal,24300,'option +100 precedes final +200');
assert.equal(stagedSix.platformOption,300,'final adjustment must be represented in exported option amount');
assert.equal(stagedSix.platformFinal,stagedSix.platformBase-stagedSix.platformDiscount+stagedSix.platformOption);
assert.ok(stagedSix.versions.some(r=>r.id==='option-plus'&&r.version===3));
assert.ok(stagedSix.versions.some(r=>r.id==='final-plus'&&r.version===5));
const stagedExport=await api.exportLatest(['six'],'ably');
assert.equal(stagedExport.appliedItems.find(r=>r.sellpia_sku_code==='six').target_option_price,300);
assert.equal(logs.at(-1).body.actual_items.find(r=>r.sellpia_sku_code==='six').target_final_price,24300);
assert.ok(logs.at(-1).body.rule_versions.some(r=>r.id==='final-plus'&&r.version===5));

includeHigh=true;platform.body.anchor='middle';
registry.rules.push(rule('high-basis','calculated_base_price','purchase_price',[{op:'multiply',value:5}]));
registry.assignments.push({sku:'high',rule_id:'high-basis',target_field:'calculated_base_price',scope:'',version:1});
const negative=await api.calculate(['six'],'ably');
assert.deepEqual(negative.errors,[]);
const negativeSix=negative.rows.find(r=>r.sku==='six');
assert.deepEqual([negativeSix.platformBase,negativeSix.platformOption,negativeSix.platformFinal],[28000,-1700,24300],'negative middle option flows through option and final rules');
includeHigh=false;platform.body.anchor='lowest';
registry.assignments=registry.assignments.filter(a=>a.sku!=='high');

const originalRows=['six','eight'].map((sku,index)=>({product_code:'same-product',option_code:sku,final_price:9000+index,base_price:9000,option_price:index,discount_terms:[],source_row_no:index+2,raw_payload:{source_file_name:'latest.xlsx'}}));
const extraOriginal={...originalRows[0],option_code:'unlinked-option',source_row_no:4};
for(const source of ['smartstore','makeshop']){
 const preserved=api.itemsFromCalculation({...staged,source},[...originalRows,extraOriginal]);
 assert.equal(preserved.length,3,'shared product price keeps an unmapped original option in the same product');
 assert.deepEqual(preserved.find(item=>item.preserve_unmapped),{
  ...preserved.find(item=>item.preserve_unmapped),
  sellpia_sku_code:null,preserve_unmapped:true,seller_option_code:'unlinked-option',target_final_price:9000,
 },'unmapped original option is not assigned to a fake SKU and keeps its final price');
 const complete=api.itemsFromCalculation({...staged,source},originalRows);assert.equal(complete.length,2);
}
assert.equal(api.itemsFromCalculation({...staged,source:'ably'},[...originalRows,extraOriginal]).length,2,'Ably row-local prices do not impose the shared-price coverage requirement');
const duplicated={...staged,rows:[...staged.rows,{...staged.rows[0],sku:'duplicate-internal-sku'}]};
assert.throws(()=>api.itemsFromCalculation(duplicated,originalRows),/여러 SKU/,'same seller product and option cannot receive duplicate mapped writes');
registry.rules.push(rule('child-final','platform_final_price','platform_final_price',[{op:'add',value:2000}],{scope:'ably',input_origin:'parent'}));
registry.assignments.push({sku:'eight',rule_id:'child-final',target_field:'platform_final_price',scope:'ably',version:1});
registry.dependencies.push({child_sku:'eight',parent_sku:'six',target_field:'platform_final_price',source_field:'platform_final_price',scope:'ably',source_scope:'ably',rule_id:'child-final',relation_valid:true});
const childFirst=await api.calculate(['eight'],'ably');
assert.deepEqual(childFirst.errors,[],'platform parent final dependencies must work even when requested child appears first');
assert.equal(childFirst.rows.find(r=>r.sku==='eight').platformFinal,26300,'child references parent final after parent option/final rules');
console.log('PASS fresh source/rules/export flow: 6mm parent and 8mm child, sibling completeness, scoped rules, latest source file, version log, missing source abort; in-memory adapter only');
