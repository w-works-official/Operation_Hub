import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {webcrypto} from 'node:crypto';

const require=createRequire(import.meta.url),XLSX=require('./vendor/xlsx-0.18.5.full.min.js'),JSZip=require('./vendor/jszip-3.10.1.min.js');
const read=name=>fs.readFileSync(new URL(`../mockups/operations-hub/${name}.js`,import.meta.url),'utf8');
const app=read('app'),bridgeStart=app.indexOf('window.SystemV3SellerExportBridge='),bridgeEnd=app.indexOf('\n};',bridgeStart)+3;
const prepare=app.slice(app.indexOf('async function prepareChangedOnlyExport('),bridgeStart),bridge=app.slice(bridgeStart,bridgeEnd);
const snapshots={seller_snapshot_id:'00000000-0000-4000-8000-000000000001',sellpia_snapshot_id:'00000000-0000-4000-8000-000000000002',sellpia_observed_at:'2026-11-03T00:00:00Z'};
class TestFile extends Blob{constructor(parts,name){super(parts,{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});this.name=name;}}
const tuple=final=>({base:10000,discounted:10000,option:final-10000,final,terms:[]});

async function harness({count=16000,roots=850}={}){
 const mapping=Array.from({length:count},(_,index)=>({sku:index<roots?`P-${index}`:index<roots*2?`C-${index-roots}`:`N-${index}`,
  product_code:String(8000000000+Math.floor(index/10)),option_code:`OPTION-${index}`,index}));
 const bySku=new Map(mapping.map(row=>[row.sku,row])),byProduct=new Map();
 for(const row of mapping){if(!byProduct.has(row.product_code))byProduct.set(row.product_code,[]);byProduct.get(row.product_code).push(row);}
 const rawPrices=new Map(mapping.map(row=>[row.sku,row.sku.startsWith('P-')?12000+row.index%10*100:row.sku.startsWith('C-')?8000:11000+row.index%10*100]));
 const products=[...byProduct],sources=[];
 for(let part=0;part<2;part++){
  const rows=[Array(96).fill('')];Object.assign(rows[0],{0:'상품번호',1:'판매자 상품코드',3:'상품명',5:'판매가',12:'재고수량',15:'옵션번호',16:'옵션명',17:'옵션가',18:'옵션 재고수량',57:'즉시할인 기본할인',58:'기본할인 단위',93:'보존 열',95:'수식 보존'});
  for(const [code,members] of products.slice(part*Math.ceil(products.length/2),(part+1)*Math.ceil(products.length/2))){
   const row=Array(96).fill('');Object.assign(row,{0:code,1:`SELLER-${code}`,3:`원본상품 ${code}`,5:10000,12:77,15:members.map(x=>x.option_code).join('\n'),16:members.map(x=>`옵션 ${x.option_code}`).join('\n'),17:members.map(()=>0).join('\n'),18:members.map(x=>x.index%17).join('\n'),93:`KEEP-${code}`,95:{t:'n',f:'2+3',v:5}});rows.push(row);
  }
  const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(rows),'일괄수정');
  sources.push(new TestFile([XLSX.write(book,{type:'buffer',bookType:'xlsx'})],`large-smartstore-${part+1}.xlsx`));
 }
 const state={graphVersion:'graph-1',decisionVersion:1,decisionFinal:null},downloads=[],calls=[],proofReads=[],writes=[];
 let parsed=[],parsedByIdentity=new Map();
 function evidence(skus){
  const requested=new Set(skus),products=new Set(skus.map(sku=>bySku.get(sku)?.product_code).filter(Boolean));
  const groups=[],absence_proofs=[],rows=[];
  for(const product of products){
   const members=byProduct.get(product),targets=members.map(member=>({sku:member.sku,member_skus:[member.sku],seller_product_code:product,seller_option_code:member.option_code,price:tuple(10000),source_row_no:parsedByIdentity.get(member.option_code).source_row_no,source_valid:true,
    component_members:[{sku:member.sku,mapping_source:'carrier_cache',listing_id:null,component_id:null,component_qty:1,component_role:'primary'}]}));
   const entry={source_channel:'smartstore',seller_product_code:product,revision:0,mapping_valid:true,mapping_fingerprint:`mapping-${product}`,snapshot_id:snapshots.seller_snapshot_id,sellpia_snapshot_id:snapshots.sellpia_snapshot_id,source_observed_at:snapshots.sellpia_observed_at,sellpia_prices:Object.fromEntries(members.map(row=>[row.sku,rawPrices.get(row.sku)])),targets};
   if(state.decisionFinal!==null&&members.some(member=>member.sku==='P-0')){
    const target=targets.find(target=>target.sku==='P-0'),decision={sku:'P-0',source_channel:'smartstore',seller_product_code:product,seller_option_code:target.seller_option_code,price:tuple(state.decisionFinal),event_id:'decision-change',revision:state.decisionVersion,decision_source:'matrix_manual',effective_at:'2026-11-03T01:00:00Z',mapping_valid:true};
    target.current_state=decision;entry.revision=state.decisionVersion;entry.input_fingerprints={'P-0':'current-proof'};groups.push(entry);if(requested.has('P-0'))rows.push(decision);
   }else absence_proofs.push(entry);
  }
  const carrier_proofs=[...groups,...absence_proofs].map(entry=>{const {revision,mapping_valid,input_fingerprints,...proof}=entry;return {...proof,targets:proof.targets.map(({current_state,...target})=>target)};});
  return {rows,groups,proof_version:'sellpia-export-v2',absence_proofs,carrier_proofs,snapshots:{...snapshots}};
 }
 const D={
  async loadExportSkuDependencies({skus,expectedVersion}={}){
   calls.push('graph');if(expectedVersion&&expectedVersion!==state.graphVersion)throw Error('dependency graph changed');
   const requested=skus??mapping.map(row=>row.sku),selected=new Set(requested);for(let i=0;i<roots;i++)if(selected.has(`P-${i}`))selected.add(`C-${i}`);
   return {contract_version:1,version:state.graphVersion,snapshot_id:snapshots.sellpia_snapshot_id,requested_skus:[...requested].sort(),selected_skus:[...selected].sort(),reference_skus:[],edges:Array.from({length:roots},(_,i)=>({edge_id:`edge-${i}`,parent_sku:`P-${i}`,child_sku:`C-${i}`}))};
  },
  async loadExportCurrentPriceDecisions({skus}){calls.push('decisions');return evidence(skus);},
  async loadSellpiaSourcePricesForExport({skus}){calls.push('source-prices');return new Map(skus.map(sku=>[sku,rawPrices.get(sku)]));},
  async downloadLatestSellerOriginals(){calls.push('files');return new Map([['smartstore',sources]]);},
  async loadCarrierSellerMappings({identities}){const products=new Set(identities.map(row=>row.product_code));return {rows:mapping.filter(row=>products.has(row.product_code)).map(({index,...row})=>({...row}))};},
  async loadProductPriceSettings(){calls.push('settings-read');return {settings:[]};},
  async loadCarrierMatrixTargets(){throw Error('source-price mode must not read formula targets');},
  async loadSellpiaStockSourcesForExport(){throw Error('price-only export must preserve carrier stock');},
  async saveProductPriceSettings(){writes.push('settings');throw Error('preview/export must not save settings');},
  async recordStockExportAudit(){writes.push('stock');throw Error('price-only export must not write inventory');}
 };
 const value={console,Blob,File:TestFile,JSZip,XLSX,Map,Set,Number,String,JSON,RegExp,Error,Promise,Uint8Array,ArrayBuffer,Date,Math,Intl,setTimeout,clearTimeout,URL,TextEncoder,TextDecoder,AbortController,AbortSignal,performance,crypto:webcrypto,
  CustomEvent:class{constructor(type,init){this.type=type;this.detail=init?.detail;}},dispatchEvent(){},formatNumber:String,CHANNEL_LABELS:{smartstore:'스마트스토어'},assertMatrixChangesSaved(){},fetch:async()=>{throw Error('network forbidden');},SystemV3Data:D};
 value.window=value;value.globalThis=value;vm.createContext(value);
 for(const name of ['discount-price-math','seller-source-parsers','seller-export-adapter','rule-registry','current-price-export','product-price-adjustment','price-dependency-export','price-dependency-service'])vm.runInContext(read(name),value,{filename:name+'.js'});
 parsed=(await value.SystemV3SellerParsers.parseSellerFiles('smartstore',sources,{basic:true,price:true,discount:true,inventory:true})).normalizedRows;
 parsedByIdentity=new Map(parsed.map(row=>[row.option_code,row]));assert.equal(parsed.length,count);
 const resolver=value.HubCurrentPriceDecisionResolver;
 value.HubCurrentPriceDecisionResolver={...resolver,proof(decisions){
  if(decisions.skus.length===roots&&decisions.skus.every(sku=>sku.startsWith('P-'))){
   const latest=calls.lastIndexOf('graph'),previous=proofReads.filter(row=>row.graphCall===latest);assert.equal(previous.length,0,'serialize the complete parent decision evidence once per graph read, never once per parent');
   const proof=resolver.proof(decisions);proofReads.push({graphCall:latest,length:proof.length});return proof;
  }
  return resolver.proof(decisions);
 }};
 value.liveData=D;value.sellerExport={...value.SystemV3SellerExport,downloadBlob(blob,name){downloads.push({blob,name});}};
 vm.runInContext(prepare+'\nthis.prepare=prepareChangedOnlyExport;',value);vm.runInContext(bridge,value);
 const options={source:'smartstore',skus:mapping.map(row=>row.sku),priceMode:'sellpia_source',includeDependencies:true,includePrice:true,includeStock:false};
 const preview=()=>value.SystemV3SellerExportBridge.previewFullOriginal(options),run=expectedPlanFingerprint=>value.SystemV3SellerExportBridge.runFullOriginal({...options,expectedPlanFingerprint});
 return {value,mapping,sources,rawPrices,parsed,state,downloads,proofReads,writes,preview,run};
}

test('16000-option two-file Smartstore export hashes 850-parent evidence once, keeps final inheritance and preserves stock, formulas and originals',async()=>{
 const h=await harness(),originals=await Promise.all(h.sources.map(async source=>Buffer.from(await source.arrayBuffer())));
 const preview=await h.preview();assert.ok(preview.planFingerprint);assert.equal(preview.outputs.length,2);assert.equal(preview.dependencies.inheritedCount,850);assert.equal(preview.scopeSummary.blockedCount,0);
 assert.equal(h.proofReads.length,1);assert.ok(h.proofReads[0].length>500000,'the reproduction carries a real large batch decision proof');
 for(const row of preview.dependencies.rows.filter(row=>row.inherited)){assert.equal(row.final,h.rawPrices.get(row.root_sku));assert.match(row.price_proof.decisionProof,/^sha256:v1:[0-9a-f]{64}$/);}
 const generated=await h.run(preview.planFingerprint);assert.equal(h.downloads.filter(row=>row.name.endsWith('.xlsx')).length,2);assert.equal(generated.scopeSummary.blockedCount,0);
 const reparsed=(await h.value.SystemV3SellerParsers.parseSellerFiles('smartstore',generated.outputs.map(output=>new TestFile([output.blob],output.file.name)),{basic:true,price:true,discount:true,inventory:true})).normalizedRows;
 assert.equal(reparsed.length,16000);const byOption=new Map(reparsed.map(row=>[row.option_code,row]));
 for(const original of h.parsed){const after=byOption.get(original.option_code),mapping=h.mapping.find(row=>row.option_code===original.option_code),root=mapping.sku.startsWith('C-')?'P-'+mapping.sku.slice(2):mapping.sku;
  assert.equal(after.final_price,h.rawPrices.get(root),mapping.sku);assert.equal(after.stock,original.stock,`${mapping.sku} keeps inventory`);assert.equal(after.product_name,original.product_name);assert.equal(after.option_name,original.option_name);
 }
 for(let i=0;i<h.sources.length;i++){
  assert.deepEqual(Buffer.from(await h.sources[i].arrayBuffer()),originals[i]);
  const output=generated.outputs.find(output=>output.file.name===h.sources[i].name),before=XLSX.read(await h.sources[i].arrayBuffer(),{type:'array'}),after=XLSX.read(await output.blob.arrayBuffer(),{type:'array'});
  assert.equal(after.Sheets['일괄수정'].CR2.f,before.Sheets['일괄수정'].CR2.f);assert.equal(after.Sheets['일괄수정'].CP2.v,before.Sheets['일괄수정'].CP2.v);
  if(process.env.HUB_LARGE_EXPORT_ARTIFACT_DIR){fs.mkdirSync(process.env.HUB_LARGE_EXPORT_ARTIFACT_DIR,{recursive:true});fs.writeFileSync(new URL(output.file.name,'file:///'+process.env.HUB_LARGE_EXPORT_ARTIFACT_DIR.replace(/\\/g,'/')+'/'),Buffer.from(await output.blob.arrayBuffer()));}
 }
 assert.deepEqual(h.writes,[]);
});

test('graph, parent source price and current-decision changes each invalidate the preview before any file download',async()=>{
 for(const change of ['graph','source','decision']){
  const h=await harness({count:40,roots:2}),preview=await h.preview();
  if(change==='graph')h.state.graphVersion='graph-2';
  if(change==='source')h.rawPrices.set('P-0',14000);
  if(change==='decision')h.state.decisionFinal=14000;
  await assert.rejects(h.run(preview.planFingerprint),/변경|changed/);assert.equal(h.downloads.length,0,change);assert.deepEqual(h.writes,[]);
 }
});
