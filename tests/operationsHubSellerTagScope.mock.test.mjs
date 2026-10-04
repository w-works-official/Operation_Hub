import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app=fs.readFileSync(new URL('../mockups/operations-hub/app.js',import.meta.url),'utf8');
const start=app.indexOf('function updateSellerExportTagPicker()');
const end=app.indexOf('function sellerExportRowsForSources(',start);
assert.ok(start>0&&end>start,'seller tag scope helpers must remain available');

function harness({changeCount=false}={}){
 const nodes=new Map([
  ['seller-export-tag-select',{value:'tag-1',disabled:false,innerHTML:'',selectedOptions:[{textContent:'14K · 1,500 SKU'}]}],
  ['seller-export-tag-count',{textContent:''}],
  ['seller-export-tag-picker',{hidden:true}]
 ]);
 const calls=[];
 const rows=Array.from({length:1500},(_,index)=>({sellpia_sku_code:`SKU-${index+1}`}));
 const context={
  document:{getElementById:id=>nodes.get(id)||null},
  sellerExportState:{tagId:'',tagSkus:null,tagSkusPromise:null,tagCatalogLoaded:false},
  selectedSellerExportScope:()=> 'tag',
  escapeHtml:value=>String(value),formatNumber:value=>Number(value).toLocaleString('en-US'),
  liveData:{
   loadTagCatalog:async()=>({rows:[{tag_id:'tag-1',tag_name:'14K',option_count:1500}]}),
   loadTagMembers:async({tagId,page,pageSize})=>{
    calls.push({tagId,page,pageSize});
    const count=changeCount&&page===2?1499:1500;
    return {count,rows:rows.slice((page-1)*pageSize,page*pageSize)};
   }
  }
 };
 vm.createContext(context);
 vm.runInContext(app.slice(start,end)+'\nthis.collect=collectSellerExportTagSkus;this.resolve=resolveSellerExportScopeSkus;this.update=updateSellerExportTagPicker;',context);
 return {context,nodes,calls};
}

{
 const {context,nodes,calls}=harness();
 context.update();
 assert.equal(nodes.get('seller-export-tag-picker').hidden,false,'tag picker must be visible for tag scope');
 const skus=await context.resolve();
 assert.equal(skus.length,1500);
 assert.equal(new Set(skus).size,1500);
 assert.deepEqual(calls.map(call=>call.page),[1,2]);
 assert.match(nodes.get('seller-export-tag-count').textContent,/서버 확인 1,500 SKU/);
}

{
 const {context}=harness({changeCount:true});
 await assert.rejects(context.collect(),/조회 중 변경/,'membership drift must fail closed');
}

console.log('Seller export tag scope: authoritative pagination and drift guard passed');
