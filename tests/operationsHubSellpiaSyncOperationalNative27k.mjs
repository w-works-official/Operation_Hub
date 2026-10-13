// Explicit opt-in native integration diagnostic. Never part of automatic npm tests.
// Uses only the dedicated loopback DB and unchanged local collector artifacts.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {backendFixtureSQL,backendMatrixFixtureSQL} from './helpers/sellpia-sync-backend-fixture.mjs';
import {createNativeSqlRunner,sqlLiteral as L,sqlJson as J} from './operationsHubSellpiaSyncOperationalNativeSql.mjs';
import {QueueProtocol,sha256} from '../supabase/functions/operations-hub-sellpia-sync/protocol.mjs';
import {RpcQueueStore} from '../supabase/functions/operations-hub-sellpia-sync/rpc-store.mjs';
const require=createRequire(import.meta.url),XLSX=require('./vendor/xlsx-0.18.5.full.min.js');
const contract=require('../mockups/operations-hub/sellpia-sync-contract.js');
const session='isolated-operator',actor={kind:'browser',username:'isolated'},worker={kind:'worker',workerId:'qa-native-pc'};
const base='10000000-0000-4000-8000-000000000001';
const count=27278;
const fields=['sellpia_sku_code','sellpia_product_code','sellpia_product_name','sellpia_option_name','own_sku','stock','available_stock','integrated_available_stock','safety_stock','source_row_no','raw_payload','supplier_code','supplier_name','supplier_group','supplier_address','supplier_market_name','supplier_phone','purchase_product_name','purchase_option_name','purchase_price','order_unit','minimum_order_unit'];
const recordFields='sellpia_sku_code text,sellpia_product_code text,sellpia_product_name text,sellpia_option_name text,own_sku text,stock integer,available_stock integer,integrated_available_stock integer,safety_stock integer,source_row_no integer,raw_payload jsonb,supplier_code text,supplier_name text,supplier_group text,supplier_address text,supplier_market_name text,supplier_phone text,purchase_product_name text,purchase_option_name text,purchase_price numeric,order_unit numeric,minimum_order_unit numeric';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const report={verifiedAt:new Date().toISOString(),status:'running',scope:'Native isolated PostgreSQL source/Matrix integration',productionWrites:0,productionCredentialsRead:0,profileFilesRead:0,checks:[],timings:{},limitations:[
 'Native DB uses actual shipped source/import/Matrix SQL with minimal synthetic dependencies and operator session fixture; it is not a full Production schema clone.',
 'Storage upload acknowledgment here uses SQL metadata plus independently verified local bytes. Actual signed HTTP Storage/RLS runtime is a separate pending QA condition.',
 'Actual source bytes remain unchanged. Patch mutation payloads and prior baseline values are synthetic boundary tests, not marketplace or Production edits.',
 'Synthetic tags/rules/manual-price fixture preservation proves these tables are not written by the import; complete Production trigger stacks are not modeled.'
]};
let stage='startup';
async function main(){
 if(process.argv[2]!=='--run-isolated-native')throw Error('QA_EXPLICIT_OPT_IN_REQUIRED');
 const outputs=path.resolve(process.env.SELLPIA_QA_OUTPUT_DIRECTORY||'');
 if(path.basename(outputs)!=='outputs')throw Error('QA_OUTPUT_SCOPE');
 const resume=process.argv.includes('--resume-after-full');
 let prior;
 if(resume){prior=JSON.parse(await fs.readFile(path.join(outputs,'sellpia-native-operational-27k-qa-20261013.json'),'utf8'));assert.ok(prior.checks.find(c=>c.id==='C02'&&c.pass&&c.allTypedAndRawPayloadRowsEqual===count));report.checks=prior.checks.filter(c=>c.id!=='A01');report.timings=prior.timings;report.bootstrap=prior.bootstrap;report.resumedWithoutReset=true;}
 const run=path.join(process.env.LOCALAPPDATA,'OperationHubSellpiaSync/runs/804883ac-0600-4ea6-89c7-24d69e37995e');
 const journal=JSON.parse(await fs.readFile(path.join(run,'journal.json'),'utf8'));
 assert.equal(journal.state,'collected');assert.equal(journal.expectedRowCount,count);assert.equal(journal.files.length,3);
 const sourceFiles=[];
 for(const [i,file] of journal.files.entries()){
  const expected=path.join(run,`part-${i+1}.csv`);assert.equal(path.resolve(file.localPath),expected);
  const bytes=await fs.readFile(expected);assert.equal(bytes.length,file.size);assert.equal(digest(bytes),file.sha256);
  sourceFiles.push({name:file.name,size:file.size,type:'text/csv',arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)});
 }
 const parsedPlan=await contract.prepare(sourceFiles,{mode:'full',manifest:journal.collectionManifest,baselineSnapshotId:base,baselineRowCount:3,XLSX});
 assert.equal(parsedPlan.valid,true);assert.equal(parsedPlan.rowCount,count);
 const rows=parsedPlan.parsed.rows;
 report.source={runId:journal.jobId,rowCount:count,fileCount:3,bytesVerified:true,sourceCollectedAt:journal.updatedAt};
 report.checks.push({id:'A01',name:'actual raw bytes/hash, complete source and strict parser',pass:true});
 stage='database-identity';const db=await createNativeSqlRunner();report.database=db.identity;
 const sql=async expression=>(await db.json(`select ${expression}`)).data;
 const rpc=async(name,args)=>sql(`public.${name}(${args.join(',')})`);
 const runtime=async(action,body={},enabled=false)=>rpc('hub_sellpia_sync_runtime_v1',[L(action),J(body),L(session),String(enabled)]);
 const check=async(id,name,fn)=>{stage=name;const start=performance.now();const data=await fn();report.checks.push({id,name,pass:true,...data});report.timings[id]=Math.round(performance.now()-start);console.log(JSON.stringify({check:id,pass:true}));};
 if(!resume){stage='bootstrap-empty';const empty=await sql("jsonb_build_object('tableCount',(select count(*) from information_schema.tables where table_schema in ('public','operations_private','storage')))");
 if(empty.tableCount!==0)throw Error('QA_DATABASE_NOT_EMPTY_NO_RESET');
 let fixture=await backendFixtureSQL();fixture=fixture.replace('create role service_role bypassrls;',()=> 'do $$ begin create role service_role bypassrls; exception when duplicate_object then null; end $$;');
 await db.call('begin;'+fixture+'commit;');await db.call('begin;'+await backendMatrixFixtureSQL()+'commit;');
 report.bootstrap={emptyVerified:true,resetExecuted:false,actualMatrixSQL:'20260820150000_sellpia_authoritative_matrix.sql',actualOperationalMigration:'20261013071210_sellpia_sync_operational_queue.sql'};
 stage='synthetic-prior-baseline';
 await db.call(`insert into public.sellpia_stock_snapshots(snapshot_id,upload_status,valid_row_count,created_at,completed_at,metadata) values('${base}','ready',3,'2026-10-01','2026-10-01','{"upload_mode":"full","qa":"synthetic-prior-baseline"}');
 insert into public.sellpia_stock_snapshot_rows(snapshot_id,${fields.join(',')}) select '${base}',${fields.map(f=>'r.'+f).join(',')} from jsonb_to_recordset(${J(rows.slice(0,3))}) r(${recordFields});
 create table operations_private.qa_expected_source as select ${fields.join(',')} from public.sellpia_stock_snapshot_rows with no data;
 create unique index qa_expected_source_sku on operations_private.qa_expected_source(sellpia_sku_code);
 create table operations_private.qa_manual_aux(domain text primary key,payload jsonb);
 insert into operations_private.qa_manual_aux values('tag','{"members":["synthetic-member"]}'),('price_rule','{"rule":17,"manual":true}'),('manual_price','{"decision":1200,"revision":42}');
 insert into public.operations_hub_sku_operational_master values(${L(rows[0].sellpia_sku_code)},7,51,121,'{"owner":"manual","revision":42}');
 insert into review.final_excel_mapping_import values('${randomUUID()}','ably',${L(rows[0].sellpia_sku_code)},'123-456','synthetic mapping','synthetic option','MANUAL_LINKED',100,clock_timestamp());
 insert into review.sheet_manual_mappings values('${randomUUID()}','ably',${L(rows[1].sellpia_sku_code)},'789-987','synthetic manual','synthetic manual option','MANUAL_LINKED',100,clock_timestamp(),clock_timestamp());`);
 for(let i=0;i<rows.length;i+=500)await db.call(`insert into operations_private.qa_expected_source(${fields.join(',')}) select ${fields.map(f=>'r.'+f).join(',')} from jsonb_to_recordset(${J(rows.slice(i,i+500))}) r(${recordFields});`);
 }else{assert.equal(await sql('(select count(*) from operations_private.qa_expected_source)'),count);}
 const manualHash=()=>sql("jsonb_build_object('master',(select md5(jsonb_agg(to_jsonb(r) order by sellpia_sku_code)::text) from public.operations_hub_sku_operational_master r),'mapping',(select md5(jsonb_agg(to_jsonb(r) order by import_id)::text) from review.final_excel_mapping_import r),'manualMapping',(select md5(jsonb_agg(to_jsonb(r) order by manual_mapping_id)::text) from review.sheet_manual_mappings r),'aux',(select md5(jsonb_agg(to_jsonb(r) order by domain)::text) from operations_private.qa_manual_aux r))");
 const beforeManual=await manualHash();
 const client={rpc:async(name,{p_action,p_payload})=>{assert.equal(name,'hub_sellpia_sync_queue_v1');try{const data=(await db.json(`begin;set local role service_role;select public.hub_sellpia_sync_queue_v1(${L(p_action)},${J(p_payload)});commit;`)).data;return {data,error:null};}catch(error){return {data:null,error};}}};
 const queue=new QueueProtocol(new RpcQueueStore(client));
 async function collectedPreview(mode,selected,baseline){
  const {job}=await queue.dispatch('enqueue',{requestId:randomUUID(),mode:'full',applicationMode:mode,selectedFields:selected,baselineSnapshotId:baseline},actor);
  const claim=await queue.dispatch('claim',{},worker),scope={jobId:job.jobId,leaseToken:claim.leaseToken};
  const {manifest}=await queue.dispatch('upload-init',{...scope,collectionManifest:journal.collectionManifest},worker);
  // Exact local bytes have been checked above. No signed HTTP storage is claimed.
  await queue.dispatch('upload-finalize',{...scope,verifiedArtifacts:manifest.map(f=>({...f,verified:true}))},worker);
  const fingerprint=digest(Buffer.from(JSON.stringify(canonical({bytesFingerprint:parsedPlan.sourceFingerprint,mode,selected:job.selectedFields,baseline}))));
  const added=baseline===base?count-3:0;
  await queue.dispatch('receipt',{jobId:job.jobId,receipt:{valid:true,rowCount:count,sourceFingerprint:fingerprint,baselineSnapshotId:baseline,summary:{mode,rowCount:count,reviewRequired:added>100,comparison:{baselineRowCount:baseline===base?3:count,newRowCount:count,addedCount:added,removedCount:0,unknownCount:0,fieldCounts:{inventory:count}}}}},actor);
  return {job,fingerprint};
 }
 const p=resume?null:await collectedPreview('full',undefined,base);
 if(!resume)await check('C01','default-off and mass source delta require explicit local review',async()=>{
  await assert.rejects(runtime('apply-init',{jobId:p.job.jobId,sourceFingerprint:p.fingerprint,tokenHash:'a'.repeat(64)},true),error=>error.safeReason==='APPLY_DISABLED');
  await db.call('update operations_private.sellpia_sync_config set apply_enabled=true');
  await assert.rejects(runtime('apply-init',{jobId:p.job.jobId,sourceFingerprint:p.fingerprint,tokenHash:'a'.repeat(64)},true),error=>error.safeReason==='REVIEW_REQUIRED');
  const scopes=await sql('(select count(*) from operations_private.sellpia_sync_apply_scopes)');assert.equal(scopes,0);
  await db.call(`update operations_private.sellpia_sync_config set approved_source_fingerprint=${L(p.fingerprint)}`);
  return {defaultOffBlocked:true,unreviewedDeltaBlocked:true,localFixtureApprovalOnly:true};
 });
 async function apply(p,payload){
  const token=randomUUID();const authorization=await runtime('apply-init',{jobId:p.job.jobId,sourceFingerprint:p.fingerprint,tokenHash:await sha256(token)},true);
  const begin=await rpc('hub_sellpia_sync_upload_begin_v1',[L(session),L(p.job.jobId)+'::uuid',L(token),L(p.job.requestId)+'::uuid',L(authorization.applicationMode),J(journal.files.map(f=>({name:f.name,size:f.size,sha256:f.sha256,mime_type:'text/csv'}))),J(authorization.selectedFields),String(count)]);
  const storage=begin.manifest.map(f=>({path:f.path,size:f.size,type:f.type||'text/csv',object_id:randomUUID(),etag:'qa-local-byte-oracle'}));
  await rpc('hub_original_upload_intent_uploaded_v1',[L(session),L(begin.intent_id)+'::uuid',J(storage)]);
  let imported=0;
  for(let i=0;i<payload.length;i+=500){const result=await rpc('hub_sellpia_upload_rows_v2',[L(session),L(begin.intent_id)+'::uuid',J(payload.slice(i,i+500))]);imported+=result.inserted_count;}
  assert.equal(imported,count);
  const duplicate=await rpc('hub_sellpia_upload_rows_v2',[L(session),L(begin.intent_id)+'::uuid',J(payload.slice(0,500))]);assert.equal(duplicate.inserted_count,0);
  const start=performance.now();const complete=await rpc('hub_sellpia_upload_complete_v2',[L(session),L(begin.intent_id)+'::uuid']);
  assert.equal(complete.status,'ready');assert.equal(complete.row_count??complete.valid_row_count,count);
  const retried=await rpc('hub_sellpia_upload_complete_v2',[L(session),L(begin.intent_id)+'::uuid']);assert.equal(retried.status,'ready');
  const pending=await runtime('status',{jobId:p.job.jobId});assert.equal(pending.job.state,'db_ready');
  const matrix=await sql("operations_private.refresh_operations_hub_matrix_core('isolated-native-source-qa')");
  assert.equal(matrix.status,'completed');assert.equal(matrix.core_row_count,count);assert.equal(matrix.sellpia_snapshot_id,begin.snapshot_id);
  assert.equal((await runtime('status',{jobId:p.job.jobId})).job.state,'complete');
  assert.deepEqual(await manualHash(),beforeManual);
  return {snapshotId:begin.snapshot_id,intentId:begin.intent_id,imported,duplicateChunkInserted:0,completionRetriedSameIntent:true,completeMs:Math.round(performance.now()-start),matrixRowCount:matrix.core_row_count};
 }
 let full=resume?prior.checks.find(c=>c.id==='C02'):null;
 if(!resume)await check('C02','actual 27,278 full source via staged rows/complete and real Matrix',async()=>{
  full=await apply(p,rows);
  const match=await sql(`jsonb_build_object('rows',(select count(*) from public.sellpia_stock_snapshot_rows where snapshot_id=${L(full.snapshotId)}::uuid),'equal',(select count(*) from public.sellpia_stock_snapshot_rows r join operations_private.qa_expected_source e using(sellpia_sku_code) where r.snapshot_id=${L(full.snapshotId)}::uuid and ${fields.map(f=>`r.${f} is not distinct from e.${f}`).join(' and ')}))`);
  assert.deepEqual(match,{rows:count,equal:count});
  const mapped=await sql("(select count(*) from operations_private.operations_hub_matrix_core where ably_product_code is not null and ably_option_code is not null)");assert.equal(mapped,2);
  return {...full,allTypedAndRawPayloadRowsEqual:count,mappingRowsPreserved:2};
 });
 const inventoryRows=rows.map(r=>({...r,stock:r.stock+1,available_stock:r.available_stock-1,integrated_available_stock:r.integrated_available_stock+2,safety_stock:r.safety_stock+3,purchase_price:999999,sellpia_product_name:'synthetic undesired basic change',raw_payload:{...r.raw_payload,base_price:0,sell_price:0,purchase_price:999999,commission:'synthetic-change',purchase_vat:'synthetic-change',sale_status:'synthetic-change'}}));
 const inv=resume?null:await collectedPreview('patch',{inventory:true},full.snapshotId);let inventory;
 await check('C03','inventory-only patch preserves price commission VAT basic status and manual fixtures',async()=>{
  inventory=resume?await sql("(select jsonb_build_object('snapshotId',body->>'applySnapshotId','intentId',body->>'importIntentId','matrixRowCount',27278,'previouslyExecuted',true) from operations_private.sellpia_sync_jobs where state='complete' and body->>'applicationMode'='patch' and (body->'selectedFields'->>'inventory')::boolean=true order by body->>'createdAt' desc limit 1)"):await apply(inv,inventoryRows);
  assert.ok(inventory?.snapshotId);
  const preserved=await sql(`(select count(*) from public.sellpia_stock_snapshot_rows r join operations_private.qa_expected_source e using(sellpia_sku_code) where r.snapshot_id=${L(inventory.snapshotId)}::uuid and r.stock=e.stock+1 and r.available_stock=e.available_stock-1 and r.integrated_available_stock=coalesce(e.integrated_available_stock,0)+2 and r.safety_stock=coalesce(e.safety_stock,0)+3 and (r.raw_payload-'patch_snapshot_id')=(e.raw_payload-'patch_snapshot_id') and ${fields.filter(f=>!['sellpia_sku_code','stock','available_stock','integrated_available_stock','safety_stock','raw_payload'].includes(f)).map(f=>`r.${f} is not distinct from e.${f}`).join(' and ')})`);
  assert.equal(preserved,count);return {...inventory,preservedRows:preserved};
 });
 const purchaseRows=rows.map(r=>({...r,stock:999999,available_stock:999999,purchase_price:(r.purchase_price||0)+7,sellpia_product_name:'synthetic undesired basic change',raw_payload:{...r.raw_payload,base_price:0,sell_price:0,purchase_price:(r.purchase_price||0)+7,commission:'QA_COMMISSION_CHANGE',purchase_vat:'QA_VAT_CHANGE',sale_status:'synthetic-change'}}));
 const purchase=await collectedPreview('patch',{purchasePrice:true},inventory.snapshotId);
 await check('C04','purchasePrice-only patch updates purchase price commission VAT and preserves sale inventory basic status',async()=>{
  const result=await apply(purchase,purchaseRows);
  const preserved=await sql(`(select count(*) from public.sellpia_stock_snapshot_rows r join operations_private.qa_expected_source e using(sellpia_sku_code) where r.snapshot_id=${L(result.snapshotId)}::uuid and r.purchase_price=coalesce(e.purchase_price,0)+7 and r.raw_payload->>'commission'='QA_COMMISSION_CHANGE' and r.raw_payload->>'purchase_vat'='QA_VAT_CHANGE' and (r.raw_payload->>'purchase_price')::numeric=coalesce(e.purchase_price,0)+7 and r.stock=e.stock+1 and r.available_stock=e.available_stock-1 and r.integrated_available_stock=coalesce(e.integrated_available_stock,0)+2 and r.safety_stock=coalesce(e.safety_stock,0)+3 and (r.raw_payload-'purchase_price'-'commission'-'purchase_vat'-'patch_snapshot_id')=(e.raw_payload-'purchase_price'-'commission'-'purchase_vat'-'patch_snapshot_id') and ${fields.filter(f=>!['sellpia_sku_code','stock','available_stock','integrated_available_stock','safety_stock','purchase_price','raw_payload'].includes(f)).map(f=>`r.${f} is not distinct from e.${f}`).join(' and ')})`);
  assert.equal(preserved,count);return {...result,correctBoundaryRows:preserved};
 });
 await db.call('update operations_private.sellpia_sync_config set apply_enabled=false,approved_source_fingerprint=null');
 report.finalLocalPolicy={applyEnabled:false,approvedSourceFingerprint:null};
 report.status='passed';report.completedAt=new Date().toISOString();
 await fs.writeFile(path.join(outputs,'sellpia-native-operational-27k-qa-20261013.json'),JSON.stringify(report,null,2));
 await fs.writeFile(path.join(outputs,'sellpia-native-operational-27k-qa-20261013.txt'),[
  '격리된 native PostgreSQL 27,278행 운영 동기화 QA',
  '운영 DB 변경 0. 실제 native 원본 3개 bytes/hash를 검증하고 기존 upload rows/complete RPC로 로컬 전용 DB에 반영했다.',
  ...report.checks.map(c=>`${c.id}: PASS — ${c.name}`),
  '전체 원본, 재고만 선택 갱신, 매입가만 선택 갱신 각각 27,278행과 실제 shipped Matrix materialized refresh를 검증했다.',
  '기존 source 필드, 판매가/옵션 데이터가 포함된 raw payload, 별도 운영 master 및 매핑을 대조했다. 수수료와 매입 VAT는 매입가 선택에 포함된다.',
  'Storage HTTP 업로드는 실행하지 않았다. SQL object metadata와 독립 로컬 byte 검증을 사용한 범위를 실제 signed HTTP Storage 검증으로 표현하지 않는다.',
  ...report.limitations,
  '로컬 테스트 DB의 apply flag를 다시 false로 반환했다. 운영 apply 권한과 승인 목록에는 영향을 주지 않는다.'
 ].join('\n')+'\n');
 console.log(JSON.stringify({status:report.status,checks:report.checks.length,rowCount:count,productionWrites:0}));
}
main().catch(async error=>{report.status='failed';report.failedStage=stage;report.safeReason=error.safeReason||(/^QA_[A-Z0-9_]+$/.test(error.message)?error.message:'assertion_or_runtime_failure');report.numericDiagnostic={actual:typeof error.actual==='number'?error.actual:null,expected:typeof error.expected==='number'?error.expected:null};
 const outputs=path.resolve(process.env.SELLPIA_QA_OUTPUT_DIRECTORY||'');if(path.basename(outputs)==='outputs')await fs.writeFile(path.join(outputs,'sellpia-native-operational-27k-qa-20261013.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({status:'failed',stage,reason:report.safeReason,checksPassed:report.checks.length,identity:error.identity}));process.exitCode=1;});
