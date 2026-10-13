import test from 'node:test';
import assert from 'node:assert/strict';
import {projectSourceRow,compareProjectedRows} from './operationsHubSellpiaSyncOperationalDbCompare.mjs';
const row=()=>({sellpia_sku_code:'999999-1',sellpia_product_name:'synthetic',stock:5,available_stock:-2,integrated_available_stock:3,safety_stock:0,purchase_price:50,order_unit:1,minimum_order_unit:1,raw_payload:{base_price:0,sell_price:0,purchase_price:50,commission:15,purchase_vat:false,sale_status:'정상'}});
const compare=(a,b)=>compareProjectedRows([projectSourceRow(a)],[projectSourceRow(b)]);
test('commission and VAT changes belong only to purchasePrice, matching shipped SQL',()=>{
 for(const field of ['commission','purchase_vat']){const old=row(),next=structuredClone(old);next.raw_payload[field]=field==='commission'?20:true;const result=compare(next,old);assert.equal(result.changedCommonSkuCount,1);assert.equal(result.fieldGroups.purchasePrice.changed,1);assert.equal(result.fieldGroups.basic.changed,0);assert.equal(result.fieldGroups.inventory.changed,0);}
});
test('basic typed source text change does not imply purchase-price change',()=>{
 const old=row(),next=structuredClone(old);next.sellpia_product_name='changed synthetic';const result=compare(next,old);assert.equal(result.fieldGroups.basic.changed,1);assert.equal(result.fieldGroups.purchasePrice.changed,0);
});
test('group overlap is counted once per common identity and numeric text equals numbers',()=>{
 const old=row(),next=structuredClone(old);next.stock=6;next.raw_payload.base_price=1;next.raw_payload.commission=20;next.order_unit='1';const result=compare(next,old);assert.equal(result.changedCommonSkuCount,1);for(const group of ['inventory','price','purchasePrice'])assert.equal(result.fieldGroups[group].changed,1);assert.equal(result.fieldGroups.basic.changed,0);
});
test('null quantity is distinct from zero and absent purchase metadata remains unknown',()=>{
 const old=row(),next=structuredClone(old);old.safety_stock=null;delete old.raw_payload.purchase_vat;const result=compare(next,old);assert.equal(result.fieldGroups.inventory.changed,1);assert.equal(result.fieldGroups.purchasePrice.unknown,1);assert.equal(result.unknownCommonSkuCount,1);
});
