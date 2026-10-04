import assert from 'node:assert/strict';
import '../mockups/operations-hub/rule-registry.js';
import '../mockups/operations-hub/discount-price-math.js';
import '../mockups/operations-hub/platform-rule-service.js';
import '../mockups/operations-hub/price-result-materializer.js';
const copy=v=>structuredClone(v),sources=['smartstore','makeshop','ably'];
function fixture(){
 const rule=(id,target,source,steps,extra={})=>({id,name:id,target_field:target,source_field:source,scope:'',input_origin:'self',config:{steps},is_active:true,version:2,...extra});
 const rules=[rule('half','calculated_base_price','purchase_price',[{op:'divide',value:2}]),rule('child','calculated_base_price','calculated_base_price',[{op:'add',value:100}],{input_origin:'parent'})];
 const products=Object.fromEntries(['A','B','C','D','U'].map((sku,i)=>[sku,{sellpia_sku_code:sku,sellpia_source_purchase_price:10000+i*4000,system_base_price:99999,__sellerPriceComponents:sku==='U'?{}:Object.fromEntries(sources.map(source=>[source,{seller_product_code:['A','B'].includes(sku)?'P':sku,seller_option_code:sku,source_base_price:9000,source_option_price:0,source_final_price:9000,source_discount_terms:[]}]))}]));
 const registry={rules,assignments:Object.keys(products).map(sku=>({sku,rule_id:['C','D'].includes(sku)?'child':'half',target_field:'calculated_base_price',scope:'',version:4})),dependencies:[{parent_sku:'B',child_sku:'C',rule_id:'child',source_field:'calculated_base_price',target_field:'calculated_base_price',scope:''},{parent_sku:'A',child_sku:'D',rule_id:'child',source_field:'calculated_base_price',target_field:'calculated_base_price',scope:''}]};
 const configs=Object.fromEntries(sources.map(source=>{const discount=source==='makeshop'?HubRuleRegistry.makeshopDiscountConfig('M20'):{discount_mode:'numeric',steps:[{op:'subtract',value:2000}]};rules.push(rule('register-'+source,'platform_registration_price','calculated_base_price',[{op:'add',value:2000}],{scope:source}),rule('discount-'+source,'platform_discount_price','platform_registration_price',discount.steps,{scope:source,source_scope:source,config:discount}));return [source,{id:'settings-'+source,title:'registry-platform:'+source,body:{source,anchor:'lowest',mode:'forward',registration_rule_id:'register-'+source,discount_rule_id:'discount-'+source}}];}));
 const qa={begins:[],writes:[],loads:[],siblings:[],progress:[]};
 globalThis.SystemV3Data={beginCalculationGeneration:async request=>{qa.begins.push(copy(request));return {generation_id:42,calculated_at:'2026-09-10T00:00:00Z'};},upsertCalculatedPriceResults:async payload=>{assert.ok(payload.rows.length<=200);qa.writes.push(copy(payload));},ruleRegistry:async()=>copy(registry),workDocument:async(action,kind,payload)=>{assert.equal(action,'get_title');return copy(Object.values(configs).find(c=>c.title===payload.title));},loadFormulaProducts:async skus=>{assert.ok(skus.length<=200);qa.loads.push([...skus]);return skus.map(sku=>products[sku]).filter(Boolean).map(copy);},loadRulePlatformSiblings:async(skus,source)=>{assert.ok(skus.length<=200);qa.siblings.push({skus:[...skus],source});const codes=new Set(skus.map(sku=>products[sku]?.__sellerPriceComponents[source]?.seller_product_code).filter(Boolean));return [...skus,...Object.keys(products).filter(sku=>codes.has(products[sku].__sellerPriceComponents[source]?.seller_product_code))];}};
 return {products,registry,qa,run:options=>HubPriceMaterializer.materialize({skus:['A'],onProgress:p=>qa.progress.push(copy(p)),...options}),rows:()=>qa.writes.flatMap(w=>w.rows)};
}
{
 const f=fixture(),result=await f.run();assert.equal(result.generationId,42);assert.equal(result.status,'complete');assert.equal(result.totalSkus,4,'A dependency D plus sibling B plus sibling dependency C');assert.equal(result.persistedRows,52);assert.equal(f.qa.begins.length,1);assert.deepEqual(Object.keys(f.qa.begins[0]).sort(),['reason','requestId']);assert.ok(f.qa.writes.every(w=>w.generationId===42));
 const rows=f.rows();assert.equal(new Set(rows.map(r=>JSON.stringify([r.sku,r.field,r.scope]))).size,52);const at=(sku,field,scope='')=>rows.find(r=>r.sku===sku&&r.field===field&&r.scope===scope);
 assert.equal(at('A','calculated_base_price').value,5000);assert.equal(at('B','calculated_base_price').value,7000);assert.equal(at('C','calculated_base_price').value,7100);assert.equal(at('D','calculated_base_price').value,5100);
 for(const source of sources){const makeshop=source==='makeshop';assert.equal(at('A','platform_registration_price',source).value,7000);assert.equal(at('A','platform_discount_price',source).value,makeshop?5600:5000);assert.equal(at('B','platform_option_price',source).value,2000);assert.equal(at('B','platform_final_price',source).value,makeshop?7600:7000);assert.equal(at('A','platform_final_price',source).result_details.discount_terms[0].value,makeshop?20:2000);if(makeshop)assert.equal(at('A','platform_final_price',source).result_details.discount_terms[0].rule_code,'M20');}
 assert.ok(rows.every(r=>r.status==='calculated'&&r.error===null&&!r.rule&&!r.config&&!r.assignments));assert.ok(at('C','calculated_base_price').rule_versions.some(v=>v.id==='child'&&v.assignmentVersion===4));assert.equal(f.qa.progress.at(-1).phase,'complete');
}
{
 const f=fixture(),skus=['10000-1','10000-2','10000-3'];f.registry.dependencies=[];
 for(const [index,sku] of skus.entries()){
  f.products[sku]={sellpia_sku_code:sku,sellpia_source_purchase_price:1000+index*100,system_base_price:99999,__sellerPriceComponents:{smartstore:{seller_product_code:'P10000',seller_option_code:sku,source_base_price:2800,source_option_price:0,source_final_price:2800,source_discount_terms:[]}}};
  f.registry.assignments.push({sku,rule_id:'half',target_field:'calculated_base_price',scope:'',version:4});
 }
 const result=await f.run({skus,sources:['smartstore']});const rows=f.rows();
 assert.equal(result.totalSkus,3);assert.equal(result.persistedRows,15,'three internal values plus four Smartstore values per SKU');assert.equal(result.errorRows,0);
 assert.equal(f.qa.siblings.length,1);assert.deepEqual(f.qa.siblings[0],{skus,source:'smartstore'});
 assert.equal(f.qa.loads.length,2,'internal and seller inputs are read separately');assert.deepEqual(f.qa.loads[0],skus);
 assert.equal(new Set(rows.map(row=>JSON.stringify([row.sku,row.field,row.scope]))).size,15);assert.ok(rows.every(row=>row.status==='calculated'));
}
{
 const f=fixture();f.products.B.sellpia_source_purchase_price=null;const result=await f.run({sources:['ably']});assert.equal(result.status,'partial');const rows=f.rows();for(const sku of ['A','B'])assert.ok(rows.filter(r=>r.sku===sku&&r.scope==='ably').every(r=>r.status==='error'&&r.value===null),'invalid sibling rejects whole platform product');assert.equal(rows.find(r=>r.sku==='D'&&r.field==='calculated_base_price').value,5100);
}
{
 const f=fixture();await f.run({skus:['U']});assert.equal(f.rows().length,1,'unlinked sources skipped, not12 error rows');assert.equal(f.rows()[0].field,'calculated_base_price');
}
{
 const f=fixture();f.registry.dependencies=[];f.registry.assignments=[];for(let i=0;i<405;i++){const sku='bulk'+i;f.products[sku]={sellpia_sku_code:sku,system_base_price:1000};}const seeds=Array.from({length:405},(_,i)=>'bulk'+i);const result=await f.run({skus:seeds,sources:[]});assert.equal(result.persistedRows,405);assert.deepEqual(f.qa.loads.map(r=>r.length),[200,200,5]);assert.deepEqual(f.qa.writes.map(w=>w.rows.length),[200,200,5]);assert.equal(f.qa.begins[0].skus,undefined,'generation begin has no giantSKU payload');
}
{
 const f=fixture();f.registry.dependencies=[];f.registry.assignments=[];const seeds=Array.from({length:205},(_,i)=>'failure'+i);for(const sku of seeds)f.products[sku]={sellpia_sku_code:sku,system_base_price:1000};const read=SystemV3Data.loadFormulaProducts;let first=true;SystemV3Data.loadFormulaProducts=async skus=>{if(first){first=false;throw Error('batch input read failed');}return read(skus);};const result=await f.run({skus:seeds,sources:[]});assert.equal(result.status,'partial');assert.equal(result.errorRows,200);assert.equal(f.rows().filter(r=>r.status==='calculated').length,5,'later batch continues after calculation error');
}
{
 const f=fixture();SystemV3Data.loadFormulaProducts=async()=>{throw Error('platform input read failed');};const result=await f.run({sources:['smartstore']});assert.equal(result.status,'partial');
 const rows=f.rows();for(const sku of ['A','B','C','D'])for(const field of ['platform_registration_price','platform_discount_price','platform_option_price','platform_final_price']){const row=rows.find(item=>item.sku===sku&&item.scope==='smartstore'&&item.field===field);assert.equal(row?.status,'error','new generation invalidates each previous platform value');assert.match(row.error,/platform input read failed/);}
}
{
 const f=fixture(),controller=new AbortController();const write=SystemV3Data.upsertCalculatedPriceResults;SystemV3Data.upsertCalculatedPriceResults=async p=>{await write(p);controller.abort();};await assert.rejects(f.run({sources:[],signal:controller.signal}),e=>e.name==='AbortError');assert.equal(f.qa.writes.length,1,'abort prevents additional writes');
 const untouched=fixture();await assert.rejects(untouched.run({signal:controller.signal}),e=>e.name==='AbortError');assert.equal(untouched.qa.begins.length,0,'preabort does not start generation');
}
{
 const f=fixture(),inbound={id:'inbound-half',name:'14K_1/2 · 실입고가',target_field:'actual_inbound_cost',source_field:'purchase_price',scope:'',input_origin:'self',config:{steps:[{op:'divide',value:2}]},is_active:true,version:3,tag_id:'tag-14k-half'};
 f.registry.rules.push(inbound);f.registry.assignments=f.registry.assignments.filter(item=>item.sku!=='A');f.registry.assignments.push({sku:'A',rule_id:inbound.id,target_field:'actual_inbound_cost',scope:'',version:7,assigned_tag_id:inbound.tag_id});
 const result=await f.run({skus:['A'],sources:[]}),rows=f.rows(),inboundRow=rows.find(row=>row.sku==='A'&&row.field==='actual_inbound_cost'),baseRow=rows.find(row=>row.sku==='A'&&row.field==='calculated_base_price');
 assert.equal(rows.filter(row=>row.sku==='A').length,2,'assigned internal target and inherited matrix base are stored in the same generation');
 assert.equal(result.persistedRows,3,'the affected dependent SKU remains part of bounded materialization');
 assert.equal(inboundRow.value,5000);assert.equal(baseRow.value,5000);assert.equal(inboundRow.status,'calculated');assert.equal(inboundRow.rule_versions[0].id,inbound.id);assert.equal(inboundRow.rule_versions[0].assignmentVersion,7);assert.deepEqual(inboundRow.result_details,{},'internal derived stages keep the existing RPC-safe result_details contract');assert.equal(inboundRow.generationId,undefined,'wire payload keeps generation at request level');
}
{
 const f=fixture(),definitions=[
  ['5566-1','14K_기본',53500,[],53500],
  ['5566-2','14K_노볼',53500,[{op:'subtract',value:7500}],46000],
  ['5566-3','14K_1/2',55500,[{op:'divide',value:2}],27750]
 ];
 f.registry.rules=[];f.registry.assignments=[];f.registry.dependencies=[];
 for(const [sku,name,purchase,steps] of definitions){const id='rule-'+sku;f.products[sku]={sellpia_sku_code:sku,sellpia_source_purchase_price:purchase,system_base_price:80000};f.registry.rules.push({id,name:name+' · 실입고가',target_field:'actual_inbound_cost',source_field:'purchase_price',scope:'',input_origin:'self',config:{steps},is_active:true,version:1,tag_id:'tag-'+sku});f.registry.assignments.push({sku,rule_id:id,target_field:'actual_inbound_cost',scope:'',version:1,assigned_tag_id:'tag-'+sku});}
 f.products['5566-4']={sellpia_sku_code:'5566-4',sellpia_source_purchase_price:55500,system_base_price:83500};
 await f.run({skus:['5566-1','5566-2','5566-3','5566-4'],sources:[]});const rows=f.rows(),value=(sku,field)=>rows.find(row=>row.sku===sku&&row.field===field)?.value;
 for(const [sku,, , ,expected] of definitions){assert.equal(value(sku,'actual_inbound_cost'),expected);assert.equal(value(sku,'calculated_base_price'),expected);}
 assert.equal(value('5566-4','actual_inbound_cost'),undefined,'control SKU receives no synthetic formula-stage value');assert.equal(value('5566-4','calculated_base_price'),83500,'control SKU keeps its stored system base');
}
{
 const f=fixture();SystemV3Data.upsertCalculatedPriceResults=async()=>{throw Error('write unavailable');};await assert.rejects(f.run({sources:[]}),/write unavailable/,'persistence errors must not be mislabeled as successful error-row saves');
}
{
 const f=fixture();f.registry.assignments=[];f.registry.dependencies=[];const seeds=Array.from({length:405},(_,i)=>'staged'+i);for(const sku of seeds)f.products[sku]={sellpia_sku_code:sku,system_base_price:1000,__sellerPriceComponents:{}};
 let sellerRead=false;SystemV3Data.loadInternalFormulaProducts=async skus=>skus.map(s=>f.products[s]);SystemV3Data.loadFormulaProducts=async()=>{sellerRead=true;assert.equal(f.rows().filter(r=>r.scope==='').length,405,'every internal result precedes a heavy seller read');throw Error('seller timeout');};
 const r=await f.run({skus:seeds,sources:['smartstore'],boundedSkus:seeds});assert.ok(sellerRead);assert.equal(f.rows().filter(r=>r.scope===''&&r.status==='calculated').length,405);assert.equal(r.totalSkus,405);
 const bound=fixture();await assert.rejects(bound.run({sources:[],boundedSkus:['A']}),/범위 밖/);assert.equal(bound.qa.writes.length,0);
 const limited=fixture();await assert.rejects(limited.run({sources:[],maxAffectedSkus:1}),/안전 한도 1개/);assert.equal(limited.qa.writes.length,0);
}
console.log('PASS materializer: internal-first405, finite bound, active dependency graph, platform errors, abort/write errors, and existing pricing contracts.');
