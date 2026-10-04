import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import '../mockups/operations-hub/discount-price-math.js';
import '../mockups/operations-hub/current-price-export.js';

const api=globalThis.HubCurrentPriceExport;
const plain=value=>JSON.parse(JSON.stringify(value));

function carrier(product,option,rowNo,stock=1,final=4000){
 return {
  product_code:product,option_code:option,source_row_no:rowNo,stock,
  base_price:final,discounted_base_price:final,option_price:0,final_price:final,
  discount_terms:[],raw_payload:{
   source_file_name:'carrier.xlsx',
   smartstore_basic_discount_value:null,smartstore_basic_discount_unit:null,
   smartstore_mobile_discount_value:null,smartstore_mobile_discount_unit:null,
   smartstore_reservation_discount_value:null,smartstore_reservation_discount_unit:null,
   smartstore_multi_buy_discount_value:null,smartstore_multi_buy_discount_unit:null
  }
 };
}

test('stock-only planner fans one Sellpia SKU out to multiple exact seller identities',()=>{
 const originals=[carrier('P-1','O-1',2,1),carrier('P-2','O-2',3,2)];
 const targets=originals.map(row=>({
  sku:'SKU-A',product_code:row.product_code,option_code:row.option_code,seller_stock:5
 }));
 const plan=api.prepareCarrierItems('smartstore','carrier.xlsx',originals,targets,{includePrice:false,includeStock:true});

 assert.equal(plan.summary.blocked,0);
 assert.equal(plan.canGenerate,true);
 assert.deepEqual(plain(plan.operations.map(item=>[
  item.sellpia_sku_code,item.seller_product_code,item.seller_option_code,item.after_value
 ])),[
  ['SKU-A','P-1','O-1',5],
  ['SKU-A','P-2','O-2',5]
 ]);
});

test('rules price planner fans one Sellpia SKU out to multiple exact seller identities',()=>{
 const originals=[carrier('P-1','O-1',2),carrier('P-2','O-2',3)];
 const targets=originals.map(row=>({
  sku:'SKU-A',product_code:row.product_code,option_code:row.option_code,active_price_rule:true,
  current_effective_price:{
   platformBase:5000,platformDiscount:0,platformOption:0,platformFinal:5000,
   platformTerms:[],versions:[]
  }
 }));
 const plan=api.prepareCarrierItems('smartstore','carrier.xlsx',originals,targets,{includePrice:true,includeStock:false});

 assert.equal(plan.summary.blocked,0);
 assert.equal(plan.canGenerate,true);
 assert.deepEqual(plain(plan.operations.map(item=>[
  item.sellpia_sku_code,item.seller_product_code,item.seller_option_code,item.target_final_price
 ])),[
  ['SKU-A','P-1','O-1',5000],
  ['SKU-A','P-2','O-2',5000]
 ]);
});

test('Smartstore and MakeShop sellpia_source fan one SKU out to multiple exact seller identities',()=>{
 for(const source of ['smartstore','makeshop']){
  const originals=[carrier('P-1','O-1',2),carrier('P-2','O-2',3)];
  if(source==='makeshop')for(const row of originals)row.raw_payload={source_file_name:'carrier.xlsx',makeshop_discount_price:'',makeshop_membership_discount:0};
  const mappings=originals.map(row=>({sku:'SKU-A',product_code:row.product_code,option_code:row.option_code}));
  const plan=api.prepareSellpiaSourcePricePlan(
   source,'carrier.xlsx',originals,mappings,new Map([['SKU-A',5000]]),['SKU-A']
  );

  assert.equal(plan.summary.blocked,0,source);
  assert.equal(plan.operations.length,2,source);
  assert.ok(plan.preview.every(row=>row.status==='ready'),source);
  assert.deepEqual(plain(plan.operations.map(item=>[
   item.sellpia_sku_code,item.seller_product_code,item.seller_option_code,item.target_final_price
  ])),[
   ['SKU-A','P-1','O-1',5000],
   ['SKU-A','P-2','O-2',5000]
  ],source);
 }
});

test('the inverse direction remains a real ambiguity in both planners',()=>{
 const originals=[carrier('P-1','O-1',2)];
 const mappings=[
  {sku:'SKU-A',product_code:'P-1',option_code:'O-1'},
  {sku:'SKU-B',product_code:'P-1',option_code:'O-1'}
 ];
 const rulesPlan=api.prepareCarrierItems('smartstore','carrier.xlsx',originals,mappings.map(row=>({...row,seller_stock:5})),{includePrice:false,includeStock:true});
 const sourcePlan=api.prepareSellpiaSourcePricePlan('smartstore','carrier.xlsx',originals,mappings,new Map([['SKU-A',5000]]),['SKU-A']);

 assert.equal(rulesPlan.summary.blocked,1);
 assert.equal(rulesPlan.canGenerate,false);
 assert.match(rulesPlan.preview[0].reason,/여러 SKU/);
 assert.equal(sourcePlan.summary.blocked,1);
 assert.match(sourcePlan.preview[0].reason,/여러 SKU/);
});

async function runCrossFilePlan(definitions,{mode='changed_only',includeStock=false}={}){
 const appSource=fs.readFileSync('mockups/operations-hub/app.js','utf8');
 const start=appSource.indexOf('async function prepareChangedOnlyExport(');
 const end=appSource.indexOf('\nwindow.SystemV3SellerExportBridge=',start);
 assert.ok(start>=0&&end>start);
 const functionSource=appSource.slice(start,end);
 const files=definitions.map(definition=>({name:definition.file}));
 const rowsByFile=new Map(definitions.map(definition=>{
  const row=carrier(definition.product,definition.option,2);
  row.raw_payload.source_file_name=definition.file;
  return [definition.file,[row]];
 }));
 const mappingByFile=new Map(definitions.map(definition=>[
  definition.file,[{sku:definition.sku,product_code:definition.product,option_code:definition.option}]
 ]));
 const prices=new Map([...new Set(definitions.map(definition=>definition.sku))].map((sku,index)=>[sku,5000+index*1000]));
 const context={
  Date,Blob,setTimeout,performance:{now:()=>Date.now()},formatNumber:value=>String(value),CHANNEL_LABELS:{smartstore:'스마트스토어'},
  sellerExport:{
   async transformSellerFile(file,items){return {blob:new Blob([file.name]),appliedItems:items,skippedItems:[]};},
   async markCarrierWarnings(blob){return blob;},
   outputName:name=>name,downloadBlob(){},conflictCsv(){return '';}
  },
  liveData:{
   async downloadLatestSellerOriginals(){return new Map([['smartstore',files]]);},
   async loadCarrierSellerMappings({identities}){return {rows:mappingByFile.get(identities[0].raw_payload.source_file_name)};},
   async loadSellpiaSourcePricesForExport({skus}){return new Map(skus.map(sku=>[sku,prices.get(sku)]));}
  },
  window:{
   SystemV3SellerParsers:{async parseSellerFiles(source,[file]){return {normalizedRows:rowsByFile.get(file.name)};}},
   HubCurrentPriceExport:api
  }
 };
 vm.createContext(context);
 vm.runInContext(functionSource+'\nthis.prepare=prepareChangedOnlyExport;',context);
 return context.prepare('smartstore',[...prices.keys()],{
  download:false,mode,priceMode:'sellpia_source',includePrice:true,includeStock
 });
}

test('changed-only and full-original fan out the same SKU across separate carrier files',async()=>{
 const definitions=[
  {file:'one.xlsx',product:'P-1',option:'O-1',sku:'SKU-A'},
  {file:'two.xlsx',product:'P-2',option:'O-2',sku:'SKU-A'}
 ];
 for(const mode of ['changed_only','full_original'])for(const includeStock of [false,true]){
  const result=await runCrossFilePlan(definitions,{mode,includeStock});
  assert.equal(result.outputs.length,2,`${mode}/${includeStock?'price+stock':'price-only'}`);
  assert.equal(result.changedItems.length,2,`${mode}/${includeStock?'price+stock':'price-only'}`);
  assert.equal(result.plans.reduce((sum,plan)=>sum+plan.summary.blocked,0),0);
  assert.deepEqual(plain(result.changedItems.map(item=>item.sellpia_sku_code)),['SKU-A','SKU-A']);
 }
});

test('the same seller identity and same SKU in separate carrier files stays file-local',async()=>{
 const result=await runCrossFilePlan([
  {file:'one.xlsx',product:'P-1',option:'O-1',sku:'SKU-A'},
  {file:'two.xlsx',product:'P-1',option:'O-1',sku:'SKU-A'}
 ]);
 assert.equal(result.outputs.length,2);
 assert.equal(result.changedItems.length,2);
 assert.equal(result.plans.reduce((sum,plan)=>sum+plan.summary.blocked,0),0);
});

test('the same seller identity mapped to different SKUs across carrier files stays blocked',async()=>{
 const result=await runCrossFilePlan([
  {file:'one.xlsx',product:'P-1',option:'O-1',sku:'SKU-A'},
  {file:'two.xlsx',product:'P-1',option:'O-1',sku:'SKU-B'}
 ]);
 assert.equal(result.changedItems.length,0);
 assert.equal(result.plans.reduce((sum,plan)=>sum+plan.summary.blocked,0),2);
 assert.ok(result.plans.flatMap(plan=>plan.preview).every(row=>/여러 SKU/.test(row.reason)));
});
