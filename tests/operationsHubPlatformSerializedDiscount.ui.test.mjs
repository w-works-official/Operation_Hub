import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {chromium} from 'playwright';
const require=createRequire(import.meta.url),root=new URL('../mockups/operations-hub/',import.meta.url);
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage();await page.route('**/*',r=>r.abort());await page.setContent('<html><body>Isolated platform export QA</body></html>');
 await page.addScriptTag({content:fs.readFileSync(process.env.XLSX_BROWSER_SCRIPT||new URL('../../xlsx.full.min.js',import.meta.url),'utf8')});
 await page.addScriptTag({content:fs.readFileSync(require.resolve('jszip/dist/jszip.min.js'),'utf8')});
 for(const name of ['discount-price-math.js','rule-registry.js','platform-rule-service.js','seller-source-parsers.js','seller-export-adapter.js'])await page.addScriptTag({content:fs.readFileSync(new URL(name,root),'utf8')});
 const reports=await page.evaluate(async()=>{
  const reports=[];
  for(const source of ['smartstore','makeshop','ably']){
   const width=source==='smartstore'?68:source==='makeshop'?124:29,header=Array(width).fill(''),rows=[];
   if(source==='smartstore'){
    header[0]='상품번호';header[1]='판매자 상품코드';header[18]='옵션 재고수량';
    const r=Array(width).fill('');r[0]='12345';r[1]='sellpia_1000';r[3]='공유 상품';r[5]=15000;r[15]='op1\nop2';r[16]='6mm\n8mm';r[17]='0\n2000';r[18]='10\n20';r[19]='Y\nY';rows.push(r);
   }else if(source==='makeshop'){
    header[4]='product_uid';header[32]='sto_stock';header[44]='sell_price';
    for(let i=0;i<2;i++){const r=Array(width).fill('');if(!i){r[4]='12345';r[12]='공유 상품';r[20]='6mm,8mm';r[21]='0,2000';r[44]=15000;}r[29]=i?'8mm':'6mm';r[31]=i*2000;r[32]=10;r[41]='판매';r[43]='op'+(i+1);rows.push(r);}
   }else{
    header[0]='상품 번호';header[10]='옵션 번호';header[15]='재고수량';
    for(let i=0;i<2;i++){const r=Array(width).fill('');r[0]='12345';r[1]='1000';r[2]='공유 상품';r[4]=15000;r[5]=15000;r[6]=15000+i*2000;r[10]='op'+(i+1);r[14]=i?'8mm':'6mm';r[15]=10;rows.push(r);}
   }
   const sheet=XLSX.utils.aoa_to_sheet([header,...rows]),book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,sheet,'상품');
   const name=source+(source==='ably'?'.csv':'.xlsx'),file=new File([source==='ably'?XLSX.utils.sheet_to_csv(sheet):XLSX.write(book,{bookType:'xlsx',type:'array'})],name);
   const parsed=await SystemV3SellerParsers.parseSellerFiles(source,[file],{price:true,discount:true,basic:true,inventory:true});
   const rule=(id,target,input,op)=>({id,name:id,is_active:true,version:1,target_field:target,source_field:input,input_origin:'self',scope:source,config:{steps:[{op,value:2000}],unit:1,rounding:'nearest'}});
   const registry={rules:[rule('registration','platform_registration_price','calculated_base_price','add'),rule('discount','platform_discount_price','platform_registration_price','subtract')],assignments:[],dependencies:[]};
   const settings={source,mode:'forward',anchor:'lowest',registration_rule_id:'registration',discount_rule_id:'discount'};
   const calculated=HubPlatformRules.compose(parsed.normalizedRows.map((r,i)=>({sku:'1000-'+(i+1),value:15000+i*2000,discountTerms:r.discount_terms,component:{seller_product_code:r.product_code,seller_option_code:r.option_code}})),settings,registry);
   const items=HubPlatformRules.itemsFromCalculation({source,rows:calculated},parsed.normalizedRows);
   const directArchive=await SystemV3SellerExport.buildExportArchive(new Map([[source,[file]]]),items);
   const logs=[];
   window.SystemV3Data={
    ruleRegistry:async()=>registry,
    workDocument:async(action,kind,payload)=>action==='list'?[{id:'config',title:'registry-platform:'+source}]:['get','get_title'].includes(action)?{id:'config',title:'registry-platform:'+source,version:1,body:settings}:(logs.push(payload),payload),
    loadRulePlatformSiblings:async()=>['1000-1','1000-2'],
    loadFormulaProducts:async()=>parsed.normalizedRows.map((r,i)=>({sellpia_sku_code:'1000-'+(i+1),system_base_price:15000+i*2000,__sellerPriceComponents:{[source]:{seller_product_code:r.product_code,seller_option_code:r.option_code,source_discount_terms:r.discount_terms}}})),
    downloadLatestSellerOriginals:async()=>new Map([[source,[file]]])
   };
   if(!crypto.randomUUID)crypto.randomUUID=()=> 'qa-export';
   const archive=await HubPlatformRules.exportLatest(['1000-1'],source);
   if(directArchive.appliedItems.length!==2||logs.length!==1)throw Error(source+' direct export / service audit failed');
   const zip=await JSZip.loadAsync(await archive.blob.arrayBuffer()),outName=archive.manifest[0].output_name,bytes=await zip.file(outName).async('uint8array');
   const outFile=new File([bytes],name),reparsed=await SystemV3SellerParsers.parseSellerFiles(source,[outFile],{price:true,discount:true,basic:true,inventory:true});
   const outputBook=source==='ably'?XLSX.read(await outFile.text(),{type:'string'}):XLSX.read(bytes,{type:'array'}),outputSheet=outputBook.Sheets[outputBook.SheetNames[0]];
   const addresses=source==='smartstore'?['F2','BF2','BG2','R2']:source==='makeshop'?['AS2','DD2','AF2','AF3']:['E2','F2','G2','E3','F3','G3'];
   reports.push({source,format:source==='ably'?'csv':'xlsx',cells:Object.fromEntries(addresses.map(a=>[a,outputSheet[a]?.v??''])),applied:archive.appliedItems.length,skipped:archive.skippedItems.map(i=>i.reason),calculated:calculated.map(r=>[r.platformBase,r.platformOption,r.platformDiscount,r.platformFinal]),parsed:reparsed.normalizedRows.map(r=>[r.base_price,r.option_price,r.discounted_base_price,r.final_price]),terms:reparsed.normalizedRows[0].discount_terms.map(t=>[t.term_key,t.value,t.unit]),targetTerm:calculated[0].platformTerms[0]?.term_key});
  }
  return reports;
 });
 console.log(JSON.stringify(reports,null,2));
 for(const report of reports){
  assert.equal(report.applied,2,report.source+' must serialize both options');assert.deepEqual(report.skipped,[],report.source+' conflicts');
  assert.deepEqual(report.calculated,[[17000,0,2000,15000],[17000,2000,2000,17000]],report.source+' compose');
  assert.deepEqual(report.parsed.map(r=>r[3]),[15000,17000],report.source+' reparsed final prices');
  assert.deepEqual(report.parsed.map(r=>r[2]),[15000,15000],report.source+' reparsed discounted base');
  assert.equal(report.terms[0][1],2000,report.source+' serialized discount amount');
  if(report.source!=='ably')assert.deepEqual(report.parsed.map(r=>r[1]),[0,2000],report.source+' serialized option adjustments');
 }
 const smart=reports.find(r=>r.source==='smartstore'),make=reports.find(r=>r.source==='makeshop'),ably=reports.find(r=>r.source==='ably');
 assert.deepEqual(smart.cells,{F2:17000,BF2:2000,BG2:'원',R2:'0\n2000'});
 assert.equal(make.cells.AS2,17000);assert.match(make.cells.DD2,/2000원/);assert.deepEqual([make.cells.AF2,make.cells.AF3],[0,2000]);
 assert.deepEqual(ably.cells,{E2:17000,F2:15000,G2:15000,E3:17000,F3:15000,G3:17000});
 // Ably's native 29-column CSV records final outcomes; it has no separate option-price column.
 assert.equal(ably.cells.G3-ably.cells.F3,2000);
 console.log('PASS original exporter + registry + platform service: registration +2000 / discount -2000 serialized Smartstore and Makeshop XLSX, Ably native CSV, reparsed final prices. Ably option delta verified as G-F; no separate option-price field.');
}finally{await browser.close();}
