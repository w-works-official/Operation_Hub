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

async function runCrossFilePlan(definitions,{mode='changed_only',includeStock=false,currentDecisions=[]}={}){
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
 const prices=new Map([...new Set(definitions.map(definition=>definition.sku))].map((sku,index)=>[sku,5000+index*1000])),downloads=[],sourcePriceCalls=[];
 const context={
  Date,Blob,setTimeout,performance:{now:()=>Date.now()},formatNumber:value=>String(value),CHANNEL_LABELS:{smartstore:'스마트스토어'},
  sellerExport:{
   async transformSellerFile(file,items){return {blob:new Blob([file.name]),appliedItems:items,skippedItems:[]};},
   async markCarrierWarnings(blob){return blob;},
   outputName:name=>name,downloadBlob(blob,name){downloads.push({blob,name});},conflictCsv(){return '';}
  },
  liveData:{
   async downloadLatestSellerOriginals(){return new Map([['smartstore',files]]);},
   async loadCarrierSellerMappings({identities}){return {rows:mappingByFile.get(identities[0].raw_payload.source_file_name)};},
   async loadSellpiaSourcePricesForExport({skus}){sourcePriceCalls.push([...skus]);return new Map(skus.map(sku=>[sku,prices.get(sku)]));},
   async loadCurrentPriceDecisions({source,skus}){
    const rows=currentDecisions.filter(row=>skus.includes(row.sku)).map(row=>({...row,source_channel:source,mapping_valid:true}));
    const groups=[...new Set(rows.map(row=>row.seller_product_code))].map(product=>{
     const definition=definitions.find(item=>item.product===product),decision=rows.find(row=>row.seller_product_code===product);
     const original=rowsByFile.get(definition.file)[0];return {source_channel:source,seller_product_code:product,revision:decision.revision,mapping_fingerprint:`mapping-${product}`,input_fingerprints:{},snapshot_id:`snapshot-${product}`,mapping_valid:true,targets:[{sku:decision.sku,member_skus:[decision.sku],seller_product_code:product,seller_option_code:decision.seller_option_code,price:{base:original.base_price,discounted:original.discounted_base_price,option:original.option_price,final:original.final_price,terms:original.discount_terms},current_state:{price:decision.price,event_id:decision.event_id,revision:decision.revision},source_row_no:original.source_row_no,raw_payload:original.raw_payload}]};
    });
    return {rows,groups};
   }
  },
  window:{
   SystemV3SellerParsers:{async parseSellerFiles(source,[file]){return {normalizedRows:rowsByFile.get(file.name)};}},
   HubCurrentPriceExport:api,
   HubCurrentPriceDecisionResolver:globalThis.HubCurrentPriceDecisionResolver
  }
 };
 vm.createContext(context);
 vm.runInContext(functionSource+'\nthis.prepare=prepareChangedOnlyExport;',context);
 const result=await context.prepare('smartstore',[...prices.keys()],{
  download:false,mode,priceMode:'sellpia_source',includePrice:true,includeStock
 });
 return {...result,downloads,sourcePriceCalls,generate:options=>context.prepare('smartstore',[...prices.keys()],{download:true,mode,priceMode:'sellpia_source',includePrice:true,includeStock,...options})};
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

test('same SKU current decisions stay attached to their exact carrier identities across files',async()=>{
 const definitions=[{file:'one.xlsx',product:'P-1',option:'O-1',sku:'SKU-A'},{file:'two.xlsx',product:'P-2',option:'O-2',sku:'SKU-A'}],currentDecisions=[
  {sku:'SKU-A',seller_product_code:'P-1',seller_option_code:'O-1',event_id:'event-p1',revision:3,decision_source:'manual',effective_at:'2026-10-08T00:00:00Z',price:{base:6100,discounted:6100,option:0,final:6100,terms:[]}},
  {sku:'SKU-A',seller_product_code:'P-2',seller_option_code:'O-2',event_id:'event-p2',revision:8,decision_source:'manual',effective_at:'2026-10-08T00:01:00Z',price:{base:7300,discounted:7300,option:0,final:7300,terms:[]}}
 ];
 const result=await runCrossFilePlan(definitions,{currentDecisions});
 assert.equal(result.outputs.length,2);assert.equal(result.changedItems.length,2);assert.equal(result.plans.reduce((sum,plan)=>sum+plan.summary.blocked,0),0);
 assert.deepEqual(plain(result.plans.map(plan=>plan.preview[0].diff.price.after.final)),[6100,7300]);
 assert.deepEqual(plain(result.plans.map(plan=>plan.preview[0].current_price_decision_proof.event_id)),['event-p1','event-p2']);
 assert.deepEqual(result.sourcePriceCalls,[],'current price decisions do not depend on Sellpia source price availability');
});

test('preview to generate blocks a same-value current decision reupload before downloading',async()=>{
 const definitions=[{file:'one.xlsx',product:'P-1',option:'O-1',sku:'SKU-A'}],currentDecisions=[
  {sku:'SKU-A',seller_product_code:'P-1',seller_option_code:'O-1',event_id:'event-r5',revision:5,decision_source:'manual',effective_at:'2026-10-08T00:00:00Z',price:{base:5000,discounted:5000,option:0,final:5000,terms:[]}}
 ],result=await runCrossFilePlan(definitions,{currentDecisions});
 const preview=result.planFingerprint;
 currentDecisions[0]={...currentDecisions[0],event_id:'event-r6',revision:6,effective_at:'2026-10-08T00:01:00Z'};
 await assert.rejects(result.generate({expectedPlanFingerprint:preview}),/미리보기 이후 셀피아\/판매처 가격 또는 대상이 변경됐습니다/);
 assert.equal(result.downloads.length,0,'stale preview never downloads');
});

test('preview without a decision blocks when a same-value current decision appears before generate',async()=>{
 const definitions=[{file:'one.xlsx',product:'P-1',option:'O-1',sku:'SKU-A'}],currentDecisions=[],result=await runCrossFilePlan(definitions,{currentDecisions});
 const preview=result.planFingerprint;
 currentDecisions.push({sku:'SKU-A',seller_product_code:'P-1',seller_option_code:'O-1',event_id:'event-new',revision:1,decision_source:'manual',effective_at:'2026-10-08T00:01:00Z',price:{base:5000,discounted:5000,option:0,final:5000,terms:[]}});
 await assert.rejects(result.generate({expectedPlanFingerprint:preview}),/미리보기 이후 셀피아\/판매처 가격 또는 대상이 변경됐습니다/);
 assert.equal(result.downloads.length,0,'new current event never downloads under a no-current preview');
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
