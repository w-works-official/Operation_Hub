import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const migration=fs.readFileSync(new URL('../supabase/migrations/20261001153000_sellpia_inventory_count_stock_sources.sql',import.meta.url),'utf8');
const dataService=fs.readFileSync(new URL('../mockups/operations-hub/data-service.js',import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../mockups/operations-hub/app.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../mockups/operations-hub/index.html',import.meta.url),'utf8');

test('inventory_count is a distinct stock-only snapshot mode with exact-base staleness protection',()=>{
 assert.match(migration,/upload_mode in \('full','patch','inventory_count'\)/);
 assert.match(migration,/v_latest is distinct from v_base/);
 assert.match(migration,/upload_mode','inventory_count'/);
 assert.match(migration,/source_type','sellpia_inventory_count'/);
 assert.match(migration,/affected_skus/);
});

test('inventory_count upload validates signed PostgreSQL integer bounds before integer casts',()=>{
 assert.match(migration,/\(r->>'stock'\)::numeric not between -2147483648 and 2147483647/);
 assert.match(migration,/\(r->>'available_stock'\)::numeric not between -2147483648 and 2147483647/);
 assert.match(migration,/errcode='22003'/);
});

test('finalizer replaces only stock and available_stock while preserving other inventory and price metadata',()=>{
 const update=migration.match(/update public\.sellpia_stock_snapshot_rows patch set([\s\S]*?)from public\.sellpia_stock_snapshot_rows base/)[1];
 assert.doesNotMatch(update,/\bstock\s*=/);
 assert.doesNotMatch(update,/\bavailable_stock\s*=/);
 assert.match(update,/integrated_available_stock=base\.integrated_available_stock/);
 assert.match(update,/safety_stock=base\.safety_stock/);
 assert.match(update,/purchase_price=base\.purchase_price/);
 const finalizer=migration.match(/create or replace function public\.finalize_operations_hub_sellpia_inventory_count[\s\S]*?\n\$\$;/)[0];
 assert.doesNotMatch(finalizer,/price recovery|calculation_begin/i);
});

test('server accepts signed negative integer stock values but rejects blank/decimal payloads',()=>{
 assert.match(migration,/\^\-\?\[0-9\]\+\$/);
 assert.doesNotMatch(migration,/greatest\([^\n]*available_stock|available_stock[^\n]*greatest/i);
});

test('frontend requires preview fingerprint and refreshes only affected Matrix SKUs',()=>{
 assert.match(dataService,/previewSellpiaInventoryCount/);
 assert.match(dataService,/preview\.fingerprint!==expectedPreview\.fingerprint/);
 assert.match(dataService,/source_row_count:preview\.changedRows\.length/);
 assert.match(app,/sourceSelect\.value==='inventory_count'[\s\S]*?refreshMatrixSkus\(changed\)/);
 assert.match(html,/<option value="inventory_count">재고조사 결과 반영<\/option>/);
 assert.match(html,/id="inventory-count-preview"/);
});

test('inventory-count upload renders only selected files instead of ten empty picker slots',()=>{
 assert.match(app,/sourceSelect\.value === 'inventory_count'[\s\S]*?selectedFiles\.map\(\(file, index\)/);
 assert.match(app,/class="inventory-count-file-remove"/);
 assert.match(app,/selectedFiles\.splice\(Number\(removeButton\.dataset\.fileIndex\), 1\)/);
 assert.doesNotMatch(app,/상품코드·가용재고·재고 헤더가 있는 XLSX를 1~10개/);
 assert.match(html,/<div id="file-slots" class="file-slots"><\/div>/);
});

test('stock-only export audit records the selected source before download',()=>{
 assert.match(migration,/add column if not exists stock_source text/);
 assert.match(migration,/export_mode in \('change_queue','inventory_match','stock_only'\)/);
 assert.match(migration,/create or replace function public\.hub_stock_export_audit_v1/);
 assert.match(dataService,/recordStockExportAudit[\s\S]*?hub_stock_export_audit_v1/);
 assert.match(app,/recordStockExportAudit[\s\S]*?stockSource[\s\S]*?downloadBlob/);
});

console.log('operations hub inventory-count static contract tests passed');
