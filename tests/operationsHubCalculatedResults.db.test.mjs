import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {PGlite} from '../work/rule-registry-db-test/node_modules/@electric-sql/pglite/dist/index.js';
const migration=await readFile(new URL('../supabase/migrations/20260910065602_hub_calculated_results.sql',import.meta.url),'utf8');
test('calculated result persistence executes real bounded SQL without copying rules',async t=>{
 const db=new PGlite();let request=0;
 try{
  await db.exec(`create role anon;create role authenticated;create schema operations_private;
   create function operations_private.require_operations_hub_operator_session(token text) returns jsonb language plpgsql as $$begin if token not in ('operator','second') or token is null then raise exception 'unauthorized';end if;return jsonb_build_object('username',token);end$$;
   create table public.matrix_fixture(sellpia_sku_code text primary key,smartstore_product_code text,smartstore_option_code text,makeshop_product_code text,makeshop_option_code text,ably_product_code text,ably_option_code text);
   insert into public.matrix_fixture select 'SKU'||lpad(g::text,5,'0'),'S'||(g/10),'s'||g,'M'||(g/10),'m'||g,'A'||(g/10),'a'||g from generate_series(1,23760)g;
   insert into public.matrix_fixture values('missing-linked','missing-product','missing-option',null,null,null,null),('unlinked',null,null,null,null,null,null);
   create view public.operations_hub_matrix_managed_live as select * from public.matrix_fixture;
   create view operations_private.operations_hub_matrix_export_cache as select * from public.matrix_fixture;
   create table operations_private.hub_rules(id uuid primary key,config jsonb);insert into operations_private.hub_rules values('00000000-0000-4000-8000-000000000001','{"steps":[{"op":"divide","value":2}]}');
   create table operations_private.hub_rule_assignments(sku text,rule_id uuid);insert into operations_private.hub_rule_assignments select sellpia_sku_code,'00000000-0000-4000-8000-000000000001' from public.matrix_fixture;
   analyze public.matrix_fixture;`);
  await db.exec(migration);
  const rpc=async(fn,args)=>(await db.query(`select public.${fn}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result;
  const nextRequest=()=>`00000000-0000-4000-8000-${String(++request).padStart(12,'0')}`;
  const begin=(id=nextRequest(),token='operator')=>rpc('hub_calculation_begin_v1',[token,'test calculation',id]);
  const write=(generation,rows,token='operator')=>rpc('hub_calculation_results_upsert_v1',[token,generation,JSON.stringify(rows)]);
  const read=(skus,scope=null,fields=null,after=null,limit=1000)=>rpc('hub_calculation_results_read_v1',['operator',skus,scope,fields,after,limit]);
  const row=(sku,value=10000,scope='smartstore',field='platform_final_price')=>({sku,scope,field,value,rule_versions:[{id:'00000000-0000-4000-8000-000000000001',version:3,assignmentVersion:2}]});
  let generation;
  await t.test('operator auth, private tables and idempotent server generations',async()=>{
   await assert.rejects(begin(nextRequest(),'bad'),/unauthorized/);
   await assert.rejects(rpc('hub_calculation_results_read_v1',['bad',['SKU00001'],null,null,null,1000]),/unauthorized/);
   await assert.rejects(rpc('hub_calculation_results_upsert_v1',['bad',1,JSON.stringify([row('SKU00001')])]),/unauthorized/);
   const id=nextRequest(),first=await begin(id);assert.deepEqual(await begin(id),first);generation=first.generation_id;
   await assert.rejects(begin(id,'second'),/다른 운영자/);
   for(const relation of ['hub_calculation_generations','hub_calculated_results']){
    const info=(await db.query("select relrowsecurity rls,has_table_privilege('anon',oid,'SELECT') exposed from pg_class where oid=$1::regclass",['operations_private.'+relation])).rows[0];assert.deepEqual(info,{rls:true,exposed:false});
   }
   assert.equal((await db.query("select has_function_privilege('anon','public.hub_calculation_results_read_v1(text,text[],text,text[],jsonb,integer)','EXECUTE') permitted")).rows[0].permitted,true);
  });
  await t.test('23760 SKU results persist and read in bounded batches with seller identities',async()=>{
   const started=performance.now();let worstWrite=0,worstRead=0,total=0;
   for(let offset=0;offset<23760;offset+=1000){const rows=Array.from({length:Math.min(1000,23760-offset)},(_,i)=>row('SKU'+String(offset+i+1).padStart(5,'0'),10000+offset+i));const tick=performance.now();const saved=await write(generation,rows);worstWrite=Math.max(worstWrite,performance.now()-tick);assert.equal(saved.upserted,rows.length);}
   await db.exec('analyze operations_private.hub_calculated_results');
   for(let offset=0;offset<23760;offset+=1000){const skus=Array.from({length:Math.min(1000,23760-offset)},(_,i)=>'SKU'+String(offset+i+1).padStart(5,'0'));const tick=performance.now();const page=await read(skus,'smartstore',['platform_final_price']);worstRead=Math.max(worstRead,performance.now()-tick);assert.equal(page.rows.length,skus.length);assert.equal(page.total,skus.length);assert.equal(page.next_key,null);assert.deepEqual(page.missing,[]);total+=page.rows.length;assert.ok(page.rows.every(r=>r.seller_product_code&&r.seller_option_code&&!r.mapping_missing));}
   assert.equal(total,23760);console.log(`RESULTS_23760_MS=${Math.round(performance.now()-started)} MAX_WRITE_BATCH_MS=${Math.round(worstWrite)} MAX_READ_BATCH_MS=${Math.round(worstRead)}`);
   const content=(await db.query('select config from operations_private.hub_rules')).rows[0].config;assert.deepEqual(content,{steps:[{op:'divide',value:2}]});
   assert.equal((await db.query('select count(*)::int n from operations_private.hub_rule_assignments')).rows[0].n,23762);
  });
  await t.test('older runs cannot replace newer results and identical retries are no-ops',async()=>{
   const newer=await begin();await write(newer.generation_id,[row('SKU00001',20000)]);
   assert.equal((await write(generation,[row('SKU00001',999)])).upserted,0);
   assert.equal((await write(newer.generation_id,[row('SKU00001',20000)])).upserted,0);
   await assert.rejects(write(newer.generation_id,[row('SKU00001',30000),row('must-not-insert')]),/다른 값/);
   const page=await read(['SKU00001','must-not-insert'],'smartstore',['platform_final_price']);assert.equal(Number(page.rows[0].value),20000);assert.deepEqual(page.missing_skus,['must-not-insert']);
  });
  await t.test('batch atomicity, scope constraints, bounded requests and malformed metadata',async()=>{
   const run=await begin();
   const invalid=[null,{},[],Array.from({length:1001},(_,i)=>row('L'+i)),[row('same'),row('same')],[{...row('x'),config:{steps:[]}}],[{...row('x'),rule_versions:null}],[{...row('x'),rule_versions:[{id:'bad',version:1}]}],[{...row('x'),result_details:{config:{steps:[]}}}],[{...row('x'),result_details:{discount_terms:{}}}],[{...row('x'),result_details:{discount_terms:Array(17).fill({})}}],[{...row('x'),result_details:{discount_terms:[{title:'x'.repeat(17000)}]}}],[row('x',-1)],[row('x',1,'','platform_final_price')],[row('x',1,'smartstore','calculated_base_price')],[{...row('x'),status:'error',value:null,error:null}]];
   for(const rows of invalid)await assert.rejects(write(run.generation_id,rows));
   await assert.rejects(write(run.generation_id,[row('atomic-valid'),row('atomic-invalid',-1)]));
   assert.deepEqual((await read(['atomic-valid'])).rows,[]);
   await assert.rejects(write(run.generation_id,[row('x')],'second'),/계산 작업/);
   await assert.rejects(read(Array(1001).fill('x')));await assert.rejects(read(['x'],null,null,null,1001));
  });
  await t.test('errors replace old numeric output and missing metadata covers linked targets only',async()=>{
   const run=await begin();await write(run.generation_id,[{...row('SKU00002'),status:'error',value:null,error:'missing source price'}]);
   const page=await read(['SKU00002','missing-linked','unlinked'],'smartstore',['platform_final_price']);
   assert.equal(page.rows[0].value,null);assert.equal(page.rows[0].status,'error');assert.equal(page.rows[0].error,'missing source price');
   assert.deepEqual(page.missing.map(m=>m.sellpia_sku_code),['SKU00002','missing-linked']);assert.equal(page.missing[1].seller_product_code,'missing-product');assert.equal(page.missing[1].seller_option_code,'missing-option');
  });
  await t.test('discount output metadata roundtrips and keyset pages include every field exactly once',async()=>{
   const run=await begin(),terms=[{term_key:'basic',unit:'percent',value:10,is_baseline:true,rounding_unit:1}];
   const rows=[row('SKU00003',0,'','calculated_base_price'),row('SKU00003',-300,'smartstore','platform_option_price'),{...row('SKU00003',9000,'smartstore','platform_discount_price'),result_details:{discount_terms:terms}},{...row('SKU00003',8700),result_details:{discount_terms:terms}},row('SKU00003',10000,'smartstore','platform_registration_price'),row('SKU00003',7000,'makeshop'),row('SKU00003',6000,'ably')];
   await write(run.generation_id,rows);let cursor=null;const found=[];
   do{const page=await read(['SKU00003'],null,null,cursor,2);assert.equal(page.total,7);found.push(...page.rows);cursor=page.next_key;}while(cursor);
   assert.equal(new Set(found.map(r=>r.sku+'|'+r.scope+'|'+r.field)).size,7);assert.equal(found.find(r=>r.scope==='').seller_product_code,null);
   assert.deepEqual(found.find(r=>r.scope==='smartstore'&&r.field==='platform_final_price').result_details,{discount_terms:terms});
   assert.deepEqual((await read(['SKU00003'],'smartstore',null)).missing,[]);
   assert.equal(found.find(r=>r.scope==='makeshop').seller_option_code,'m3');assert.equal(found.find(r=>r.scope==='ably').seller_option_code,'a3');
  });
 }finally{await db.close();}
});
