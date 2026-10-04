import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';
const source=fs.readFileSync(new URL('../mockups/operations-hub/data-service.js',import.meta.url),'utf8');
const helper=source.slice(source.indexOf('  async function countSellerDraftsForExport('),source.indexOf('  async function loadLatestSellerOriginalStatus('));
function setup(size=1201){
 const rows=Array.from({length:size},(_,i)=>({change_id:i+1,sellpia_sku_code:'sku-'+(i+1),source_channel:'ably',seller_product_code:'product-'+(i+1),status:'pending',field_key:'sellpia_current_stock',target_safety_state:'ready'})),calls=[],validations=[];
 const db={from(table){const q={table,filters:[],head:false,max:null,after:null,from:null,to:null,select(fields,options){this.head=options?.head===true;this.count=options?.count;return this;},in(field,values){this.filters.push([field,Array.from(values)]);return this;},gt(field,value){assert.equal(field,'change_id');this.after=value;return this;},order(){return this;},limit(value){this.max=value;return this;},range(from,to){this.from=from;this.to=to;return this;},then(resolve,reject){
  calls.push({head:this.head,count:this.count,max:this.max,after:this.after,from:this.from,to:this.to,filters:this.filters});
  const all=rows.filter(r=>this.filters.every(([field,values])=>values.includes(r[field]))&&(this.after===null||r.change_id>this.after));
  const selected=this.from===null?all.slice(0,this.max??all.length):all.slice(this.from,this.to+1);
  return Promise.resolve({data:this.head?null:selected.map(r=>({...r})),count:this.head?all.length:null,error:null}).then(resolve,reject);
 }};return q;}};
 const context={db,cleanText:v=>String(v??'').trim(),validateChangeQueue:async ids=>{validations.push(Array.from(ids));for(const row of rows)if(ids.includes(row.change_id))row.status='validated';}};
 vm.createContext(context);vm.runInContext(helper+'\nthis.api={loadSellerDraftRows,countSellerDraftsForExport,reviewSellerDraftsForExport};',context);
 return {...context.api,rows,calls,validations};
}
test('count uses exact HEAD server filtering, deduplicated200-SKU chunks, and zero payloads',async()=>{
 const h=setup(11518);assert.equal(await h.countSellerDraftsForExport(['ably']),11518);assert.equal(h.calls.length,1);assert.equal(h.calls[0].head,true);assert.equal(h.calls[0].count,'exact');
 h.calls.length=0;const skus=Array.from({length:2916},(_,i)=>'sku-'+(i+1));assert.equal(await h.countSellerDraftsForExport(['ably'],[...skus,skus[0]]),2916);assert.equal(h.calls.length,15);
 assert.ok(h.calls.every(c=>c.head&&c.filters.find(([f])=>f==='sellpia_sku_code')[1].length<=200));
 h.calls.length=0;assert.equal(await h.countSellerDraftsForExport(['ably'],[]),0);assert.equal(h.calls.length,0);
});
test('all saved-change rows use bounded 1000-row pages',async()=>{
 const h=setup();const rows=await h.loadSellerDraftRows({sources:['ably']});assert.equal(rows.length,1201);assert.equal(new Set(rows.map(r=>r.change_id)).size,1201);
 assert.deepEqual(h.calls.map(c=>[c.from,c.to]),[[0,999],[1000,1999]]);assert.equal(h.validations.length,0);
});
test('scoped rows are filtered on server and retain deterministic ordering across chunks',async()=>{
 const h=setup();const skus=Array.from({length:450},(_,i)=>'sku-'+(900-i));
 const rows=await h.loadSellerDraftRows({sources:['ably'],skus});assert.equal(rows.length,450);assert.equal(rows[0].change_id,451);assert.equal(rows.at(-1).change_id,900);
 assert.equal(h.calls.length,3);assert.ok(h.calls.every(c=>c.filters.find(([f])=>f==='sellpia_sku_code')[1].length<=200));
});
test('review preserves validation semantics using50-row writes and100-ID fresh reads',async()=>{
 const h=setup(251);h.rows[250].target_safety_state='conflict';
 const result=await h.reviewSellerDraftsForExport({sources:['ably'],changeIds:h.rows.map(r=>r.change_id)});
 assert.equal(result.changeIds.length,250);assert.equal(result.excluded.length,1);assert.deepEqual(h.validations.map(ids=>ids.length),[50,50,50,50,50]);
 assert.equal(h.calls.length,6);assert.ok(h.calls.every(c=>c.filters.find(([f])=>f==='change_id')[1].length<=100));
 assert.equal(h.rows[250].status,'pending','unsafe proposal must not be mutated by review');
});
test('validated rows without a seller product code are excluded before export preparation',async()=>{
 const h=setup(8099);for(let index=0;index<154;index++){h.rows[index].status='validated';h.rows[index].seller_product_code='';}
 for(let index=154;index<h.rows.length;index++)h.rows[index].status='validated';
 const result=await h.reviewSellerDraftsForExport({sources:['ably'],changeIds:h.rows.map(row=>row.change_id)});
 assert.equal(result.changeIds.length,7945);assert.equal(result.excluded.length,154);assert.equal(h.validations.length,0);
 assert.ok(result.excluded.every(entry=>/상품코드 누락/.test(entry.reason)));
});
