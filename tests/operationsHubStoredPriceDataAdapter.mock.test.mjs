import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../mockups/operations-hub/data-service.js',import.meta.url),'utf8');
function extract(name){const start=source.search(new RegExp('  async function '+name+'\\('));assert.ok(start>=0,name);const rest=source.slice(start+2),end=rest.slice(2).search(/\n  (?:async )?function /);return end<0?rest:rest.slice(0,end+2);}
const names=['beginCalculationGeneration','upsertCalculatedPriceResults','loadCalculatedResults','loadCalculatedResultsForExport','loadStoredMatrixPrices'];
function adapter({emptyStored=false,noActiveRules=false}={}){
 const calls=[],allSkus=Array.from({length:401},(_,i)=>'S'+String(i).padStart(3,'0'));
 const fields=['platform_registration_price','platform_discount_price','platform_option_price','platform_final_price'];
 const context={global:{crypto:{randomUUID:()=> 'request-id'}},cleanText:v=>String(v??'').trim(),requireOperationsHubSessionToken:()=> 'session',readableDatabaseError:e=>e,
  loadAllFilteredSkus:async()=>({skus:allSkus,total:allSkus.length}),
  loadActiveSellerPriceRules:async()=>new Set(noActiveRules?[]:allSkus.flatMap(sku=>['smartstore','makeshop','ably'].map(scope=>JSON.stringify([sku,scope])))),
  db:{from(name){assert.equal(name,'operations_hub_active_seller_drafts');const query={select(){return query;},eq(){return query;},in(){return query;},order(){return query;},range(){return query;},then(resolve){resolve({data:[{change_id:77,sellpia_sku_code:'S000',source_channel:'smartstore',price_base_after:7000,price_discounted_base_after:6500,price_option_after:300,price_final_after:6800,price_discount_terms_after:[{term_key:'saved',value:500}],updated_at:'now'}],error:null});}};return query;},async rpc(name,args){calls.push({name,args:structuredClone(args)});if(name==='hub_calculation_begin_v1')return {data:{generation_id:9,calculated_at:'now'},error:null};if(name==='hub_calculation_results_upsert_v1')return {data:{upserted:args.p_rows.length},error:null};if(name==='load_operations_hub_seller_price_components')return {data:[{sellpia_sku_code:'S000',source_channel:'smartstore',seller_product_code:'P0',seller_option_code:'O0',source_base_price:5000,source_discounted_base_price:5000,source_option_price:0,source_final_price:5000,source_discount_terms:[]}],error:null};
   if(name==='hub_calculation_results_export_read_v1'){const rows=[];for(const sku of ['S000','S001'])for(const field of fields)rows.push({sku,scope:args.p_scope,field,value:{platform_registration_price:5000,platform_discount_price:4800,platform_option_price:-200,platform_final_price:4600}[field],status:'calculated',error:null,rule_versions:[{id:'rule',version:2}],result_details:{},generation_id:9,seller_product_code:'P'+sku,seller_option_code:sku});return {data:{rows,next_sku:null,sku_count:2},error:null};}
   if(emptyStored)return {data:{rows:[],next_key:null,missing:args.p_skus.map(sku=>({sellpia_sku_code:sku,source_channel:args.p_scope,reason:'not materialized'})),missing_skus:args.p_skus},error:null};
   const rows=[];for(const sku of args.p_skus)for(const field of fields)rows.push({sku,scope:args.p_scope,field,value:{platform_registration_price:5000,platform_discount_price:4800,platform_option_price:-200,platform_final_price:4600}[field],status:'calculated',error:null,rule_versions:[{id:'rule',version:2}],result_details:field==='platform_final_price'?{discount_terms:[{term_key:'basic',value:200}]}:{},generation_id:9,seller_product_code:'P'+sku,seller_option_code:sku});return {data:{rows,next_key:null,missing:[],missing_skus:[]},error:null};}}
 };
 vm.createContext(context);vm.runInContext(names.map(extract).join('\n')+'\nthis.api={beginCalculationGeneration,upsertCalculatedPriceResults,loadCalculatedResults,loadStoredMatrixPrices};',context);return {api:context.api,calls,allSkus};
}

test('stored price adapter uses bounded reads and reconstructs exact persisted platform tuple',async()=>{
 const {api,calls,allSkus}=adapter();const result=await api.loadStoredMatrixPrices({sources:['smartstore'],skus:allSkus});
 assert.equal(result.rows.length,401);assert.equal(result.missing.length,0);assert.deepEqual(calls.filter(call=>call.name==='hub_calculation_results_read_v1').map(call=>call.args.p_skus.length),[200,200,1]);
 const row=result.rows[0];assert.deepEqual(JSON.parse(JSON.stringify([row.base_price,row.discounted_base_price,row.option_price,row.final_price,row.discount_terms])),[5000,4800,-200,4600,[{term_key:'basic',value:200}]]);assert.equal(row.status,'calculated');assert.equal(row.generation_id,9);
});

test('no current price Rule suppresses historical result and draft without DB deletion',async()=>{
 const {api,calls}=adapter({noActiveRules:true});
 const result=await api.loadStoredMatrixPrices({sources:['smartstore'],skus:['S000'],includeMatrixDrafts:true});
 assert.equal(result.rows.length,0);assert.equal(result.activePriceRules.length,0);
 assert.ok(calls.every(call=>!call.name.includes('upsert')&&!call.name.includes('begin')));
});

test('active price Rule identity is current assignment plus active matching destination',async()=>{
 const context={ruleRegistry:async()=>({rules:[{id:'live',is_active:true,scope:'smartstore',target_field:'platform_registration_price'},{id:'deleted',is_active:false,scope:'smartstore',target_field:'platform_registration_price'},{id:'internal',is_active:true,scope:'',target_field:'calculated_base_price'}],assignments:[{sku:'A',rule_id:'live',scope:'smartstore',target_field:'platform_registration_price'},{sku:'B',rule_id:'deleted',scope:'smartstore',target_field:'platform_registration_price'},{sku:'C',rule_id:'internal',scope:'',target_field:'calculated_base_price'},{sku:'D',rule_id:'live',scope:'ably',target_field:'platform_registration_price'}]})};
 vm.createContext(context);vm.runInContext(extract('loadActiveSellerPriceRules')+'\nthis.read=loadActiveSellerPriceRules;',context);
 assert.deepEqual([...await context.read()],['["A","smartstore"]']);
});

test('whole-platform export streams only stored results without enumerating every matrix SKU',async()=>{
 const {api,calls}=adapter();const result=await api.loadStoredMatrixPrices({sources:['makeshop'],skus:null});
 assert.equal(result.rows.length,2);assert.equal(result.missing.length,0);
 assert.deepEqual(calls.map(call=>call.name),['hub_calculation_results_export_read_v1']);
 assert.equal(calls[0].args.p_scope,'makeshop');assert.equal(calls[0].args.p_after_sku,null);
});

test('generation and result writes use authenticated bounded RPC contracts',async()=>{
 const {api,calls}=adapter();assert.equal((await api.beginCalculationGeneration({reason:'tag apply',requestId:'id'})).generation_id,9);assert.equal((await api.upsertCalculatedPriceResults({generationId:9,rows:[{sku:'A'}]})).upserted,1);
 assert.deepEqual(calls.slice(0,2).map(call=>call.name),['hub_calculation_begin_v1','hub_calculation_results_upsert_v1']);
 assert.equal(calls[0].args.p_session_token,'session');assert.equal(calls[1].args.p_generation_id,9);
});

test('export reads an active matrix price draft when no calculated tuple exists',async()=>{
 const {api}=adapter({emptyStored:true});
 const result=await api.loadStoredMatrixPrices({sources:['smartstore'],skus:['S000','S001'],includeMatrixDrafts:true});
 assert.equal(result.rows.length,1);
 assert.deepEqual(JSON.parse(JSON.stringify(result.rows[0])),{sellpia_sku_code:'S000',source_channel:'smartstore',seller_product_code:'P0',seller_option_code:'O0',base_price:7000,discounted_base_price:6500,option_price:300,final_price:6800,discount_terms:[{term_key:'saved',value:500}],rule_versions:[],generation_id:null,status:'matrix_draft',error:null,change_id:77});
 assert.equal(result.missing.length,0,'wholly uncalculated rows are unchanged originals, not export errors');
});

test('stored price enrichment failure keeps the core matrix rows available',async()=>{
 const attach=extract('attachStoredCalculatedPrices');
 const products=[{sellpia_sku_code:'SKU-1',price:1200}];
 const warnings=[];
 const context={
  fullMatrixReadContext:null,
  cleanText:v=>String(v??'').trim(),
  loadCalculatedResults:async()=>{throw new Error('statement timeout');},
  loadStoredMatrixPrices:async()=>({rows:[]}),
  throwIfAborted:()=>{},
  console:{warn:(...args)=>warnings.push(args)}
 };
 vm.createContext(context);
 vm.runInContext(attach+'\nthis.attachStoredCalculatedPrices=attachStoredCalculatedPrices;',context);
 const result=await context.attachStoredCalculatedPrices(products);
 assert.equal(result,products);
 assert.equal(warnings.length,1);
 assert.equal(warnings[0][0],'stored matrix price enrichment failed');
});
