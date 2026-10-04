import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const workflow=fs.readFileSync(new URL('../mockups/operations-hub/seller-file-workflow-v2.js',import.meta.url),'utf8');
const helpers=workflow.slice(workflow.indexOf(' const ablyPhases='),workflow.indexOf('\n async function loadStatuses('));
const previewSource=workflow.slice(workflow.indexOf(' async function preview(role)'),workflow.indexOf('\n function previewRowsForFilter('));
const mathSource=fs.readFileSync(new URL('../mockups/operations-hub/discount-price-math.js',import.meta.url),'utf8');
const priceSource=fs.readFileSync(new URL('../mockups/operations-hub/current-price-export.js',import.meta.url),'utf8');
const inventoryCountSource=fs.readFileSync(new URL('../mockups/operations-hub/sellpia-inventory-count.js',import.meta.url),'utf8');
const projectionSource=fs.readFileSync(new URL('../mockups/operations-hub/ably-price-projection.js',import.meta.url),'utf8');
const ablySource=fs.readFileSync(new URL('../mockups/operations-hub/ably-playauto-export.js',import.meta.url),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));

function harness({items,targets=[],role='playauto_option',priceMode='rules',fieldMode='option_stock',stockSource='available_stock',stockSources={},selectedSkus=null,sourcePrices={},carrierCatalog=null,carrierMappings=[],shadow=false}){
 const fields=new Map(['title','detail','bar','cancel'].map(key=>[key,{textContent:'',style:{},disabled:false}]));
 const progress={hidden:true,dataset:{},querySelector:selector=>fields.get(selector.match(/progress-(\w+)/)?.[1])};
 const previewNode={hidden:true};
 const document={querySelector(selector){if(selector==='[data-ably-progress]')return progress;if(selector==='[data-ably-progress-detail]')return fields.get('detail');if(selector==='[data-standard-price-mode="ably"]')return {value:priceMode};if(selector==='[data-ably-field-mode]')return {value:fieldMode};if(selector==='[data-ably-stock-source]')return {value:stockSource};if(selector==='[data-seller-scope-mode="ably"]')return {value:selectedSkus?'tag':'all'};return null;},getElementById:id=>id==='export-preview-v2'?previewNode:null};
 let nextTimer=0,rendered=0;
 const timers=new Map(),messages=[],state={carrierFiles:new Map(),ablyJob:null,ablyJobSequence:0};
 const global={console,performance:{now:()=>0},setInterval(fn){const id=++nextTimer;timers.set(id,fn);return id;},clearInterval:id=>timers.delete(id),setTimeout:fn=>setImmediate(fn)};
 vm.createContext(global);
 vm.runInContext(mathSource,global);
 vm.runInContext(inventoryCountSource,global);
 vm.runInContext(priceSource,global);
 vm.runInContext(projectionSource,global);
 vm.runInContext(ablySource,global);
 if(shadow){
  global.HubMatrixShadow={request:product=>({sku:product.sellpia_sku_code}),rememberCarrierEvidence(){}};
  global.HubBaselineIdentityShadow={crosswalk:()=>({disposition:'WARN_KEEP_ORIGINAL',row:null,reason:'baseline 없음'})};
 }
 const n=value=>Number(value||0).toLocaleString('ko-KR'),setStatus=(text,kind)=>messages.push({text,kind});
 const createAblyJob=Function('global','state','document','n','renderExportStatuses','setStatus',`${helpers};return createAblyJob;`)(global,state,document,n,()=>{},setStatus);
 const roles={playauto_option:{label:'옵션가 + 재고',type:'option_price_stock'},playauto_product:{label:'판매가 + 옵션가',type:'product_price_option'}};
 const file={name:'carrier.xlsx',arrayBuffer:async()=>new ArrayBuffer(1)};
 const A=()=>({readTemplate:async()=>({type:roles[role].type,items}),resolveRows:(rows,_catalog,_mappings,options)=>rows.map(item=>({...item,resolution:carrierCatalog?global.AblyPlayautoExport.resolveSellpiaSku(item,carrierCatalog,carrierMappings,options):item.resolution||{sku:item.sku,method:'direct_sku'}}))});
 const P=()=>global.AblyPriceProjection;
 const calls=[];
 const D=()=>({loadCarrierSellerMappings:async()=>({rows:carrierMappings}),loadCarrierMatrixTargets:async options=>{calls.push(options);return {rows:targets};},loadSellpiaSourcePricesForExport:async()=>new Map(Object.entries(sourcePrices)),loadSellpiaStockSourcesForExport:async()=>({snapshotId:'stock-snapshot',bySku:new Map(Object.entries(stockSources))}),loadAblyCarrierPoliciesForSkus:async()=>({rows:[],fingerprint:'[]'}),...(shadow?{loadMatrixShadowMetadata:async({rows})=>({rows:rows.map(request=>({sku:request.sku,candidates:[],declared_links:[]}))})}:{})});
 const preview=Function('state','roles','setStatus','createAblyJob','document','global','blobFile','A','D','P','catalog','scopeSkus','renderPreview','n',`${previewSource};return preview;`)(state,roles,setStatus,createAblyJob,document,global,async()=>file,A,D,P,async()=>carrierCatalog||[],async()=>selectedSkus?new Set(selectedSkus):null,()=>{rendered++;},n);
 state.carrierFiles.set(role,file);
 return {run:()=>preview(role),state,calls,timers,messages,rendered:()=>rendered};
}
test('Ably PlayAuto Sellpia mode preserves unselected option finals while changing shared sale price',async()=>{
 const items=[row('P-1',6,{option_index:0,base_price:30000,option_price:0}),row('P-2',6,{option_index:1,base_price:30000,option_price:3500}),row('P-3',6,{option_index:2,base_price:30000,option_price:9000})];
 const h=harness({role:'playauto_product',priceMode:'sellpia_source',items,selectedSkus:['P-1'],sourcePrices:{'P-1':32000}}),preview=await h.run();
 assert.ok(preview,h.messages.at(-1)?.text);assert.equal(preview.counts.selected,1);assert.equal(preview.output.length,3);assert.equal(h.calls.length,0,'source overlay does not require a historical calculated target');
 assert.deepEqual(plain(preview.output.map(item=>item.target_base_price+item.target_option_price)),[32000,33500,39000]);
 assert.deepEqual(plain(preview.output.map(item=>item._preserveUnselected)),[false,true,true]);
 assert.deepEqual(plain(preview.output.map(item=>item._changedFields)),[['base'],['base','option'],['base','option']]);
 const absent=harness({role:'playauto_product',priceMode:'sellpia_source',items,selectedSkus:['P-1']});
 const blocked=await absent.run();assert.ok(blocked);assert.equal(blocked.counts.blocked,3);assert.equal(blocked.counts.changed,0);assert.match(blocked.output[0]._error,/셀피아.*판매가/);
});
test('Ably PlayAuto rules partial export recomputes every sibling T while preserving unselected finals',async()=>{
 const items=[row('P-1',6,{option_index:0,base_price:30000,option_price:0}),row('P-2',6,{option_index:1,base_price:30000,option_price:3500}),row('P-3',6,{option_index:2,base_price:30000,option_price:9000})];
 const rule={active_price_rule:true,current_effective_price:{platformBase:32000,platformDiscount:0,platformOption:0,platformFinal:32000,platformTerms:[],versions:[{id:'rule',version:1}]}};
 const h=harness({role:'playauto_product',priceMode:'rules',items,selectedSkus:['P-1'],targets:[target('P-1',rule),target('P-2'),target('P-3')]}),preview=await h.run();
 assert.ok(preview,h.messages.at(-1)?.text);assert.equal(preview.output.length,3);
 assert.deepEqual(plain(preview.output.map(item=>item.target_base_price+item.target_option_price)),[32000,33500,39000]);
 assert.deepEqual(plain(preview.output.map(item=>item.target_option_price)),[0,1500,7000]);
 assert.deepEqual(plain(preview.output.map(item=>item._preserveUnselected)),[false,true,true]);
});
test('Ably Sellpia mode isolates a blocked physical row and retains another safe row',async()=>{
 const items=[row('P-1',6,{option_index:0,base_price:30000,option_price:0}),row('P-2',6,{option_index:1,base_price:30000,option_price:3500}),row('Q-1',7,{option_index:0,base_price:40000,option_price:0})];
 const h=harness({role:'playauto_product',priceMode:'sellpia_source',items,selectedSkus:['P-1','Q-1'],sourcePrices:{'Q-1':45000}}),preview=await h.run();
 assert.ok(preview);assert.equal(preview.counts.blocked,2);assert.equal(preview.counts.changed,1);assert.ok(preview.output.filter(item=>item.source_row_no===6).every(item=>item._status==='conflict'));
 assert.equal(preview.output.find(item=>item.source_row_no===7).target_base_price,45000);
});
test('Ably Sellpia product preview prefers a catalog-validated P SKU over stale seller mapping',async()=>{
 const items=[row('11360-1',32,{template_type:'product_price_option',seller_management_code:'sellpia_11360',sellpia_product_code:'11360',seller_product_code:'66356790',primary_option_name:'옐로우골드/6mm',secondary_option_value:'기본',direct_sellpia_sku_code:'11360-1',option_index:0,base_price:62500}),row('11360-2',32,{template_type:'product_price_option',seller_management_code:'sellpia_11360',sellpia_product_code:'11360',seller_product_code:'66356790',primary_option_name:'로즈골드/6mm',secondary_option_value:'기본',direct_sellpia_sku_code:'11360-2',option_index:1,base_price:62500})];
 const carrierCatalog=['11360-1','11360-2'].map(sku=>({sellpia_product_code:'11360',sellpia_sku_code:sku}));
 const h=harness({role:'playauto_product',priceMode:'sellpia_source',items,selectedSkus:['11360-1','11360-2'],sourcePrices:{'11360-1':70000,'11360-2':73000},carrierCatalog,carrierMappings:[{product_code:'66356790',option_code:'',sku:'11360-2'}]});
 const preview=await h.run();assert.ok(preview,h.messages.at(-1)?.text);
 assert.deepEqual(plain(preview.output.map(item=>item.resolution.sku)),['11360-1','11360-2']);
 assert.equal(preview.counts.mappingOverrides,1);assert.equal(preview.counts.blocked,0);
 assert.deepEqual(plain(preview.output.map(item=>item.target_base_price+item.target_option_price)),[70000,73000]);
});
function row(sku,sourceRowNo=6,extra={}){
 return {sku,sellpia_product_code:sku.split('-')[0],seller_management_code:'sellpia_'+sku.split('-')[0],primary_option_name:sku,secondary_option_value:'',source_row_no:sourceRowNo,option_index:Number(sku.split('-')[1])||0,base_price:2800,option_price:0,sales_quantity:3,available_stock:888,...extra};
}
function target(sku,extra={}){return {sku,active_price_rule:false,seller_stock:0,...extra};}
function calculated(generation=27){
 return {active_price_rule:true,current_effective_price:{platformBase:3000,platformDiscount:0,platformOption:100,platformFinal:3100,platformTerms:[],versions:[{id:'current-rule',version:generation}]}};
}
function assertNoOp(item){
 assert.equal(item._status,'warn_keep_original');
 assert.deepEqual(plain(item._changedFields),[]);
 assert.equal(item._current,item._target);
 for(const field of ['target_base_price','target_option_price','target_stock'])assert.equal(Object.hasOwn(item,field),false,`${field} cannot remain on a warning row`);
 assert.ok(item._error);
}

test('Ably option carrier: per-SKU generations are independent while missing/error rows stay protected',async()=>{
 const items=[row('SAFE-1',6),row('MISSING-1',7),row('ERROR-1',8),row('STALE-1',9),row('LATEST-1',10)];
 const targets=[target('SAFE-1'),target('MISSING-1',{active_price_rule:true,current_effective_error:'현재 target 없음'}),target('ERROR-1',{active_price_rule:true,current_effective_error:'현재 Rule 계산 실패',registration_status:'error',registration_error:'과거 statement timeout'}),target('STALE-1',calculated(26)),target('LATEST-1',calculated(27))];
 const h=harness({items,targets}),preview=await h.run();
 assert.ok(preview,h.messages.at(-1)?.text);
 assert.equal(preview.counts.warned,2);
 assert.equal(preview.counts.blocked,0);
 assert.equal(preview.counts.changed,3);
 assert.equal(preview.output[0]._status,'ready');
 assert.equal(preview.output[0].target_stock,0);
 assert.deepEqual(plain(preview.output[0]._changedFields),['stock']);
 for(const index of [1,2])assertNoOp(preview.output[index]);
 assert.deepEqual(preview.output.slice(1,4).map(item=>item._priceState.code),['timeout_error','timeout_error','calculated_complete']);
 assert.equal(preview.output[3].target_option_price,100);
 assert.equal(preview.output[3].target_stock,0);
 assert.equal(preview.output[4].target_option_price,100);
 assert.equal(preview.output[4].target_stock,0);
 assert.equal(preview.output[0].available_stock,888,'W available stock is preserved');
 assert.equal(h.rendered(),1);
 assert.equal(h.state.ablyJob.running,false);
 assert.equal(h.timers.size,0);
});

test('Ably product carrier: a price warning quarantines every option on its shared physical row',async()=>{
 const h=harness({role:'playauto_product',items:[row('SHARED-1',6),row('SHARED-2',6),row('OTHER-1',7)],targets:[target('SHARED-1',calculated()),target('SHARED-2',{active_price_rule:true}),target('OTHER-1',calculated())]});
 const preview=await h.run();
 assert.ok(preview,h.messages.at(-1)?.text);
 assert.equal(preview.counts.warned,2);
 assert.equal(preview.counts.blocked,0);
 assert.equal(preview.counts.changed,1);
 assertNoOp(preview.output[0]);
 assertNoOp(preview.output[1]);
 assert.match(preview.output[0]._error,/공유 판매가/);
 assert.equal(preview.output[2]._status,'ready');
 assert.equal(preview.output[2].target_base_price,3000);
 assert.equal(preview.output[2].target_option_price,100);
});

test('Ably product carrier: identity ambiguity takes precedence over warning fallback for a shared row',async()=>{
 const h=harness({role:'playauto_product',items:[row('SHARED-1',6),row('SHARED-2',6),row('SHARED-3',6,{resolution:{sku:null,method:'mapping_ambiguous',error:'SKU 후보 다수'}})],targets:[target('SHARED-1',calculated()),target('SHARED-2',{active_price_rule:true})]});
 const preview=await h.run();
 assert.ok(preview,h.messages.at(-1)?.text);
 assert.equal(preview.counts.blocked,3);
 assert.equal(preview.counts.warned,0);
 assert.equal(preview.counts.changed,0);
 assert.ok(preview.output.every(item=>item._status==='conflict'));
 for(const item of preview.output)for(const field of ['target_base_price','target_option_price','target_stock'])assert.equal(Object.hasOwn(item,field),false);
});

test('Ably option carrier: a uniquely unresolved identity can safely preserve the original',async()=>{
 const h=harness({items:[row('NO-MATCH',6,{resolution:{sku:null,method:'unresolved',error:'exact match 없음'}})]});
 const preview=await h.run();
 assert.ok(preview,h.messages.at(-1)?.text);
 assert.equal(preview.counts.matched,0);
 assert.equal(preview.counts.warned,1);
 assert.equal(preview.counts.blocked,0);
 assertNoOp(preview.output[0]);
 assert.deepEqual(h.calls[0].skus,[],'unmatched rows must not invent SKU target queries');
});

for(const method of ['mapping_ambiguous','direct_sku_invalid','direct_sku_conflict']){
 test(`Ably option carrier: ${method} is a hard identity blocker rather than a warning`,async()=>{
  const h=harness({items:[row('BAD-1',6,{resolution:{sku:null,method,error:'identity 검증 실패'}}),row('GOOD-1',7)],targets:[target('GOOD-1')]});
  const preview=await h.run();
  assert.ok(preview,h.messages.at(-1)?.text);
  assert.equal(preview.counts.blocked,1);
  assert.equal(preview.counts.warned,0);
  assert.equal(preview.output[0]._status,'ambiguous');
  for(const field of ['target_base_price','target_option_price','target_stock'])assert.equal(Object.hasOwn(preview.output[0],field),false);
  assert.equal(preview.output[1].target_stock,0);
 });
}

test('Ably explicit parser identity error blocks even if a resolved SKU also exists',async()=>{
 const h=harness({items:[row('GOOD-1',6,{carrier_identity_error:'두 direct SKU code 충돌'})],targets:[target('GOOD-1')]});
 const preview=await h.run();
 assert.equal(preview.counts.blocked,1);
 assert.equal(preview.counts.warned,0);
 assert.equal(preview.output[0]._status,'ambiguous');
 assert.match(preview.output[0]._error,/direct SKU code 충돌/);
});

test('Ably missing writable stock target is a whole-row warning, not a partial option-price mutation',async()=>{
 const h=harness({items:[row('NO-STOCK-1')],targets:[target('NO-STOCK-1',{seller_stock:null})]});
 const preview=await h.run();
 assert.equal(preview.counts.warned,1);
 assert.equal(preview.counts.blocked,0);
 assertNoOp(preview.output[0]);
 assert.match(preview.output[0]._error,/재고 target 없음/);
});

test('Ably blank X stock keeps the existing blank policy without creating a spurious warning',async()=>{
 const h=harness({items:[row('BLANK-1',6,{sales_quantity:null})],targets:[target('BLANK-1',{seller_stock:9})]});
 const preview=await h.run();
 assert.equal(preview.counts.warned,0);
 assert.equal(preview.counts.blocked,0);
 assert.equal(preview.counts.preserved,1);
 assert.equal(preview.output[0]._blankStockPreserved,true);
 assert.equal(preview.output[0].target_stock,undefined);
 assert.equal(preview.output[0].available_stock,888);
});

test('Ably stock-only uses the shared available-stock projection and never writes option price',async()=>{
 const h=harness({fieldMode:'stock_only',items:[row('NEG-1',6,{option_price:777,sales_quantity:5})],stockSources:{'NEG-1':{sellpia_current_stock:-4,sellpia_available_stock:-3}}});
 const preview=await h.run();assert.ok(preview,h.messages.at(-1)?.text);
 assert.equal(preview.stockOnly,true);assert.equal(preview.stockSource,'available_stock');
 assert.equal(preview.output[0].target_stock,0);
 assert.equal(Object.hasOwn(preview.output[0],'target_option_price'),false);
 assert.deepEqual(plain(preview.output[0]._changedFields),['stock']);
});

test('Ably price-only writes option price and preserves X stock even when no stock target exists',async()=>{
 const h=harness({fieldMode:'price_only',items:[row('PRICE-1',6,{option_price:0,sales_quantity:5})],targets:[target('PRICE-1',{seller_stock:null,...calculated()})]});
 const preview=await h.run();assert.ok(preview,h.messages.at(-1)?.text);
 assert.equal(preview.priceOnly,true);
 assert.equal(preview.output[0].target_option_price,100);
 assert.equal(Object.hasOwn(preview.output[0],'target_stock'),false);
 assert.deepEqual(plain(preview.output[0]._changedFields),['option']);
 assert.equal(preview.counts.warned,0);
});

test('Ably shadow reports one-SKU-to-many-carrier rows as normal multi-listing without changing generation input',async()=>{
 const h=harness({shadow:true,items:[row('MULTI-1',6),row('MULTI-1',7)],targets:[target('MULTI-1')]});
 const preview=await h.run();assert.ok(preview,h.messages.at(-1)?.text);
 assert.equal(preview.counts.blocked,0);
 assert.equal(preview.output.length,2);
 assert.ok(preview.output.every(item=>item._status==='ready'&&item.target_stock===0));
 assert.deepEqual(plain(preview.shadowDiagnostics),[{sku:'MULTI-1',lookup:'multi',reason:'동일 SKU가 2개 carrier row에 연결됨 · 정상 fan-out'}]);
});

test('Ably shadow keeps actual seller-identity-to-many-SKU ambiguity as conflict',async()=>{
 const h=harness({shadow:true,items:[row('AMBIGUOUS-1',6,{seller_product_code:'ABLY-P',resolution:{sku:null,method:'seller_mapping_ambiguous',error:'기존 에이블리 판매처 연결이 여러 SKU를 가리킵니다.'}})]});
 const preview=await h.run();assert.ok(preview,h.messages.at(-1)?.text);
 assert.equal(preview.counts.blocked,1);
 assert.equal(preview.output[0]._status,'ambiguous');
 assert.deepEqual(plain(preview.shadowDiagnostics),[{sku:'ABLY-P',lookup:'conflict',reason:'기존 에이블리 판매처 연결이 여러 SKU를 가리킵니다.'}]);
});
