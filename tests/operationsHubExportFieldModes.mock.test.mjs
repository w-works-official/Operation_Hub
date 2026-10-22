import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const workflow=fs.readFileSync(new URL('../mockups/operations-hub/seller-file-workflow-v2.js',import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../mockups/operations-hub/app.js',import.meta.url),'utf8');
const sellpiaPatch=fs.readFileSync(new URL('../mockups/operations-hub/sellpia-patch-export.js',import.meta.url),'utf8');

test('seller cards and shared presets expose price+stock, price-only, and stock-only',()=>{
 assert.match(workflow,/data-export-field-preset="price_stock"[\s\S]*?data-export-field-preset="price_only"[\s\S]*?data-export-field-preset="stock_only"/);
 assert.match(workflow,/data-standard-field-mode="\$\{source\}"[\s\S]*?value="price_stock"[\s\S]*?value="price_only"[\s\S]*?value="stock_only"/);
 assert.match(workflow,/data-ably-field-mode[\s\S]*?value="option_stock"[\s\S]*?value="price_only"[\s\S]*?value="stock_only"/);
});

test('standard field selection is the actual exporter contract',()=>{
 assert.match(workflow,/includePrice:!stockOnly,includeStock:!priceOnly/);
 assert.match(workflow,/selection\.priceOnly[\s\S]*?bridge\.previewPriceOnly/);
 assert.match(workflow,/selection\.priceOnly[\s\S]*?bridge\.runPriceOnly/);
 assert.match(app,/previewPriceOnly[\s\S]*?includePrice:true,includeStock:false/);
 assert.match(app,/runPriceOnly[\s\S]*?includePrice:true,includeStock:false/);
 assert.match(app,/previewStockOnly[\s\S]*?includePrice:false,includeStock:true/);
 assert.match(app,/runStockOnly[\s\S]*?includePrice:false,includeStock:true/);
});

test('Ably price-only suppresses stock projection while stock-only suppresses price projection',()=>{
 const ablyPreview=workflow.slice(workflow.indexOf(' async function preview(role){'),workflow.indexOf('\n function previewRowsForFilter('));
 assert.match(workflow,/const priceOnly=role==='playauto_option'&&fieldMode==='price_only'/);
 assert.match(ablyPreview,/const stockInScope=inScope&&\(!selectedScope\|\|selectedScope\.has\(sku\)\)/,'automatically included children are outside the original stock scope');
 const stockReads=[...ablyPreview.matchAll(/matrixStockTarget\(row,stockSource\)/g)];
 const guardedStockReads=[...ablyPreview.matchAll(/if\(!priceOnly&&stockInScope\)\{\s*const \w+=global\.HubCurrentPriceExport\?\.matrixStockTarget\(row,stockSource\)/g)];
 assert.equal(stockReads.length,2,'ordinary and inherited option-price paths both retain stock projection');
 assert.equal(guardedStockReads.length,stockReads.length,'every stock projection requires both a stock-enabled field mode and the original selected scope');
 assert.match(ablyPreview,/if\(stockOnly\)\{\s*return A\(\)\.prepareStockOnlyRow\(out,row,\{stockSource,inScope\}\)/);
 assert.match(workflow,/p\.priceOnly\?'가격-only/);
});

test('existing Sellpia field checkboxes remain independent',()=>{
 assert.match(sellpiaPatch,/<legend>내보낼 필드<\/legend>/);
 assert.match(sellpiaPatch,/data-patch-field/);
});

console.log('operations hub export field mode contract tests passed');
