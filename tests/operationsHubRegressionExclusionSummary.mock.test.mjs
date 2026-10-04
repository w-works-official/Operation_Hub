import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';
const source=fs.readFileSync(new URL('../mockups/operations-hub/app.js',import.meta.url),'utf8');
const functionSource=source.slice(source.indexOf('function showSellerExportExclusions('),source.indexOf('\nasync function refreshSellerOriginalStates('));
function harness(){
 const nodes=new Map(),state={};
 const c={sellerExportState:state,CHANNEL_LABELS:{ably:'에이블리'},formatNumber:n=>Number(n).toLocaleString('ko-KR'),escapeHtml:v=>String(v).replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x])),document:{getElementById(id){if(!nodes.has(id))nodes.set(id,{});return nodes.get(id);}}};
 vm.createContext(c);vm.runInContext(functionSource+'\nthis.show=showSellerExportExclusions;',c);
 return {show:c.show,state,node:suffix=>nodes.get('seller-export-exclusions'+suffix)};
}
const entry=(id,reason)=>({item:{source_channel:'ably',sellpia_sku_code:'sku-'+id,seller_product_code:'product-'+id,seller_option_code:'option-'+id},reason});
test('5000 different SKU reasons collapse into one representative summary and keep50 original rows',()=>{
 const h=harness(),items=Array.from({length:5000},(_,i)=>entry(i,`상품 묶음 전체 제외: sku-${i}: 매입가 없음`)),before=JSON.stringify(items);
 h.show(items);assert.equal(h.node('-summary').textContent,'5,000건: 매입가 없음');
 assert.equal((h.node('-rows').innerHTML.match(/<tr>/g)||[]).length,50);assert.match(h.node('-rows').innerHTML,/sku-49: 매입가 없음/);assert.doesNotMatch(h.node('-rows').innerHTML,/sku-50:/);
 assert.equal(h.state.excludedItems,items,'the complete original item list stays available for CSV');assert.equal(JSON.stringify(items),before,'normalization must not rewrite any original reason or item');
});
test('representative categories preserve counts and show only ten largest plus remainder',()=>{
 const h=harness(),items=[],labels=['가','나','다','라','마','바','사','아','자','차','카','타'];
 labels.forEach((label,index)=>{for(let n=0;n<index+1;n++)items.push(entry(items.length,`${label} 유형 오류`));});
 h.show(items);const lines=h.node('-summary').textContent.split('\n');assert.equal(lines.length,11);assert.equal(lines[0],'12건: 타 유형 오류');assert.equal(lines[9],'3건: 다 유형 오류');assert.equal(lines[10],'나머지 3건 · 2개 사유');
 assert.equal((h.node('-rows').innerHTML.match(/<tr>/g)||[]).length,50);
});
test('unknown dynamic reasons stay bounded and original detail text remains escaped',()=>{
 const h=harness(),items=Array.from({length:5000},(_,i)=>entry(i,`sku-${i}: 검증 실패 / 상품 product-${i} / 값 ${i}`));
 items[0].reason='<script>alert("detail")</script> '+items[0].reason;h.show(items);
 assert.ok(h.node('-summary').textContent.split('\n').length<=11);assert.ok(h.node('-summary').textContent.length<2200);assert.doesNotMatch(h.node('-rows').innerHTML,/<script>/);assert.match(h.node('-rows').innerHTML,/&lt;script&gt;/);
 h.show([]);assert.equal(h.node('').hidden,true);assert.equal(h.node('-summary').textContent,'');assert.equal(h.node('-rows').innerHTML,'');
});
