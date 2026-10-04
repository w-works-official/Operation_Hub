import {createFixtureDatabase} from './fixture.mjs';
import {readFileSync,readdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const db=await createFixtureDatabase();
await db.exec(`create table source_orders(row jsonb); grant usage on schema operations_private to anon,authenticated;
create function operations_private.inventory_order_source(p_date date,p_offset integer,p_ids jsonb default null)
returns jsonb language sql as $$select coalesce(jsonb_agg(row),'[]') from (select row from public.source_orders where row->>'date'=p_date::text
and (p_ids is null or p_ids @> jsonb_build_array(row->>'id')) order by row->>'id' limit 201 offset p_offset) s$$;`);
const dir=new URL('../../supabase/migrations/',import.meta.url);
let sql=readFileSync(new URL(readdirSync(dir).find(name=>name.endsWith('_operations_hub_manual_order_stock_v1.sql')),dir),'utf8');
// Network boundary alone is replaced. All auth, locks, ledger, stock writes and undo use production SQL.
sql=sql.slice(0,sql.indexOf('-- Fixed host'))+sql.slice(sql.indexOf('create function operations_private.inventory_describe'));
await db.exec(sql);
const session='test-only-valid-session',date='2026-09-08';
const rpc=async(name,args)=>(await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result;
const list=async()=> (await rpc('list_operations_hub_order_stock_v1',[session,date,0])).rows;
const save=(rows,mode='deduct',id=randomUUID(),token=session)=>rpc('save_operations_hub_order_stock_v1',[token,id,date,mode,JSON.stringify(rows)]);
const undo=id=>rpc('undo_operations_hub_order_stock_v1',[session,id]);
const stock=async sku=>(await db.query('select stock_quantity from public.operations_hub_sku_operational_master where sellpia_sku_code=$1',[sku])).rows[0].stock_quantity;
const row=(id,sku,quantity)=>({id,key:JSON.stringify(['picking-order','order',id]),sku,quantity,date,source_status:'재고매칭',source_hash:`hash-${id}-${quantity}`});
async function reset(input=[row('1','A',3),row('2','A',2),row('3','B',20)]) {
 await db.exec(`truncate operations_private.inventory_actions,operations_private.inventory_movements,source_orders,public.operations_hub_sku_operational_master,public.operations_hub_sellpia_overrides;
 insert into public.operations_hub_sku_operational_master(sellpia_sku_code,stock_quantity) values('A',10),('B',5);`);
 for(const r of input)await db.query('insert into source_orders values($1)',[JSON.stringify(r)]);
}
let count=0;async function test(name,fn){await reset();await fn();count++;console.log('PASS',name);}
await test('custom session required and private data denied to public API roles',async()=>{
 await assert.rejects(rpc('list_operations_hub_order_stock_v1',['bad',date,0]),/invalid session/);
 await assert.rejects(save(await list(),'deduct',randomUUID(),'bad'),/invalid session/);
 await assert.rejects(rpc('undo_operations_hub_order_stock_v1',['bad',randomUUID()]),/invalid session/);
 await assert.rejects(rpc('list_operations_hub_stock_history_v1',['bad']),/invalid session/);
 await db.exec('set role anon');await assert.rejects(db.query('select * from operations_private.inventory_movements'),/permission denied/);
 assert.equal((await list()).length,3);await db.exec('reset role');
});
await test('same SKU summed once; insufficient SKU excluded; stock and ledger undo together',async()=>{
 const result=await save(await list());assert.equal(await stock('A'),5);assert.equal(await stock('B'),5);
 assert.deepEqual(result.items.map(r=>r.status),['saved','excluded']);
 assert.equal((await db.query('select count(*) n from operations_private.inventory_movements')).rows[0].n,2);
 assert.equal((await undo(result.action_id)).status,'undone');assert.equal(await stock('A'),10);
 assert.equal((await db.query('select count(*) n from operations_private.inventory_movements')).rows[0].n,0);
});
await test('same request replay, new request duplicate, and mismatched ID cannot double deduct',async()=>{
 const rows=(await list()).slice(0,1),id=randomUUID();await save(rows,'deduct',id);
 assert.equal((await save(rows,'deduct',id)).replayed,true);assert.equal(await stock('A'),7);
 assert.equal((await save((await list()).slice(0,1))).items[0].status,'skipped');assert.equal(await stock('A'),7);
 await assert.rejects(save(rows,'included',id),/다른 요청/);
 await undo(id);assert.equal((await save(rows,'deduct',id)).status,'undone');assert.equal(await stock('A'),10);
});
await test('already in source records only; later quantity difference is deducted; undo restores ledger',async()=>{
 const first=await save((await list()).slice(0,1),'included');assert.equal(await stock('A'),10);
 await db.query("update source_orders set row=$1 where row->>'id'='1'",[JSON.stringify(row('1','A',5))]);
 const result=await save((await list()).slice(0,1));assert.equal(await stock('A'),8);
 await undo(result.action_id);assert.equal(await stock('A'),10);
 assert.equal((await db.query('select applied from operations_private.inventory_movements')).rows[0].applied,-3);
});
await test('stale stock or changed source is excluded without mutation',async()=>{
 const rows=(await list()).slice(0,1);
 await db.query("update source_orders set row=$1 where row->>'id'='1'",[JSON.stringify(row('1','A',7))]);
 assert.equal((await save(rows)).items[0].status,'excluded');assert.equal(await stock('A'),10);
 const fresh=(await list()).slice(0,1);await db.exec("update public.operations_hub_sku_operational_master set stock_quantity=11,stock_version=stock_version+1 where sellpia_sku_code='A'");
 assert.equal((await save(fresh)).items[0].status,'excluded');assert.equal(await stock('A'),11);
});
await test('disappeared order is not automatically treated as cancellation',async()=>{
 const rows=(await list()).slice(0,1);await db.exec("delete from public.source_orders where row->>'id'='1'");
 assert.equal((await save(rows)).items[0].status,'excluded');assert.equal(await stock('A'),10);
});
await test('SKU change and unrecognized/cancellation statuses cannot mutate stock',async()=>{
 await save((await list()).slice(0,1));
 await db.query("update source_orders set row=$1 where row->>'id'='1'",[JSON.stringify({...row('1','B',3),source_status:'취소'})]);
 assert.ok((await list())[0].reason);assert.equal((await save((await list()).slice(0,1))).items[0].status,'excluded');
 assert.equal(await stock('A'),7);assert.equal(await stock('B'),5);
});
await test('undo blocks later stock edits and other operators',async()=>{
 const result=await save((await list()).slice(0,1));
 await assert.rejects(rpc('undo_operations_hub_order_stock_v1',['test-only-other-user',result.action_id]),/본인/);
 await db.exec("update public.operations_hub_sku_operational_master set stock_version=stock_version+1 where sellpia_sku_code='A'");
 assert.equal((await undo(result.action_id)).status,'conflict');assert.equal(await stock('A'),7);
});
await test('persisted history survives session changes and has no credential',async()=>{
 await save((await list()).slice(0,1));
 const history=await rpc('list_operations_hub_stock_history_v1',['test-only-new-session']);
 assert.equal(history.length,1);assert.equal(JSON.stringify(history).includes(session),false);
 assert.deepEqual(await rpc('list_operations_hub_stock_history_v1',['test-only-other-user']),[]);
});
await test('malformed and duplicate input rejected',async()=>{
 const rows=await list();await assert.rejects(save([rows[0],rows[0]]),/중복/);
 await assert.rejects(save([]),/선택/);await assert.rejects(save(null),/선택/);
});
await import('../../mockups/operations-hub/order-stock.js');
const model=globalThis.OperationsOrderStockModel;
assert.equal(model.plan([{...row('x','A',3),before:10,applied:0,ledger_revision:'0',reason:''}]).cells[0].after,7);
assert.equal(model.plan([{...row('x','A',3),before:10,applied:0,ledger_revision:'0',reason:''}],'included').cells[0].after,10);
console.log(`PASS: ${count} PostgreSQL scenarios and browser preview arithmetic`);
await db.close();

