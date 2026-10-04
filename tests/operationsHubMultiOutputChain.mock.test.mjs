import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import '../mockups/operations-hub/rule-registry.js';
import '../mockups/operations-hub/price-result-materializer.js';
test('new inbound owner propagates to base in one bounded run without stored value fallback',async()=>{
 const sku='5566-1',rules=[
  {id:'half',name:'14K_1_2',version:2,target_field:'actual_inbound_cost',source_field:'purchase_price',input_origin:'self',scope:'',config:{steps:[{op:'divide',value:2}]}},
  {id:'base',name:'2.2',version:1,target_field:'calculated_base_price',source_field:'actual_inbound_cost',input_origin:'self',scope:'',config:{steps:[{op:'multiply',value:2.2},{op:'round',unit:500,rounding:'up'}]}}
 ];
 const rows=[],loaded=[];
 globalThis.SystemV3Data={
  beginCalculationGeneration:async()=>({generation_id:34}),ruleRegistry:async()=>({rules,assignments:rules.map(r=>({sku,rule_id:r.id,target_field:r.target_field,scope:'',version:1})),dependencies:[]}),
  expandRepresentativeMembers:async()=>[],loadInputFingerprints:async()=>({[sku]:'a'.repeat(64)}),
  loadFormulaProducts:async codes=>{loaded.push(...codes);return [{sellpia_sku_code:sku,sellpia_source_purchase_price:53500,actual_inbound_cost:53500,system_base_price:80000}];},
  upsertCalculatedPriceResults:async p=>rows.push(...p.rows)
 };
 const result=await HubPriceMaterializer.materialize({skus:[sku],sources:[]});
 assert.equal(result.errorRows,0);assert.equal(result.totalSkus,1);assert.deepEqual(loaded,[sku]);
 assert.equal(rows.find(r=>r.field==='actual_inbound_cost').value,26750);
 const base=rows.find(r=>r.field==='calculated_base_price');assert.equal(base.value,59000);
 assert.deepEqual(base.rule_versions.map(r=>r.id),['half','base']);assert.ok(rows.every(r=>r.scope===''&&r.sku===sku));
});
test('drawer never labels legacy output as current owner proof',()=>{
 const context={};vm.createContext(context);vm.runInContext(fs.readFileSync('mockups/operations-hub/matrix-shadow.js','utf8'),context);
 const html=context.HubMatrixShadow.renderDetail({sellpia_sku_code:'5566-1',__hubInternalPrices:{actual_inbound_cost:{value:53500,generationId:29,stale:true,provenanceMismatch:true,ruleNames:[]}}});
 assert.match(html,/현재 Rule과 다름/);assert.match(html,/재계산 필요/);assert.doesNotMatch(html,/최신 여부 미확인/);
});
