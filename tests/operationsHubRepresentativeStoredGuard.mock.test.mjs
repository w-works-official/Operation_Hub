import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const source=fs.readFileSync('mockups/operations-hub/data-service.js','utf8');
function extract(name){const start=source.indexOf('  async function '+name+'('),rest=source.slice(start+2),end=rest.slice(2).search(/\n  (?:async )?function /);return rest.slice(0,end+2);}
test('stored representative-dependent seller tuples require fresh current product and seller fingerprint, including inactive definitions',async()=>{
 for(const [status,currentFp,expected] of [['calculated','current','calculated'],['inactive','current','error'],['stale','current','error'],['calculated','changed','error']]){
  const fields=['platform_registration_price','platform_discount_price','platform_option_price','platform_final_price'],calls=[];
  const rows=['rep-sku','ordinary'].flatMap(sku=>fields.map((field,i)=>({sku,scope:'smartstore',field,value:[6000,5000,0,5000][i],status:'calculated',generation_id:42,seller_product_code:sku,seller_option_code:'option',rule_versions:[{id:sku==='rep-sku'?'rep-id':'existing-seller',version:1,assignmentVersion:1}],result_details:{input_fingerprint:'current',discount_terms:[]}})));
  const context={cleanText:v=>String(v??'').trim(),loadActiveSellerPriceRules:async()=>new Set(['rep-sku','ordinary'].map(s=>JSON.stringify([s,'smartstore']))),loadCalculatedResults:async()=>({rows,missing:[]}),productPrice:async(action,body)=>{calls.push({action,body});return {rules:[{id:'rep-id',is_active:status!=='inactive'}]};},readRepresentativePrices:async()=>[{status,contributors:[{sku:'rep-sku'}]}],loadInputFingerprints:async()=>({'rep-sku':currentFp})};
  vm.createContext(context);vm.runInContext(extract('loadStoredMatrixPrices')+'\nthis.read=loadStoredMatrixPrices;',context);
  const actual=await context.read({sources:['smartstore'],skus:['rep-sku','ordinary']});
  assert.equal(actual.rows.find(r=>r.sellpia_sku_code==='rep-sku').status,expected);assert.equal(actual.rows.find(r=>r.sellpia_sku_code==='ordinary').status,'calculated');assert.equal(actual.rows.find(r=>r.sellpia_sku_code==='ordinary').final_price,5000);assert.equal(calls[0].body.include_inactive,true);
 }
});
