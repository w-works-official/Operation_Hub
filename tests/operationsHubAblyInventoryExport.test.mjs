import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const require=createRequire(import.meta.url),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const JSZip=require('./vendor/jszip-3.10.1.min.js'),XLSX=require('./vendor/xlsx-0.18.5.full.min.js');
const source=fs.readFileSync(path.join(root,'mockups/operations-hub/ably-inventory-export.js'),'utf8');
const templateBytes=fs.readFileSync(path.join(root,'mockups/operations-hub/ably-inventory-template.xlsx'));
class TestFile extends Blob{constructor(parts,name,options={}){super(parts,options);this.name=name;}}
const context={console,Blob,File:TestFile,JSZip,XLSX,Map,Set,Number,String,JSON,RegExp,Error,Promise,Uint8Array,ArrayBuffer,TextEncoder,TextDecoder,Date,Math};
context.window=context;
context.SystemV3SellpiaInventoryCount={resolveExportStock(row,stockSource){const value=stockSource==='stock'?row.sellpia_current_stock:row.sellpia_available_stock;return Number.isSafeInteger(Number(value))?stockSource==='available_stock'?Math.max(0,Number(value)):Number(value):null;}};
vm.createContext(context);vm.runInContext(source,context,{filename:'ably-inventory-export.js'});
const exporter=context.HubAblyInventoryExport;
const shared=(solution_code,sellpia_sku_code,option_code)=>({solution_code,sellpia_sku_code,product_code:`P-${option_code}`,option_code,mapping_state:'verified',stock_policy:'shared',individual_stock:null,suppression_active:false,is_active:true});
const stockSources={snapshotId:'snapshot-1',bySku:new Map([['sku-1',{sellpia_current_stock:8,sellpia_available_stock:-3}],['sku-2',{sellpia_current_stock:5,sellpia_available_stock:4}]])};
function templateFile(){return new TestFile([templateBytes],'official-template.xlsx',{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});}
function xmlSection(xml,name){return xml.match(new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?<\\/${name}>`))?.[0]||'';}

test('mapping readiness excludes review and suppressed rows while retaining multiple solution codes for one SKU',()=>{
 const rows=[shared('code-1','sku-1','red'),shared('code-2','sku-1','blue'),{...shared('code-3','sku-2','one'),stock_policy:'individual',individual_stock:0},{...shared('code-4','sku-1','suppressed'),suppression_active:true},{...shared('code-5','sku-2','review'),mapping_state:'review'}];
 const readiness=exporter.readiness({mappingRows:rows});assert.equal(readiness.ready,true);assert.equal(readiness.eligibleCount,3);assert.equal(readiness.reviewCount,1);assert.equal(readiness.excludedCount,1);
 const plan=exporter.prepare({mappingRows:rows,stockSources,stockSource:'available_stock'});assert.deepEqual(Array.from(plan.rows,row=>[row.solution_code,row.sellpia_sku_code,row.quantity]),[['code-1','sku-1',0],['code-2','sku-1',0],['code-3','sku-2',0]]);assert.equal(plan.summary.reviewCount,1);assert.equal(plan.summary.excludedCount,1);
});

test('duplicate active solution codes fail closed, including identical option rows',()=>{
 const rows=[shared('duplicate','sku-1','red'),shared('duplicate','sku-1','red')];
 const readiness=exporter.readiness({mappingRows:rows});assert.equal(readiness.ready,false);assert.deepEqual(Array.from(readiness.duplicateCodes),['duplicate']);
 assert.throws(()=>exporter.prepare({mappingRows:rows,stockSources,stockSource:'stock'}),/중복 솔루션사 고유코드/);
});

test('shared mapping without an authoritative snapshot SKU fails closed',()=>{
 const rows=[shared('code-1','missing-sku','red')];
 assert.throws(()=>exporter.prepare({mappingRows:rows,stockSources,stockSource:'stock'}),/snapshot에서 SKU를 찾지 못했습니다/);
});

test('official template output retains headings, guidance, merge, validation and row styles',async()=>{
 const rows=[shared('code<&1','sku-1','red'),shared('code-2','sku-1','blue')],plan=exporter.prepare({mappingRows:rows,stockSources,stockSource:'stock'}),output=await exporter.build({plan,templateFile:templateFile()});
 assert.equal(output.fileName,'에이블리_재고 수량 변경.xlsx');assert.equal(output.rowCount,2);assert.equal(output.mappingFingerprint,plan.mappingFingerprint);
 const zip=await JSZip.loadAsync(await output.blob.arrayBuffer()),workbook=XLSX.read(await output.blob.arrayBuffer(),{type:'array'}),sheet=workbook.Sheets['재고 수량 수정_양식'];
 assert.equal(sheet.A1.v,'솔루션사 고유코드');assert.equal(sheet.B1.v,'재고 수량');assert.equal(sheet.A2.v,'code<&1');assert.equal(sheet.B2.v,8);assert.equal(sheet.A3.v,'code-2');assert.equal(sheet.B3.v,8);
 assert.equal(sheet.D1.v,'← 양식의 A,B열 순서를 변경하지 말아주세요.');
 const originalZip=await JSZip.loadAsync(templateBytes),originalWorkbook=await originalZip.file('xl/workbook.xml').async('string'),relationship=[...originalWorkbook.matchAll(/<sheet\b[^>]*>/g)].map(match=>match[0]).find(node=>node.includes('재고 수량 수정_양식'));
 const relId=relationship.match(/r:id="([^"]+)"/)?.[1],rels=await originalZip.file('xl/_rels/workbook.xml.rels').async('string'),target=[...rels.matchAll(/<Relationship\b[^>]*>/g)].map(match=>match[0]).find(node=>node.includes(`Id="${relId}"`)).match(/Target="([^"]+)"/)?.[1],sheetPath=target.startsWith('/')?target.slice(1):`xl/${target.replace(/^\.\//,'')}`;
 const before=await originalZip.file(sheetPath).async('string'),after=await zip.file(sheetPath).async('string');
 assert.equal(xmlSection(after,'mergeCells'),xmlSection(before,'mergeCells'));assert.equal(xmlSection(after,'dataValidations'),xmlSection(before,'dataValidations'));
 for(const address of ['A2','B2'])assert.equal(after.match(new RegExp(`<c\\b[^>]*\\br="${address}"[^>]*>`))?.[0].match(/\bs="([^"]+)"/)?.[1],before.match(new RegExp(`<c\\b[^>]*\\br="${address}"[^>]*>`))?.[0].match(/\bs="([^"]+)"/)?.[1]);
});

test('template body expands with its row 2 cell style and reopens every exact solution code and quantity',async()=>{
 const rows=Array.from({length:1002},(_,index)=>shared(`code-${String(index+1).padStart(4,'0')}`,'sku-1',`option-${index+1}`)),plan=exporter.prepare({mappingRows:rows,stockSources,stockSource:'available_stock'}),output=await exporter.build({plan,templateFile:templateFile()}),reopened=XLSX.read(await output.blob.arrayBuffer(),{type:'array'}).Sheets['재고 수량 수정_양식'];
 assert.equal(output.rowCount,1002);assert.equal(reopened.A1003.v,'code-1002');assert.equal(reopened.B1003.v,0);
 const zip=await JSZip.loadAsync(await output.blob.arrayBuffer()),workbook=await zip.file('xl/workbook.xml').async('string'),relationship=[...workbook.matchAll(/<sheet\b[^>]*>/g)].map(match=>match[0]).find(node=>node.includes('재고 수량 수정_양식')),relId=relationship.match(/r:id="([^"]+)"/)?.[1],rels=await zip.file('xl/_rels/workbook.xml.rels').async('string'),target=[...rels.matchAll(/<Relationship\b[^>]*>/g)].map(match=>match[0]).find(node=>node.includes(`Id="${relId}"`)).match(/Target="([^"]+)"/)?.[1],sheetPath=target.startsWith('/')?target.slice(1):`xl/${target.replace(/^\.\//,'')}`,xml=await zip.file(sheetPath).async('string');
 assert.match(xml,/<dimension\b[^>]*ref="A1:K1003"/);assert.match(xml,/<row\b[^>]*r="1003"/);
 for(const column of ['A','B']){const styleFor=row=>xml.match(new RegExp(`<c\\b[^>]*\\br="${column}${row}"[^>]*>`))?.[0].match(/\bs="([^"]+)"/)?.[1];assert.equal(styleFor(1003),styleFor(2));}
});
