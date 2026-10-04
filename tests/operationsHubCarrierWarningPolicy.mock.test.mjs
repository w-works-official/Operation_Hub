import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const mathSource=fs.readFileSync(new URL('../mockups/operations-hub/discount-price-math.js',import.meta.url),'utf8');
const exportSource=fs.readFileSync(new URL('../mockups/operations-hub/current-price-export.js',import.meta.url),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));

function harness(){
 const context={console};
 vm.createContext(context);
 vm.runInContext(mathSource,context);
 vm.runInContext(exportSource,context);
 return context.HubCurrentPriceExport;
}
function carrier(product='P',option='O',rowNo=6){
 return {product_code:product,option_code:option,source_row_no:rowNo,base_price:5000,discounted_base_price:5000,option_price:0,final_price:5000,stock:8,discount_terms:[]};
}
function snapshot(product='P',option='O',extra={}){
 return {sku:`${product}-${option}`,product_code:product,option_code:option,active_price_rule:true,seller_stock:0,source_stock:8,source_base_price:5000,source_discounted_base_price:5000,source_option_price:0,source_final_price:5000,source_discount_terms:[],...extra};
}
function calculated(generation=27){
 return {current_effective_price:{platformBase:5500,platformDiscount:0,platformOption:0,platformFinal:5500,platformTerms:[],versions:[{id:'current-rule',version:generation}]}};
}
function assertPriceWarningRow(plan,index=0,{stockChanged=true}={}){
 const row=plan.preview[index];
 assert.equal(row.status,'warn_keep_original');
 assert.equal(row.warning_field,'price');
 assert.equal(row.changed,stockChanged);
 assert.deepEqual(plain(row.changed_fields||[]),stockChanged?['stock']:[]);
 assert.equal(row.diff.stock.changed,stockChanged,'price warning must not suppress an independent stock operation');
 assert.deepEqual(plain(row.diff.price.after),plain(row.diff.price.before),'warning must preserve the complete original price tuple');
 assert.equal(plan.operations.some(item=>item.seller_product_code===row.product_code&&item.seller_option_code===row.option_code&&item.field_key==='sellpia_sale_price'),false);
 assert.equal(plan.operations.some(item=>item.seller_product_code===row.product_code&&item.seller_option_code===row.option_code&&item.field_key==='sellpia_current_stock'),stockChanged);
 assert.ok(row.reason,'warning must explain why the original is kept');
}

for(const source of ['smartstore','makeshop']){
 test(`${source}: missing price target preserves price while exporting independent stock`,()=>{
  const plan=harness().prepareCarrierItems(source,'carrier.xlsx',[carrier()],[snapshot()]);
  assert.equal(plan.canGenerate,true);
  assert.equal(plan.summary.warned,1);
  assert.equal(plan.summary.blocked,0);
  assert.equal(plan.summary.changed,1);
  assert.deepEqual(plain(plan.operations.map(item=>[item.field_key,item.after_value])),[['sellpia_current_stock',0]]);
  assertPriceWarningRow(plan);
  assert.equal(plan.preview[0].price_state.code,'timeout_error');
 });
 test(`${source}: timeout/error preserves price but does not freeze independent stock`,()=>{
  const plan=harness().prepareCarrierItems(source,'carrier.xlsx',[carrier()],[snapshot('P','O',{current_effective_error:'현재 Rule 입력이 없습니다.',registration_status:'error',registration_error:'과거 statement timeout'})]);
  assert.equal(plan.canGenerate,true);
  assert.equal(plan.summary.warned,1);
  assert.equal(plan.summary.blocked,0);
  assert.equal(plan.preview[0].price_state.code,'timeout_error');
  assertPriceWarningRow(plan);
 });
 test(`${source}: current per-SKU projection is independent of historical generation ordering`,()=>{
  const plan=harness().prepareCarrierItems(source,'carrier.xlsx',[carrier('OLD'),carrier('NEW','O',7)],[snapshot('OLD','O',calculated(26)),snapshot('NEW','O',calculated(27))]);
  assert.equal(plan.latest_generation_id,null);
  assert.equal(plan.canGenerate,true);
  assert.equal(plan.summary.warned,0);
  assert.equal(plan.summary.blocked,0);
  assert.equal(plan.summary.changed,2);
  assert.deepEqual(plain(plan.preview.map(row=>row.price_state.code)),['calculated_complete','calculated_complete']);
  assert.ok(plan.operations.some(item=>item.seller_product_code==='OLD'&&item.field_key==='sellpia_sale_price'));
  assert.ok(plan.operations.some(item=>item.seller_product_code==='NEW'&&item.field_key==='sellpia_sale_price'));
 });
 test(`${source}: mixed products mutate safe rows and retain missing-price rows completely`,()=>{
  const plan=harness().prepareCarrierItems(source,'carrier.xlsx',[carrier('GOOD'),carrier('WARN','O',7)],[snapshot('GOOD','O',calculated()),snapshot('WARN')]);
  assert.equal(plan.operations,plan.items,'preview and serializer share one resolved operation array');
  assert.equal(plan.canGenerate,true);
  assert.equal(plan.summary.changed,2);
  assert.equal(plan.summary.warned,1);
  assert.equal(plan.summary.blocked,0);
  assert.equal(plan.preview[0].status,'ready');
  assert.equal(plan.preview[0].disposition,'change');
  assertPriceWarningRow(plan,1);
  assert.deepEqual(plain(plan.operations.map(item=>[item.seller_product_code,item.field_key,item.after_value])),[['GOOD','sellpia_current_stock',0],['GOOD','sellpia_sale_price',5500],['WARN','sellpia_current_stock',0]]);
 });
 test(`${source}: a unique unmatched identity is safely kept original without invented SKU operations`,()=>{
  const plan=harness().prepareCarrierItems(source,'carrier.xlsx',[carrier('UNMATCHED')],[]);
  assert.equal(plan.canGenerate,true);
  assert.equal(plan.summary.matched,0);
  assert.equal(plan.summary.warned,1);
  assert.equal(plan.summary.blocked,0);
  assert.equal(plan.preview[0].status,'warn_keep_original');
  assert.equal(plan.preview[0].sku,'');
  assert.equal(plan.operations.length,0);
 });
 test(`${source}: duplicate carrier identities remain hard blockers`,()=>{
  const plan=harness().prepareCarrierItems(source,'carrier.xlsx',[carrier(),carrier('P','O',7)],[snapshot('P','O',calculated())]);
  assert.equal(plan.canGenerate,false);
  assert.equal(plan.summary.blocked,2);
  assert.equal(plan.summary.warned,0);
  assert.equal(plan.operations.length,0);
  assert.ok(plan.preview.every(row=>row.status==='blocked'));
 });
 test(`${source}: multiple mapped SKU candidates remain hard blockers`,()=>{
  const plan=harness().prepareCarrierItems(source,'carrier.xlsx',[carrier()],[snapshot('P','O',calculated()),snapshot('P','O',{...calculated(),sku:'OTHER-SKU'})]);
  assert.equal(plan.canGenerate,false);
  assert.equal(plan.summary.blocked,1);
  assert.equal(plan.summary.warned,0);
  assert.equal(plan.operations.length,0);
  assert.equal(plan.preview[0].status,'blocked');
 });
 test(`${source}: one warning quarantines its shared-price product but not unrelated products`,()=>{
  const plan=harness().prepareCarrierItems(source,'carrier.xlsx',[carrier('SHARED','A'),carrier('SHARED','B',7),carrier('OTHER','C',8)],[snapshot('SHARED','A',calculated()),snapshot('SHARED','B',{current_effective_error:'현재 Rule 계산 실패',registration_status:'error',registration_error:'과거 statement timeout'}),snapshot('OTHER','C',calculated())]);
  assert.equal(plan.canGenerate,true);
  assert.equal(plan.summary.warned,2);
  assert.equal(plan.summary.blocked,0);
  assert.equal(plan.summary.changed,3);
  assert.equal(plan.preview[0].shared_price_warning,true);
  assert.equal(plan.preview[0].diff.price.changed,false);
  assert.equal(plan.preview[0].diff.stock.changed,true);
  assert.deepEqual(plain(plan.preview[0].changed_fields),['stock']);
  assertPriceWarningRow(plan,1);
  assert.ok(plan.operations.length>0);
  assert.ok(plan.operations.filter(item=>item.seller_product_code==='SHARED').every(item=>item.field_key==='sellpia_current_stock'),'shared price warning must retain only independent stock operations');
  assert.ok(plan.operations.some(item=>item.seller_product_code==='OTHER'&&item.field_key==='sellpia_sale_price'));
 });
 test(`${source}: no active price Rule is normal original-price behavior and may still export stock zero`,()=>{
  const plan=harness().prepareCarrierItems(source,'carrier.xlsx',[carrier()],[snapshot('P','O',{active_price_rule:false,...calculated()})]);
  assert.equal(plan.canGenerate,true);
  assert.equal(plan.summary.warned,0);
  assert.equal(plan.summary.blocked,0);
  assert.equal(plan.summary.changed,1);
  assert.equal(plan.preview[0].status,'ready');
  assert.equal(plan.preview[0].disposition,'change');
  assert.deepEqual(plain(plan.operations.map(item=>[item.field_key,item.after_value])),[['sellpia_current_stock',0]]);
  assert.deepEqual(plain(plan.preview[0].diff.price.after),plain(plan.preview[0].diff.price.before));
 });
 test(`${source}: safe equal values are classified unchanged rather than warnings`,()=>{
  const plan=harness().prepareCarrierItems(source,'carrier.xlsx',[carrier()],[snapshot('P','O',{active_price_rule:false,seller_stock:8})]);
  assert.equal(plan.canGenerate,true);
  assert.equal(plan.summary.unchanged,1);
  assert.equal(plan.summary.warned,0);
  assert.equal(plan.preview[0].disposition,'unchanged');
  assert.equal(plan.operations.length,0);
 });
}
test('empty carrier cannot generate a meaningless output file',()=>{
 const plan=harness().prepareCarrierItems('smartstore','carrier.xlsx',[],[]);
 assert.equal(plan.canGenerate,false);
 assert.equal(plan.operations.length,0);
});
