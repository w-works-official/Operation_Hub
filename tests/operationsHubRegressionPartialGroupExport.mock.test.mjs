import assert from 'node:assert/strict';
import {test} from 'node:test';
await import('../mockups/operations-hub/rule-registry.js');
await import('../mockups/operations-hub/discount-price-math.js');
await import('../mockups/operations-hub/seller-export-adapter.js');
await import('../mockups/operations-hub/platform-rule-service.js');
const api=globalThis.HubPlatformRules;
const row=(sku,product,option,base=200)=>({sku,component:{seller_product_code:product,seller_option_code:option},platformBase:base,platformDiscount:0,platformOption:0,platformFinal:base,platformTerms:[],versions:[]});
const original=(product,option,base=100)=>({product_code:product,option_code:option,base_price:base,final_price:base,option_price:0,discount_terms:[],source_row_no:2,raw_payload:{source_file_name:'original.xlsx'}});
test('bulk export excludes whole invalid groups and never recalculates an incomplete group',()=>{
 const result={source:'makeshop',rows:[row('good','G','1'),row('duplicate1','D','1'),row('duplicate2','D','1'),row('missing1','M','1'),row('missing2','M','2'),row('unmapped','U','1'),row('errorSibling','E','1'),row('sourceDuplicate','S','1')],errors:[{sku:'errorSku',product_code:'E',error:'invalid cost'}]};
 const originals=[original('G','1'),original('D','1'),original('M','1'),original('U','1'),original('U','2'),original('E','1'),original('E','2'),original('S','1'),original('S','1')];
 const partition=api.partitionExportGroups(result,originals);
 assert.deepEqual(partition.items.filter(i=>!i.preserve_unmapped).map(i=>i.sellpia_sku_code),['good','unmapped','errorSibling']);assert.equal(partition.items[0].target_base_price,200);
 assert.equal(partition.items.find(i=>i.preserve_unmapped).target_final_price,100);
 assert.equal(partition.excludedItems.length,6);assert.equal(new Set(partition.excludedItems.map(i=>i.item.export_item_id)).size,6);
 assert.ok(partition.excludedItems.every(i=>i.item.seller_product_code&&i.item.sellpia_sku_code&&i.reason));
 assert.throws(()=>api.itemsFromCalculation({...result,rows:result.rows.slice(1,3)},originals),/여러 SKU/,'strict manual queue mapper must still reject duplicates');
});
test('shared base and discount changes preserve unmapped final prices without recalculating matrix rows',()=>{
 for(const source of ['smartstore','makeshop']){
  const mapped=row('same','P','1',100),result={source,rows:[mapped],errors:[]};
  const originals=[original('P','1'),{...original('P','2'),final_price:4500,option_price:4400}];
  assert.equal(api.partitionExportGroups(result,originals).items.length,1);
  Object.assign(mapped,{platformBase:10000,platformDiscount:1000,platformOption:300,platformFinal:9300,platformTerms:[{term_key:source==='makeshop'?'period':'basic',value:1000,unit:'amount',is_baseline:true}]});
  const before=structuredClone(result),partition=api.partitionExportGroups(result,originals);
  assert.equal(partition.excludedItems.length,0);assert.equal(partition.items.length,2);assert.deepEqual(result,before);
  const calculated=partition.items.find(i=>!i.preserve_unmapped),preserved=partition.items.find(i=>i.preserve_unmapped);
  assert.equal(calculated.target_base_price,10000);assert.equal(calculated.target_option_price,300);assert.equal(calculated.target_final_price,9300);
  assert.equal(preserved.sellpia_sku_code,null);assert.equal(preserved.target_option_price,-4500);assert.equal(preserved.target_final_price,4500);assert.equal(preserved.after_value,4500);
  assert.equal(preserved.target_discounted_base_price+preserved.target_option_price,preserved.expected_source_value);assert.deepEqual(preserved.target_discount_terms,calculated.target_discount_terms);
 }
});
test('Makeshop structural header is not a missing option and repeated same-SKU targets deduplicate',()=>{
 const r=row('sku','P','1',200),result={source:'makeshop',rows:[r,structuredClone(r)],errors:[]};
 const partition=api.partitionExportGroups(result,[original('P',''),original('P','1')]);
 assert.equal(partition.excludedItems.length,0);assert.equal(partition.items.length,1);assert.equal(partition.items[0].sellpia_sku_code,'sku');
 const actualNoOption=api.partitionExportGroups({source:'makeshop',rows:[row('plain','N','',200)],errors:[]},[original('N','')]);assert.equal(actualNoOption.items[0].target_final_price,200);
 assert.throws(()=>api.itemsFromCalculation({...result,rows:[r,row('different-sku','P','1',200)]},[original('P','1')]),/여러 SKU/);
});
test('unmapped option with missing original final fails visibly rather than silently changing its price',()=>{
 const partition=api.partitionExportGroups({source:'makeshop',rows:[row('sku','P','1',200)],errors:[]},[original('P','1'),{...original('P','2'),final_price:null,price:null}]);
 assert.equal(partition.items.length,0);assert.match(partition.excludedItems[0].reason,/원본 최종가/);
});
test('single-SKU calculation errors preserve its original option while valid matrix rows remain exact',()=>{
 const good={...row('good','P','1',10000),platformOption:300,platformFinal:10300};
 const bad={...row('bad','P','2',10000),error:'missing purchase price'};
 const result={source:'makeshop',rows:[good,bad],errors:[{sku:'bad',product_code:'P',option_code:'2',group_error:false,error:'missing purchase price'},{sku:'unknown',product_code:'',group_error:false,unresolved_product:true,error:'SKU missing'}]};
 const before=structuredClone(result),partition=api.partitionExportGroups(result,[original('P','1'),{...original('P','2'),final_price:4500}]);
 assert.deepEqual(result,before);assert.equal(partition.items.find(i=>i.sellpia_sku_code==='good').target_final_price,10300);
 const preserve=partition.items.find(i=>i.preserve_unmapped);assert.equal(preserve.seller_option_code,'2');assert.equal(preserve.target_final_price,4500);assert.equal(preserve.target_option_price,-5500);
 assert.deepEqual(partition.excludedItems.map(e=>e.item.sellpia_sku_code),['bad','unknown']);assert.ok(partition.excludedItems.every(e=>e.reason.startsWith('SKU 계산 오류:')));
 const groupFailure=api.partitionExportGroups({...result,errors:[{sku:'bad',product_code:'P',option_code:'2',group_error:true,error:'conflicting group base'}]},[original('P','1'),original('P','2')]);
 assert.equal(groupFailure.items.length,0);assert.equal(groupFailure.excludedItems.length,2);
});
test('exportLatest passes exclusions into archive, records only applied rows, and rejects zero valid groups',async()=>{
 const reg={rules:[],assignments:[],dependencies:[]},config={id:'config',version:1,body:{source:'makeshop',anchor:'lowest',mode:'forward'}};
 let includeGood=true,saves=0,received;
 globalThis.SystemV3Data={ruleRegistry:async()=>reg,workDocument:async(action,kind,payload)=>{if(action==='get_title')return config;saves++;assert.equal(payload.body.sku_count,1);return payload;},loadRulePlatformSiblings:async()=>[],loadFormulaProducts:async()=>[
  ...(includeGood?[{sellpia_sku_code:'good',system_base_price:200,__sellerPriceComponents:{makeshop:{seller_product_code:'G',seller_option_code:'1'}}}]:[]),
  {sellpia_sku_code:'bad1',system_base_price:200,__sellerPriceComponents:{makeshop:{seller_product_code:'D',seller_option_code:'1'}}},
  {sellpia_sku_code:'bad2',system_base_price:300,__sellerPriceComponents:{makeshop:{seller_product_code:'D',seller_option_code:'1'}}}],downloadLatestSellerOriginals:async()=>new Map([['makeshop',[{name:'original.xlsx'}]]])};
 globalThis.SystemV3SellerParsers={parseSellerFiles:async()=>({normalizedRows:[original('G','1'),original('D','1')]})};
 const actual=globalThis.SystemV3SellerExport;
 globalThis.SystemV3SellerExport={...actual,buildExportArchive:async(files,items,progress,excluded)=>{received=excluded;return {appliedItems:items,skippedItems:excluded,manifest:[],blob:new Blob()};}};
 try{
  const result=await api.exportLatest(['good','bad1','bad2'],'makeshop');assert.equal(result.appliedItems.length,1);assert.equal(received.length,2);assert.equal(saves,1);
  includeGood=false;
  await assert.rejects(api.exportLatest(['bad1','bad2'],'makeshop'),error=>error.preflightFailure&&error.skippedItems.length===2&&/내보낼 수/.test(error.message));assert.equal(saves,1,'empty exports must not save success history');
  globalThis.SystemV3Data.loadFormulaProducts=async()=>[{sellpia_sku_code:'bad',system_base_price:200,__sellerPriceComponents:{makeshop:{seller_product_code:'known-product',seller_option_code:'1',draft_change_id:1,pricing_input_mode:'option',option_price_source:'manual',draft_option_price:'invalid'}}}];
  const failure=await api.calculate(['bad'],'makeshop');assert.equal(failure.errors[0].product_code,'known-product','calculation failures must retain product identity before row construction succeeds');assert.equal(failure.errors[0].option_code,'1');assert.equal(failure.errors[0].group_error,false);
 }finally{globalThis.SystemV3SellerExport=actual;}
});
test('late serializer conflict rebuilds untouched originals without any member of the failed product',async()=>{
 const products=[['a1','A','1'],['a2','A','2'],['b','B','1']].map(([sku,product,option])=>({sellpia_sku_code:sku,system_base_price:200,__sellerPriceComponents:{ably:{seller_product_code:product,seller_option_code:option}}}));
 const originalFile={name:'original.xlsx'};let builds=0,saves=0;
 globalThis.SystemV3Data={ruleRegistry:async()=>({rules:[],assignments:[],dependencies:[]}),workDocument:async(action,kind,payload)=>{if(action==='get_title')return null;if(action==='save'){saves++;assert.equal(payload.body.sku_count,1);return payload;}},loadRulePlatformSiblings:async()=>[],loadFormulaProducts:async()=>products,downloadLatestSellerOriginals:async()=>new Map([['ably',[originalFile]]])};
 globalThis.SystemV3SellerParsers={parseSellerFiles:async()=>({normalizedRows:[original('A','1'),original('A','2'),original('B','1')]})};
 const actual=globalThis.SystemV3SellerExport;
 globalThis.SystemV3SellerExport={...actual,buildExportArchive:async(files,items,progress,excluded)=>{
  assert.equal(files.get('ably')[0],originalFile,'every rebuild starts from the original file');builds++;
  if(builds===1)return {appliedItems:items.filter(i=>i.sellpia_sku_code!=='a2'),skippedItems:[{item:items.find(i=>i.sellpia_sku_code==='a2'),reason:'baseline conflict'}],manifest:[]};
  assert.deepEqual(items.map(i=>i.sellpia_sku_code),['b']);assert.deepEqual(excluded.map(i=>i.item.sellpia_sku_code),['a1','a2']);
  return {appliedItems:items,skippedItems:excluded,manifest:[]};
 }};
 try{const output=await api.exportLatest(['a1','a2','b'],'ably');assert.equal(builds,2);assert.equal(saves,1);assert.equal(output.skippedItems.length,2);}finally{globalThis.SystemV3SellerExport=actual;}
});
test('preexisting per-SKU exclusions do not roll back successful siblings or count preservation as a SKU',async()=>{
 const good={sellpia_sku_code:'good',system_base_price:200,__sellerPriceComponents:{makeshop:{seller_product_code:'P',seller_option_code:'1'}}};
 const bad={sellpia_sku_code:'bad',system_base_price:200,__sellerPriceComponents:{makeshop:{seller_product_code:'P',seller_option_code:'2',draft_change_id:1,pricing_input_mode:'option',option_price_source:'manual',draft_option_price:'invalid'}}};
 let builds=0;globalThis.SystemV3Data={ruleRegistry:async()=>({rules:[],assignments:[],dependencies:[]}),workDocument:async(action,kind,payload)=>{if(action==='get_title')return null;if(action==='save'){assert.equal(payload.body.sku_count,1);return payload;}},loadRulePlatformSiblings:async()=>[],loadFormulaProducts:async()=>[good,bad],downloadLatestSellerOriginals:async()=>new Map([['makeshop',[{name:'original.xlsx'}]]])};
 globalThis.SystemV3SellerParsers={parseSellerFiles:async()=>({normalizedRows:[original('P','1'),original('P','2')]})};
 const actual=globalThis.SystemV3SellerExport;globalThis.SystemV3SellerExport={...actual,buildExportArchive:async(files,items,progress,excluded)=>{builds++;return {appliedItems:items,skippedItems:excluded,manifest:[]};}};
 try{const out=await api.exportLatest(['good','bad'],'makeshop');assert.equal(builds,1);assert.equal(out.appliedItems.length,2);assert.equal(out.appliedItems.filter(i=>i.preserve_unmapped).length,1);assert.deepEqual(out.skippedItems.map(e=>e.item.sellpia_sku_code),['bad']);}finally{globalThis.SystemV3SellerExport=actual;}
});
