import http from 'node:http';
import {readFileSync,readdirSync} from 'node:fs';
import {createFixtureDatabase} from './fixture.mjs';
const db=await createFixtureDatabase();
await db.exec(`create table public.source_orders(row jsonb);
create function operations_private.inventory_order_source(p_date date,p_offset integer,p_ids jsonb default null)
returns jsonb language sql as $$select coalesce(jsonb_agg(row),'[]') from (select row from public.source_orders where row->>'date'=p_date::text
and (p_ids is null or p_ids @> jsonb_build_array(row->>'id')) order by row->>'id' limit 201 offset p_offset) s$$;
insert into public.operations_hub_sku_operational_master(sellpia_sku_code,stock_quantity) values('TEST-1',20),('TEST-2',5);`);
const dir=new URL('../../supabase/migrations/',import.meta.url);
let sql=readFileSync(new URL(readdirSync(dir).find(name=>name.endsWith('_operations_hub_manual_order_stock_v1.sql')),dir),'utf8');
await db.exec(sql.slice(0,sql.indexOf('-- Fixed host'))+sql.slice(sql.indexOf('create function operations_private.inventory_describe')));
for(const [id,sku,quantity,source_status,date] of [['1','TEST-1',3,'재고매칭','2026-09-08'],['2','TEST-1',2,'상품매칭','2026-09-08'],['3','TEST-2',9,'재고매칭','2026-09-08'],['4','TEST-2',1,'취소','2026-09-08'],['5','TEST-1',1,'송장입력','2026-09-07']]) {
 await db.query('insert into source_orders values($1)',[JSON.stringify({id,key:JSON.stringify(['picking-order','sample',id]),sku,quantity,source_status,date,source_hash:id,product_name:'테스트 상품',option_name:'실제 운영 데이터와 분리'})]);
}
const root=new URL('../../mockups/operations-hub/',import.meta.url);
const html=`<!doctype html><html lang="ko"><meta charset="utf-8"><title>접수 주문 · 로컬 검증</title><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/order-stock.css"><body style="padding:30px;background:#f5f7fb"><div id="inventory"></div><script>
const rpc=(name,args)=>fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,args})}).then(async response=>{const data=await response.json();if(!response.ok)throw new Error(data.error);return data;});
window.SystemV3Data={listOrderStock:({date,offset})=>rpc('list_operations_hub_order_stock_v1',['test-only-valid-session',date,offset]),saveOrderStock:({actionId,date,mode,rows})=>rpc('save_operations_hub_order_stock_v1',['test-only-valid-session',actionId,date,mode,JSON.stringify(rows)]),undoOrderStock:id=>rpc('undo_operations_hub_order_stock_v1',['test-only-valid-session',id]),listStockHistory:()=>rpc('list_operations_hub_stock_history_v1',['test-only-valid-session'])};
</script><script src="/order-stock.js"></script><script>OperationsOrderStock.open();</script></body></html>`;
http.createServer(async(req,res)=>{
try {
 if(req.url==='/rpc'&&req.method==='POST') {
  let body='';for await(const chunk of req)body+=chunk;if(body.length>250000)throw new Error('too large');
  const {name,args}=JSON.parse(body);
  if(!['list_operations_hub_order_stock_v1','save_operations_hub_order_stock_v1','undo_operations_hub_order_stock_v1','list_operations_hub_stock_history_v1'].includes(name))throw new Error('unsupported fixture endpoint');
  const value=(await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result;
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));return;
 }
 const filename=req.url.split('?')[0].slice(1);
 if(['style.css','order-stock.css','order-stock.js'].includes(filename)) {res.writeHead(200,{'Content-Type':filename.endsWith('.js')?'text/javascript':'text/css'});res.end(readFileSync(new URL(filename,root)));return;}
 res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});res.end(html);
}catch(error){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
}).listen(8776,'127.0.0.1',()=>console.log('Inventory fixture ready at http://127.0.0.1:8776 (isolated PostgreSQL; no remote writes)'));
