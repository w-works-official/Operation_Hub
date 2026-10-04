import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source=fs.readFileSync('mockups/operations-hub/app.js','utf8');
function extract(name){
  const start=source.indexOf(`function ${name}(`);assert.notEqual(start,-1,`${name} exists`);
  const brace=source.indexOf('{',start);let depth=0,quote='',escaped=false;
  for(let i=brace;i<source.length;i++){
    const char=source[i];
    if(quote){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char===quote)quote='';continue;}
    if(['"',"'",'`'].includes(char)){quote=char;continue;}
    if(char==='{')depth++;else if(char==='}'&&--depth===0)return source.slice(start,i+1);
  }
  throw Error(`unterminated ${name}`);
}

test('matrix prefers stored unified formula result while direct input remains authoritative',()=>{
  const context={};vm.createContext(context);vm.runInContext(`${extract('resolvedInboundCost')}\nthis.resolve=resolvedInboundCost`,context);
  const formula=context.resolve({actual_inbound_cost:null,__profile:{sku_tags:[{tag_id:'half',tag_name:'14K_1/2',tag_color:'#aa5500'}]},__hubInternalPrices:{actual_inbound_cost:{value:5000,ruleNames:['14K_1/2']}}});
  assert.equal(formula.value,5000);assert.equal(formula.mode,'formula');assert.equal(formula.tagName,'14K_1/2');assert.equal(formula.color,'#aa5500');
  const manual=context.resolve({actual_inbound_cost:7200,actual_inbound_cost_mode:'manual',__hubInternalPrices:{actual_inbound_cost:{value:5000,ruleNames:['14K_1/2']}}});
  assert.equal(manual.value,7200);assert.equal(manual.mode,'manual');
});

test('matrix tag chips keep formula/general and product/SKU scope visible with bounded overflow',()=>{
  const context={escapeHtml:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')};vm.createContext(context);vm.runInContext(`${extract('matrixAppliedTagChips')}\nthis.render=matrixAppliedTagChips`,context);
  const html=context.render({product_tags:[{tag_id:'p',tag_name:'14K',tag_group:'운영'}],sku_tags:[{tag_id:'f',tag_name:'14K_1/2',tag_group:'가격 수식'},{tag_id:'s',tag_name:'소스_2000',tag_group:'가격 수식'},{tag_id:'x',tag_name:'예외',tag_group:'운영'}]});
  assert.match(html,/14K/);assert.match(html,/fx 14K_1\/2/);assert.match(html,/상품 태그/);assert.match(html,/SKU 태그/);assert.match(html,/\+1/);
});
