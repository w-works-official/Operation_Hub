import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url),XLSX=require('./vendor/xlsx-0.18.5.full.min.js'),JSZip=require('./vendor/jszip-3.10.1.min.js');
const read=name=>fs.readFileSync(new URL(`../mockups/operations-hub/${name}.js`,import.meta.url),'utf8');
const app=read('app'),prepare=app.slice(app.indexOf('async function prepareChangedOnlyExport('),app.indexOf('\nwindow.SystemV3SellerExportBridge='));
const plain=value=>JSON.parse(JSON.stringify(value));
const snapshots={seller_snapshot_id:'00000000-0000-4000-8000-000000000001',sellpia_snapshot_id:'00000000-0000-4000-8000-000000000002',sellpia_observed_at:'2026-10-26T00:00:00Z'};
class TestFile extends Blob{constructor(parts,name){super(parts,{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});this.name=name;}}
const groups=[['8008',12],['8434',3],['9992',10],['10057',3]].map(([prefix,count])=>({prefix,product:`990000${prefix}`,skus:Array.from({length:count},(_,i)=>`${prefix}-${i+1}`)}));
const child={prefix:'COLLECTION',product:'9900012345',skus:['COLLECTION-1']};
function workbook(name,definitions){
 const rows=[Array(112).fill('')];Object.assign(rows[0],{0:'상품번호',1:'판매자 상품코드',3:'상품명',5:'판매가',12:'재고수량',15:'옵션번호',16:'옵션명',17:'옵션가',18:'옵션 재고수량',57:'즉시할인 기본할인',58:'기본할인 단위',93:'보존 열'});
 for(const group of definitions){const row=Array(112).fill('');Object.assign(row,{0:group.product,1:`seller-${group.product}`,3:`원본 상품 ${group.prefix}`,5:10000,12:23,15:group.skus.join('\n'),16:group.skus.map(sku=>`옵션 ${sku}`).join('\n'),17:group.skus.map((_,i)=>String(i*100)).join('\n'),18:group.skus.map((_,i)=>String(i+2)).join('\n'),93:`보존 ${group.prefix}`});rows.push(row);}
 const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(rows),'일괄수정');return {file:new TestFile([XLSX.write(book,{type:'buffer',bookType:'xlsx'})],name),rows};
}
async function fixture({unlinked=[]}={}){
 const files=[workbook('smartstore-a.xlsx',groups.slice(0,2)),workbook('smartstore-b.xlsx',[...groups.slice(2),child])];
 const catalog=new Set([...groups,child].flatMap(group=>group.skus));
 const mapping=[...groups,child].filter(group=>!unlinked.includes(group.prefix)).flatMap(group=>group.skus.map(sku=>({sku,product_code:group.product,option_code:sku})));
 const rawPrices=new Map([...groups,child].flatMap(group=>group.skus.map((sku,i)=>[sku,11000+i*100]))),calls=[],downloads=[],resolverCalls=[],resolverRanges=[],sourceReads=[],graphCalls=[];
 const state={mappingVersion:1,graphVersion:1};let parsed;
 function evidence(skus){
  const products=new Set(mapping.filter(row=>skus.includes(row.sku)).map(row=>row.product_code));
  const proofs=[...products].map(product=>{
   const members=mapping.filter(row=>row.product_code===product);
   return {source_channel:'smartstore',seller_product_code:product,revision:0,mapping_valid:true,mapping_fingerprint:`mapping-${product}-${state.mappingVersion}`,snapshot_id:snapshots.seller_snapshot_id,sellpia_snapshot_id:snapshots.sellpia_snapshot_id,source_observed_at:snapshots.sellpia_observed_at,
    sellpia_prices:Object.fromEntries(members.map(row=>[row.sku,rawPrices.get(row.sku)])),targets:parsed.filter(row=>row.product_code===product).map(row=>({sku:row.option_code,member_skus:[row.option_code],seller_product_code:product,seller_option_code:row.option_code,price:{base:row.base_price,discounted:row.discounted_base_price,option:row.option_price,final:row.final_price,terms:row.discount_terms},source_row_no:row.source_row_no,source_valid:true,component_members:[{sku:row.option_code,mapping_source:'carrier_cache',listing_id:null,component_id:null,component_qty:1,component_role:'primary'}]}))};
  });
  return {rows:[],groups:[],proof_version:'sellpia-export-v2',snapshots:{...snapshots},absence_proofs:proofs,carrier_proofs:proofs.map(({revision,mapping_valid,...proof})=>proof)};
 }
 const db={rpc(name,args,options){
  if(name==='resolve_operations_hub_code_entries'){
   resolverCalls.push(plain(args.p_entries));assert.deepEqual(plain(options),{count:'exact'});
   // Only the transport is mocked. Execute the actual scope helper and DS;
   // the SQL resolver itself is represented by this synthetic catalog fixture.
   const rows=args.p_entries.flatMap(entry=>{
    const exact=catalog.has(entry.code),matches=exact?[entry.code]:[...catalog].filter(sku=>sku.startsWith(entry.code+'-')).sort();
    const common={input_row:entry.row_no,source_channel:entry.source,input_code:entry.code,product_code:null,option_code:null};
    return matches.length?matches.map(sku=>({...common,match_scope:exact?'sku':'prefix',match_status:'matched',sellpia_sku_code:sku})):[{...common,match_scope:'none',match_status:'not_found',sellpia_sku_code:null}];
   });
   return {async range(from,to){resolverRanges.push([from,to]);return {data:rows.slice(from,to+1),count:rows.length,error:null};}};
  }
  if(name==='hub_product_price_settings_read_v1')return {data:{contract_version:1,source:'smartstore',settings:[]},error:null};
  if(name==='hub_export_sku_dependencies_read_v1'){
   graphCalls.push(plain(args));if(args.p_expected_version&&args.p_expected_version!==`graph-${state.graphVersion}`)return {data:null,error:{message:'dependency graph changed'}};
   const requested=args.p_skus||[...catalog],selected=[...new Set([...requested,...(requested.includes('8008-1')?[child.skus[0]]:[])])].sort();
   return {data:{contract_version:1,version:`graph-${state.graphVersion}`,snapshot_id:snapshots.sellpia_snapshot_id,requested_skus:[...requested].sort(),selected_skus:selected,reference_skus:[],edges:requested.includes('8008-1')?[{edge_id:1,parent_sku:'8008-1',child_sku:child.skus[0]}]:[]},error:null};
  }
  assert.ok(['hub_price_decision_export_read_v2','hub_price_decision_export_read_v3'].includes(name),`write or unexpected RPC forbidden: ${name}`);calls.push({name,args:plain(args)});return {data:evidence(args.p_skus),error:null};
 },from(table){assert.equal(table,'operations_hub_matrix_system_live');return {select(){return this;},in(field,skus){assert.equal(field,'sellpia_sku_code');sourceReads.push([...skus]);return Promise.resolve({data:skus.map(sku=>({sellpia_sku_code:sku,sellpia_source_sale_price:rawPrices.get(sku),sellpia_source_updated_at:snapshots.sellpia_observed_at})),error:null});}};},storage:new Proxy({},{get(){throw Error('storage access forbidden');}})};
 const value={console,Blob,File:TestFile,XLSX,JSZip,Map,Set,Number,String,JSON,RegExp,Error,Promise,Uint8Array,ArrayBuffer,Date,Math,Intl,setTimeout,clearTimeout,URL,TextEncoder,TextDecoder,AbortController,AbortSignal,performance,structuredClone,
  formatNumber:String,CHANNEL_LABELS:{smartstore:'스마트스토어'},assertMatrixChangesSaved(){},supabase:{createClient:()=>db},fetch:async()=>{throw Error('network forbidden');}};
 value.window=value;value.globalThis=value;vm.createContext(value);
 for(const name of ['manual-sku-scope','discount-price-math','sellpia-inventory-count','seller-source-parsers','seller-export-adapter','rule-registry','current-price-export','product-price-adjustment','data-service','price-dependency-export','price-dependency-service'])vm.runInContext(read(name),value,{filename:name+'.js'});
 value.SystemV3Data.setOperationsHubSessionToken('fixture-session');parsed=(await value.SystemV3SellerParsers.parseSellerFiles('smartstore',files.map(row=>row.file),{basic:true,price:true,discount:true,inventory:true})).normalizedRows;
 const targets=async({skus})=>({rows:skus.map(sku=>({sku,active_price_rule:true,current_effective_price:{platformBase:11000,platformDiscount:0,platformOption:rawPrices.get(sku)-11000,platformFinal:rawPrices.get(sku),platformTerms:[]}}))});
 value.SystemV3Data={...value.SystemV3Data,loadCarrierMatrixTargets:targets};
 value.liveData={...value.SystemV3Data,async downloadLatestSellerOriginals(){return new Map([['smartstore',files.map(row=>row.file)]]);},async loadCarrierSellerMappings({identities}){const products=new Set(identities.map(row=>row.product_code));return {rows:mapping.filter(row=>products.has(row.product_code)).map(row=>({...row}))};},async loadSellpiaStockSourcesForExport(){throw Error('stock query forbidden in price-only fixture');},async recordStockExportAudit(){throw Error('DB write forbidden');}};
 value.sellerExport={...value.SystemV3SellerExport,downloadBlob(blob,name){downloads.push({blob,name});}};vm.runInContext(prepare+'\nthis.prepare=prepareChangedOnlyExport;',value);
 const resolve=raw=>value.HubManualSkuScope.resolve(raw,{resolveEntries:entries=>value.SystemV3Data.resolveCodeEntries(entries)});
 const run=async(raw,options={})=>{const scope=await resolve(raw);assert.ok(scope.skus.length,'fixture needs a resolved SKU scope');return {scope,result:await value.prepare('smartstore',scope.skus,{mode:'target_all',priceMode:'sellpia_source',includePrice:true,includeStock:false,...options})};};
 return {run,resolve,value,files,catalog,mapping,rawPrices,state,calls,downloads,resolverCalls,resolverRanges,sourceReads,graphCalls};
}
async function outputRows(result){const rows=[];for(const output of result.outputs){const book=XLSX.read(await output.blob.arrayBuffer(),{type:'array'});rows.push(...XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]],{header:1,raw:true,defval:''}).slice(1));}return rows;}
function finals(rows){return new Map(rows.flatMap(row=>String(row[15]).split('\n').map((sku,index)=>[sku,Number(row[5])+Number(String(row[17]).split('\n')[index])])));}
function assertProtected(h,rows){for(const row of rows){const original=h.files.flatMap(file=>file.rows).find(candidate=>String(candidate[0])===String(row[0]));assert.ok(original);for(let column=0;column<original.length;column++)if(![5,17,57,58].includes(column))assert.equal(row[column],original[column],`${row[0]} protected column ${column}`);}}

test('four bare Sellpia product prefixes resolve through the real service into 28 selected SKUs and both actual XLSX outputs',async()=>{
 const h=await fixture(),original=await Promise.all(h.files.map(async row=>Buffer.from(await row.file.arrayBuffer()))),{scope,result}=await h.run('8008 8434 9992 10057');
 assert.equal(scope.skus.length,28);assert.equal(scope.unresolved.length,0);assert.equal(result.scopeSummary.selectedSkuCount,28);assert.equal(result.scopeSummary.matchedOptionCount,28);assert.equal(result.scopeSummary.unmatchedSkuCount,0);assert.equal(result.outputs.length,2);
 assert.deepEqual(h.resolverCalls[0].map(row=>[row.source,row.code]),[['sellpia','8008'],['sellpia','8434'],['sellpia','9992'],['sellpia','10057']]);
 const rows=await outputRows(result),actual=finals(rows);for(const sku of scope.skus)assert.equal(actual.get(sku),h.rawPrices.get(sku));assertProtected(h,rows);
 await h.run('8008 8434 9992 10057',{download:true,expectedPlanFingerprint:result.planFingerprint});assert.equal(h.downloads.filter(row=>row.name.endsWith('.xlsx')).length,2);
 for(let i=0;i<h.files.length;i++)assert.deepEqual(Buffer.from(await h.files[i].file.arrayBuffer()),original[i]);
});

test('exact SKU remains a one-option selection while mixed product/SKU inputs deduplicate without losing unresolved codes or sibling originals',async()=>{
 const h=await fixture(),exact=await h.run('8008-1');assert.deepEqual(plain(exact.scope.skus),['8008-1']);assert.equal(exact.result.scopeSummary.selectedSkuCount,1);assert.equal(exact.result.scopeSummary.matchedOptionCount,1);
 const rows=await outputRows(exact.result),values=finals(rows);assert.equal(values.get('8008-1'),11000);for(let i=1;i<12;i++)assert.equal(values.get(`8008-${i+1}`),10000+i*100,'unselected sibling final stays original');assertProtected(h,rows);
 const mixed=await h.run('8008,8008-1 8434\n8008 UNKNOWN');assert.equal(mixed.scope.skus.length,15);assert.deepEqual(plain(mixed.scope.unresolved),[{inputCode:'UNKNOWN',status:'not_found'}]);assert.equal(mixed.result.scopeSummary.selectedSkuCount,15);assert.equal(mixed.result.scopeSummary.matchedOptionCount,15);
});

test('resolved Sellpia options without seller connections remain unmatched rather than being removed from the selected denominator',async()=>{
 const h=await fixture({unlinked:['8008','8434','9992']}),{scope,result}=await h.run('8008 8434 9992 10057');
 assert.equal(scope.skus.length,28);assert.equal(result.scopeSummary.selectedSkuCount,28);assert.equal(result.scopeSummary.matchedOptionCount,3);assert.equal(result.scopeSummary.unmatchedSkuCount,25);assert.equal(result.outputs.length,1);
 assert.deepEqual([...result.diagnostics.unmatched_selected_skus].sort(),plain(scope.skus).filter(sku=>!sku.startsWith('10057-')).sort());assert.deepEqual((await outputRows(result)).map(row=>String(row[0])),['99000010057']);
});

test('all three output modes preserve the expanded scope and source/rule price semantics',async()=>{
 for(const mode of ['target_all','changed_only','full_original'])for(const priceMode of ['sellpia_source','rules']){
  const h=await fixture(),{scope,result}=await h.run('8008 8434 9992 10057',{mode,priceMode});assert.equal(result.scopeSummary.selectedSkuCount,28);assert.equal(result.scopeSummary.matchedOptionCount,28);
  const rows=await outputRows(result),values=finals(rows);for(const sku of scope.skus)assert.equal(values.get(sku),h.rawPrices.get(sku),`${mode}/${priceMode}/${sku}`);assertProtected(h,rows);
 }
});

test('dependency expansion starts after product resolution and only adds the approved descendant SKU',async()=>{
 const h=await fixture(),{scope,result}=await h.run('8008 8434 9992 10057',{includeDependencies:true});assert.equal(scope.skus.length,28);
 assert.deepEqual([...h.graphCalls[0].p_skus].sort(),[...scope.skus].sort());assert.equal(result.scopeSummary.selectedSkuCount,29);assert.equal(result.scopeSummary.matchedOptionCount,29);
 const rows=await outputRows(result);assert.equal(finals(rows).get('COLLECTION-1'),h.rawPrices.get('8008-1'));assertProtected(h,rows);
});

test('a changed resolved membership or carrier mapping proof invalidates generation rather than reusing an old scope or download',async()=>{
 for(const change of ['membership','mapping']){
  const h=await fixture(),before=await h.run('8008');if(change==='membership')h.catalog.add('8008-13');else h.state.mappingVersion++;
  await assert.rejects(h.run('8008',{download:true,expectedPlanFingerprint:before.result.planFingerprint}),/미리보기|변경/);assert.equal(h.downloads.length,0);
  assert.equal(h.resolverCalls.length,2,'generation resolves the current member set again');
 }
});

test('a product with more than 1000 resolved options keeps the entire selected population through paged DS reads and export diagnostics',async()=>{
 const h=await fixture();for(let i=13;i<=1205;i++)h.catalog.add(`8008-${i}`);
 const {scope,result}=await h.run('8008');assert.equal(scope.skus.length,1205);assert.deepEqual(h.resolverRanges,[[0,999],[1000,1999]]);
 assert.equal(result.scopeSummary.selectedSkuCount,1205);assert.equal(result.scopeSummary.matchedOptionCount,12);assert.equal(result.scopeSummary.unmatchedSkuCount,1193);
 assert.equal(result.diagnostics.unmatched_selected_skus.length,1193);assert.equal(result.outputs.length,1);
 const values=finals(await outputRows(result));for(const sku of groups[0].skus)assert.equal(values.get(sku),h.rawPrices.get(sku));
});
