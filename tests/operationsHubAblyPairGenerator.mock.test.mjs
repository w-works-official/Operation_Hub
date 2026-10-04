import assert from 'node:assert/strict';
await import('../mockups/operations-hub/ably-pair-generator.js');
const products=Array.from({length:9},(_,i)=>({sellpia_sku_code:`1000-${i+1}`,sellpia_option_name:`옵션 ${i+1}`,system_stock:i}));
const rows=globalThis.AblyPairGenerator.generate(products,{title:'1+1 상품'});
assert.equal(rows.length,81);assert.equal(new Set(rows.map(r=>JSON.stringify([r[11],r[13]]))).size,81);
assert.equal(rows.filter(r=>r[11]===r[13]).length,9);assert.deepEqual(rows[0].slice(10,14),['옵션1','옵션 1','옵션2','옵션 1']);
assert.equal(rows[1][16],'[1000-1],[1000-2]');assert.equal(rows[9][16],'[1000-2],[1000-1]');assert.equal(rows[1][23],0);assert.equal(rows[80][23],8);
assert.throws(()=>globalThis.AblyPairGenerator.generate([{...products[0],system_stock:null}],{title:'test'}));
console.log('PASS 9x9=81, option order, 9 self-pairs, exact Q references, zero and missing stock');
const triples=globalThis.AblyPairGenerator.generate(products,{title:'3개 조합',size:3,option1:'첫 선택',option2:'두 번째',option3:'세 번째'});
assert.equal(triples.length,729);assert.equal(new Set(triples.map(r=>JSON.stringify([r[11],r[13],r[15]]))).size,729);
assert.deepEqual([triples[0][10],triples[0][12],triples[0][14]],['첫 선택','두 번째','세 번째']);
assert.equal(triples[728][16],'[1000-9],[1000-9],[1000-9]');assert.equal(triples[728][23],8);
assert.throws(()=>globalThis.AblyPairGenerator.generate(Array.from({length:30},(_,i)=>({...products[0],sellpia_sku_code:String(i)})),{title:'too many',size:3}));
console.log('PASS 9x9x9=729, editable option labels, three exact Q references and size limit');

const generatedDefaults=globalThis.AblyPairGenerator.generate([
 {sellpia_sku_code:'1000-1',system_stock:10,system_base_price:1200},
 {sellpia_sku_code:'1000-2',system_stock:20,system_base_price:2300}
],{title:'automatic',autoDefaults:true});
assert.deepEqual(generatedDefaults.map(r=>r[5]),[2400,3500,3500,4600]);
assert.ok(generatedDefaults.every(r=>r[1]==='pink_rocket@naver.com'&&r[2]==='sellpia_1000'));
assert.throws(()=>globalThis.AblyPairGenerator.generate([{sellpia_sku_code:'1000-1',system_stock:1}],{title:'missing',autoDefaults:true}),/기준가격 없음/);
console.log('PASS new-combination account, SKU prefix, per-option price sums and missing-price rejection');
