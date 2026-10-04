import test from 'node:test';import assert from 'node:assert/strict';
import '../mockups/operations-hub/rule-registry.js';import '../mockups/operations-hub/representative-price.js';import '../mockups/operations-hub/discount-price-math.js';import '../mockups/operations-hub/platform-rule-service.js';import '../mockups/operations-hub/price-result-materializer.js';
import {representativeFixture} from './fixtures/representativeWiringFixture.mjs';
test('production materializer finishes full product membership across 200-row batches before representative -> seller -> discount',async()=>{
 const f=representativeFixture({count:250});const result=await f.run();assert.equal(result.totalSkus,250);assert.equal(result.errorRows,0);assert.equal(f.events.find(e=>e.type==='representative').options,250);
 const event=f.events.findIndex(e=>e.type==='representative');assert.ok(f.events.slice(0,event).every(e=>e.scope===''));assert.ok(f.events.slice(event+1).every(e=>e.scope==='smartstore'));
 const expected=(1000+124*1000+1000)*2;assert.equal(f.read().value,expected);assert.equal(f.read().status,'calculated');
 for(const row of f.writes.filter(r=>r.scope)){assert.equal(row.status,'calculated');assert.ok(row.rule_versions.some(v=>v.id==='representative'));assert.equal(row.value,row.field==='platform_option_price'?0:expected+(row.field==='platform_registration_price'?2000:1000));}
});
test('representative input is explicit; removal/stale/missing/provenance changes never use stored history as current',async()=>{
 const f=representativeFixture();await f.run();const evaluator=()=>HubRuleRegistry.createEvaluator({...f.registry,products:Object.fromEntries(f.skus.map(s=>[s,{...f.products[s],__hubRepresentativePrice:f.read()}]))});
 assert.equal(evaluator().evaluate(f.skus[0],'platform_registration_price','smartstore').value,8000);
 f.representative.is_active=false;assert.equal(f.read().value,null);assert.throws(()=>evaluator().evaluate(f.skus[0],'platform_registration_price','smartstore'),/商品|상품 대표가/);
 f.representative.is_active=true;f.base.get(f.skus[1]).generation_id++;assert.equal(f.read().status,'stale');assert.throws(()=>evaluator().evaluate(f.skus[0],'platform_registration_price','smartstore'),/상품 대표가/);
 f.base.delete(f.skus[1]);assert.equal(f.read().status,'blocked');assert.equal(f.read().value,null);
});
test('source changes and assignment changes invalidate representative proof without unrelated product mutation',async()=>{
 const f=representativeFixture();await f.run();f.products[f.skus[0]].sellpia_source_purchase_price++;assert.equal(f.read().status,'stale');await f.run();assert.equal(f.read().status,'calculated');
 f.registry.assignments.find(a=>a.sku===f.skus[1]&&a.rule_id==='base').version++;assert.equal(f.read().status,'stale');
 assert.ok(f.writes.every(r=>f.skus.includes(r.sku)));assert.equal(f.products[f.skus[0]].system_base_price,999999);
});
test('representative input cannot own SKU output or parent/cross-seller aliases',()=>{
 const good={id:'explicit',name:'explicit',scope:'smartstore',input_origin:'self',source_field:'representative_base_price',target_field:'platform_registration_price',config:{steps:[]}};
 assert.equal(HubRuleRegistry.validateRule(good),good);
 for(const patch of [{scope:'',target_field:'calculated_base_price'},{input_origin:'parent'},{source_scope:'makeshop'},{target_field:'platform_discount_price'}])assert.throws(()=>HubRuleRegistry.validateRule({...good,...patch}));
});
