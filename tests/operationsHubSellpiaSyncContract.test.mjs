import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash, webcrypto} from 'node:crypto';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const contract = require('../mockups/operations-hub/sellpia-sync-contract.js');
const parser = require('../mockups/operations-hub/sellpia-source-parser.js');
const requestId = '92e5b4cb-956d-4f59-9130-bc9d6c21f240';
const baselineOne = '0f35c8ae-8d28-481e-95f1-14845d8b5ed0';
const baselineTwo = '04e77cfa-3421-480d-af11-8fe10193e84b';
const headers = ['#','상품코드','자사코드','상품명','옵션명','재고','가용재고','품절','단종','판매가','안전재고','매입처코드','매입처','매입처그룹','매입처주소','상가명','매입처전화','매입상품명','매입옵션명','매입가','수수료','매입처부가세','발주단위','최소발주수량'];
const hash = bytes => createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
const csvCell = value => /[",\r\n]/.test(String(value ?? '')) ? `"${String(value).replaceAll('"','""')}"` : String(value ?? '');
function sourceRow(index, overrides = {}) {
  return {'#':index, 상품코드:`00123-${String(index).padStart(5,'0')}`, 자사코드:`OWN-${index}`, 상품명:'합성 상품', 옵션명:'합성 옵션', 재고:7, 가용재고:5, 판매가:1000, 안전재고:0, ...overrides};
}
function csvFile(name, rows, {bom = false, selectedHeaders = headers} = {}) {
  const text = (bom ? '\ufeff' : '') + [selectedHeaders.map(csvCell).join(','), ...rows.map(row => selectedHeaders.map(key => csvCell(row[key])).join(','))].join('\r\n');
  return new File([text], name, {type:'text/csv'});
}
function smallFiles(overrides = {}) {
  return [1,2,3].map(index => csvFile(`part-${index}.csv`, [sourceRow(index, index === 2 ? overrides : {})]));
}
async function collection(files, {mode = 'full', expectedRowCount = 3, ...overrides} = {}) {
  return {source:'sellpia', collectionMode:'official_download', mode, includeAll:mode === 'full', filters:[], expectedRowCount,
    files:await Promise.all(files.map(async(file,index) => ({ordinal:index + 1,name:file.name,size:file.size,sha256:hash(await file.arrayBuffer())}))), ...overrides};
}
async function prepare(files, options = {}) {
  const manifest = Object.hasOwn(options,'manifest') ? options.manifest : await collection(files);
  return contract.prepare(files, {manifest, crypto:webcrypto, requestId, ...options});
}

test('full source contract validates over 20k artificial rows with the existing parser and preserves source identifiers', async () => {
  const count = 20501;
  const files = [[1,7000],[7001,14000],[14001,count]].map(([first,last],index) => csvFile(`large-${index+1}.csv`, Array.from({length:last-first+1},(_,offset) => sourceRow(first+offset)), {bom:index===0}));
  const events = [];
  const result = await contract.prepare(files, {manifest:await collection(files,{expectedRowCount:count}), crypto:webcrypto, requestId, baselineSnapshotId:baselineOne, baselineRowCount:count}, event => events.push(event));
  assert.equal(result.valid,true,result.errors.join(' '));
  assert.equal(result.rowCount,count);
  assert.equal(result.parsed.firstRowNo,1);
  assert.equal(result.parsed.lastRowNo,count);
  assert.equal(result.parsed.rows[0].sellpia_sku_code,'00123-00001');
  assert.equal(result.filesManifest[0].encoding,'utf-8-bom');
  assert.equal(result.filesManifest[2].rowCount,6501);
  assert.deepEqual(result.fields,contract.FULL_FIELDS);
  assert.equal(result.summary.productionApply,false);
  assert.equal(result.sourceFingerprint.length,64);
  assert.ok(events.length>0);
});

test('a truncated last part is rejected even when three files have continuous row numbers and correct hashes', async () => {
  const files = smallFiles();
  const result = await prepare(files,{manifest:await collection(files,{expectedRowCount:4})});
  assert.equal(result.parsed.valid,true);
  assert.equal(result.valid,false);
  assert.match(result.errors.join(' '),/전체 행 수/);
  assert.equal(result.sourceFingerprint,null);
  const fewer = await prepare(files.slice(0,2),{manifest:await collection(files.slice(0,2),{expectedRowCount:2})});
  assert.equal(fewer.valid,false);
  assert.match(fewer.errors.join(' '),/3개/);
});

test('official quoted CSV with two leading BOMs parses with SheetJS without changing original file identity', async () => {
  const quote=value=>'"'+String(value??'').replaceAll('"','""')+'"';
  const files=[1,2,3].map(index=>{
    const row=sourceRow(index,{상품명:'합성\uFEFF상품, 인용 "값"',가용재고:-2,판매가:0});
    return new File(['\uFEFF\uFEFF'+[headers.map(quote).join(','),headers.map(key=>quote(row[key])).join(',')].join('\r\n')],`bom-${index}.csv`,{type:'text/csv'});
  });
  const manifest=await collection(files);
  const result=await prepare(files,{manifest,XLSX:require('./vendor/xlsx-0.18.5.full.min.js')});
  assert.equal(result.valid,true,result.errors.join(' '));
  assert.equal(result.parsed.rows[0].sellpia_product_name,'합성\uFEFF상품, 인용 "값"');
  assert.equal(result.parsed.rows[0].available_stock,-2);
  assert.equal(result.parsed.rows[0].raw_payload.sell_price,0);
  assert.deepEqual(result.filesManifest.map(f=>f.sha256),manifest.files.map(f=>f.sha256));
  assert.deepEqual([...new Uint8Array(await files[0].arrayBuffer()).slice(0,6)],[239,187,191,239,187,191]);
});

test('full scope requires official download, include-all, no filters, matching mode and an independent positive row count', async () => {
  const files = smallFiles();
  for (const override of [{collectionMode:'internal_api'}, {includeAll:false}, {filters:['soldOut:false']}, {mode:'patch'}, {expectedRowCount:0}, {expectedRowCount:'3'}, {source:'picking'}, {filters:null}]) {
    const result = await prepare(files,{manifest:await collection(files,override)});
    assert.equal(result.valid,false,JSON.stringify(override));
  }
  assert.equal((await prepare(files,{manifest:null})).valid,false);
  assert.equal((await prepare(files,{mode:'unknown'})).valid,false);
});

test('full mode cannot silently become a stock-only import; patch keeps an explicit selected-field policy', async () => {
  const files = smallFiles();
  for (const fields of [{inventory:true}, {...contract.FULL_FIELDS, price:false}, {...contract.FULL_FIELDS, inventory:'true'}, {...contract.FULL_FIELDS, extra:true}]) {
    const result = await prepare(files,{fields});
    assert.equal(result.valid,false);
  }
  assert.ok(Object.isFrozen(contract.FULL_FIELDS));
  const patchFiles = [csvFile('patch.csv',[sourceRow(810),sourceRow(830)])];
  const patch = await prepare(patchFiles,{mode:'patch',fields:{inventory:true},manifest:await collection(patchFiles,{mode:'patch',expectedRowCount:2,includeAll:false,filters:['explicit_skus']})});
  assert.equal(patch.valid,true,patch.errors.join(' '));
  assert.equal(patch.fields.inventory,true);
  assert.equal(patch.fields.price,false);
  assert.equal(patch.fields.basic,false);
  assert.equal((await prepare(patchFiles,{mode:'patch',fields:{},manifest:await collection(patchFiles,{mode:'patch',expectedRowCount:2})})).valid,false);
  assert.equal((await prepare(patchFiles,{mode:'patch',manifest:await collection(patchFiles,{mode:'patch',expectedRowCount:2})})).valid,false);
});

test('file ordinal, name, size and actual SHA-256 must match; declared digests alone are insufficient', async () => {
  const files = smallFiles();
  for (const change of [{ordinal:2},{name:'other.csv'},{size:files[0].size+1},{sha256:'f'.repeat(64)},{sha256:'not-a-hash'}]) {
    const manifest = await collection(files);
    Object.assign(manifest.files[0],change);
    const result = await prepare(files,{manifest});
    assert.equal(result.valid,false,JSON.stringify(change));
    assert.equal(result.sourceFingerprint,null);
  }
  const manifest = await collection(files);
  const renamed = [new File([await files[0].arrayBuffer()],files[1].name,{type:'text/csv'}), ...files.slice(1)];
  assert.equal((await prepare(renamed,{manifest})).valid,false);
});

test('automatic preparation rejects malformed numeric values and unsafe stock integers instead of normalizing them to zero', async () => {
  for (const bad of [{재고:'NaN'},{가용재고:'Infinity'},{재고:'1,00'},{재고:'7 units'},{재고:'9007199254740993'},{재고:'7.5'},{판매가:'NaN'},{매입가:'not-a-price'},{발주단위:'Infinity'},{최소발주수량:'bad'},{재고:''},{가용재고:''}]) {
    const result = await prepare(smallFiles(bad));
    assert.equal(result.valid,false,JSON.stringify(bad));
    assert.match(result.errors.join(' '),/숫자|정수|비어/);
  }
});

test('legitimate negative available stock, grouped numeric text and nullable purchasing fields remain unchanged', async () => {
  const result = await prepare(smallFiles({가용재고:-8,재고:'1,234',매입가:'',발주단위:' ',최소발주수량:null}));
  assert.equal(result.valid,true,result.errors.join(' '));
  const row = result.parsed.rows[1];
  assert.equal(row.stock,1234);
  assert.equal(row.available_stock,-8);
  assert.equal(row.integrated_available_stock,-8);
  assert.equal(row.purchase_price,null);
  assert.equal(row.order_unit,null);
  assert.equal(row.minimum_order_unit,null);
  assert.equal(row.raw_payload.purchase_price,null);
});

test('strict numeric is opt-in for the shared parser and default manual parsing retains its existing fallback behavior', async () => {
  const files = smallFiles({재고:'NaN',판매가:'Infinity',매입가:'bad'});
  const manual = await parser.parseSellpiaFiles(files,{mode:'full'});
  assert.equal(manual.valid,true);
  assert.equal(manual.rows[1].stock,0);
  assert.equal(manual.rows[1].raw_payload.sell_price,0);
  assert.equal(manual.rows[1].purchase_price,null);
  const strict = await parser.parseSellpiaFiles(files,{mode:'full',strictNumeric:true});
  assert.equal(strict.valid,false);
});

test('raw XLSX NaN, infinity, booleans and rounded fractional stock are rejected before coercion', async () => {
  for (const bad of [NaN,Infinity,true,9007199254740992,'9007199254740990.5']) {
    const values = sourceRow(1,{재고:bad});
    const matrix = [headers,headers.map(key=>values[key]??null)];
    const XLSX = {read:()=>({SheetNames:['Synthetic'],Sheets:{Synthetic:{'!ref':'A1:X2',matrix}}}),utils:{decode_range:()=>({s:{r:0,c:0},e:{r:1,c:23}}),sheet_to_json:sheet=>sheet.matrix}};
    const result = await parser.parseSellpiaFiles([new File(['synthetic'],'nan.xlsx')],{mode:'patch',strictNumeric:true,XLSX});
    assert.equal(result.valid,false,String(bad));
  }
});

test('the parser sees the exact original bytes that were hashed, not a changed async file object', async () => {
  const files = smallFiles(), manifest = await collection(files);
  const original = await files[0].arrayBuffer();
  let reads = 0;
  const volatile = {name:files[0].name,size:files[0].size,type:files[0].type,arrayBuffer:async()=>++reads===1?original:new TextEncoder().encode('changed content').buffer};
  const result = await prepare([volatile,...files.slice(1)],{manifest});
  assert.equal(result.valid,true,result.errors.join(' '));
  assert.equal(reads,1);
  assert.equal(result.parsed.rows[0].sellpia_sku_code,'00123-00001');
});

test('row-count drops require review without changing parser values or permitting an automatic apply', async () => {
  const result = await prepare(smallFiles(),{baselineRowCount:30,baselineSnapshotId:baselineOne});
  assert.equal(result.valid,true,result.errors.join(' '));
  assert.equal(result.summary.reviewRequired,true);
  assert.deepEqual(result.summary.reviewReasons,['source_row_count_drop']);
  assert.equal(result.summary.productionApply,false);
  assert.equal(result.rowCount,3);
});

test('source fingerprints are stable across retries and differ when the baseline or field policy changes', async () => {
  const files = smallFiles(), manifest = await collection(files);
  const first = await prepare(files,{manifest,baselineSnapshotId:baselineOne,sha256:async bytes=>hash(bytes)});
  const retry = await prepare(files,{manifest,baselineSnapshotId:baselineOne,requestId:'d1992c27-8d10-4ee4-898e-a221088d9896'});
  const changed = await prepare(files,{manifest,baselineSnapshotId:baselineTwo});
  assert.equal(first.valid,true);
  assert.equal(first.sourceFingerprint,retry.sourceFingerprint);
  assert.notEqual(first.sourceFingerprint,changed.sourceFingerprint);
  assert.equal((await prepare(files,{sha256:async()=>'invalid'})).valid,false);
  assert.equal((await prepare(files,{requestId:'not-a-uuid'})).valid,false);
  assert.equal((await prepare(files,{baselineSnapshotId:'not-a-uuid'})).valid,false);
  assert.equal((await prepare(files,{rowDropReviewRatio:'bad'})).valid,false);
});

test('existing signed-upload size caps fail before reading oversized files', async () => {
  const make = (name,size) => ({name,size,arrayBuffer:async()=>{throw new Error('oversized files must not be read');}});
  const manifest = {source:'sellpia',collectionMode:'official_download',mode:'full',includeAll:true,filters:[],expectedRowCount:3,files:[]};
  for (const files of [[make('too-big.csv',26*1024*1024),make('two.csv',1),make('three.csv',1)], [make('one.csv',21*1024*1024),make('two.csv',21*1024*1024),make('three.csv',21*1024*1024)]]) {
    manifest.files = files.map((file,index)=>({ordinal:index+1,name:file.name,size:file.size,sha256:'a'.repeat(64)}));
    const result = await prepare(files,{manifest});
    assert.equal(result.valid,false);
    assert.match(result.errors.join(' '),/25 MiB|60 MiB/);
    assert.doesNotMatch(result.errors.join(' '),/must not be read/);
  }
});

test('UMD browser preparation uses injected crypto and does not access a network, database, storage or runtime credential', async () => {
  const source = fs.readFileSync(new URL('../mockups/operations-hub/sellpia-sync-contract.js',import.meta.url),'utf8');
  const prohibited = () => { throw new Error('contract cannot access an external system'); };
  const context = {SystemV3SellpiaSourceParser:parser,TextEncoder,Uint8Array,ArrayBuffer,crypto:webcrypto,fetch:prohibited};
  Object.defineProperties(context,{supabase:{get:prohibited},localStorage:{get:prohibited},sessionStorage:{get:prohibited}});
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source,context);
  const files = smallFiles();
  const result = await context.SystemV3SellpiaSyncContract.prepare(files,{manifest:await collection(files),requestId});
  assert.equal(result.valid,true,Array.from(result.errors).join(' '));
  assert.equal(result.summary.productionApply,false);
});

async function comparisonSample() {
  const result = await parser.parseSellpiaFiles(smallFiles(),{mode:'full',strictNumeric:true});
  assert.equal(result.valid,true);
  return result.rows[0];
}

test('comparison of over 20k source rows reports exact field-group changes, additions and full removals', async () => {
  const count=20500, sample=await comparisonSample();
  const baseline=Array.from({length:count},(_,index)=>({...structuredClone(sample),sellpia_sku_code:`00123-${index+1}`,source_row_no:index+1}));
  const next=baseline.slice(1).map(row=>structuredClone(row));
  next[0].stock=8;
  next[1].raw_payload.sell_price=1200;
  next[2].purchase_price=250;
  next[2].raw_payload.purchase_price=250;
  next[3].supplier_name='합성 새 매입처';
  next[4].raw_payload.sale_status='품절';
  next[5].raw_payload.source_file_name='new-download.csv';
  next[5].source_row_no=99999;
  next[5].snapshot_id='new-lineage';
  next[6].current_price_decision={price:{final:999999}};
  next[6].price_draft={after_value:222222};
  next[6].system_stock=999;
  next[6].system_base_price=333333;
  next.push({...structuredClone(sample),sellpia_sku_code:'00999-99999'});
  const result=contract.compareRows(next,baseline,{mode:'full'});
  assert.equal(result.valid,true,result.errors.join(' '));
  assert.equal(result.changedCount,5);
  assert.equal(result.unchangedCount,20494);
  assert.equal(result.addedCount,1);
  assert.equal(result.removedCount,1);
  assert.equal(result.preservedCount,0);
  assert.equal(result.unknownCount,0);
  assert.equal(result.newRowCount,count);
  assert.equal(result.baselineRowCount,count);
  assert.deepEqual(result.summary.fieldCounts,{inventory:1,price:1,purchasePrice:1,basic:1,status:1});
  assert.equal(result.rows.find(row=>row.sku===next[5].sellpia_sku_code).status,'unchanged');
  assert.equal(result.rows.find(row=>row.sku===next[6].sellpia_sku_code).status,'unchanged');
});

test('patch compares selected source fields and preserves omitted baseline SKUs', async () => {
  const parsed=await parser.parseSellpiaFiles(smallFiles(),{mode:'full',strictNumeric:true}),baseline=parsed.rows;
  const changed=structuredClone(baseline[0]);
  changed.stock=12;
  changed.raw_payload.sell_price=777777;
  const added={...structuredClone(baseline[1]),sellpia_sku_code:'00999-01'};
  const result=contract.compareRows([changed,added],baseline,{mode:'patch',fields:{inventory:true}});
  assert.equal(result.valid,true,result.errors.join(' '));
  assert.equal(result.changedCount,1);
  assert.equal(result.unchangedCount,0);
  assert.equal(result.addedCount,1);
  assert.equal(result.removedCount,0);
  assert.equal(result.preservedCount,2);
  assert.deepEqual(result.rows.find(row=>row.status==='changed').changedFields,['inventory']);
  assert.equal(contract.compareRows([changed],baseline,{mode:'patch'}).valid,false);
});

test('missing baselines and missing projected fields are unknown rather than fabricated zero differences', async () => {
  const sample=await comparisonSample();
  const absent=contract.compareRows([sample],null,{mode:'full'});
  assert.equal(absent.valid,false);
  assert.equal(absent.baselineAvailable,false);
  assert.equal(absent.baselineRowCount,null);
  assert.equal(absent.changedCount,null);
  assert.equal(absent.unchangedCount,null);
  assert.equal(absent.addedCount,null);
  assert.equal(absent.removedCount,null);
  const empty=contract.compareRows([sample],[],{mode:'full'});
  assert.equal(empty.valid,true);
  assert.equal(empty.addedCount,1);
  const partial=structuredClone(sample);
  delete partial.stock;
  const unknown=contract.compareRows([sample],[partial],{mode:'full'});
  assert.equal(unknown.valid,false);
  assert.equal(unknown.unknownCount,1);
  assert.equal(unknown.changedCount,null);
  assert.equal(unknown.unchangedCount,null);
  assert.equal(unknown.addedCount,0);
  assert.deepEqual(unknown.rows[0].unknownFields,['inventory']);
  const invalid=contract.compareRows([sample],[sample,sample],{mode:'full'});
  assert.equal(invalid.valid,false);
  assert.equal(invalid.addedCount,null);
});

test('comparison preserves null versus zero, numeric representations and source-only price policy', async () => {
  const sample=await comparisonSample(),baseline=structuredClone(sample),next=structuredClone(sample);
  baseline.available_stock='-8';
  baseline.integrated_available_stock='-8';
  next.available_stock=-8;
  next.integrated_available_stock=-8;
  baseline.raw_payload.base_price='1,000';
  baseline.raw_payload.sell_price='1000.00';
  baseline.manual_cost=999;
  next.current_price_decision={price:{final:888}};
  assert.equal(contract.compareRows([next],[baseline],{mode:'full'}).unchangedCount,1);
  next.purchase_price=0;
  next.raw_payload.purchase_price=0;
  const purchase=contract.compareRows([next],[baseline],{mode:'full'});
  assert.equal(purchase.changedCount,1);
  assert.deepEqual(purchase.rows[0].changedFields,['purchasePrice']);
  assert.equal(purchase.rows[0].changes.purchasePrice[0].before,null);
  assert.equal(purchase.rows[0].changes.purchasePrice[0].after,0);
  const price=structuredClone(sample);
  price.raw_payload.base_price=2000;
  price.raw_payload.sell_price=2000;
  const changed=contract.compareRows([price],[sample],{mode:'full'});
  assert.equal(changed.changedCount,1);
  assert.deepEqual(changed.rows[0].changedFields,['price']);
  assert.equal(changed.summary.fieldCounts.price,1);
});
