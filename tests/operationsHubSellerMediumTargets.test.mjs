import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(path.join(process.env.CODEX_NODE_MODULES||process.cwd(),'medium.cjs'));
const JSZip=require('jszip');
class TransportZip extends JSZip { file(name,value,...rest){return super.file(name,value instanceof Blob?value.arrayBuffer().then(b=>new Uint8Array(b)):value,...rest);} }
const ctx={console,Blob,File,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,JSZip:TransportZip,XLSX:{}};vm.createContext(ctx);
for(const name of ['discount-price-math','seller-source-parsers','seller-export-adapter','current-price-export'])vm.runInContext(fs.readFileSync('mockups/operations-hub/'+name+'.js','utf8'),ctx);
const api=ctx.HubCurrentPriceExport,fixture=JSON.parse(fs.readFileSync('tests/fixtures/sellerMedium1181.json','utf8')).rows;
const plain=value=>JSON.parse(JSON.stringify(value));
test('stock source is seller matrix/draft, never system or carrier; no Rule ignores old prices',()=>{
 assert.equal(api.matrixStockTarget({seller_stock:0,system_stock:999}),0);
 assert.equal(api.matrixStockTarget({seller_stock:2,stock_draft:{after_value:0}}),0);
 assert.equal(api.matrixStockTarget({system_stock:999}),null);
 const row={active_price_rule:false,current_effective_price:{platformBase:4000,platformDiscount:4000,platformOption:0,platformFinal:4000,platformTerms:[]},registration_status:'calculated',discount_status:'calculated',option_status:'calculated',final_status:'calculated',registration_price:4000,discount_price:4000,option_price:0,final_price:4000,registration_generation_id:12,discount_generation_id:12,option_generation_id:12,final_generation_id:12};
 assert.equal(api.matrixPriceTarget(row),null);
 assert.match(api.carrierPriceState(row).label,/가격 지시 없음/);
 row.active_price_rule=true;assert.equal(api.matrixPriceTarget(row).final,4000);
 row.active_price_rule=false;assert.equal(api.matrixPriceTarget(row),null,'Rule removal suppresses persisted result without deleting it');
});
const cells=xml=>new Map([...xml.matchAll(/<c\b([^>]*?\br="([A-Z]+\d+)"[^>]*?)(?:\/>|>[\s\S]*?<\/c>)/g)].map(m=>[m[2],m[0]]));
for(const [source,env,column] of [['smartstore','SMARTSTORE_MEDIUM_SAMPLE','S'],['makeshop','MAKESHOP_MEDIUM_SAMPLE','AG']])test(source+' actual 31-option carrier -> plan -> XLSX matrix-stock contract',{skip:!process.env[env]},async()=>{
 const file=new File([fs.readFileSync(process.env[env])],path.basename(process.env[env]));
 const parsed=await ctx.SystemV3SellerParsers.parseSellerFiles(source,[file],{inventory:true,price:true,discount:true});
 assert.equal(parsed.normalizedRows.length,31);
 const snapshots=fixture.map(([sku,smartOption,smartStock,makeStock])=>({sku,product_code:source==='smartstore'?'7577001822':'38323',option_code:source==='smartstore'?smartOption:sku.split('-')[1],seller_stock:source==='smartstore'?smartStock:makeStock,system_stock:999,active_price_rule:false})).reverse();
 const plan=api.prepareCarrierItems(source,file.name,parsed.normalizedRows,snapshots);
 assert.equal(plan.summary.total,31);assert.equal(plan.summary.matched,31);assert.equal(plan.summary.blocked,0);assert.equal(plan.canGenerate,true);
 assert.equal(plan.operations.filter(item=>item.field_key==='sellpia_sale_price').length,0);
 for(const preview of plan.preview)assert.equal(preview.diff.stock.after,snapshots.find(row=>row.sku===preview.sku).seller_stock);
 const generated=await ctx.SystemV3SellerExport.transformSellerFile(file,plan.operations.slice().reverse());
 assert.equal(generated.skippedItems.length,0);
 const reparsed=await ctx.SystemV3SellerParsers.parseSellerFiles(source,[new File([generated.blob],file.name)],{inventory:true,price:true,discount:true});
 for(const row of reparsed.normalizedRows){const snapshot=snapshots.find(s=>s.product_code===row.product_code&&s.option_code===row.option_code);assert.ok(snapshot);assert.equal(row.stock,snapshot.seller_stock);const original=parsed.normalizedRows.find(s=>s.product_code===row.product_code&&s.option_code===row.option_code);assert.equal(row.final_price,original.final_price);}
 const beforeZip=await JSZip.loadAsync(await file.arrayBuffer()),afterZip=await JSZip.loadAsync(await generated.blob.arrayBuffer());
 const before=cells(await beforeZip.file('xl/worksheets/sheet1.xml').async('string')),after=cells(await afterZip.file('xl/worksheets/sheet1.xml').async('string'));
 for(const [ref,cell] of before)if(!ref.startsWith(column)||!new RegExp('^'+column+'\\d+$').test(ref))assert.equal(after.get(ref),cell,'non-target '+ref);
 console.log(source+' medium',plain(plan.summary),'stock writes',plan.operations.length);
});
