import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

// Independent release contracts: use real official OOXML and reopen all values.
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
const JSZip=require('./vendor/jszip-3.10.1.min.js');
const XLSX=require('./vendor/xlsx-0.18.5.full.min.js');
const official=fs.readFileSync(path.join(repo,'mockups/operations-hub/ably-inventory-template.xlsx'));
class TestFile extends Blob{constructor(parts,name,options={}){super(parts,options);this.name=name;}}

function loadExporter(){
 const context={console,Blob,File:TestFile,JSZip,XLSX,Map,Set,Number,String,JSON,RegExp,Error,Promise,Uint8Array,ArrayBuffer,TextEncoder,TextDecoder,Date,Math};
 context.globalThis=context;context.window=context;vm.createContext(context);
 for(const name of ['sellpia-inventory-count','ably-inventory-export'])vm.runInContext(fs.readFileSync(path.join(repo,`mockups/operations-hub/${name}.js`),'utf8'),context,{filename:name+'.js'});
 return context.HubAblyInventoryExport;
}
const exporter=loadExporter();
function loadPricePlanner(){
 const context={console,Map,Set,Number,String,JSON,RegExp,Error,Promise,Date,Math};context.globalThis=context;context.window=context;vm.createContext(context);
 for(const name of ['discount-price-math','sellpia-inventory-count','current-price-export'])vm.runInContext(fs.readFileSync(path.join(repo,`mockups/operations-hub/${name}.js`),'utf8'),context,{filename:name+'.js'});
 return context.HubCurrentPriceExport;
}
const pricePlanner=loadPricePlanner();
const template=()=>new TestFile([official],'official.xlsx');
const shared=(code,sku='SKU-A',option=code)=>({solution_code:code,sellpia_sku_code:sku,product_code:'PRODUCT-1',option_code:option,mapping_state:'verified',stock_policy:'shared',individual_stock:null,suppression_active:false,is_active:true});
const snapshot={snapshotId:'authoritative-1',bySku:new Map([['SKU-A',{sellpia_current_stock:12,sellpia_available_stock:-7}],['SKU-B',{sellpia_current_stock:21,sellpia_available_stock:18}]])};
const plain=value=>JSON.parse(JSON.stringify(value));
async function sheetXml(zip){
 const book=await zip.file('xl/workbook.xml').async('string');
 const rid=book.match(/<sheet\b[^>]*r:id="([^"]+)"/)?.[1];
 const rels=await zip.file('xl/_rels/workbook.xml.rels').async('string');
 const relationship=[...rels.matchAll(/<Relationship\b[^>]*>/g)].map(match=>match[0]).find(row=>row.includes(`Id="${rid}"`));
 const target=relationship.match(/Target="([^"]+)"/)?.[1];
 const name=target.startsWith('/')?target.slice(1):`xl/${target.replace(/^\.\//,'')}`;
 return {name,xml:await zip.file(name).async('string')};
}
function withoutDataCells(xml){return xml.replace(/<c\b[^>]*r="[AB](\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g,(cell,row)=>Number(row)>1?'':cell);}
function groupedPriceFixture(targetBase,targetOption){
 const originals=[['O-A',50],['O-B',100]].map(([option,optionPrice],index)=>({product_code:'P-SHARED',option_code:option,source_row_no:index+2,stock:index+1,base_price:1000,discounted_base_price:1000,option_price:optionPrice,final_price:1000+optionPrice,discount_terms:[],raw_payload:{source_file_name:'grouped.xlsx'}}));
 const mappings=originals.map((row,index)=>({sku:index?'SKU-B':'SKU-A',product_code:row.product_code,option_code:row.option_code,export_scope_selected:index===0,sellpia_current_stock:7+index,sellpia_available_stock:7+index,active_price_rule:true,current_effective_price:{platformBase:9000,platformDiscount:0,platformOption:0,platformFinal:9000,platformTerms:[]},price_draft:{price_base_after:8000,price_discounted_base_after:8000,price_option_after:0,price_final_after:8000},current_price_decision:{event_id:index?'unselected-current':'latest-manual-9',revision:9,decision_source:'matrix_manual',effective_at:'2026-10-08T01:00:00Z',price:index?{base:9000,discounted:9000,option:0,final:9000,terms:[]}:{base:targetBase,discounted:targetBase,option:targetOption,final:targetBase+targetOption,terms:[]}}}));
 return {originals,mappings};
}

test('integrated partial SKU shared-base change preserves both prices and retains the selected independent stock change',()=>{
 const fixture=groupedPriceFixture(1500,50),plan=pricePlanner.prepareCarrierItems('smartstore','grouped.xlsx',fixture.originals,fixture.mappings,{includePrice:true,includeStock:true,stockSource:'available_stock'});
 assert.deepEqual(plain(plan.operations.map(item=>[item.sellpia_sku_code,item.field_key,item.after_value])),[['SKU-A','sellpia_current_stock',7]]);
 assert.equal(plan.preview[0].shared_price_warning,true);assert.equal(plan.preview[0].diff.price.after.final,1050);assert.equal(plan.preview[1].diff.price.after.final,1100);assert.equal(plan.preview[1].diff.stock.after,2);
 assert.equal(plan.preview[1].export_scope_selected,false);assert.equal(plan.preview[1].disposition,'context');assert.equal(plan.summary.blocked,0);
});

test('integrated partial SKU option-only change is allowed and the latest current decision outranks draft and calculated values',()=>{
 const fixture=groupedPriceFixture(1000,250),plan=pricePlanner.prepareCarrierItems('smartstore','grouped.xlsx',fixture.originals,fixture.mappings,{includePrice:true,includeStock:true,stockSource:'available_stock'});
 const prices=plan.operations.filter(item=>item.field_key==='sellpia_sale_price');assert.equal(prices.length,1);assert.equal(prices[0].sellpia_sku_code,'SKU-A');assert.equal(prices[0].target_base_price,1000);assert.equal(prices[0].target_option_price,250);assert.equal(prices[0].target_final_price,1250);assert.equal(prices[0].current_price_decision_proof.event_id,'latest-manual-9');assert.equal(prices[0].current_price_decision_proof.revision,9);
 assert.equal(plan.preview[0].shared_price_warning,undefined);assert.equal(plan.preview[1].diff.price.after.final,1100);assert.equal(plan.preview[1].diff.stock.after,2);assert.equal(plan.summary.blocked,0);
});

test('integrated official template is the byte-identical supplied AB template',async()=>{
 assert.equal(createHash('sha256').update(official).digest('hex'),'6ec1171b1c4a4e9c19468d17c7d593241f4d1b08370f2a945fb31f52daa24e5a');
 const inspected=await exporter.validateTemplate(template());
 assert.equal(inspected.sheetName,'재고 수량 수정_양식');assert.equal(inspected.capacity,1001);
});

test('integrated fanout writes each literal solution code independently and clamps only available stock',()=>{
 const rows=[shared('000123'),shared('123'),shared('J<&"한글'),{...shared('INDIVIDUAL','SKU-B'),stock_policy:'individual',individual_stock:0}];
 const available=exporter.prepare({mappingRows:rows,stockSources:snapshot,stockSource:'available_stock'});
 const real=exporter.prepare({mappingRows:rows,stockSources:snapshot,stockSource:'stock'});
 assert.deepEqual(plain(available.rows.map(row=>[row.solution_code,row.sellpia_sku_code,row.quantity])),[['000123','SKU-A',0],['123','SKU-A',0],['J<&"한글','SKU-A',0],['INDIVIDUAL','SKU-B',0]]);
 assert.deepEqual(plain(real.rows.map(row=>row.quantity)),[12,12,12,0]);
 assert.equal(snapshot.bySku.get('SKU-A').sellpia_available_stock,-7,'source snapshot remains the authoritative negative value');
});

test('integrated excluded, suppressed, review and uncertain stock are reported without zero writes, including all-blocked official output',async()=>{
 const rows=[shared('SAFE'),{...shared('EXCLUDED'),stock_policy:'excluded'},{...shared('SUPPRESSED'),suppression_active:true},{...shared('REVIEW'),mapping_state:'review'},{...shared('NULL'),stock_policy:'individual',individual_stock:null},{...shared('FRACTION'),stock_policy:'individual',individual_stock:1.5}];
 const result=exporter.prepare({mappingRows:rows,stockSources:snapshot,stockSource:'stock'});
 assert.deepEqual(plain(result.rows.map(row=>[row.solution_code,row.quantity])),[['SAFE',12]]);
 assert.equal(result.summary.reviewCount,3);assert.equal(result.summary.excludedCount,2);
 const unavailable=exporter.prepare({mappingRows:[shared('MISSING','UNKNOWN'),{...shared('MISSING-INDIVIDUAL','UNKNOWN','other'),stock_policy:'individual',individual_stock:0}],stockSources:snapshot,stockSource:'stock'});
 assert.equal(unavailable.rows.length,0);assert.equal(unavailable.excludedRows.length,2);
 assert.deepEqual(plain(unavailable.excludedRows.map(row=>[row.solution_code,row.status])),[['MISSING','snapshot_sku_missing'],['MISSING-INDIVIDUAL','snapshot_sku_missing']]);
 const output=await exporter.build({plan:unavailable,templateFile:template()}),reopened=XLSX.read(await output.blob.arrayBuffer(),{type:'array'}).Sheets['재고 수량 수정_양식'];
 assert.equal(output.rowCount,0);assert.equal(reopened.A1.v,'솔루션사 고유코드');assert.equal(reopened.B1.v,'재고 수량');
 assert.equal(Object.entries(reopened).filter(([ref,cell])=>/^[AB]\d+$/.test(ref)&&Number(ref.match(/\d+/)[0])>1&&cell.v!==undefined&&cell.v!=='').length,0);
});

test('integrated inverse seller option ambiguity fails closed even with two unique solution codes',()=>{
 const rows=[shared('J-1','SKU-A','same-option'),shared('J-2','SKU-B','same-option')];
 const readiness=exporter.readiness({mappingRows:rows});
 assert.equal(readiness.ready,false,'one seller product/option must not select two underlying SKUs');
 assert.throws(()=>exporter.prepare({mappingRows:rows,stockSources:snapshot,stockSource:'stock'}),/여러 SKU|중복|충돌|ambigu|option/i);
});

test('integrated duplicate rawcodes in review do not block unrelated verified export rows',()=>{
 const rows=[shared('SAFE'),{...shared('RAW-DUPLICATE','SKU-A','review-1'),mapping_state:'review'},{...shared('RAW-DUPLICATE','SKU-B','review-2'),mapping_state:'review'}];
 const readiness=exporter.readiness({mappingRows:rows});assert.equal(readiness.ready,true);assert.equal(readiness.reviewCount,2);
 const plan=exporter.prepare({mappingRows:rows,stockSources:snapshot,stockSource:'stock'});assert.deepEqual(plain(plan.rows.map(row=>row.solution_code)),['SAFE']);
});

test('integrated one seller option with two solution codes remains ambiguous even with one SKU',()=>{
 const rows=[shared('J-1','SKU-A','same-option'),shared('J-2','SKU-A','same-option')];
 assert.equal(exporter.readiness({mappingRows:rows}).ready,false);
});

test('integrated 1205-row official template output reopens every code and quantity and preserves every package part',async()=>{
 const rows=Array.from({length:1205},(_,index)=>({...shared(`00-${String(index).padStart(5,'0')}`,'SKU-A',`OPTION-${index}`),stock_policy:'individual',individual_stock:index%43}));
 const plan=exporter.prepare({mappingRows:rows,stockSources:snapshot,stockSource:'stock'});
 const output=await exporter.build({plan,templateFile:template()});
 const bytes=await output.blob.arrayBuffer(),reopened=XLSX.read(bytes,{type:'array'});
 assert.deepEqual(reopened.SheetNames,['재고 수량 수정_양식']);
 const sheet=reopened.Sheets[exporter.SHEET_NAME];
 assert.equal(output.rowCount,1205);assert.equal(sheet['!ref'],'A1:K1206');
 for(let index=0;index<rows.length;index++){
  assert.equal(sheet[`A${index+2}`].v,rows[index].solution_code,`exact code at ${index+2}`);
  assert.equal(sheet[`A${index+2}`].t,'s',`text type at ${index+2}`);
  assert.equal(sheet[`B${index+2}`].v,rows[index].individual_stock,`exact stock at ${index+2}`);
  assert.equal(sheet[`B${index+2}`].t,'n',`numeric type at ${index+2}`);
 }
 const before=await JSZip.loadAsync(official),after=await JSZip.loadAsync(bytes);
 const originalSheet=await sheetXml(before),outputSheet=await sheetXml(after);
 assert.deepEqual(Object.keys(after.files).sort(),Object.keys(before.files).sort(),'no package parts are discarded or introduced');
 for(const name of Object.keys(before.files))if(!before.files[name].dir&&name!==originalSheet.name)assert.deepEqual(await after.file(name).async('uint8array'),await before.file(name).async('uint8array'),`unchanged OOXML part ${name}`);
 const originalRows=[...withoutDataCells(originalSheet.xml).matchAll(/<row\b[^>]*r="(\d+)"[^>]*>[\s\S]*?<\/row>/g)];
 const outputRows=new Map([...withoutDataCells(outputSheet.xml).matchAll(/<row\b[^>]*r="(\d+)"[^>]*>[\s\S]*?<\/row>/g)].map(match=>[match[1],match[0]]));
 for(const row of originalRows)assert.equal(outputRows.get(row[1]),row[0],`all non-AB content and row attributes at ${row[1]} preserved`);
 const style=(xml,address)=>xml.match(new RegExp(`<c\\b[^>]*r="${address}"[^>]*>`))?.[0].match(/\bs="([^"]+)"/)?.[1];
 assert.equal(style(outputSheet.xml,'A1206'),style(originalSheet.xml,'A2'));
 assert.equal(style(outputSheet.xml,'B1206'),style(originalSheet.xml,'B2'));
});

test('integrated template validation rejects a populated AB body before generation',async()=>{
 const zip=await JSZip.loadAsync(official),sheet=await sheetXml(zip);
 const populated=sheet.xml.replace(/<c\b([^>]*r="A2"[^>]*?)(?:\/>|>[\s\S]*?<\/c>)/,'<c r="A2" s="1" t="inlineStr"><is><t>STALE-CODE</t></is></c>');
 zip.file(sheet.name,populated);
 await assert.rejects(exporter.validateTemplate(new TestFile([await zip.generateAsync({type:'uint8array'})],'dirty.xlsx')),/비어 있지 않습니다/);
});
