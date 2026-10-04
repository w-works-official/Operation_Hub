import assert from 'node:assert/strict';
await import('../mockups/operations-hub/ably-combinations.js');
await import('../mockups/operations-hub/ably-pair-generator.js');
const items=[
 {row:['에이블리','account','sellpia_8149','동일 상품','PRODUCT-1']},
 {row:['에이블리','account','manual-row-code','동일 상품','PRODUCT-1']},
 {row:['에이블리','account','sellpia_8149','동일 상품','PRODUCT-2']}
];
const groups=globalThis.AblyCombinationModel.groupProducts(items);
assert.deepEqual(groups.map(g=>g.items.length),[2,1]);
assert.equal(groups[0].items[1].row[2],'manual-row-code');
const product=sku=>({sellpia_sku_code:sku,system_stock:10,system_base_price:100});
assert.throws(()=>globalThis.AblyPairGenerator.generate([product('1000-1'),product('8149-2')],{title:'미확정 규칙',autoDefaults:true}),/확인된 관리코드 규칙/);
const rows=globalThis.AblyPairGenerator.generate([product('8149-1'),product('8149-2')],{title:'동일 접두부',autoDefaults:true});
assert.ok(rows.every(r=>r[2]==='sellpia_8149'));
console.log('PASS platform product identity groups varying row C, different product IDs stay separate, same-prefix code generation and unconfirmed mixed-prefix rejection');
