import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const migration=fs.readFileSync(path.join(repo,'supabase/migrations/20261008150000_ably_inventory_mapping_contract.sql'),'utf8');
const db=new PGlite();test.after(()=>db.close());
await db.exec(`
 create role anon;create role authenticated;create schema operations_private;
 grant usage on schema operations_private to anon,authenticated;
 create function operations_private.require_operations_hub_operator_session(token text) returns jsonb language plpgsql security definer as $$begin
  if token is distinct from 'independent-qa-session' then raise exception using errcode='42501',message='operator session required';end if;
  return jsonb_build_object('username','independent-qa');end$$;
 create table public.operations_hub_link_suppressions(source_channel text,product_code text,option_code text,sellpia_sku_code text);
 create table public.operations_hub_manual_links(source_channel text,product_code text,option_code text,sellpia_sku_code text);
 create table public.operations_hub_matrix_live(sellpia_sku_code text primary key,sellpia_current_stock integer);
 insert into public.operations_hub_matrix_live values('SKU-1',10),('SKU-2',20);
 insert into public.operations_hub_manual_links values('ably','INVERSE','OPTION','SKU-1'),('ably','INVERSE','OPTION','SKU-2');
 insert into public.operations_hub_link_suppressions values('ably','LEGACY-SUPPRESSION','OPTION','SKU-1');
`);
await db.exec(migration);
async function importRows(batch,sha,rows){return (await db.query('select operations_private.import_ably_inventory_mappings_admin_v1($1,$2,$3,$4::jsonb) as result',[batch,'independent.xlsx',sha.repeat(64),JSON.stringify(rows)])).rows[0].result;}
async function load(){return (await db.query("select public.load_ably_inventory_mappings_v1('independent-qa-session') as result")).rows[0].result;}
async function update(product,option,sku,policy='shared',individual=null,active=true){return (await db.query("select public.update_operations_hub_ably_mapping_v1('independent-qa-session',$1,$2,$3,'verified',$4,$5,$6,'independent QA approved option policy') as result",[product,option,sku,policy,individual,active])).rows[0].result;}

test('integrated server import never auto-verifies an inverse ambiguous legacy manual identity',async()=>{
 await importRows('independent-inverse-0001','a',[{product_code:'INVERSE',option_code:'OPTION',solution_code:'sellpia_SKU-1',source_stock:10,safety_stock:0,source_row_no:2}]);
 const row=(await load()).rows.find(row=>row.product_code==='INVERSE');
 assert.ok(['review','conflict'].includes(row.mapping_state),'EXISTS agreement with one candidate is insufficient when the same seller option has two legacy SKU owners');assert.equal(row.is_active,false);assert.equal(row.stock_policy,'review');
});

test('integrated server mapping fingerprint remains stable when stock upload changes Matrix stock, and changes when policy changes',async()=>{
 await importRows('independent-fanout-0002','b',[{product_code:'FANOUT',option_code:'RED',solution_code:'001234',source_stock:10,safety_stock:0,source_row_no:2},{product_code:'FANOUT',option_code:'BLUE',solution_code:'001235',source_stock:10,safety_stock:0,source_row_no:3}]);
 await update('FANOUT','RED','SKU-1');await update('FANOUT','BLUE','SKU-1');
 const before=await load();assert.equal(before.rows.filter(row=>row.product_code==='FANOUT'&&row.is_active).length,2,'verified one SKU to multiple distinct option identities is supported');
 await db.exec("update public.operations_hub_matrix_live set sellpia_current_stock=32 where sellpia_sku_code='SKU-1'");
 const afterStock=await load();assert.equal(afterStock.fingerprint,before.fingerprint,'a successful stock update must not trigger a mapping-drift abort');
 assert.equal(afterStock.rows.find(row=>row.product_code==='FANOUT').current_sellpia_stock,32,'stock freshness remains visible outside the mapping fingerprint');
 await update('FANOUT','BLUE','SKU-1','individual',4);
 assert.notEqual((await load()).fingerprint,afterStock.fingerprint,'changing option stock policy invalidates a prepared export');
});

test('integrated migration and repeated identical import retain history and leave legacy mappings and suppressions intact',async()=>{
 const legacyBefore=(await db.query('select * from public.operations_hub_manual_links order by product_code,sellpia_sku_code')).rows;
 const suppressionBefore=(await db.query('select * from public.operations_hub_link_suppressions')).rows;
 const rows=[{product_code:'REPEAT',option_code:'ONE',solution_code:'LITERAL-J-01',source_stock:3,safety_stock:0,source_row_no:2}];
 await importRows('independent-repeat-0003','c',rows);const historyBefore=(await db.query('select * from operations_private.operations_hub_ably_mapping_history order by event_id')).rows;
 const repeat=await importRows('independent-repeat-newkey','c',rows);assert.equal(repeat.idempotent,true);
 await db.exec(migration);
 assert.deepEqual((await db.query('select * from operations_private.operations_hub_ably_mapping_history order by event_id')).rows,historyBefore);
 assert.deepEqual((await db.query('select * from public.operations_hub_manual_links order by product_code,sellpia_sku_code')).rows,legacyBefore);
 assert.deepEqual((await db.query('select * from public.operations_hub_link_suppressions')).rows,suppressionBefore);
 assert.equal((await db.query("select count(*)::int as count from public.operations_hub_ably_inventory_mappings where product_code='REPEAT'")).rows[0].count,1);
});

test('integrated server refuses unauthenticated reads/writes, suppressed activation and direct public table mutation',async()=>{
 await assert.rejects(db.query("select public.load_ably_inventory_mappings_v1(null)"),error=>error.code==='42501');
 await assert.rejects(db.query("select public.update_operations_hub_ably_mapping_v1('bad','FANOUT','RED','SKU-1','verified','shared',null,true,'unauthorized')"),error=>error.code==='42501');
 const beforeSuppression=(await load()).fingerprint;
 await db.exec("insert into public.operations_hub_link_suppressions values('ably','FANOUT','RED','SKU-1')");
 assert.notEqual((await load()).fingerprint,beforeSuppression,'new suppression invalidates a prepared mapping plan');
 await assert.rejects(update('FANOUT','RED','SKU-1'),error=>error.code==='23514');
 await assert.rejects(update('FANOUT','RED','UNKNOWN-SKU'),error=>error.code==='22023');
 await db.exec('set role anon');
 try{
  await assert.rejects(db.query("update public.operations_hub_ably_inventory_mappings set is_active=true where product_code='FANOUT'"),error=>error.code==='42501');
  await assert.rejects(db.query("select operations_private.import_ably_inventory_mappings_admin_v1('unauthorized-batch','bad.xlsx',repeat('d',64),'[]'::jsonb)"),error=>error.code==='42501');
  await assert.rejects(db.query("select public.load_ably_inventory_mappings_v1('bad')"),error=>error.code==='42501');
 }
 finally{await db.exec('reset role');}
 const secured=(await db.query("select relname,relrowsecurity from pg_class where relname in ('operations_hub_ably_inventory_mappings','operations_hub_ably_mapping_import_batches','operations_hub_ably_mapping_history') order by relname")).rows;
 assert.equal(secured.length,3);assert.ok(secured.every(row=>row.relrowsecurity),'all new exposed and private mapping tables enable RLS');
});

test('integrated active solution-code uniqueness is enforced by the schema so two identity owners cannot race activation',async()=>{
 const indexes=(await db.query("select indexdef from pg_indexes where tablename='operations_hub_ably_inventory_mappings'")).rows;
 assert.ok(indexes.some(row=>/CREATE UNIQUE INDEX.*\(solution_code\).*WHERE.*is_active/i.test(row.indexdef)),'the database must arbitrate concurrent active code ownership beyond an application-level EXISTS check');
 await importRows('independent-duplicate-0004','d',[{product_code:'DUPLICATE-A',option_code:'ONE',solution_code:'SHARED-J-CODE',source_stock:32,safety_stock:0,source_row_no:2},{product_code:'DUPLICATE-B',option_code:'TWO',solution_code:'SHARED-J-CODE',source_stock:32,safety_stock:0,source_row_no:3}]);
 await update('DUPLICATE-A','ONE','SKU-1');
 await assert.rejects(update('DUPLICATE-B','TWO','SKU-1'),error=>['23505','23514'].includes(error.code));
 await assert.rejects(db.query("update public.operations_hub_ably_inventory_mappings set sellpia_sku_code='SKU-1',mapping_state='verified',stock_policy='shared',is_active=true where product_code='DUPLICATE-B'"),error=>error.code==='23505','schema protection remains effective even if another privileged writer bypasses the RPC');
 const active=(await db.query("select count(*)::integer as count from public.operations_hub_ably_inventory_mappings where solution_code='SHARED-J-CODE' and is_active")).rows[0].count;assert.equal(active,1);
});
