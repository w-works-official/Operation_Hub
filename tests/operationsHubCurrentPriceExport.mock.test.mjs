import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import '../mockups/operations-hub/discount-price-math.js';
import '../mockups/operations-hub/seller-export-adapter.js';
import '../mockups/operations-hub/current-price-export.js';
let JSZip=null;
try { ({default:JSZip}=await import('jszip')); } catch {}
const api=globalThis.HubCurrentPriceExport,clone=value=>structuredClone(value),sources=['smartstore','makeshop','ably'];
const forbidden=name=>()=>{throw Error('Export must not call '+name);};
globalThis.HubPlatformRules=new Proxy({}, {get:(_,name)=>forbidden('HubPlatformRules.'+String(name))});
globalThis.HubRuleRegistry=new Proxy({}, {get:(_,name)=>forbidden('HubRuleRegistry.'+String(name))});
function fixture(){
 const calls=[];
 const rows=sources.flatMap(source=>['A','B','C','D'].map((sku,i)=>({sellpia_sku_code:sku,source_channel:source,seller_product_code:i<2?'P':'Q',seller_option_code:sku,base_price:i<2?5000:9000,discounted_base_price:i<2?5000:9000,option_price:i%2?2000:0,final_price:5000+i*2000,discount_terms:[],rule_versions:[{id:'stored-rule',version:9}],price_version:9,generation_id:'stored-generation',status:'ready'})));
 const missing=[];
 const originals=Object.fromEntries(sources.map(source=>[source,['A','B','C','D'].map((sku,i)=>({product_code:i<2?'P':'Q',option_code:sku,base_price:9000,discounted_base_price:9000,option_price:0,final_price:9000,discount_terms:[],source_row_no:i+2,raw_payload:{source_file_name:source+'.csv'}}))]));
 const files=new Map(sources.map(source=>[source,[{name:source+'.csv'}]]));
 globalThis.SystemV3Data={
  async loadCarrierSellerMappings({source}){return {rows:clone(rows.filter(r=>r.source_channel===source).map(r=>({sku:r.sellpia_sku_code,product_code:r.seller_product_code,option_code:r.seller_option_code})))};},
  async loadCarrierMatrixTargets({source,skus}){calls.push({source,skus:[...skus]});return {rows:clone(rows.filter(r=>r.source_channel===source&&skus.includes(r.sellpia_sku_code)).map(r=>({
   sku:r.sellpia_sku_code,active_price_rule:true,
   current_effective_price:r.current_error?null:{platformBase:r.base_price,platformDiscount:Number(r.base_price)-Number(r.discounted_base_price),platformOption:r.option_price,platformFinal:r.final_price,platformTerms:r.discount_terms,versions:r.rule_versions},
   current_effective_error:r.current_error||(r.final_price===null||r.final_price===undefined||r.final_price===''||!Number.isFinite(Number(r.final_price))?'현재 가격 target 계산 실패':null)
  })))};},
  ruleRegistry:forbidden('ruleRegistry'),workDocument:forbidden('workDocument'),loadFormulaProducts:forbidden('loadFormulaProducts'),loadRulePlatformSiblings:forbidden('loadRulePlatformSiblings'),loadAllFilteredSkus:forbidden('loadAllFilteredSkus'),loadProductsBySkus:forbidden('loadProductsBySkus')
 };
 globalThis.SystemV3SellerParsers={parseSellerFiles:async(source,files)=>{assert.equal(files[0].name,source+'.csv');return {normalizedRows:clone(originals[source])};}};
 const stock={export_item_id:91,sellpia_sku_code:'A',source_channel:'ably',field_key:'sellpia_current_stock',seller_product_code:'P',seller_option_code:'A',source_file_name:'ably.csv',source_row_no:2,expected_source_value:40,after_value:7};
 return {calls,rows,missing,originals,files,stock};
}
{
 const f=fixture(),stored=f.rows.find(r=>r.source_channel==='ably'&&r.sellpia_sku_code==='A');Object.assign(stored,{base_price:5000,discounted_base_price:4800,option_price:300,final_price:5100,discount_terms:[{term_key:'basic',value:200,unit:'amount',is_baseline:true}],error:'3일 전 materialization timeout'});
 const r=await api.refreshItems([f.stock],f.files,{sources:['ably'],skus:['A']});assert.deepEqual(r.excludedItems,[]);assert.equal(r.items[0],f.stock);
 const i=r.items[1];assert.deepEqual([i.target_base_price,i.target_discounted_base_price,i.target_option_price,i.target_final_price],[5000,4800,300,5100]);assert.equal(i.expected_source_value,9000);assert.equal(i.stored_matrix_price,true);assert.deepEqual(i.rule_versions,[{id:'stored-rule',version:9}]);assert.equal(i.generation_id,undefined,'historical materialization generation is not an export prerequisite');assert.equal(r.excludedItems.length,0,'historical timeout is diagnostic and does not retain the original when current target is complete');assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].skus,['A'],'the authoritative selected scope is evaluated without widening to sibling Rules');
 stored.option_price=-300;stored.final_price=4500;const next=await api.refreshItems([],f.files,{sources:['ably'],skus:['A']});assert.equal(next.items[0].target_option_price,-300);assert.equal(next.items[0].target_final_price,4500,'current effective projection is recomputed without materialization');
}
{
 const f=fixture(),all=await api.refreshItems([],f.files,{});assert.equal(all.items.length,9,'unchanged current targets produce no operation');assert.equal(all.excludedItems.length,0);assert.equal(f.calls.length,3);assert.ok(f.calls.every(call=>call.skus.length===4),'each carrier is evaluated from its bounded mapped SKU set');
 const queue=[{...f.stock,field_key:'sellpia_sale_price',target_final_price:6200}],explicit=await api.refreshItems(queue,new Map(),{includeRules:false});assert.equal(explicit.items[0],queue[0]);assert.equal(f.calls.length,3,'explicit queue must not call any price read or calculation');
 const empty=await api.refreshItems([f.stock],new Map(),{skus:[]});assert.deepEqual(empty.items,[f.stock]);assert.equal(f.calls.length,3);
}
{
 const f=fixture();f.rows.find(r=>r.source_channel==='ably'&&r.sellpia_sku_code==='A').current_error='current price error';f.rows.find(r=>r.source_channel==='ably'&&r.sellpia_sku_code==='B').final_price=null;
 f.missing.push({source_channel:'ably',sellpia_sku_code:'MISSING',reason:'not materialized'});
 const stale={...f.stock,field_key:'sellpia_sale_price',after_value:99999},r=await api.refreshItems([f.stock,stale],f.files,{sources:['ably']});
 assert.equal(r.items[0],f.stock);assert.deepEqual(r.items.filter(i=>i.field_key==='sellpia_sale_price').map(i=>i.sellpia_sku_code),['D'],'unchanged C produces no operation');assert.equal(r.excludedItems.length,2);assert.ok(!r.excludedItems.some(e=>/not materialized/.test(e.reason)),'a wholly uncalculated row keeps the original and is not an exclusion');assert.ok(!r.items.some(i=>i.after_value===99999),'current target errors must not reuse a stale prepared price');
}
{
 const f=fixture();const a=f.rows.find(r=>r.source_channel==='ably'&&r.sellpia_sku_code==='A');f.rows.push({...a,sellpia_sku_code:'SAME'});const r=await api.refreshItems([],f.files,{sources:['ably']});assert.equal(r.items.length,2);assert.equal(r.excludedItems.length,1);assert.ok(r.items.every(i=>i.seller_option_code!=='A'),'identity ambiguity blocks the carrier row even when values happen to match');
 f.rows.at(-1).option_price=100;f.rows.at(-1).final_price=5100;const conflict=await api.refreshItems([],f.files,{sources:['ably']});assert.equal(conflict.excludedItems.length,1);assert.ok(conflict.items.every(i=>i.seller_option_code!=='A'));
}
{
 const f=fixture();f.originals.makeshop.push({product_code:'P',option_code:'',base_price:9000,final_price:null,source_row_no:1,raw_payload:{source_file_name:'makeshop.csv'}});
 const r=await api.refreshItems([],f.files,{sources:['makeshop'],skus:['A']});assert.equal(r.items.length,2);assert.equal(r.excludedItems.length,0);
 const preserved=r.items.find(item=>item.preserve_unmapped);assert.equal(preserved.seller_option_code,'B');assert.equal(preserved.target_base_price,5000);assert.equal(preserved.target_option_price,4000);assert.equal(preserved.target_final_price,9000);assert.equal(preserved.sellpia_sku_code,null,'unmapped original final preserved without inventing SKU');assert.ok(r.items.every(item=>item.seller_option_code),'Makeshop structural parent is not an option preservation target');
 const one=f.rows.find(r=>r.source_channel==='makeshop'&&r.sellpia_sku_code==='A');Object.assign(one,{base_price:9000,discounted_base_price:9000,option_price:100,final_price:9100});
 const optionOnly=await api.refreshItems([],f.files,{sources:['makeshop'],skus:['A']});assert.equal(optionOnly.items.length,1,'same base option-only change does not require unrelated stored siblings');
}
{
 const f=fixture(),count=23760;f.rows.length=0;f.originals.ably.length=0;
 for(let n=0;n<count;n++){f.rows.push({source_channel:'ably',sellpia_sku_code:'SKU-'+n,seller_product_code:'P'+n,seller_option_code:'1',base_price:1000,discounted_base_price:1000,option_price:0,final_price:1000,discount_terms:[]});f.originals.ably.push({product_code:'P'+n,option_code:'1',base_price:9000,discounted_base_price:9000,option_price:0,final_price:9000,discount_terms:[],source_row_no:n+2,raw_payload:{source_file_name:'ably.csv'}});}
 const r=await api.refreshItems([],f.files,{sources:['ably']});assert.equal(r.items.length,count);assert.equal(r.excludedItems.length,0);assert.equal(f.calls.length,1);assert.equal(new Set(r.items.map(i=>i.export_item_id)).size,count);
}

// Real serializer integration: one bad option rolls its entire price group back,
// while the original stock change and another product remain in the final ZIP.
const xlsxPath=process.env.XLSX_BROWSER_SCRIPT||new URL('../../xlsx.full.min.js',import.meta.url);
if(JSZip&&existsSync(xlsxPath)){
 const source=await readFile(xlsxPath,'utf8');const sandbox={module:{exports:{}},exports:{},require:createRequire(import.meta.url)};sandbox.exports=sandbox.module.exports;vm.runInNewContext(source,sandbox);globalThis.XLSX=sandbox.module.exports;
 // JSZip's Node runtime cannot read Blob directly; adapt transport only, retaining its real ZIP implementation.
 class NodeZip extends JSZip{file(name,value,...args){return super.file(name,value instanceof Blob?value.arrayBuffer().then(b=>new Uint8Array(b)):value,...args);}}
 globalThis.JSZip=NodeZip;
 const rows=[Array.from({length:16},(_,i)=>'header'+i),...['A','B','C'].map(sku=>{const row=Array(16).fill('');row[0]=sku==='C'?'Q':'P';row[2]='원본 상품';row[4]=9000;row[5]=9000;row[6]=9000;row[10]=sku;row[14]='원본 옵션';row[15]=40;return row;})];
 const csv=XLSX.utils.sheet_to_csv(XLSX.utils.aoa_to_sheet(rows));const file=new File([csv],'ably.csv',{type:'text/csv'}),files=new Map([['ably',[file]]]);
 const item=(sku,index)=>({export_item_id:index,sellpia_sku_code:sku,source_channel:'ably',field_key:'sellpia_sale_price',seller_product_code:sku==='C'?'Q':'P',seller_option_code:sku,source_file_name:'ably.csv',source_row_no:index+1,expected_source_value:sku==='B'?12345:9000,after_value:5000,target_base_price:5000,target_discounted_base_price:5000,target_option_price:0,target_final_price:5000,target_discount_terms:[],rule_generated:true});
 const stock={...item('A',1),export_item_id:91,field_key:'sellpia_current_stock',expected_source_value:40,after_value:7,rule_generated:false};
 const archive=await api.buildArchive(files,[stock,item('A',1),item('B',2),item('C',3)]);
 assert.deepEqual(archive.appliedItems.map(i=>[i.sellpia_sku_code,i.field_key]),[['A','sellpia_current_stock'],['C','sellpia_sale_price']]);assert.equal(archive.skippedItems.length,2);assert.ok(archive.skippedItems.every(e=>/상품 묶음 전체 제외/.test(e.reason)));
 const zip=await JSZip.loadAsync(await archive.blob.arrayBuffer()),output=await zip.file('ably_SystemV3반영.csv').async('string'),book=XLSX.read(output,{type:'string',raw:true}),actual=XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]],{header:1,raw:true});
 assert.equal(Number(actual[1][6]),9000,'already serialized A price restored from original after sibling failure');assert.equal(Number(actual[2][6]),9000);assert.equal(Number(actual[3][6]),5000,'unrelated valid group retained');assert.equal(Number(actual[1][15]),7,'stock change survives group price rollback');assert.equal(await file.text(),csv,'original source file unchanged');

 const alreadyExcluded={item:item('B',2),export_item_id:2,reason:'SKU 계산 오류: 테스트 제외'};
 const prefiltered=await api.buildArchive(files,[item('A',1),item('C',3)],undefined,[alreadyExcluded]);
 assert.deepEqual(prefiltered.appliedItems.map(i=>i.sellpia_sku_code),['A','C'],'a pre-calculation exclusion must not roll back its valid sibling');
 assert.equal(prefiltered.skippedItems.filter(e=>e.export_item_id===2).length,1);
 const savedFixture=fixture(),saved=savedFixture.rows.find(row=>row.source_channel==='ably'&&row.sellpia_sku_code==='A');
 Object.assign(saved,{base_price:5000,discounted_base_price:4800,option_price:300,final_price:5100,discount_terms:[{term_key:'basic',value:200,unit:'amount',is_baseline:true}]});
 const converted=await api.refreshItems([savedFixture.stock],files,{sources:['ably'],skus:['A']});
 const storedArchive=await api.buildArchive(files,converted.items,undefined,converted.excludedItems);
 const storedZip=await JSZip.loadAsync(await storedArchive.blob.arrayBuffer()),storedCsv=await storedZip.file('ably_SystemV3반영.csv').async('string'),storedBook=XLSX.read(storedCsv,{type:'string',raw:true}),storedRows=XLSX.utils.sheet_to_json(storedBook.Sheets[storedBook.SheetNames[0]],{header:1,raw:true});
 assert.deepEqual(Array.from(storedRows[1].slice(4,7),Number),[5000,4800,5100],'real serialized CSV must contain stored matrix values, not recalculated values');
 assert.equal(Number(storedRows[1][15]),7);assert.equal(storedArchive.appliedItems.length,2);assert.equal(storedArchive.skippedItems.length,0);
 for(let r=1;r<rows.length;r++)for(let col=0;col<rows[r].length;col++)if(r!==1||![4,5,6,15].includes(col))assert.equal(storedRows[r][col]??'',String(rows[r][col]),'unrelated actual CSV cell preserved');
}
console.log('PASS current effective export: bounded carrier mapping; current tuple without materialization gate; exact selected scope; sibling-final preservation; identity conflicts blocked; 23760 rows; actual CSV/ZIP group rollback and stock preservation.');
