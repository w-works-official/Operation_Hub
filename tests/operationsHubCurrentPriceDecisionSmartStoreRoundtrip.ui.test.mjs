import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {createRequire} from 'node:module';
import {chromium} from 'playwright';

const require=createRequire(import.meta.url),root=path.resolve('mockups/operations-hub');
const xlsxScript=process.env.XLSX_BROWSER_SCRIPT&&fs.existsSync(process.env.XLSX_BROWSER_SCRIPT)
  ?fs.readFileSync(process.env.XLSX_BROWSER_SCRIPT,'utf8')
  :await (await fetch('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js')).text();

test('SmartStore real XLSX roundtrip preserves current price decision in Rule and Sellpia source plans',async()=>{
 const browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});
 try{
  const page=await browser.newPage();await page.setContent('<!doctype html><title>Current price decision XLSX</title>');
  await page.addScriptTag({content:xlsxScript});
  await page.addScriptTag({content:fs.readFileSync(require.resolve('jszip/dist/jszip.min.js'),'utf8')});
  for(const script of ['seller-export-adapter.js','discount-price-math.js','current-price-export.js'])await page.addScriptTag({path:path.join(root,script)});
  const results=await page.evaluate(async()=>{
   const matrix=Array.from({length:3},()=>Array(112).fill(''));
   matrix[1][5]=16000;matrix[1][15]='A';matrix[1][17]='0';
   const workbook=XLSX.utils.book_new();XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet(matrix),'Products');
   const file=new File([XLSX.write(workbook,{type:'array',bookType:'xlsx'})],'smartstore-current-price.xlsx');
   const event={sku:'SKU-1',source_channel:'smartstore',seller_product_code:'P-1',seller_option_code:'A',event_id:'decision-18900',revision:7,decision_source:'matrix_manual',effective_at:'2026-10-08T00:00:00Z',price:{base:20000,discounted:20000,option:-1100,final:18900,terms:[]}};
   const carrier=[{product_code:'P-1',option_code:'A',base_price:16000,discounted_base_price:16000,option_price:0,final_price:16000,discount_terms:[],source_row_no:2,raw_payload:{source_file_name:file.name,smartstore_basic_discount_value:null,smartstore_basic_discount_unit:null,smartstore_mobile_discount_value:null,smartstore_mobile_discount_unit:null,smartstore_reservation_discount_value:null,smartstore_reservation_discount_unit:null,smartstore_multi_buy_discount_value:null,smartstore_multi_buy_discount_unit:null}}];
   const mapped=[{sku:'SKU-1',product_code:'P-1',option_code:'A',source_row_no:2,active_price_rule:true,current_effective_price:{platformBase:17500,platformDiscount:0,platformOption:0,platformFinal:17500,platformTerms:[],versions:[{rule_version_id:4}]},current_price_decision:event}];
   const rulesPlan=HubCurrentPriceExport.prepareCarrierItems('smartstore',file.name,carrier,mapped,{includeStock:false,includePrice:true});
   const sellpiaPlan=HubCurrentPriceExport.prepareSellpiaSourcePricePlan('smartstore',file.name,carrier,mapped,new Map([['SKU-1',24000]]),['SKU-1'],new Map(),new Map([['SKU-1',event]]));
   async function roundtrip(kind,plan){
    if(plan.items.length!==1)throw Error(`${kind}: expected one price operation, got ${plan.items.length}`);
    const operation=plan.items[0];
    const blob=await SystemV3SellerExport.transformSellerFile(file,[operation]);
    if(blob.skippedItems.length||blob.appliedItems.length!==1)throw Error(`${kind}: SmartStore serializer rejected current tuple`);
    const reparsed=XLSX.read(await blob.blob.arrayBuffer(),{type:'array',raw:true}),sheet=reparsed.Sheets[reparsed.SheetNames[0]],rows=XLSX.utils.sheet_to_json(sheet,{header:1,raw:true});
    return {kind,priceSource:plan.preview?.[0]?.price_state?.code||plan.preview?.[0]?.price_source||operation.pricing_input_mode||'',base:Number(rows[1][5]),option:Number(rows[1][17]),final:Number(rows[1][5])+Number(rows[1][17]),eventId:operation.current_price_decision_proof?.event_id||plan.preview?.[0]?.current_price_decision_proof?.event_id||''};
   }
   return [await roundtrip('rules',rulesPlan),await roundtrip('sellpia_source',sellpiaPlan)];
  });
  assert.deepEqual(results,[
   {kind:'rules',priceSource:'current_price_decision',base:20000,option:-1100,final:18900,eventId:'decision-18900'},
   {kind:'sellpia_source',priceSource:'current_price_decision',base:20000,option:-1100,final:18900,eventId:'decision-18900'}
  ]);
 }finally{await browser.close();}
});
