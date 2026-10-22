import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import '../mockups/operations-hub/discount-price-math.js';
import '../mockups/operations-hub/current-price-export.js';
import '../mockups/operations-hub/product-price-adjustment.js';

const app=fs.readFileSync('mockups/operations-hub/app.js','utf8');
const start=app.indexOf('async function prepareChangedOnlyExport(');
const end=app.indexOf('\nwindow.SystemV3SellerExportBridge=',start);
assert.ok(start>=0&&end>start);
const source=app.slice(start,end);
const carrierRows=[
 {product_code:'P1',option_code:'O1',source_row_no:2,stock:4,base_price:1000,discounted_base_price:1000,option_price:0,final_price:1000,discount_terms:[],raw_payload:{source_file_name:'carrier.xlsx'}},
 {product_code:'P1',option_code:'O2',source_row_no:3,stock:1,base_price:2000,discounted_base_price:2000,option_price:0,final_price:2000,discount_terms:[],raw_payload:{source_file_name:'carrier.xlsx'}}
];

async function run(mode,{ambiguous=false,download=false,expectedPlanFingerprint=null}={}){
 const file=Object.assign(new Blob(['carrier fixture']),{name:'carrier.xlsx'}),serialized=[],downloads=[],settingReads=[];
 const mappings=ambiguous?[
  {sku:'S1',product_code:'P1',option_code:'O1'},
  {sku:'SX',product_code:'P1',option_code:'O1'},
  {sku:'S2',product_code:'P1',option_code:'O2'}
 ]:[{sku:'S1',product_code:'P1',option_code:'O1'},{sku:'S2',product_code:'P1',option_code:'O2'}];
 const context={
  Date,Blob,setTimeout,performance:{now:()=>Date.now()},formatNumber:value=>String(value),CHANNEL_LABELS:{smartstore:'스마트스토어'},
  sellerExport:{
   async transformSellerFile(_file,items,options){serialized.push({items,options});return {blob:new Blob(['xlsx']),appliedItems:items,skippedItems:[]};},
   async markCarrierWarnings(blob){return blob;},outputName:name=>name,downloadBlob(blob,name){downloads.push({blob,name});},conflictCsv(){return '';}
  },
  liveData:{
   async downloadLatestSellerOriginals(){return new Map([['smartstore',[file]]]);},
   async loadCarrierSellerMappings(){return {rows:mappings};},
   async loadCarrierMatrixTargets({skus}){return {rows:skus.map(sku=>sku==='S1'
    ?{sku,product_code:'P1',option_code:'O1',seller_stock:4,active_price_rule:false}
    :{sku,product_code:'P1',option_code:'O2',seller_stock:9,active_price_rule:false,price_draft:{price_base_after:3000,price_discounted_base_after:3000,price_option_after:0,price_final_after:3000,price_discount_terms_after:[]}})};},
   async loadCurrentPriceDecisions(){throw Error('Smartstore price export must use the export evidence reader');},
   async loadExportCurrentPriceDecisions({source,skus,allowLargeGroups}){
    assert.equal(source,'smartstore');assert.equal(allowLargeGroups,true);assert.ok(skus.includes('S1'));
    const snapshots={seller_snapshot_id:'seller-v1',sellpia_snapshot_id:'sellpia-v1',sellpia_observed_at:'2026-10-22T00:00:00Z'};
    const targets=carrierRows.map(row=>{
     const memberSkus=mappings.filter(mapping=>mapping.option_code===row.option_code).map(mapping=>mapping.sku).sort();
     return {sku:memberSkus[0],member_skus:memberSkus,seller_product_code:row.product_code,seller_option_code:row.option_code,
      price:{base:row.base_price,discounted:row.discounted_base_price,option:row.option_price,final:row.final_price,terms:row.discount_terms},
      source_row_no:row.source_row_no,source_valid:true,component_members:memberSkus.map((sku,index)=>({sku,component_qty:1,component_role:'primary',mapping_source:'explicit',listing_id:1,component_id:index+1}))};
    });
    const proof={source_channel:source,seller_product_code:'P1',mapping_fingerprint:'mapping-P1',snapshot_id:snapshots.seller_snapshot_id,sellpia_snapshot_id:snapshots.sellpia_snapshot_id,source_observed_at:snapshots.sellpia_observed_at,sellpia_prices:Object.fromEntries(mappings.map(row=>[row.sku,1000])),targets};
    return {rows:[],groups:[],proof_version:'sellpia-export-v2',absence_proofs:[{...proof,revision:0,mapping_valid:true}],carrier_proofs:[proof],snapshots};
   },
   async loadProductPriceSettings({source,productCodes}){assert.equal(source,'smartstore');settingReads.push([...productCodes]);return {contractVersion:1,source,settings:[]};},
   async saveProductPriceSettings(){throw Error('export must not save product price settings');}
  },
  window:{SystemV3SellerParsers:{async parseSellerFiles(){return {normalizedRows:carrierRows};}},HubCurrentPriceExport:globalThis.HubCurrentPriceExport,HubCurrentPriceDecisionResolver:globalThis.HubCurrentPriceDecisionResolver,HubProductPriceAdjustment:globalThis.HubProductPriceAdjustment}
 };
 context.assertMatrixChangesSaved??=()=>true;context.requireMatrixChangesSaved??=()=>true;vm.createContext(context);vm.runInContext(source+'\nthis.prepare=prepareChangedOnlyExport;',context);
 const result=await context.prepare('smartstore',['S1'],{download,mode,expectedPlanFingerprint,includePrice:true,includeStock:true});
 assert.ok(settingReads.length>0,'Smartstore price previews load setting absence as well as saved values');
 assert.ok(settingReads.every(codes=>codes.length===1&&codes[0]==='P1'),'setting reads stay within the selected product context');
 return {result,serialized,downloads};
}

test('target_all emits selected unchanged product rows without turning sibling values into changes',async()=>{
 const {result,serialized}=await run('target_all');
 assert.equal(result.scopeSummary.selectedSkuCount,1);
 assert.equal(result.scopeSummary.matchedOptionCount,1);
 assert.equal(result.scopeSummary.changedOptionCount,0);
 assert.equal(result.scopeSummary.unchangedOptionCount,1);
 assert.equal(result.selectedRows.length,1);
 assert.equal(result.selectedRows[0].sku,'S1');
 assert.equal(result.changedItems.length,0,'target_all retains rows without inventing a cell edit');
 assert.equal(result.outputs.length,1,'an unchanged selected match still produces an XLSX');
 assert.equal(result.scopeSummary.outputRowCount,2,'selected seller product group keeps its sibling rows as context');
 assert.deepEqual([...serialized[0].options.keepOnlyRows].sort((a,b)=>a-b),[2,3]);
 const sibling=result.plans[0].preview.find(row=>row.sku==='S2');
 assert.equal(sibling.export_scope_selected,false);
 assert.equal(sibling.changed,false,'an unselected sibling current price and stock target are context only');
});

test('changed_only keeps no output for a selected match with no changed cells',async()=>{
 const {result,serialized}=await run('changed_only');
 assert.equal(result.selectedRows.length,1);
 assert.equal(result.changedItems.length,0);
 assert.equal(result.outputs.length,0);
 assert.equal(serialized.length,0);
});

test('target_all fingerprint revalidates its no-op row plan at generation',async()=>{
 const preview=await run('target_all');
 const generated=await run('target_all',{download:true,expectedPlanFingerprint:preview.result.planFingerprint});
 assert.equal(generated.result.changedItems.length,0);
 assert.equal(generated.result.outputs.length,1);
 assert.equal(generated.downloads.length,1);
 await assert.rejects(()=>run('changed_only',{download:true,expectedPlanFingerprint:preview.result.planFingerprint}),/미리보기 이후/);
});

test('target_all retains inverse identity owners for ambiguity checks',async()=>{
 const {result}=await run('target_all',{ambiguous:true});
 assert.equal(result.plans[0].preview.find(row=>row.option_code==='O1').status,'blocked');
 assert.equal(result.scopeSummary.blockedCount,1);
 assert.equal(result.outputs.length,0,'an ambiguous selected identity cannot become a unique export after scope filtering');
});

test('MakeShop target_all keeps physical continuation rows and full_original counts real data rows',async()=>{
 const file={name:'makeshop.xlsx'},serialized=[];
 async function prepare(mode,sellerStock){
  const context={
   Date,Blob,setTimeout,performance:{now:()=>Date.now()},formatNumber:value=>String(value),CHANNEL_LABELS:{makeshop:'메이크샵'},
   sellerExport:{
    async readMakeshopPhysicalProductRows(){return {dataRowNumbers:[2,3,4,5],rowsByProduct:{P1:[3,4],P2:[5]}};},
    async transformSellerFile(_file,items,options){serialized.push({mode,items,options});return {blob:new Blob(['xlsx']),appliedItems:items,skippedItems:[]};},
    async markCarrierWarnings(blob){return blob;},outputName:name=>name,downloadBlob(){},conflictCsv(){return '';}
   },
   liveData:{
    async downloadLatestSellerOriginals(){return new Map([['makeshop',[file]]]);},
    async loadCarrierSellerMappings(){return {rows:[{sku:'S1',product_code:'P1',option_code:'O1'},{sku:'S2',product_code:'P2',option_code:'O2'}]};},
    async loadSellpiaStockSourcesForExport(){return {snapshotId:'stock-v1',bySku:new Map([['S1',{seller_stock:sellerStock}]])};}
   },
   window:{SystemV3SellerParsers:{async parseSellerFiles(){return {normalizedRows:[
    {product_code:'P1',option_code:'O1',source_row_no:3,stock:4,base_price:1000,discounted_base_price:1000,option_price:0,final_price:1000,discount_terms:[],raw_payload:{source_file_name:'makeshop.xlsx'}},
    {product_code:'P2',option_code:'O2',source_row_no:5,stock:6,base_price:2000,discounted_base_price:2000,option_price:0,final_price:2000,discount_terms:[],raw_payload:{source_file_name:'makeshop.xlsx'}}
   ]};}},HubCurrentPriceExport:globalThis.HubCurrentPriceExport,HubCurrentPriceDecisionResolver:globalThis.HubCurrentPriceDecisionResolver}
  };
  context.assertMatrixChangesSaved??=()=>true;context.requireMatrixChangesSaved??=()=>true;vm.createContext(context);vm.runInContext(source+'\nthis.prepare=prepareChangedOnlyExport;',context);
  return context.prepare('makeshop',['S1'],{download:false,mode,includePrice:false,includeStock:true,stockSource:'stock'});
 }
 const scoped=await prepare('target_all',4);
 assert.equal(scoped.scopeSummary.outputRowCount,2,'row count includes physical continuation row, excludes template metadata row 2');
 assert.deepEqual([...serialized.at(-1).options.keepOnlyRows].sort((a,b)=>a-b),[2,3,4]);
 const original=await prepare('full_original',5);
 assert.equal(original.scopeSummary.outputRowCount,3,'full-original count includes every physical data row except metadata row 2');
 assert.equal(original.outputs.length,1);
});
