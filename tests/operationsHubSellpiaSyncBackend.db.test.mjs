import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {backendFixtureSQL,backendMatrixFixtureSQL} from './helpers/sellpia-sync-backend-fixture.mjs';
import fs from 'node:fs/promises';
import {QueueProtocol,sha256} from '../supabase/functions/operations-hub-sellpia-sync/protocol.mjs';
import {RpcQueueStore} from '../supabase/functions/operations-hub-sellpia-sync/rpc-store.mjs';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const session='isolated-operator',actor={kind:'browser',username:'isolated'},worker={kind:'worker',workerId:'qa-pc'},base='10000000-0000-4000-8000-000000000001';
async function setup(t){
  const db=new PGlite({extensions:{pgcrypto}});t.after(()=>db.close());await db.exec(await backendFixtureSQL());
  await db.exec(`insert into public.sellpia_stock_snapshots(snapshot_id,upload_status,valid_row_count,created_at,completed_at) values('${base}','ready',3,'2026-10-01','2026-10-01');insert into public.sellpia_stock_snapshot_rows(snapshot_id,sellpia_sku_code) select '${base}',g||'-1' from generate_series(1,3)g;`);
  const client={rpc:async(_name,{p_action,p_payload})=>{try{await db.exec('set role service_role');const data=(await db.query('select public.hub_sellpia_sync_queue_v1($1,$2::jsonb) result',[p_action,JSON.stringify(p_payload)])).rows[0].result;return {data,error:null};}catch(error){return {data:null,error};}finally{await db.exec('reset role');}}};
  const q=new QueueProtocol(new RpcQueueStore(client));
  const sql=async(statement,params=[])=> (await db.query(statement,params)).rows;
  const runtime=async(action,body={},enabled=false)=> (await sql('select public.hub_sellpia_sync_runtime_v1($1,$2::jsonb,$3,$4) result',[action,JSON.stringify(body),session,enabled]))[0].result;
  return {db,q,sql,runtime};
}
async function preview(x,extra={}){
  const {job}=await x.q.dispatch('enqueue',{requestId:id(5),mode:'full',baselineSnapshotId:base,...extra},actor);
  const claim=await x.q.dispatch('claim',{},worker),scope={jobId:job.jobId,leaseToken:claim.leaseToken};
  const files=await Promise.all([1,2,3].map(async n=>({ordinal:n,name:`part-${n}.csv`,size:5,sha256:await sha256('bytes')})));
  const {manifest}=await x.q.dispatch('upload-init',{...scope,collectionManifest:{source:'sellpia',collectionMode:'official_download',mode:'full',includeAll:true,filters:[],expectedRowCount:3,files}},worker);
  await x.q.dispatch('upload-finalize',{...scope,verifiedArtifacts:manifest.map(f=>({...f,verified:true}))},worker);
  await x.q.dispatch('receipt',{jobId:job.jobId,receipt:{valid:true,rowCount:3,sourceFingerprint:'b'.repeat(64),baselineSnapshotId:base,summary:{mode:extra.applicationMode||'full',rowCount:3,reviewRequired:false,comparison:{baselineRowCount:3,newRowCount:3,addedCount:0,removedCount:0,unknownCount:0,fieldCounts:{inventory:1}}}}},actor);
  return {job,scope,files:files.map(f=>({name:f.name,size:f.size,sha256:f.sha256,mime_type:'text/csv'}))};
}
async function begin(x,p){
  const token='scoped-test-token';await x.db.exec('update operations_private.sellpia_sync_config set apply_enabled=true');
  const authorization=await x.runtime('apply-init',{jobId:p.job.jobId,sourceFingerprint:'b'.repeat(64),tokenHash:await sha256(token)},true);
  const rows=await x.sql('select public.hub_sellpia_sync_upload_begin_v1($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,3) result',[session,p.job.jobId,token,p.job.requestId,authorization.applicationMode,JSON.stringify(p.files),JSON.stringify(authorization.selectedFields)]);
  return {...rows[0].result,token};
}
test('migration runs in isolated PostgreSQL with private ACL and restrictive staging Storage',async t=>{
  const x=await setup(t);await x.db.exec('set role anon');
  await assert.rejects(x.sql('select * from operations_private.sellpia_sync_jobs'));
  await assert.rejects(x.sql("select public.hub_sellpia_sync_runtime_v1('history','{}','isolated-operator',true)"));
  await assert.rejects(x.sql("insert into storage.objects(bucket_id,name) values('seller-originals','sellpia-sync/forbidden')"));
  assert.equal((await x.sql("insert into storage.objects(bucket_id,name) values('seller-originals','legacy/allowed') returning name"))[0].name,'legacy/allowed');
});
test('default-off apply and service-only bridge cannot be bypassed by request flags',async t=>{
  const x=await setup(t),p=await preview(x);await assert.rejects(x.runtime('apply-init',{jobId:p.job.jobId,sourceFingerprint:'b'.repeat(64),tokenHash:'a'.repeat(64)},true),/APPLY_DISABLED/);
  assert.equal((await x.runtime('availability')).applyEnabled,false);
  assert.deepEqual((await x.runtime('availability')).applicationPolicy,{maxAddedCount:100,maxAddedRatio:0.05,maxRemovedCount:0,approvedSourceFingerprint:null});
  await x.db.exec('update operations_private.sellpia_sync_config set apply_enabled=true');
  await assert.rejects(x.runtime('apply-init',{jobId:p.job.jobId,sourceFingerprint:'b'.repeat(64),tokenHash:'a'.repeat(64)},false),/APPLY_DISABLED/);
});
test('reviewed source fingerprint is explicit policy evidence and never grants apply authority',async t=>{
  const x=await setup(t),p=await preview(x),fingerprint='b'.repeat(64);
  await x.sql('update operations_private.sellpia_sync_config set approved_source_fingerprint=$1',[fingerprint]);
  const available=await x.runtime('availability');assert.equal(available.applicationPolicy.approvedSourceFingerprint,fingerprint);assert.equal(available.applyEnabled,false);
  await assert.rejects(x.runtime('apply-init',{jobId:p.job.jobId,sourceFingerprint:fingerprint,tokenHash:'a'.repeat(64)},true),/APPLY_DISABLED/);
  await x.db.exec('update operations_private.sellpia_sync_config set apply_enabled=true');
  await assert.rejects(x.runtime('apply-init',{jobId:p.job.jobId,sourceFingerprint:'c'.repeat(64),tokenHash:'a'.repeat(64)},true),/fingerprint mismatch/);
  await x.sql("update operations_private.sellpia_sync_jobs set body=jsonb_set(body,'{receipt,summary,comparison,addedCount}','3515') where job_id=$1",[p.job.jobId]);
  assert.equal((await x.runtime('apply-init',{jobId:p.job.jobId,sourceFingerprint:fingerprint,tokenHash:'a'.repeat(64)},true)).job.state,'applying');
});
test('full collection supports selected-field application and frozen manifest scope',async t=>{
  const x=await setup(t),p=await preview(x,{applicationMode:'patch',selectedFields:{inventory:true}}),r=await begin(x,p);
  assert.equal(r.upload_mode,'patch');
  const stored=(await x.sql('select selected_fields from operations_private.operations_hub_original_upload_intents where intent_id=$1',[r.intent_id]))[0].selected_fields;
  assert.equal(stored.inventory,true);assert.equal(stored.price,false);assert.equal(stored.basic,false);
  await assert.rejects(x.sql('select public.hub_sellpia_sync_upload_begin_v1($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,3)',[session,p.job.jobId,'wrong',p.job.requestId,'patch',JSON.stringify(p.files),JSON.stringify(stored)]),/authorization/);
});
test('baseline drift before begin and before completion blocks promotion, including legacy v1 entry',async t=>{
  const x=await setup(t),p=await preview(x),r=await begin(x,p);
  await x.db.exec(`update operations_private.operations_hub_original_upload_intents set status='parsing' where intent_id='${r.intent_id}';insert into public.sellpia_stock_snapshot_rows(snapshot_id,sellpia_sku_code,stock) select '${r.snapshot_id}',g||'-1',1 from generate_series(1,3)g;insert into public.sellpia_stock_snapshots(snapshot_id,upload_status,created_at,completed_at) values('${id(99)}','ready',clock_timestamp(),clock_timestamp());`);
  for(const version of [1,2])await assert.rejects(x.sql(`select public.hub_sellpia_upload_complete_v${version}($1,$2)`,[session,r.intent_id]),/baseline snapshot changed/);
  assert.equal((await x.sql('select upload_status from public.sellpia_stock_snapshots where snapshot_id=$1',[r.snapshot_id]))[0].upload_status,'uploading');
});
test('completion atomically marks DB ready; response loss and Matrix failure recover without reimport',async t=>{
  const x=await setup(t),p=await preview(x),r=await begin(x,p);
  await x.db.exec(`update operations_private.operations_hub_original_upload_intents set status='parsing' where intent_id='${r.intent_id}';insert into public.sellpia_stock_snapshot_rows(snapshot_id,sellpia_sku_code,stock,raw_payload) select '${r.snapshot_id}',g||'-1',1,'{"base_price":120,"sale_status":"판매중"}' from generate_series(1,3)g;`);
  const completed=(await x.sql('select public.hub_sellpia_upload_complete_v2($1,$2) result',[session,r.intent_id]))[0].result;assert.equal(completed.status,'ready');
  await x.db.exec('update operations_private.sellpia_sync_config set apply_enabled=false');
  assert.equal((await x.runtime('status',{jobId:p.job.jobId})).job.state,'db_ready');
  assert.equal((await x.runtime('apply-progress',{jobId:p.job.jobId,snapshotId:r.snapshot_id,state:'matrix_failed'})).job.state,'matrix_failed');
  await assert.rejects(x.runtime('apply-progress',{jobId:p.job.jobId,snapshotId:r.snapshot_id,state:'complete'}),/Matrix is not ready/);
  await x.sql('update operations_private.test_matrix_state set snapshot_id=$1',[r.snapshot_id]);
  const recovery=(await x.runtime('status',{jobId:p.job.jobId})).job;assert.equal(recovery.state,'complete');assert.equal(recovery.importIntentId,r.intent_id);
  const replay=await x.q.dispatch('upload-finalize',p.scope,worker);assert.equal(replay.job.state,'collected');assert.equal(replay.deduplicated,true);assert.equal('importIntentId' in replay.job,false);
  assert.equal((await x.runtime('status',{jobId:p.job.jobId})).job.state,'complete','collector replay must not rewind import state');
  assert.equal((await x.runtime('history')).jobs.length,1);
  assert.equal((await x.sql('select count(*)::integer n from public.sellpia_stock_snapshots')).at(0).n,2);
});
test('large SKU additions, unknown comparison and row-drop receipt require explicit reviewed fingerprint',async t=>{
  const x=await setup(t),p=await preview(x);await x.db.exec('update operations_private.sellpia_sync_config set apply_enabled=true');
  await x.sql("update operations_private.sellpia_sync_jobs set body=jsonb_set(body,'{receipt,summary,comparison,addedCount}','3462') where job_id=$1",[p.job.jobId]);
  await assert.rejects(x.runtime('apply-init',{jobId:p.job.jobId,sourceFingerprint:'b'.repeat(64),tokenHash:'a'.repeat(64)},true),/REVIEW_REQUIRED/);
  assert.equal((await x.sql('select count(*)::integer n from operations_private.sellpia_sync_apply_scopes'))[0].n,0);
});
test('worker availability and operator history expose no scope tokens, paths or credentials',async t=>{
  const x=await setup(t),p=await preview(x);await x.runtime('hello',{workerId:'qa-pc',status:'connected',version:'2026.10.13'});
  const available=await x.runtime('availability');assert.equal(available.runner.online,true);assert.equal(available.runner.status,'connected');
  const job=(await x.runtime('history')).jobs[0];for(const key of ['tokenHash','leaseHash','manifest','verifiedArtifacts','operatorUsername'])assert.equal(key in job,false);
  await x.db.exec("update operations_private.sellpia_sync_workers set last_seen_at=clock_timestamp()-interval '100 seconds'");assert.equal((await x.runtime('availability')).runner.status,'offline');
  await x.sql("update operations_private.sellpia_sync_jobs set body=jsonb_set(body,'{operatorUsername}','\"other\"') where job_id=$1",[p.job.jobId]);
  await assert.rejects(x.runtime('status',{jobId:p.job.jobId}),/owner/);assert.equal((await x.runtime('history')).jobs.length,0);
});
test('actual shipped Matrix projection and materialized refresh reconcile snapshot completion',async t=>{
  const x=await setup(t);await x.db.exec(await backendMatrixFixtureSQL());
  const p=await preview(x),r=await begin(x,p);
  await x.db.exec(`insert into review.final_excel_mapping_import(import_id,source_channel,sellpia_sku,channel_code,channel_product_name,match_tier,match_score,imported_at) values('${id(80)}','ably','1-1','123-456','preserved mapping','MANUAL_LINKED',100,clock_timestamp());
    insert into public.sellpia_stock_snapshot_rows(snapshot_id,sellpia_sku_code,sellpia_product_name,stock) select '${r.snapshot_id}',g||'-1','actual source',5 from generate_series(1,3)g;
    update operations_private.operations_hub_original_upload_intents set status='parsing' where intent_id='${r.intent_id}';`);
  await x.sql('select public.hub_sellpia_upload_complete_v2($1,$2)',[session,r.intent_id]);
  assert.equal((await x.runtime('status',{jobId:p.job.jobId})).job.state,'db_ready');
  const result=(await x.sql("select operations_private.refresh_operations_hub_matrix_core('isolated-sync-qa') result"))[0].result;
  assert.equal(result.status,'completed');assert.equal(result.core_row_count,3);assert.equal(result.sellpia_snapshot_id,r.snapshot_id);
  assert.equal((await x.runtime('status',{jobId:p.job.jobId})).job.state,'complete');
  const row=(await x.sql("select ably_product_code,ably_option_code from operations_private.operations_hub_matrix_core where sellpia_sku_code='1-1'"))[0];assert.equal(row.ably_product_code,'123');assert.equal(row.ably_option_code,'456');
});
test('selected inventory patch preserves actual price/status/basic fields and separate manual master',async t=>{
  const x=await setup(t);await x.db.exec(`update public.sellpia_stock_snapshot_rows set stock=3,available_stock=2,purchase_price=50,sellpia_product_name='original product',raw_payload='{"base_price":120,"sell_price":110,"sale_status":"판매중","purchase_vat":true}' where snapshot_id='${base}';
    insert into public.operations_hub_sku_operational_master values('1-1',7,51,121,'{"manual":true}');`);
  const p=await preview(x,{applicationMode:'patch',selectedFields:{inventory:true}}),r=await begin(x,p);
  await x.db.exec(`update operations_private.operations_hub_original_upload_intents set status='uploaded' where intent_id='${r.intent_id}';`);
  const rows=[1,2,3].map(g=>({sellpia_sku_code:`${g}-1`,stock:8,available_stock:6,purchase_price:999,sellpia_product_name:'undesired',raw_payload:{base_price:0,sell_price:0,sale_status:'단종',purchase_vat:false}}));
  await x.sql('select public.hub_sellpia_upload_rows_v2($1,$2,$3::jsonb)',[session,r.intent_id,JSON.stringify(rows)]);
  await x.sql('select public.hub_sellpia_upload_complete_v2($1,$2)',[session,r.intent_id]);
  const source=(await x.sql('select stock,available_stock,purchase_price,sellpia_product_name,raw_payload from public.sellpia_stock_snapshot_rows where snapshot_id=$1 order by sellpia_sku_code',[r.snapshot_id]));
  for(const row of source){assert.equal(row.stock,8);assert.equal(row.purchase_price,'50');assert.equal(row.sellpia_product_name,'original product');assert.equal(row.raw_payload.base_price,120);assert.equal(row.raw_payload.sale_status,'판매중');}
  const master=(await x.sql("select stock_quantity,base_price,purchase_price,provenance from public.operations_hub_sku_operational_master where sellpia_sku_code='1-1'"))[0];assert.deepEqual(master,{stock_quantity:7,base_price:'121',purchase_price:'51',provenance:{manual:true}});
});
test('rollback restores exact importer delegates while preserving completed snapshots and audit history',async t=>{
  const x=await setup(t),p=await preview(x),r=await begin(x,p);
  const rollback=await fs.readFile(new URL('../supabase/rollback/20261013071210_sellpia_sync_operational_queue.sql',import.meta.url),'utf8');
  await assert.rejects(x.db.exec(rollback),/Resolve active import/);await x.db.exec('rollback');
  await x.db.exec(`update operations_private.sellpia_sync_jobs set state='failed',body=body||'{"state":"failed"}' where job_id='${p.job.jobId}';`);
  await x.db.exec(rollback);
  const body=(await x.sql("select prosrc from pg_proc where oid='public.hub_sellpia_upload_complete_v2(text,uuid)'::regprocedure"))[0].prosrc;
  assert.ok(body.includes('public.hub_sellpia_upload_complete_v1'));assert.equal(body.includes('pre_sync'),false);
  assert.equal((await x.sql('select count(*)::integer n from public.sellpia_stock_snapshots'))[0].n,2);
  assert.equal((await x.sql('select count(*)::integer n from operations_private.sellpia_sync_jobs'))[0].n,1);
  assert.equal((await x.sql('select apply_enabled from operations_private.sellpia_sync_config'))[0].apply_enabled,false);
});
test('expired apply reservation cannot block other jobs and staging cleanup is bounded and acknowledged',async t=>{
  const x=await setup(t),p=await preview(x),r=await begin(x,p);
  await x.db.exec("update operations_private.sellpia_sync_apply_scopes set expires_at=clock_timestamp()-interval '1 second'");
  assert.equal((await x.runtime('status',{jobId:p.job.jobId})).job.state,'failed');
  await x.sql("update operations_private.sellpia_sync_jobs set body=jsonb_set(body,'{updatedAt}',to_jsonb((clock_timestamp()-interval '4 hours')::text)) where job_id=$1",[p.job.jobId]);
  const paths=(await x.sql('select public.hub_sellpia_sync_cleanup_candidates_v1() result'))[0].result;
  assert.equal(paths.length,3);assert.ok(paths.every(x=>x.path.startsWith('sellpia-sync/')));
  await x.sql('select public.hub_sellpia_sync_cleanup_ack_v1($1::text[])',[paths.map(f=>f.path)]);
  assert.deepEqual((await x.sql('select public.hub_sellpia_sync_cleanup_candidates_v1() result'))[0].result,[]);
  assert.equal((await x.sql('select upload_status from public.sellpia_stock_snapshots where snapshot_id=$1',[r.snapshot_id]))[0].upload_status,'uploading');
});
test('completion derives missing SKU guard from actual staged rows rather than a forged zero-delta receipt',async t=>{
  const x=await setup(t),p=await preview(x),r=await begin(x,p);
  await x.db.exec(`update operations_private.operations_hub_original_upload_intents set status='parsing' where intent_id='${r.intent_id}';insert into public.sellpia_stock_snapshot_rows(snapshot_id,sellpia_sku_code,stock) select '${r.snapshot_id}',g||'-9',1 from generate_series(1,3)g;`);
  await assert.rejects(x.sql('select public.hub_sellpia_upload_complete_v2($1,$2)',[session,r.intent_id]),/stored SKU set/);
  assert.equal((await x.sql('select upload_status from public.sellpia_stock_snapshots where snapshot_id=$1',[r.snapshot_id]))[0].upload_status,'uploading');
});
