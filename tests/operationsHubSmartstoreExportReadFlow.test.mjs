import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url),XLSX=require('./vendor/xlsx-0.18.5.full.min.js'),JSZip=require('./vendor/jszip-3.10.1.min.js');
const read=name=>fs.readFileSync(new URL(`../mockups/operations-hub/${name}.js`,import.meta.url),'utf8');
const app=read('app'),prepare=app.slice(app.indexOf('async function prepareChangedOnlyExport('),app.indexOf('\nwindow.SystemV3SellerExportBridge='));
const plain=value=>JSON.parse(JSON.stringify(value));
class TestFile extends Blob{constructor(parts,name){super(parts,{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});this.name=name;}}
const snapshots={seller_snapshot_id:'00000000-0000-4000-8000-000000000001',sellpia_snapshot_id:'00000000-0000-4000-8000-000000000002',sellpia_observed_at:'2026-10-21T00:00:00Z'};
const mapping=[['A','1001','A'],['B','1001','B'],['C','1002','C'],['D','1003','D'],['E','1004','E'],['INVERSE','1004','E']].map(([sku,product_code,option_code])=>({sku,product_code,option_code}));
const rawPrices={A:32000,B:33500,C:99000,D:5000,E:7000,INVERSE:7000};

function workbook(){
  const rows=Array.from({length:5},()=>Array(112).fill(''));
  Object.assign(rows[0],{0:'상품번호',1:'판매자 상품코드',3:'상품명',5:'판매가',12:'재고수량',15:'옵션번호',16:'옵션명',17:'옵션가',18:'옵션 재고수량',93:'보존 열'});
  for(const [index,code,name,base,options,prices,stocks] of [[1,'1001','공유 상품',30000,'A\nB','0\n3500','5\n6'],[2,'1002','현재 결정 상품',16000,'C','0','7'],[3,'1003','변경 없는 상품',5000,'D','0','8'],[4,'1004','역방향 모호 상품',7000,'E','0','9']]){
    Object.assign(rows[index],{0:code,1:`sellpia_${code}`,3:name,5:base,12:20+index,15:options,16:options.split('\n').map(value=>`원본 옵션 ${value}`).join('\n'),17:prices,18:stocks,93:`보존-${code}`});
  }
  const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(rows),'일괄수정');
  return {file:new TestFile([XLSX.write(book,{type:'buffer',bookType:'xlsx'})],'smartstore-export.xlsx'),rows};
}
const baseTuple=(base,option=0)=>({base,discounted:base,option,final:base+option,terms:[]});
function evidence(parsed,skus){
  const requested=new Set(skus),groups=[],absence_proofs=[],rows=[];
  for(const product of new Set(mapping.filter(row=>requested.has(row.sku)).map(row=>row.product_code))){
    const members=mapping.filter(row=>row.product_code===product),sourceRows=parsed.filter(row=>row.product_code===product);
    const entry={source_channel:'smartstore',seller_product_code:product,revision:0,mapping_valid:true,mapping_fingerprint:`mapping-${product}`,
      snapshot_id:snapshots.seller_snapshot_id,sellpia_snapshot_id:snapshots.sellpia_snapshot_id,source_observed_at:snapshots.sellpia_observed_at,
      sellpia_prices:Object.fromEntries(members.map(row=>[row.sku,rawPrices[row.sku]])),targets:sourceRows.map(row=>({sku:members.find(member=>member.option_code===row.option_code)?.sku,
        member_skus:members.filter(member=>member.option_code===row.option_code).map(member=>member.sku),seller_product_code:product,seller_option_code:row.option_code,
        price:baseTuple(row.base_price,row.option_price),source_row_no:row.source_row_no,source_valid:true,component_members:members.map(member=>({sku:member.sku,component_qty:1,component_role:'primary'}))}))};
    if(product==='1002'){
      const state={price:baseTuple(20000,-1100),event_id:7,revision:1,decision_source:'matrix_manual',effective_at:'2026-10-21T00:01:00Z'};
      entry.revision=1;entry.input_fingerprints={C:'current-rule-input'};entry.targets[0].current_state=state;groups.push(entry);
      if(requested.has('C'))rows.push({sku:'C',source_channel:'smartstore',seller_product_code:product,seller_option_code:'C',mapping_valid:true,...state});
    }else absence_proofs.push(entry);
  }
  const carrier_proofs=[...groups,...absence_proofs].map(entry=>{
    const {revision,mapping_valid,input_fingerprints,...proof}=plain(entry);
    proof.targets=proof.targets.map(({current_state,raw_payload,...target})=>target);
    return proof;
  });
  return {rows,groups,proof_version:'sellpia-export-v2',absence_proofs,carrier_proofs,snapshots:{...snapshots}};
}

async function harness(){
  const source=workbook(),calls=[],downloads=[],tableReads=[],state={mutate:null,error:null,sourcePriceAtRead:null};
  let parsed;
  const db={
    async rpc(name,args){
      assert.ok(['hub_price_decision_export_read_v2','hub_price_decision_export_read_v3'].includes(name),'preview and generation must use a bounded export read without calling the editor RPC');
      calls.push({name,args:plain(args)});
      if(state.error)return {data:null,error:state.error};
      const data=evidence(parsed,args.p_skus);state.mutate?.(data,calls.length);
      return {data,error:null};
    },
    from(table){
      assert.equal(table,'operations_hub_matrix_system_live','this fixture allows only the separately unchanged source-price reader');
      return {select(columns){assert.equal(columns,'sellpia_sku_code,sellpia_source_sale_price,sellpia_source_updated_at');return this;},in(field,values){
        assert.equal(field,'sellpia_sku_code');tableReads.push([...values]);
        return Promise.resolve({data:values.map(sellpia_sku_code=>({sellpia_sku_code,sellpia_source_sale_price:state.sourcePriceAtRead?.(sellpia_sku_code,tableReads.length)??rawPrices[sellpia_sku_code],sellpia_source_updated_at:'2026-10-21T00:00:00Z'})),error:null});
      }};
    },storage:new Proxy({},{get(){throw Error('storage access forbidden');}})
  };
  const value={console,Blob,File:TestFile,JSZip,XLSX,Map,Set,Number,String,JSON,RegExp,Error,Promise,Uint8Array,ArrayBuffer,Date,Math,Intl,setTimeout,clearTimeout,URL,TextEncoder,TextDecoder,AbortController,AbortSignal,performance,
    formatNumber:String,CHANNEL_LABELS:{smartstore:'스마트스토어'},assertMatrixChangesSaved(){},fetch:async()=>{throw Error('network forbidden');},supabase:{createClient:()=>db}};
  value.window=value;value.globalThis=value;vm.createContext(value);
  for(const name of ['discount-price-math','sellpia-inventory-count','seller-source-parsers','seller-export-adapter','current-price-export','data-service'])vm.runInContext(read(name),value,{filename:name+'.js'});
  value.SystemV3Data.setOperationsHubSessionToken('test-session');
  parsed=(await value.SystemV3SellerParsers.parseSellerFiles('smartstore',[source.file],{price:true,discount:true,inventory:false})).normalizedRows;
  value.liveData={...value.SystemV3Data,
    async downloadLatestSellerOriginals(){return new Map([['smartstore',[source.file]]]);},
    async loadCarrierSellerMappings(){return {rows:mapping.map(row=>({...row}))};},
    async loadCarrierMatrixTargets(){throw Error('rules calculation forbidden in Sellpia source mode');},
    async loadSellpiaStockSourcesForExport(){throw Error('stock read forbidden in price-only mode');},
    async recordStockExportAudit(){throw Error('audit writes forbidden in this read-only price workflow');}
  };
  value.sellerExport={...value.SystemV3SellerExport,downloadBlob(blob,name){downloads.push({blob,name});}};
  vm.runInContext(prepare+'\nthis.prepare=prepareChangedOnlyExport;',value);
  const run=options=>value.prepare('smartstore',['A','C','D','E'],{mode:'target_all',priceMode:'sellpia_source',includePrice:true,includeStock:false,...options});
  return {run,value,calls,downloads,tableReads,state,source,parsed};
}
async function cells(blob){const book=XLSX.read(await blob.arrayBuffer(),{type:'array'});return XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]],{header:1,raw:true,defval:''});}

function dependencies(h,{price=32000,graphVersion='graph-1',forceRoot=false}={}){
  vm.runInContext(read('price-dependency-export'),h.value);
  const state={price,graphVersion,verified:0};
  h.value.HubPriceDependencyService={
    async prepare({source,skus,priceMode}){
      const context={contract_version:1,version:state.graphVersion,requested_skus:skus,selected_skus:[...new Set([...skus,...(skus.includes('A')?['C']:[])])].sort(),reference_skus:skus.includes('A')?[]:['A'],edges:[{edge_id:1,parent_sku:'A',child_sku:'C'}]};
      const resolution=h.value.HubPriceDependencyExport.resolve({context,selection:skus,parentPrices:new Map([['A',{final:state.price,proof:{mode:priceMode}}]])});
      if(forceRoot)for(const row of resolution.rows)if(row.sku==='A'){row.dependency_root=true;row.final=state.price;}
      return {source,context,resolution,outputSkus:resolution.outputSkus,proof:resolution.proof,summary:{enabled:true,rows:resolution.rows}};
    },async verify(){state.verified++;}
  };
  return state;
}

test('dependency ON auto includes collection and copies parent final over child decision without modifying source or sibling cells',async()=>{
 const h=await harness(),state=dependencies(h),options={mode:'target_all',priceMode:'sellpia_source',includePrice:true,includeStock:false,includeDependencies:true};
 const preview=await h.value.prepare('smartstore',['A'],options),output=await cells(preview.outputs[0].blob),byCode=new Map(output.slice(1).map(row=>[String(row[0]),row]));
 assert.equal(preview.scopeSummary.selectedSkuCount,2);
 assert.ok(h.calls.every(call=>call.name==='hub_price_decision_export_read_v3'),'dependency previews use the full large-group proof reader');
 assert.deepEqual([Number(byCode.get('1001')[5]),byCode.get('1001')[17]],[32000,'0\n1500']);
 assert.deepEqual([Number(byCode.get('1002')[5]),Number(byCode.get('1002')[17])],[32000,0],'collection gets exact parent final, replacing its 18,900 current decision only in this export');
 const child=preview.plans.flatMap(plan=>plan.preview).find(row=>row.sku==='C');
 assert.equal(child.dependency.parent_sku,'A');assert.equal(child.dependency.automatically_included,true);assert.equal(child.diff.price.after.final,32000);
 for(const code of ['1001','1002'])for(const column of [0,1,3,12,15,16,18,93])assert.equal(byCode.get(code)[column],h.source.rows.find(row=>row[0]===code)[column]);
 await h.value.prepare('smartstore',['A'],{...options,download:true,expectedPlanFingerprint:preview.planFingerprint});
 assert.equal(state.verified,1);assert.equal(h.downloads.filter(entry=>entry.name.endsWith('.xlsx')).length,1);
});

test('dependency rules mode copies final scalar without applying collection formula again; child-only scope can read outside parent',async()=>{
 const h=await harness();dependencies(h,{price:40000});
 h.value.liveData.loadCurrentPriceDecisions=h.value.liveData.loadExportCurrentPriceDecisions;
 h.value.liveData.loadCarrierMatrixTargets=async({skus})=>({rows:skus.map(sku=>({sku,active_price_rule:true,current_effective_price:{platformBase:60000,platformDiscount:0,platformOption:0,platformFinal:60000,platformTerms:[]}}))});
 const result=await h.value.prepare('smartstore',['C'],{mode:'target_all',priceMode:'rules',includePrice:true,includeStock:false,includeDependencies:true});
 const output=await cells(result.outputs[0].blob);
 assert.equal(output.length,2);assert.equal(String(output[1][0]),'1002');assert.equal(Number(output[1][5])+Number(output[1][17]),40000);
 assert.equal(result.scopeSummary.selectedSkuCount,1,'reference-only parent is not added to output');
});

test('dependency graph and parent price changes invalidate preview even when ordinary child decisions remain the same',async()=>{
 const h=await harness(),state=dependencies(h),options={mode:'target_all',priceMode:'sellpia_source',includePrice:true,includeStock:false,includeDependencies:true};
 const before=await h.value.prepare('smartstore',['A'],options);
 state.graphVersion='graph-2';
 await assert.rejects(h.value.prepare('smartstore',['A'],{...options,download:true,expectedPlanFingerprint:before.planFingerprint}),/미리보기/);
 assert.equal(h.downloads.length,0);
 state.graphVersion='graph-1';state.price=33000;
 await assert.rejects(h.value.prepare('smartstore',['A'],{...options,download:true,expectedPlanFingerprint:before.planFingerprint}),/미리보기/);
 assert.equal(h.downloads.length,0);
});

test('a parent with only an edited Matrix internal price is exported together with its collection at the same final',async()=>{
 const h=await harness();dependencies(h,{price:34000,forceRoot:true});
 h.value.liveData.loadCarrierMatrixTargets=async()=>({rows:[]});
 h.value.liveData.loadCurrentPriceDecisions=h.value.liveData.loadExportCurrentPriceDecisions;
 const result=await h.value.prepare('smartstore',['A'],{mode:'target_all',priceMode:'rules',includePrice:true,includeStock:false,includeDependencies:true});
 const output=await cells(result.outputs[0].blob),byCode=new Map(output.slice(1).map(row=>[String(row[0]),row]));
 assert.equal(Number(byCode.get('1001')[5])+Number(String(byCode.get('1001')[17]).split('\n')[0]),34000);
 assert.equal(Number(byCode.get('1002')[5])+Number(byCode.get('1002')[17]),34000);
 const sibling=String(byCode.get('1001')[17]).split('\n').map(Number)[1];
 assert.equal(Number(byCode.get('1001')[5])+sibling,33500,'unselected individual sibling final stays unchanged');
});

test('changing the checkbox or closing while final dependency verification is pending prevents native downloads',async()=>{
 const h=await harness();dependencies(h);
 let current=true;const options={mode:'target_all',priceMode:'sellpia_source',includePrice:true,includeStock:false,includeDependencies:true,isCurrent:()=>current};
 const preview=await h.value.prepare('smartstore',['A'],options);
 h.value.HubPriceDependencyService.verify=async()=>{current=false;};
 await assert.rejects(h.value.prepare('smartstore',['A'],{...options,download:true,expectedPlanFingerprint:preview.planFingerprint}),/설정이 변경|취소/);
 assert.equal(h.downloads.length,0);
});

test('stock-only never reads dependencies even if a stale checkbox flag is passed',async()=>{
 const h=await harness();h.value.HubPriceDependencyService={prepare(){throw Error('dependency lookup forbidden');}};
 h.value.liveData.loadSellpiaStockSourcesForExport=async({skus})=>({snapshotId:'stock',bySku:new Map(skus.map(sku=>[sku,{sellpia_current_stock:5,sellpia_available_stock:5}]))});
 await h.value.prepare('smartstore',['A'],{mode:'target_all',includePrice:false,includeStock:true,stockSource:'stock',includeDependencies:true});
});

test('collection registration price is composed independently from inherited finals and preserves both negative and positive option deltas in actual XLSX',async()=>{
 const h=await harness();vm.runInContext(read('price-dependency-export'),h.value);
 const context={contract_version:1,version:'wide-collection',requested_skus:['ROOT_A','ROOT_B'],selected_skus:['A','B','ROOT_A','ROOT_B'],reference_skus:[],edges:[{parent_sku:'ROOT_A',child_sku:'A'},{parent_sku:'ROOT_B',child_sku:'B'}]};
 let prices=[5000,15000];
 h.value.HubPriceDependencyService={async prepare(){
  const resolution=h.value.HubPriceDependencyExport.resolve({context,parentPrices:new Map([['ROOT_A',prices[0]],['ROOT_B',prices[1]]])});
  return {context,resolution,outputSkus:resolution.outputSkus,proof:resolution.proof,summary:{enabled:true,rows:resolution.rows}};
 },async verify(){}};
 const options={mode:'target_all',priceMode:'sellpia_source',includePrice:true,includeStock:false,includeDependencies:true};
 const result=await h.value.prepare('smartstore',['ROOT_A','ROOT_B'],options),output=await cells(result.outputs[0].blob),row=output.find(row=>String(row[0])==='1001');
 assert.equal(Number(row[5]),10000,'collection base differs from each individual final and is not copied from either parent');
 assert.deepEqual(String(row[17]).split('\n').map(Number),[-5000,5000]);
 assert.deepEqual(String(row[17]).split('\n').map(value=>Number(row[5])+Number(value)),prices);
 assert.deepEqual(plain(result.plans[0].preview.map(row=>[row.sku,row.option_code,row.diff.price.after.final])),[['A','A',5000],['B','B',15000]],'options sharing a physical spreadsheet row retain distinct identities and preview prices');
 for(const column of [0,1,3,12,15,16,18,93])assert.equal(row[column],h.source.rows[1][column]);
 prices=[1000,100000];
 const blocked=await h.value.prepare('smartstore',['ROOT_A','ROOT_B'],options);
 assert.equal(blocked.changedItems.filter(item=>item.field_key==='sellpia_sale_price').length,0);
 assert.ok(blocked.plans[0].preview.every(row=>row.status==='blocked'));
 assert.match(blocked.plans[0].preview[0].reason,/옵션가 허용범위/);
});

test('actual app, data service, parser and XLSX serializer preserve price precedence, siblings, unchanged targets and untouched cells',async()=>{
  const h=await harness(),before=Buffer.from(await h.source.file.arrayBuffer());
  const preview=await h.run({download:false});
  assert.equal(h.calls.length,1);assert.equal(h.downloads.length,0);
  assert.equal(preview.scopeSummary.selectedSkuCount,4);assert.equal(preview.scopeSummary.unchangedOptionCount,1);
  assert.equal(preview.scopeSummary.blockedCount,1);assert.equal(preview.scopeSummary.outputRowCount,3);
  const output=await cells(preview.outputs[0].blob),byCode=new Map(output.slice(1).map(row=>[String(row[0]),row]));
  assert.deepEqual([Number(byCode.get('1001')[5]),byCode.get('1001')[17]],[32000,'0\n1500'],'selected raw price changes shared base while the unselected sibling final remains 33,500');
  assert.deepEqual([Number(byCode.get('1002')[5]),Number(byCode.get('1002')[17])],[20000,-1100],'accepted current decision 18,900 wins over raw Sellpia 99,000');
  assert.equal(Number(byCode.get('1003')[5]),5000,'a selected no-op remains in target_all output');
  assert.equal(byCode.has('1004'),false,'inverse ambiguous identity cannot be serialized as a unique match');
  for(const code of ['1001','1002','1003']){
    const original=h.source.rows.find(row=>row[0]===code),actual=byCode.get(code);
    for(const column of [0,1,3,12,15,16,18,93])assert.equal(actual[column],original[column],`${code} column ${column} is preserved`);
  }
  assert.ok(h.tableReads.flat().every(sku=>!['B','C','INVERSE'].includes(sku)),'only selected SKUs without current decisions require a raw price read');
  await h.run({download:true,expectedPlanFingerprint:preview.planFingerprint});
  assert.equal(h.calls.length,3,'generation rereads via the same optimized protocol and performs a fresh final proof read');
  assert.equal(h.downloads.filter(entry=>entry.name.endsWith('.xlsx')).length,1);
  assert.deepEqual(Buffer.from(await h.source.file.arrayBuffer()),before,'the original XLSX is immutable');
});

test('final generation rejects new, removed or changed decisions and source/mapping proof drift before offering a download',async()=>{
  const mutations=[
    data=>{data.absence_proofs.find(entry=>entry.seller_product_code==='1001').mapping_fingerprint='new-mapping';},
    data=>{data.absence_proofs.find(entry=>entry.seller_product_code==='1001').sellpia_prices.A=32100;},
    data=>{data.absence_proofs.find(entry=>entry.seller_product_code==='1001').targets[0].price=baseTuple(32100);},
    data=>{data.groups[0].input_fingerprints.C='changed-rule-input';},
    data=>{data.rows[0].price=baseTuple(20000,-1000);data.groups[0].targets[0].current_state.price=baseTuple(20000,-1000);},
    data=>{const group=data.groups.shift();data.rows=[];delete group.input_fingerprints;group.revision=0;delete group.targets[0].current_state;data.absence_proofs.push(group);},
    data=>{const index=data.absence_proofs.findIndex(entry=>entry.seller_product_code==='1003'),group=data.absence_proofs.splice(index,1)[0];group.revision=1;group.input_fingerprints={D:'new-decision'};const row={sku:'D',source_channel:'smartstore',seller_product_code:'1003',seller_option_code:'D',price:baseTuple(5500),event_id:8,revision:1,decision_source:'matrix_manual',effective_at:'2026-10-21T00:02:00Z',mapping_valid:true};group.targets[0].current_state=row;data.rows.push(row);data.groups.push(group);},
    data=>{data.snapshots.seller_snapshot_id='new-seller-snapshot';for(const group of [...data.groups,...data.absence_proofs,...data.carrier_proofs])group.snapshot_id='new-seller-snapshot';}
  ];
  for(const mutate of mutations){
    const h=await harness(),preview=await h.run({download:false});
    h.state.mutate=(data,index)=>{if(index===3)mutate(data);};
    await assert.rejects(h.run({download:true,expectedPlanFingerprint:preview.planFingerprint}),/미리보기|변경|증거/);
    assert.equal(h.calls.length,3);assert.equal(h.downloads.length,0,'a stale proof cannot publish even an otherwise valid serialized workbook');
  }
});

test('missing product proof, invalid orphan decisions and RPC timeouts fail without falling back or downloading',async()=>{
  for(const kind of ['missing-proof','orphan','timeout']){
    const h=await harness();
    if(kind==='timeout')h.state.error={code:'57014',message:'synthetic decision read timeout'};
    else h.state.mutate=data=>{
      if(kind==='missing-proof')data.carrier_proofs=data.carrier_proofs.filter(entry=>entry.seller_product_code!=='1003');
      else data.rows.push({sku:'A',source_channel:'smartstore',seller_product_code:'ORPHAN',seller_option_code:'missing',price:baseTuple(5000),event_id:90,revision:1,decision_source:'matrix_manual',effective_at:'2026-10-21T00:00:00Z',mapping_valid:false});
    };
    await assert.rejects(h.run({download:false}),/증거|identity|timeout|연결/);
    assert.equal(h.calls.length,1);assert.equal(h.downloads.length,0);
  }
});

test('the final raw Sellpia source-price recheck also blocks a value changed after the plan was serialized',async()=>{
  const h=await harness(),preview=await h.run({download:false});
  h.state.sourcePriceAtRead=(sku,index)=>sku==='A'&&index===3?32100:rawPrices[sku];
  await assert.rejects(h.run({download:true,expectedPlanFingerprint:preview.planFingerprint}),/셀피아 원본 판매가가 변경/);
  assert.equal(h.tableReads.length,3);assert.equal(h.calls.length,2,'the raw source mismatch stops generation before final decision verification');
  assert.equal(h.downloads.length,0);
});

function cacheOnlyProduct(data){
  data.absence_proofs=data.absence_proofs.filter(entry=>entry.seller_product_code!=='1001');
  const carrier=data.carrier_proofs.find(entry=>entry.seller_product_code==='1001');
  for(const target of carrier.targets)for(const component of target.component_members||[])component.mapping_source='carrier_cache';
  return carrier;
}

test('cache-only carrier mappings remain exportable without fabricating canonical price groups and final cache drift blocks generation',async()=>{
  const h=await harness();h.state.mutate=data=>{cacheOnlyProduct(data);};
  const preview=await h.run({download:false});
  assert.equal(preview.scopeSummary.outputRowCount,3);
  assert.equal(preview.plans[0].preview.find(row=>row.sku==='A').diff.price.after.final,32000);
  const output=await cells(preview.outputs[0].blob);
  assert.equal(Number(output.find(row=>String(row[0])==='1001')[5]),32000);
  h.state.mutate=(data,index)=>{const carrier=cacheOnlyProduct(data);if(index===3)carrier.mapping_fingerprint='cache-only-mapping-changed';};
  await assert.rejects(h.run({download:true,expectedPlanFingerprint:preview.planFingerprint}),/미리보기|변경/);
  assert.equal(h.downloads.length,0);
});

test('carrier coverage requires the exact mapped option and SKU rather than just the seller product',async()=>{
  const h=await harness();h.state.mutate=data=>{
    const carrier=cacheOnlyProduct(data),target=carrier.targets.find(target=>target.seller_option_code==='A');
    target.sku='OTHER';target.member_skus=['OTHER'];
  };
  await assert.rejects(h.run({download:false}),/증거|연결|identity/);
  assert.equal(h.downloads.length,0);
});
