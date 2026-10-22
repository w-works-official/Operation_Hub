import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url),XLSX=require('./vendor/xlsx-0.18.5.full.min.js'),JSZip=require('./vendor/jszip-3.10.1.min.js');
const read=name=>fs.readFileSync(new URL(`../mockups/operations-hub/${name}.js`,import.meta.url),'utf8');
const app=read('app'),bridgeStart=app.indexOf('window.SystemV3SellerExportBridge='),bridgeEnd=app.indexOf('\n};',bridgeStart)+3;
const prepare=app.slice(app.indexOf('async function prepareChangedOnlyExport('),bridgeStart);
const bridge=app.slice(bridgeStart,bridgeEnd);
const plain=value=>JSON.parse(JSON.stringify(value));
const productCode='8005434563';
const snapshots={seller_snapshot_id:'00000000-0000-4000-8000-000000000001',sellpia_snapshot_id:'00000000-0000-4000-8000-000000000002',sellpia_observed_at:'2026-10-22T00:00:00Z'};
class TestFile extends Blob{constructor(parts,name){super(parts,{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});this.name=name;}}
const basic=value=>({term_key:'basic',term_type:'basic',value,unit:'amount',rounding_mode:'nearest',rounding_unit:1,is_baseline:true,title:'즉시할인 기본할인'});
const tuple=(base,discount,final)=>({base,discounted:base-discount,option:final-(base-discount),final,terms:discount?[basic(discount)]:[]});
const draft=(basePrice=9000,basicDiscount=2000)=>({source:'smartstore',productCode,basePrice,basicDiscount});

function workbook(name,products){
  const rows=[Array(112).fill('')];
  Object.assign(rows[0],{0:'상품번호',1:'판매자 상품코드',3:'상품명',5:'판매가',12:'재고수량',15:'옵션번호',16:'옵션명',17:'옵션가',18:'옵션 재고수량',57:'즉시할인 기본할인',58:'기본할인 단위',93:'보존 열'});
  for(const product of products){
    const row=Array(112).fill(''),options=product.options,base=product.base??10000,discount=product.discount??3000;
    Object.assign(row,{0:product.productCode,1:`seller-${product.productCode}`,3:`원본 상품명 ${product.productCode}`,5:base,12:91,
      15:options.map(option=>option.option).join('\n'),16:options.map(option=>`이름-${option.option}`).join('\n'),
      17:options.map(option=>option.final-(base-discount)).join('\n'),18:options.map((_,index)=>index%13).join('\n'),
      57:discount,58:'원',93:`보존-${product.productCode}`});
    if(product.productCode===productCode)Object.assign(row,{59:7,60:'%'});
    rows.push(row);
  }
  const book=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet(rows);sheet['!cols']=[{wch:22},{wch:25},{wch:15},{wch:40}];
  XLSX.utils.book_append_sheet(book,sheet,'일괄수정');
  return {file:new TestFile([XLSX.write(book,{type:'buffer',bookType:'xlsx'})],name),rows};
}

async function harness({siblingCount=218,splitSameProduct=false,duplicateAcrossFiles=false}={}){
  const siblings=Array.from({length:siblingCount},(_,index)=>({sku:`SIBLING-${index}`,option:`OPTION-${index}`,final:3000+Math.round(index*7500/Math.max(1,siblingCount-1)/100)*100}));
  if(!siblings.some(option=>option.final===7000))siblings.push({sku:'ZERO-OPTION',option:'ZERO-OPTION',final:7000});
  const products=[{productCode,options:[{sku:'SELECTED',option:'SELECTED',final:7000},...siblings]},
    {productCode:'8005434564',base:6000,discount:0,options:[{sku:'UNTOUCHED',option:'UNTOUCHED',final:6000}]},
    {productCode:'8005434565',base:5000,discount:0,options:[{sku:'SECOND',option:'SECOND',final:5000}]}];
  const sources=splitSameProduct
    ?[workbook('smartstore-one.xlsx',[{...products[0],options:products[0].options.slice(0,1)},products[1]]),
      workbook('smartstore-two.xlsx',[{...products[0],options:products[0].options.slice(duplicateAcrossFiles?0:1)},products[2]])]
    :[workbook('smartstore-one.xlsx',products.slice(0,2)),workbook('smartstore-two.xlsx',products.slice(2))];
  const mapping=products.flatMap(product=>product.options.map(option=>({sku:option.sku,product_code:product.productCode,option_code:option.option})));
  const rawPrices=Object.fromEntries([...mapping.map(row=>[row.sku,row.sku==='SELECTED'?3000:row.sku==='SECOND'?5500:products.flatMap(product=>product.options).find(option=>option.sku===row.sku).final]),['ROOT',3000]]);
  const calls=[],downloads=[],sourceReads=[],graphReads=[],state={mutate:null,afterDecision:null,sourcePriceAtRead:null,graphVersion:'graph-1',currentDecision:false};
  let parsed=[];
  function evidence(skus){
    const requested=new Set(skus),rows=[],groups=[],absence_proofs=[];
    for(const product of new Set(mapping.filter(row=>requested.has(row.sku)).map(row=>row.product_code))){
      const members=mapping.filter(row=>row.product_code===product),sourceRows=parsed.filter(row=>row.product_code===product);
      const entry={source_channel:'smartstore',seller_product_code:product,revision:0,mapping_valid:true,mapping_fingerprint:`mapping-${product}`,
        snapshot_id:snapshots.seller_snapshot_id,sellpia_snapshot_id:snapshots.sellpia_snapshot_id,source_observed_at:snapshots.sellpia_observed_at,
        sellpia_prices:Object.fromEntries(members.map(row=>[row.sku,rawPrices[row.sku]])),targets:sourceRows.map(row=>({
          sku:members.find(member=>member.option_code===row.option_code).sku,member_skus:members.filter(member=>member.option_code===row.option_code).map(member=>member.sku),
          seller_product_code:product,seller_option_code:row.option_code,price:tuple(row.base_price,row.base_price-row.discounted_base_price,row.final_price),source_row_no:row.source_row_no,source_valid:true,
          component_members:members.filter(member=>member.option_code===row.option_code).map(member=>({sku:member.sku,mapping_source:'carrier_cache',listing_id:null,component_id:null,component_qty:1,component_role:'primary'}))}))};
      if(state.currentDecision&&product===productCode){
        const target=entry.targets.find(target=>target.sku==='SELECTED'),decision={sku:'SELECTED',source_channel:'smartstore',seller_product_code:product,seller_option_code:'SELECTED',price:tuple(10000,3000,3000),event_id:'manual-1',revision:1,decision_source:'matrix_manual',effective_at:'2026-10-22T00:01:00Z',mapping_valid:true};
        entry.revision=1;entry.input_fingerprints={SELECTED:'current-input'};target.current_state=decision;
        if(requested.has('SELECTED'))rows.push(decision);groups.push(entry);
      }else absence_proofs.push(entry);
    }
    const carrier_proofs=[...groups,...absence_proofs].map(entry=>{const {revision,mapping_valid,input_fingerprints,...proof}=plain(entry);proof.targets=proof.targets.map(({current_state,...target})=>target);return proof;});
    return {rows,groups,proof_version:'sellpia-export-v2',absence_proofs,carrier_proofs,snapshots:{...snapshots}};
  }
  const db={
    async rpc(name,args){
      if(name==='hub_export_sku_dependencies_read_v1'){
        graphReads.push(plain(args));
        if(args.p_expected_version&&args.p_expected_version!==state.graphVersion)return {data:null,error:{message:'dependency graph changed'}};
        const requested=args.p_skus||mapping.map(row=>row.sku),selected=[...new Set([...requested,...(requested.includes('ROOT')?['SELECTED']:[])])].sort(),references=selected.includes('SELECTED')&&!selected.includes('ROOT')?['ROOT']:[];
        return {data:{contract_version:1,version:state.graphVersion,snapshot_id:snapshots.sellpia_snapshot_id,requested_skus:[...requested].sort(),selected_skus:selected,reference_skus:references,edges:selected.includes('SELECTED')?[{edge_id:'ROOT-SELECTED',parent_sku:'ROOT',child_sku:'SELECTED'}]:[]},error:null};
      }
      assert.ok(['hub_price_decision_export_read_v2','hub_price_decision_export_read_v3'].includes(name),`unexpected RPC ${name}; no price decisions or mapping writes are authorized`);
      calls.push({name,args:plain(args)});const data=evidence(args.p_skus);state.mutate?.(data,calls.length);state.afterDecision?.(data,calls.length);return {data,error:null};
    },
    from(table){
      assert.equal(table,'operations_hub_matrix_system_live','only the existing raw source-price view may be read');
      return {select(columns){assert.equal(columns,'sellpia_sku_code,sellpia_source_sale_price,sellpia_source_updated_at');return this;},in(field,skus){
        assert.equal(field,'sellpia_sku_code');sourceReads.push([...skus]);
        return Promise.resolve({data:skus.map(sku=>({sellpia_sku_code:sku,sellpia_source_sale_price:state.sourcePriceAtRead?.(sku,sourceReads.length)??rawPrices[sku],sellpia_source_updated_at:'2026-10-22T00:00:00Z'})),error:null});
      }};
    },storage:new Proxy({},{get(){throw Error('storage writes and downloads are forbidden in this fixture');}})
  };
  const value={console,Blob,File:TestFile,JSZip,XLSX,Map,Set,Number,String,JSON,RegExp,Error,Promise,Uint8Array,ArrayBuffer,Date,Math,Intl,setTimeout,clearTimeout,URL,TextEncoder,TextDecoder,AbortController,AbortSignal,performance,
    CustomEvent:class CustomEvent{constructor(type,init){this.type=type;this.detail=init?.detail;}},dispatchEvent(){},formatNumber:String,CHANNEL_LABELS:{smartstore:'스마트스토어'},assertMatrixChangesSaved(){},fetch:async()=>{throw Error('network forbidden');},supabase:{createClient:()=>db}};
  value.window=value;value.globalThis=value;vm.createContext(value);
  for(const name of ['discount-price-math','sellpia-inventory-count','seller-source-parsers','seller-export-adapter','rule-registry','current-price-export','product-price-adjustment','data-service','price-dependency-export','price-dependency-service'])vm.runInContext(read(name),value,{filename:name+'.js'});
  value.SystemV3Data.setOperationsHubSessionToken('test-session');
  parsed=(await value.SystemV3SellerParsers.parseSellerFiles('smartstore',sources.map(source=>source.file),{price:true,discount:true,inventory:true})).normalizedRows;
  const matrixTargets=async({skus})=>({rows:skus.map(sku=>({sku,active_price_rule:['SELECTED','SECOND','ROOT'].includes(sku),current_effective_price:['SELECTED','SECOND','ROOT'].includes(sku)?{
    platformBase:sku==='SECOND'?5000:10000,platformDiscount:sku==='SECOND'?0:3000,platformOption:sku==='SECOND'?500:-4000,platformFinal:rawPrices[sku],platformTerms:sku==='SECOND'?[]:[basic(3000)],versions:[{id:'fixture-current-rule',version:1}]
  }:null}))});
  value.SystemV3Data={...value.SystemV3Data,loadCarrierMatrixTargets:matrixTargets};
  value.liveData={...value.SystemV3Data,
    async downloadLatestSellerOriginals(){return new Map([['smartstore',sources.map(source=>source.file)]]);},
    async loadCarrierSellerMappings({identities}){const products=new Set(identities.map(row=>row.product_code));return {rows:mapping.filter(row=>products.has(row.product_code)).map(row=>({...row}))};},
    async loadSellpiaStockSourcesForExport(){throw Error('stock reads are forbidden in the price-only fixture');},
    async recordStockExportAudit(){throw Error('DB writes are forbidden in the price adjustment fixture');}
  };
  value.sellerExport={...value.SystemV3SellerExport,downloadBlob(blob,name){downloads.push({blob,name});}};
  vm.runInContext(prepare+'\nthis.prepare=prepareChangedOnlyExport;',value);
  vm.runInContext(bridge,value);
  const run=options=>value.prepare('smartstore',['SELECTED','SECOND'],{mode:'full_original',priceMode:'sellpia_source',includePrice:true,includeStock:false,...options});
  return {value,run,sources,parsed,mapping,rawPrices,siblings,calls,sourceReads,graphReads,downloads,state};
}

async function cells(blob){const book=XLSX.read(await blob.arrayBuffer(),{type:'array'});return XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]],{header:1,raw:true,defval:''});}
async function worksheet(blob){const zip=await JSZip.loadAsync(await blob.arrayBuffer());return {zip,xml:await zip.file('xl/worksheets/sheet1.xml').async('string')};}
const cellMap=xml=>new Map([...xml.matchAll(/<c\b([^>]*?\br="([A-Z]+\d+)"[^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map(match=>[match[2],match[0]]));
async function assertProtected(h,result){
  assert.equal(result.outputs.length,2,'both original Smartstore files must be returned');
  for(const output of result.outputs){
    const source=h.sources.find(source=>source.file.name===output.file.name),before=await worksheet(source.file),after=await worksheet(output.blob),beforeCells=cellMap(before.xml),afterCells=cellMap(after.xml);
    const priceRows=source.rows.flatMap((row,index)=>[productCode,'8005434565'].includes(String(row[0]))?[index+1]:[]);
    for(const [address,xml] of beforeCells){
      // The existing serializer formats its entire price/discount cell family.
      // Non-price cells and every other OOXML package part stay byte-identical;
      // unchanged non-basic discount values are asserted after reopening below.
      const mutable=priceRows.some(row=>['F','R','BF','BG','BH','BI','BJ','BK','BO','BP'].some(column=>address===`${column}${row}`));
      if(!mutable)assert.equal(afterCells.get(address),xml,`${output.file.name} preserves ${address}`);
    }
    const fileNames=zip=>Object.keys(zip.files).filter(name=>!zip.files[name].dir).sort();
    assert.deepEqual(fileNames(after.zip),fileNames(before.zip));
    for(const name of fileNames(before.zip))if(!['xl/worksheets/sheet1.xml','xl/styles.xml'].includes(name))assert.deepEqual(await after.zip.file(name).async('uint8array'),await before.zip.file(name).async('uint8array'),`unchanged OOXML part ${name}`);
    const beforeStyles=await before.zip.file('xl/styles.xml').async('string'),afterStyles=await after.zip.file('xl/styles.xml').async('string');
    for(const section of ['numFmts','fonts','fills','borders','cellStyleXfs','cellXfs']){
      const content=beforeStyles.match(new RegExp(`<${section}\\b[^>]*>([\\s\\S]*?)<\\/${section}>`))?.[1];
      if(content)assert.ok(afterStyles.includes(content),`existing ${section} survive the serializer's added change-marking styles`);
    }
  }
}

test('actual two-file XLSX flow changes common registration/basic discount while preserving 218 unselected sibling finals in raw, rules and dependency modes',async()=>{
  for(const mode of ['raw','rules','dependency']){
    const h=await harness();
    const originalBytes=await Promise.all(h.sources.map(async source=>Buffer.from(await source.file.arrayBuffer())));
    const options={priceMode:mode==='rules'?'rules':'sellpia_source',includeDependencies:mode==='dependency',productPriceAdjustments:[draft()]};
    const preview=await h.run(options);
    assert.equal(preview.priceAdjustmentContext.source,'smartstore');assert.ok(preview.priceAdjustmentContext.versionKey);
    const group=preview.priceAdjustmentContext.groups.find(group=>group.productCode===productCode);
    assert.equal(group.editable,true);assert.equal(group.rows.length,219);assert.equal(group.rows.filter(row=>row.preserved).length,218);
    assert.deepEqual(plain(group.appliedDraft),draft());
    const output=await cells(preview.outputs.find(output=>output.file.name==='smartstore-one.xlsx').blob),row=output.find(row=>String(row[0])===productCode);
    assert.equal(Number(row[5]),9000);assert.equal(Number(row[57]),2000);assert.equal(String(row[58]),'원');
    assert.equal(Number(row[59]),7);assert.equal(String(row[60]),'%','non-basic mobile discount remains unchanged');
    const finals=String(row[17]).split('\n').map(option=>7000+Number(option));
    assert.ok(String(row[17]).split('\n').map(Number).includes(0),'the adjusted option group retains a required zero-price option');
    assert.deepEqual(finals,[3000,...h.siblings.map(option=>option.final)],`${mode}: registration/discount edits must never rewrite fixed option finals`);
    const previewRows=preview.plans.flatMap(plan=>plan.preview).filter(row=>row.product_code===productCode);
    assert.equal(new Set(previewRows.map(row=>row.option_code)).size,219,'same physical row must not collapse option identities');
    const byOption=values=>values.sort(([a],[b])=>a.localeCompare(b));
    assert.deepEqual(plain(byOption(previewRows.map(row=>[row.option_code,row.diff.price.after.final]))),byOption(String(row[15]).split('\n').map((option,index)=>[option,finals[index]])));
    await assertProtected(h,preview);
    assert.ok(h.calls.every(call=>call.name==='hub_price_decision_export_read_v3'));
    await h.run({...options,download:true,expectedPlanFingerprint:preview.planFingerprint});
    assert.equal(h.downloads.filter(output=>output.name.endsWith('.xlsx')).length,2);
    for(let index=0;index<h.sources.length;index++)assert.deepEqual(Buffer.from(await h.sources[index].file.arrayBuffer()),originalBytes[index]);
  }
});

test('all common preview/run bridges forward the product draft and return its applied context',async()=>{
  for(const [previewMethod,runMethod] of [['previewPriceOnly','runPriceOnly'],['previewChangedOnly','runChangedOnly'],['previewTargetAll','runTargetAll'],['previewFullOriginal','runFullOriginal']]){
    const h=await harness({siblingCount:2}),options={source:'smartstore',skus:['SELECTED','SECOND'],priceMode:'sellpia_source',includePrice:true,includeStock:false,productPriceAdjustments:[draft()]};
    const preview=await h.value.SystemV3SellerExportBridge[previewMethod](options);
    assert.deepEqual(plain(preview.priceAdjustmentContext.groups.find(group=>group.productCode===productCode).appliedDraft),draft(),`${previewMethod} forwards the draft`);
    await h.value.SystemV3SellerExportBridge[runMethod]({...options,expectedPlanFingerprint:preview.planFingerprint});
    assert.equal(h.downloads.filter(output=>output.name.endsWith('.xlsx')).length,2,`${runMethod} generates both files from its matching preview`);
  }
});

test('one product split across two original files validates its zero option globally and preserves every unselected sibling final',async()=>{
  for(const exportMode of ['full_original','target_all','changed_only'])for(const mode of ['raw','rules','dependency']){
    const h=await harness({siblingCount:2,splitSameProduct:true}),options={mode:exportMode,priceMode:mode==='rules'?'rules':'sellpia_source',includeDependencies:mode==='dependency',productPriceAdjustments:[draft()]};
    const result=await h.run(options),group=result.priceAdjustmentContext.groups.find(group=>group.productCode===productCode);
    assert.deepEqual(plain(group.fileNames),['smartstore-one.xlsx','smartstore-two.xlsx']);
    assert.equal(group.rows.length,1+h.siblings.length);assert.equal(group.rows.filter(row=>row.selected).length,1);
    const expected=new Map([['SELECTED',3000],...h.siblings.map(option=>[option.option,option.final])]),actual=new Map();
    assert.equal(result.outputs.length,2);
    for(const output of result.outputs){
      const row=(await cells(output.blob)).find(row=>String(row[0])===productCode);
      assert.ok(row,`${output.file.name} contains the same adjusted product`);
      assert.equal(Number(row[5]),9000);assert.equal(Number(row[57]),2000);
      const original=h.sources.find(source=>source.file.name===output.file.name).rows.find(row=>String(row[0])===productCode);
      for(let column=0;column<original.length;column++)if(![5,17,57,58].includes(column))assert.equal(row[column],original[column],`${exportMode}/${mode}: protected product cell ${column}`);
      const codes=String(row[15]).split('\n'),options=String(row[17]).split('\n').map(Number);
      if(output.file.name==='smartstore-one.xlsx')assert.ok(!options.includes(0),'the first file alone has no zero option and must use the whole product validation');
      else assert.ok(options.includes(0),'the required zero option exists only in the second original');
      for(let index=0;index<codes.length;index++){
        assert.equal(actual.has(codes[index]),false,'one global seller option identity appears once');
        actual.set(codes[index],7000+options[index]);
      }
    }
    assert.deepEqual([...actual].sort(),[...expected].sort());
    if(exportMode==='full_original')await assertProtected(h,result);
    await h.run({...options,download:true,expectedPlanFingerprint:result.planFingerprint});
    assert.equal(h.downloads.filter(output=>output.name.endsWith('.xlsx')).length,2);
  }
});

test('duplicate seller option identities across originals lock the global product and cannot be manually adjusted',async()=>{
  const h=await harness({siblingCount:2,splitSameProduct:true,duplicateAcrossFiles:true});
  const ordinary=await h.run(),group=ordinary.priceAdjustmentContext.groups.find(group=>group.productCode===productCode);
  assert.equal(group.editable,false);assert.match(group.blockedReason,/중복|identity/);
  await assert.rejects(h.run({productPriceAdjustments:[draft()]}),/중복|identity/);
  assert.equal(h.downloads.length,0);
});

test('a changed draft requires a new preview and cannot reuse the old fingerprint even when the discounted base stays the same',async()=>{
  const h=await harness({siblingCount:2}),adjustments=[draft()],before=await h.run({productPriceAdjustments:adjustments});
  adjustments[0].basePrice=9100;adjustments[0].basicDiscount=2100;
  await assert.rejects(h.run({productPriceAdjustments:adjustments,download:true,expectedPlanFingerprint:before.planFingerprint}),/미리보기|변경/);
  assert.equal(h.downloads.length,0);
  const refreshed=await h.run({productPriceAdjustments:adjustments});assert.notEqual(refreshed.planFingerprint,before.planFingerprint);
  await h.run({productPriceAdjustments:adjustments,download:true,expectedPlanFingerprint:refreshed.planFingerprint});
  assert.equal(h.downloads.filter(output=>output.name.endsWith('.xlsx')).length,2);
});

test('source price, mapping, new current decisions and graph changes all invalidate adjusted generation',async()=>{
  for(const drift of ['source','mapping','decision','graph']){
    const h=await harness({siblingCount:2}),options={productPriceAdjustments:[draft()],includeDependencies:drift==='graph'};
    const before=await h.run(options);
    if(drift==='source')h.rawPrices.SELECTED=3100;
    if(drift==='mapping')h.state.mutate=data=>{for(const entry of [...data.absence_proofs,...data.carrier_proofs])if(entry.seller_product_code===productCode)entry.mapping_fingerprint='mapping-changed';};
    if(drift==='decision')h.state.currentDecision=true;
    if(drift==='graph')h.state.graphVersion='graph-2';
    await assert.rejects(h.run({...options,download:true,expectedPlanFingerprint:before.planFingerprint}),/미리보기|변경|확정 가격|종속관계/);
    assert.equal(h.downloads.length,0,`${drift}: stale adjusted files must not escape`);
  }
});

test('current manual price decisions lock common product adjustments while the unchanged current-price flow remains available',async()=>{
  const h=await harness({siblingCount:2});h.state.currentDecision=true;
  const ordinary=await h.run();const group=ordinary.priceAdjustmentContext.groups.find(group=>group.productCode===productCode);
  assert.equal(group.editable,false);assert.match(group.blockedReason,/확정 가격/);
  await assert.rejects(h.run({productPriceAdjustments:[draft()]}),/확정 가격/);
  assert.equal(h.downloads.length,0);
});

test('final verification rejects changes occurring only after adjusted XLSX serialization, including source, current decisions, rules, graph and original files',async()=>{
  for(const drift of ['source','decision','rules','graph','original']){
    const h=await harness({siblingCount:2}),options={productPriceAdjustments:[draft()],priceMode:drift==='rules'?'rules':'sellpia_source',includeDependencies:drift==='graph'};
    const before=await h.run(options),initialCalls=h.calls.length,initialSourceReads=h.sourceReads.length;
    if(drift==='source')h.state.sourcePriceAtRead=(sku,index)=>sku==='SELECTED'&&index>initialSourceReads+2?3100:undefined;
    if(drift==='decision')h.state.mutate=(data,index)=>{
      if(index<=initialCalls+2)return;
      for(const proof of data.carrier_proofs)if(proof.seller_product_code===productCode)proof.mapping_fingerprint='final-mapping-change';
    };
    if(drift==='rules'){
      const read=h.value.liveData.loadCarrierMatrixTargets;let reads=0;
      h.value.liveData.loadCarrierMatrixTargets=async args=>{
        const response=await read(args);
        if(++reads>2)for(const row of response.rows)if(row.sku==='SELECTED'){row.current_effective_price.platformFinal=3100;row.current_effective_price.platformOption=-3900;}
        return response;
      };
    }
    if(drift==='graph'){
      const data=h.value.SystemV3Data,read=data.loadExportSkuDependencies;
      h.value.SystemV3Data={...data,async loadExportSkuDependencies(args){if(args.expectedVersion)h.state.graphVersion='graph-final-change';return read(args);}};
    }
    if(drift==='original'){
      const read=h.value.liveData.downloadLatestSellerOriginals;let reads=0;
      h.value.liveData.downloadLatestSellerOriginals=async args=>{
        if(++reads>1){
          const book=XLSX.read(await h.sources[0].file.arrayBuffer(),{type:'array'});book.Sheets[book.SheetNames[0]].D2.v='생성 도중 바뀐 상품명';
          const changed=new TestFile([XLSX.write(book,{type:'buffer',bookType:'xlsx'})],h.sources[0].file.name);
          return new Map([['smartstore',[changed,h.sources[1].file]]]);
        }
        return read(args);
      };
    }
    await assert.rejects(h.run({...options,download:true,expectedPlanFingerprint:before.planFingerprint}),/미리보기|변경|changed/);
    assert.equal(h.downloads.length,0,`${drift}: final verification must complete before either native download`);
  }
});

test('closing or changing settings during the final decision read prevents native downloads',async()=>{
  const h=await harness({siblingCount:2});let current=true;
  const options={productPriceAdjustments:[draft()],isCurrent:()=>current},before=await h.run(options),initialCalls=h.calls.length;
  h.state.afterDecision=(_data,index)=>{if(index>initialCalls+2)current=false;};
  await assert.rejects(h.run({...options,download:true,expectedPlanFingerprint:before.planFingerprint}),/설정이 변경|취소/);
  assert.equal(h.downloads.length,0);
});

test('the actual output reparse rejects a serializer blob with a corrupted option even when its applied-item manifest claims success',async()=>{
  const h=await harness({siblingCount:2}),options={productPriceAdjustments:[draft()]},before=await h.run(options);
  const transform=h.value.sellerExport.transformSellerFile;
  h.value.sellerExport.transformSellerFile=async(file,...args)=>{
    const result=await transform(file,...args);
    if(file.name==='smartstore-one.xlsx'){
      const book=XLSX.read(await result.blob.arrayBuffer(),{type:'array'}),sheet=book.Sheets[book.SheetNames[0]],values=String(sheet.R2.v).split('\n');
      values[0]=String(Number(values[0])+100);sheet.R2.v=values.join('\n');
      return {...result,blob:new Blob([XLSX.write(book,{type:'buffer',bookType:'xlsx'})])};
    }
    return result;
  };
  await assert.rejects(h.run({...options,download:true,expectedPlanFingerprint:before.planFingerprint}),/옵션|최종가|검증|가격 조정/);
  assert.equal(h.downloads.length,0,'claimed success must not bypass actual option/final checks');
});

test('stock-only and out-of-scope or invalid adjustment drafts fail before publishing or mutating source data',async()=>{
  const h=await harness({siblingCount:2});
  await assert.rejects(h.run({includePrice:false,includeStock:true,stockSource:'stock',productPriceAdjustments:[draft()]}),/가격 미리보기/);
  assert.equal(h.calls.length,0);assert.equal(h.sourceReads.length,0);
  for(const adjustment of [{...draft(),productCode:'not-in-scope'},draft(9000,10000),draft(1000,0)]){
    await assert.rejects(h.run({productPriceAdjustments:[adjustment]}),/범위|할인|옵션|조정/);
  }
  await assert.rejects(h.run({productPriceAdjustments:[draft(),draft()]}),/중복/);
  await assert.rejects(h.run({productPriceAdjustments:[{...draft(),source:'makeshop'}]}),/판매처|상품코드/);
  assert.equal(h.downloads.length,0);
});
