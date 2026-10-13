import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const psql=process.env.SELLPIA_TEST_PSQL || path.join(process.env.LOCALAPPDATA || '', 'Codex/sellpia-timeout-pg17/pgsql/bin/psql.exe');
const port=process.env.SELLPIA_TEST_PORT || '55473';
const database='sellpia_timeout_test';
const outputPath=path.join(root,'outputs/sellpia-inventory-count-timeout-results.json');
const migration=fs.readFileSync(path.join(root,'supabase/migrations/20261013045421_sellpia_inventory_count_fixed_key_copy.sql'),'utf8');
const rollback=fs.readFileSync(path.join(root,'supabase/rollback/20261013045421_sellpia_inventory_count_fixed_key_copy.sql'),'utf8');
const fixture=fs.readFileSync(path.join(root,'tests/fixtures/sellpiaInventoryCountTimeout.sql'),'utf8');
const base='10000000-0000-4000-8000-000000000001';
let sequence=0;
function id(){return `20000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`;}
function literal(s){return `'${String(s).replaceAll("'","''")}'`;}
function liveDefinitions(){
  return JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/sellpiaInventoryCountBaselineFunctions.json'),'utf8'));
}
function run(sql,{timeout=125000,app='sellpia_timeout_test'}={}){
  return new Promise((resolve,reject)=>{
    const start=performance.now();
    const child=spawn(psql,['-X','-qAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-U','postgres','-d',database],
      {cwd:root,windowsHide:true,env:{...process.env,PGAPPNAME:app,PGCLIENTENCODING:'UTF8'}});
    let stdout='',stderr=''; let ended=false;
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',v=>{stdout+=v;});child.stderr.on('data',v=>{stderr+=v;});
    const timer=setTimeout(()=>{child.kill();},timeout);
    child.on('error',e=>{ended=true;clearTimeout(timer);reject(e);});
    child.on('close',(code,signal)=>{
      if(ended)return;clearTimeout(timer);
      const result={stdout:stdout.trim(),stderr:stderr.trim(),code,signal,wallMs:performance.now()-start};
      if(code===0)resolve(result);else {const error=new Error(stderr || `psql exit ${code}/${signal}`);Object.assign(error,result);reject(error);}
    });
    child.stdin.end(`set work_mem='3500kB';\n${sql}\n`);
  });
}
async function json(sql,options){const r=await run(sql,options);return JSON.parse(r.stdout);}
async function cleanup(snapshot){await run(`delete from operations_private.operations_hub_original_upload_intents where snapshot_id=${literal(snapshot)};delete from public.sellpia_stock_snapshots where snapshot_id=${literal(snapshot)};`);}
async function stage(count,snapshot=id(),baseId=base){await run(`select operations_private.stage_inventory_timeout(${literal(snapshot)},${count},${literal(baseId)});`);return snapshot;}
const call=snapshot=>`public.hub_sellpia_upload_complete_v2('isolated-operator',${literal(snapshot)})`;
const state=snapshot=>`select jsonb_build_object('snapshot_status',s.upload_status,'intent_status',i.status,'rows',(select count(*) from public.sellpia_stock_snapshot_rows where snapshot_id=s.snapshot_id),'ready_snapshot',(select snapshot_id from public.sellpia_stock_snapshots where upload_status='ready' order by created_at desc limit 1)) from public.sellpia_stock_snapshots s join operations_private.operations_hub_original_upload_intents i using(snapshot_id) where s.snapshot_id=${literal(snapshot)};`;
async function completeness(snapshot,count,total){
  const r=await json(`set enable_nestloop=off;select jsonb_build_object(
    'row_count',count(*),
    'missing',(select count(*) from public.sellpia_stock_snapshot_rows b where b.snapshot_id=${literal(base)} and not exists(select 1 from public.sellpia_stock_snapshot_rows n where n.snapshot_id=${literal(snapshot)} and n.sellpia_sku_code=b.sellpia_sku_code)),
    'preserved_information_mismatches',count(*) filter(where (to_jsonb(n)-'snapshot_id'-'stock'-'available_stock'-'source_row_no'-'raw_payload'-'created_at') is distinct from (to_jsonb(b)-'snapshot_id'-'stock'-'available_stock'-'source_row_no'-'raw_payload'-'created_at')),
    'changed_count',count(*) filter(where n.stock is distinct from b.stock or n.available_stock is distinct from b.available_stock),
    'raw_price_mismatches',count(*) filter(where n.raw_payload->'base_price' is distinct from b.raw_payload->'base_price' or n.raw_payload->'sell_price' is distinct from b.raw_payload->'sell_price' or n.raw_payload->'purchase_price' is distinct from b.raw_payload->'purchase_price' or n.raw_payload->'commission' is distinct from b.raw_payload->'commission' or n.raw_payload->'purchase_vat' is distinct from b.raw_payload->'purchase_vat'),
    'unchanged_raw_mismatches',count(*) filter(where n.stock is not distinct from b.stock and n.available_stock is not distinct from b.available_stock and n.raw_payload is distinct from coalesce(b.raw_payload,'{}'::jsonb)||jsonb_build_object('preserved_from_snapshot_id',${literal(base)}::uuid)),
    'changed_provenance_mismatches',count(*) filter(where (n.stock is distinct from b.stock or n.available_stock is distinct from b.available_stock) and (n.raw_payload->>'inventory_count_snapshot_id' is distinct from ${literal(snapshot)} or n.raw_payload->>'inventory_count_base_snapshot_id' is distinct from ${literal(base)})),
    'master_mismatches',(select count(*) from public.operations_hub_sku_operational_master m join public.sellpia_stock_snapshot_rows b on b.snapshot_id=${literal(base)} and b.sellpia_sku_code=m.sellpia_sku_code where m.stock_quantity is distinct from b.stock or m.purchase_price is distinct from b.purchase_price or m.base_price is distinct from (b.raw_payload->>'base_price')::numeric or m.provenance is distinct from '{"owner":"existing-master","generation":42}'::jsonb),
    'negative_available_rows',count(*) filter(where n.available_stock<0)
  ) from public.sellpia_stock_snapshot_rows n join public.sellpia_stock_snapshot_rows b on b.snapshot_id=${literal(base)} and b.sellpia_sku_code=n.sellpia_sku_code where n.snapshot_id=${literal(snapshot)};`);
  assert.equal(Number(r.row_count),total);assert.equal(Number(r.changed_count),count);
  for(const key of ['missing','preserved_information_mismatches','raw_price_mismatches','unchanged_raw_mismatches','changed_provenance_mismatches','master_mismatches'])assert.equal(Number(r[key]),0,key);
  assert.ok(r.negative_available_rows>0);
  return r;
}
async function measuredComplete(snapshot){
  const r=await run(`begin;set local statement_timeout='90s';create temp table measure as select clock_timestamp() started,pg_current_wal_insert_lsn() wal_start;
    select ${call(snapshot)};
    select jsonb_build_object('execution_ms',extract(epoch from(clock_timestamp()-started))*1000,'wal_bytes',pg_wal_lsn_diff(pg_current_wal_insert_lsn(),wal_start)) from measure;commit;`);
  const lines=r.stdout.split(/\r?\n/).filter(Boolean);
  return {...JSON.parse(lines.at(-1)),result:JSON.parse(lines.at(-2)),client_transaction_wall_ms:r.wallMs};
}
function copySQL(version,snapshot){
  const source=version==='before'?rollback:migration;
  const start=source.indexOf(version==='before'?'insert into public.sellpia_stock_snapshot_rows(snapshot_id':'with uploaded_skus as materialized');
  const end=source.indexOf('get diagnostics v_preserved=row_count;',start);
  assert.ok(start>=0&&end>start);
  return source.slice(start,end).replaceAll('p_snapshot_id',`${literal(snapshot)}::uuid`).replaceAll('v_base',`${literal(base)}::uuid`).trim();
}
async function explainCopy(version,snapshot,analyze=false){
  const r=await run(`begin;set local statement_timeout='90s';explain (${analyze?'analyze,buffers,wal,':''}format json) ${copySQL(version,snapshot)}rollback;`);
  return {plan:JSON.parse(r.stdout)[0],client_wall_ms:r.wallMs};
}
const results={generated_at:new Date().toISOString(),environment:{host:'127.0.0.1',port,database,production_writes:0,authentication:'isolated stub',operational_master:'fixture table, no production materializer',matrix_rebuild:'application regression separate'},performance:[],regression:[]};
async function save(){fs.mkdirSync(path.dirname(outputPath),{recursive:true});fs.writeFileSync(outputPath,JSON.stringify(results,null,2)+'\n');}
async function check(name,fn){try{const evidence=await fn();results.regression.push({name,status:'PASS',evidence});console.log(`PASS ${name}`);}catch(e){results.regression.push({name,status:'FAIL',error:e.message});await save();throw e;}await save();}

if(process.argv.includes('--verify-final-migration')){
  const validation={production_writes:0};
  try {
    validation.environment=await json("select jsonb_build_object('version',version(),'server_addr',inet_server_addr(),'database',current_database());");
    assert.equal(validation.environment.server_addr,'127.0.0.1');assert.equal(validation.environment.database,database);
    const baselineDDL=(rollback.match(/CREATE OR REPLACE FUNCTION[\s\S]*?\$function\$;/gi)||[]).join('\n');
    await run(baselineDDL);await run(rollback);await run(migration);await run(migration);
    validation.apply_and_reapply='PASS';
    await run(`create or replace function public.finalize_operations_hub_sellpia_inventory_count(p_snapshot_id uuid,p_selected_fields jsonb) returns jsonb language plpgsql set search_path=public,pg_temp as $$ begin return '{"parallel_change":true}';end $$;`);
    await assert.rejects(run(migration),/drift/i);await assert.rejects(run(rollback),/drift/i);validation.parallel_function_drift='PASS';
    await run(baselineDDL);await run(migration);await run(rollback);await run(migration);validation.rollback_and_reapply='PASS';
    const snapshot=await stage(76),total=await json(`select count(*)::integer from public.sellpia_stock_snapshot_rows where snapshot_id=${literal(base)};`);
    validation.complete=await measuredComplete(snapshot);validation.completeness=await completeness(snapshot,76,total);await cleanup(snapshot);
    // Genuine connection loss while the completion query is in progress must roll back.
    const interrupted=await stage(76);
    await run(`create function public.test_connection_loss() returns trigger language plpgsql as $$ begin if new.snapshot_id=${literal(interrupted)}::uuid then perform pg_sleep(0.01);end if;return new;end $$;create trigger test_connection_loss before insert on public.sellpia_stock_snapshot_rows for each row execute function public.test_connection_loss();`);
    const pending=run(`select ${call(interrupted)};`,{app:'sellpia_network_loss'}).then(v=>({status:'fulfilled',value:v}),e=>({status:'rejected',error:e.message}));
    let victim;
    for(let n=0;n<40;n++){
      victim=await json("select coalesce(jsonb_agg(pid),'[]') from pg_stat_activity where datname='sellpia_timeout_test' and application_name='sellpia_network_loss' and state='active' and wait_event='PgSleep';");
      if(victim.length)break;if(n===39)throw new Error('connection-loss query did not reach copy');
    }
    await run(`select pg_terminate_backend(${Number(victim[0])});`);const network=await pending;assert.equal(network.status,'rejected');
    const interruptedState=await json(state(interrupted));assert.equal(interruptedState.rows,76);assert.equal(interruptedState.snapshot_status,'uploading');assert.equal(interruptedState.ready_snapshot,base);
    await run('drop trigger test_connection_loss on public.sellpia_stock_snapshot_rows;drop function public.test_connection_loss();');
    validation.connection_loss={status:'PASS',backend_result:network,state:interruptedState};
    const retried=await measuredComplete(interrupted);assert.equal(retried.result.status,'ready');await cleanup(interrupted);
    const boundarySQL=fs.readFileSync(path.join(root,'supabase/migrations/20260920025225_operations_hub_original_upload_boundary_v1.sql'),'utf8');
    const failStart=boundarySQL.indexOf('create or replace function public.hub_original_upload_intent_fail_v1(');
    const failEnd=boundarySQL.indexOf('$$;',failStart)+3;assert.ok(failStart>=0&&failEnd>failStart);
    await run(boundarySQL.slice(failStart,failEnd));
    const failed=await stage(76);
    const failResponse=await json(`select public.hub_original_upload_intent_fail_v1('isolated-operator',${literal(failed)},'canceling statement due to statement timeout',false);`);
    const failedState=await json(state(failed));assert.equal(failedState.snapshot_status,'failed');assert.equal(failedState.intent_status,'failed');assert.equal(failedState.rows,76);assert.equal(failedState.ready_snapshot,base);
    await assert.rejects(run(`select ${call(failed)};`),/완료 가능한/);
    const replacement=await stage(76);const replacementResult=await measuredComplete(replacement);
    await assert.rejects(run(`select public.hub_original_upload_intent_fail_v1('isolated-operator',${literal(replacement)},'response lost',false);`),/ready snapshot/);
    assert.equal((await json(state(replacement))).snapshot_status,'ready');
    validation.actual_fail_endpoint={status:'PASS',response:failResponse,state:failedState,new_intent_retry:replacementResult,ready_downgrade_rejected:true};await cleanup(replacement);await cleanup(failed);
    validation.jsonb_cpu_probe={description:'Read plus JSONB merge and aggregate; not pure isolated CPU or INSERT cost',rows:total,same_expression_before_after:true,samples:[]};
    for(let n=0;n<3;n++){
      const readProbe=await json(`explain (analyze,buffers,format json) select sum(pg_column_size(raw_payload)) from public.sellpia_stock_snapshot_rows where snapshot_id=${literal(base)};`);
      const mergeProbe=await json(`explain (analyze,buffers,format json) select sum(pg_column_size(coalesce(raw_payload,'{}'::jsonb)||jsonb_build_object('preserved_from_snapshot_id',${literal(base)}::uuid))) from public.sellpia_stock_snapshot_rows where snapshot_id=${literal(base)};`);
      validation.jsonb_cpu_probe.samples.push({read_aggregate_ms:readProbe[0]['Execution Time'],read_merge_aggregate_ms:mergeProbe[0]['Execution Time'],read_plan:readProbe[0],merge_plan:mergeProbe[0]});
    }
    validation.function_guards=await json("select jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'body_md5',md5(replace(prosrc,chr(13)||chr(10),chr(10))),'config',proconfig,'security_definer',prosecdef) order by p.oid::regprocedure::text) from pg_proc p where p.oid in('public.finalize_operations_hub_sellpia_inventory_count(uuid,jsonb)'::regprocedure,'public.hub_sellpia_upload_complete_v1(text,uuid)'::regprocedure,'operations_private.hub_sellpia_patch_read_v3(text,uuid,uuid,text[],text,text,integer,integer,boolean)'::regprocedure);");
    validation.status='PASS';
  }catch(e){validation.status='FAIL';validation.error=e.message;process.exitCode=1;}
  const target=path.join(root,'outputs/sellpia-inventory-count-timeout-final-validation.json');fs.writeFileSync(target,JSON.stringify(validation,null,2)+'\n');
  console.log(JSON.stringify({status:validation.status,error:validation.error,complete_ms:validation.complete?.execution_ms,connection_loss:validation.connection_loss?.status,actual_fail_endpoint:validation.actual_fail_endpoint?.status,jsonb_probes:validation.jsonb_cpu_probe?.samples.map(({read_aggregate_ms,read_merge_aggregate_ms})=>({read_aggregate_ms,read_merge_aggregate_ms})),artifact:target},null,2));
  process.exit(process.exitCode||0);
}

try {
  // Destructive operations are strictly confined to this local fixture database/schema.
  const connection=await json("select jsonb_build_object('version',version(),'server_addr',inet_server_addr(),'database',current_database(),'work_mem',current_setting('work_mem')); ");
  assert.equal(connection.server_addr,'127.0.0.1');assert.equal(connection.database,database);results.environment={...results.environment,...connection};
  await run('drop schema public cascade;create schema public;drop schema if exists operations_private cascade;drop schema if exists extensions cascade;'+fixture);
  const defs=liveDefinitions();
  for(const name of ['hub_sellpia_upload_rows_v2(text,uuid,jsonb)','hub_sellpia_upload_complete_v2(text,uuid)','finalize_operations_hub_sellpia_patch(uuid,jsonb)']){
    const d=defs.find(v=>v.signature===name);assert.ok(d,name);await run(d.definition+';');
  }
  // Bootstrap this newly created fixture from exact baseline DDL before invoking
  // the drift guard, whose purpose is to protect already installed functions.
  await run((rollback.match(/CREATE OR REPLACE FUNCTION[\s\S]*?\$function\$;/gi)||[]).join('\n'));
  await run(rollback);
  console.log('Seeding 11 historical snapshots + 23,816-row current base with stale statistics');
  await run('select operations_private.seed_inventory_timeout_fixture(23816,11);',{timeout:125000});
  results.fixture=await json(`select jsonb_build_object('current_rows',count(*),'all_rows',(select count(*) from public.sellpia_stock_snapshot_rows),'average_row_bytes',avg(pg_column_size(r)),'average_raw_physical_bytes',avg(pg_column_size(raw_payload)),'average_raw_text_bytes',avg(octet_length(raw_payload::text)),'max_raw_text_bytes',max(octet_length(raw_payload::text))) from public.sellpia_stock_snapshot_rows r where snapshot_id=${literal(base)};`);
  await save();
  const counts=[1,76,500,2000];
  for(const version of ['before','after']){
    await run(version==='before'?rollback:migration);
    // One representative 76-SKU baseline suffices for the before/after report;
    // all required change counts are exercised on the implemented migration.
    for(const count of version==='before'?[76]:counts){
      const snapshot=await stage(count);console.log(`Measuring ${version} ${count} changes`);
      const item={version,total_skus:23816,changed_skus:count};
      results.performance.push(item);
      item.copy_explain=await explainCopy(version,snapshot,false);
      await save();
      // Real INSERT EXPLAIN ANALYZE is permitted only inside this isolated database, rolled back.
      try {item.copy_analyze=await explainCopy(version,snapshot,true);}catch(e){item.copy_analyze={error:e.message,actual_timeout:/statement timeout/.test(e.message),client_wall_ms:e.wallMs};}
      await save();
      try {item.complete=await measuredComplete(snapshot);}catch(e){item.complete={error:e.message,actual_timeout:/statement timeout/.test(e.message),client_wall_ms:e.wallMs};item.state_after_error=await json(state(snapshot));}
      await save();
      if(!item.complete.error){try {item.completeness=await completeness(snapshot,count,23816);}catch(e){item.verification_error=e.message;await save();throw e;}}
      await save();await cleanup(snapshot);
    }
  }
  await run(migration);
  await check('zero changes rejects empty snapshot without promotion',async()=>{
    const s=await stage(0);await assert.rejects(run(`select ${call(s)};`),/실제 변경 SKU/);const r=await json(state(s));assert.equal(r.snapshot_status,'uploading');assert.equal(r.ready_snapshot,base);await cleanup(s);return r;
  });
  await check('unknown SKU rejected atomically',async()=>{
    const s=await stage(1);await run(`update public.sellpia_stock_snapshot_rows set sellpia_sku_code='UNKNOWN' where snapshot_id=${literal(s)};`);
    await assert.rejects(run(`select ${call(s)};`),/식별되지/);const r=await json(state(s));assert.equal(r.rows,1);assert.equal(r.snapshot_status,'uploading');assert.equal(r.ready_snapshot,base);await cleanup(s);return r;
  });
  await check('unchanged SKU mixed into a change payload rejected atomically',async()=>{
    const s=await stage(76);await run(`update public.sellpia_stock_snapshot_rows n set stock=b.stock,available_stock=b.available_stock from public.sellpia_stock_snapshot_rows b where n.snapshot_id=${literal(s)} and b.snapshot_id=${literal(base)} and n.sellpia_sku_code=b.sellpia_sku_code and n.sellpia_sku_code='SKU00001';`);
    await assert.rejects(run(`select ${call(s)};`),/변경되지 않은/);const r=await json(state(s));assert.equal(r.rows,76);assert.equal(r.ready_snapshot,base);await cleanup(s);return r;
  });
  await check('chunk retries insert the same SKU once; conflicting duplicate behavior documented',async()=>{
    const s=await stage(1);await run(`delete from public.sellpia_stock_snapshot_rows where snapshot_id=${literal(s)};`);
    const payload="'[ {\"sellpia_sku_code\":\"SKU00001\",\"stock\":105,\"available_stock\":-8},{\"sellpia_sku_code\":\"SKU00001\",\"stock\":106,\"available_stock\":-9}]'::jsonb";
    const first=await json(`select public.hub_sellpia_upload_rows_v2('isolated-operator',${literal(s)},${payload});`);
    const second=await json(`select public.hub_sellpia_upload_rows_v2('isolated-operator',${literal(s)},${payload});`);
    assert.equal(first.inserted_count,1);assert.equal(second.inserted_count,0);
    const saved=await json(`select to_jsonb(r) from public.sellpia_stock_snapshot_rows r where snapshot_id=${literal(s)};`);assert.equal(saved.stock,105);
    await cleanup(s);return {first,second,existing_conflicting_duplicate_policy:'DB first wins via ON CONFLICT DO NOTHING; frontend conflict blocking is separately tested'};
  });
  await check('incomplete chunk count prevents finalization; later chunk retry succeeds',async()=>{
    const s=await stage(76);await run(`delete from public.sellpia_stock_snapshot_rows where snapshot_id=${literal(s)} and sellpia_sku_code='SKU00076';`);
    await assert.rejects(run(`select ${call(s)};`),/manifest/);assert.equal((await json(state(s))).rows,75);
    await run(`select public.hub_sellpia_upload_rows_v2('isolated-operator',${literal(s)},'[ {"sellpia_sku_code":"SKU00076","stock":177,"available_stock":165}]');`);
    const finished=await measuredComplete(s);assert.equal(finished.result.status,'ready');await completeness(s,76,23816);await cleanup(s);return finished;
  });
  await check('injected completion failure rolls back the final transaction and committed chunks remain',async()=>{
    const s=await stage(76);
    await run(`create function public.test_completion_failure() returns trigger language plpgsql as $$ begin if new.upload_status='ready' then raise exception 'isolated failure at ready promotion';end if;return new;end $$;create trigger test_completion_failure before update on public.sellpia_stock_snapshots for each row execute function public.test_completion_failure();`);
    await assert.rejects(run(`select ${call(s)};`),/isolated failure/);
    const r=await json(state(s));assert.equal(r.rows,76);assert.equal(r.snapshot_status,'uploading');assert.equal(r.intent_status,'parsing');assert.equal(r.ready_snapshot,base);
    await run('drop trigger test_completion_failure on public.sellpia_stock_snapshots;drop function public.test_completion_failure();');
    const retried=await measuredComplete(s);await completeness(s,76,23816);await cleanup(s);return {after_failure:r,retried};
  });
  await check('query cancellation in copy rolls back; failure and new-intent retry remain isolated',async()=>{
    const s=await stage(76);
    await run(`create function public.test_slow_insert() returns trigger language plpgsql as $$ begin if new.snapshot_id=${literal(s)}::uuid then perform pg_sleep(0.01);end if;return new;end $$;create trigger test_slow_insert before insert on public.sellpia_stock_snapshot_rows for each row execute function public.test_slow_insert();`);
    await assert.rejects(run(`set statement_timeout='100ms';select ${call(s)};`),/statement timeout/);
    const r=await json(state(s));assert.equal(r.rows,76);assert.equal(r.snapshot_status,'uploading');assert.equal(r.ready_snapshot,base);
    await run('drop trigger test_slow_insert on public.sellpia_stock_snapshot_rows;drop function public.test_slow_insert();');
    // Model the separately committed existing failure endpoint, not part of completion transaction.
    await run(`update operations_private.operations_hub_original_upload_intents set status='failed',error_message='canceling statement due to statement timeout' where intent_id=${literal(s)};update public.sellpia_stock_snapshots set upload_status='failed',upload_note='canceling statement due to statement timeout' where snapshot_id=${literal(s)};`);
    await assert.rejects(run(`select ${call(s)};`),/완료 가능한/);
    const retry=await stage(76);await measuredComplete(retry);await completeness(retry,76,23816);const failed=await json(state(s));assert.equal(failed.snapshot_status,'failed');assert.equal(failed.rows,76);await cleanup(retry);await cleanup(s);return {rollback:r,failed,retry:'new intent only'};
  });
  await check('same intent simultaneous completion is idempotent and lost response can be retried',async()=>{
    const s=await stage(76);const completed=await Promise.all([json(`select ${call(s)};`),json(`select ${call(s)};`)]);
    for(const r of completed)assert.equal(r.status,'ready');await completeness(s,76,23816);
    const replay=await json(`select ${call(s)};`);assert.equal(replay.status,'ready');assert.equal(replay.row_count,23816);await cleanup(s);return {completed,replay};
  });
  await check('different intents against same preview base serialize and second is stale',async()=>{
    const a=await stage(76),b=await stage(1);const r=await Promise.allSettled([run(`select ${call(a)};`),run(`select ${call(b)};`)]);
    assert.equal(r.filter(v=>v.status==='fulfilled').length,1);const failure=r.find(v=>v.status==='rejected');assert.match(failure.reason.message,/최신 Sellpia snapshot이 변경/);
    const states=await Promise.all([json(state(a)),json(state(b))]);assert.equal(states.filter(v=>v.snapshot_status==='ready').length,1);await cleanup(a);await cleanup(b);return states;
  });
  await check('changed base snapshot blocks old proof before copy',async()=>{
    const s=await stage(76),newBase=id();await run(`insert into public.sellpia_stock_snapshots(snapshot_id,upload_status,created_at,completed_at) values(${literal(newBase)},'ready',clock_timestamp(),clock_timestamp());`);
    await assert.rejects(run(`select ${call(s)};`),/최신 Sellpia snapshot이 변경/);const r=await json(state(s));assert.equal(r.rows,76);await cleanup(s);await cleanup(newBase);return r;
  });
  await check('full promotion waits for the common snapshot lock',async()=>{
    const s=await stage(1);await run(`update operations_private.operations_hub_original_upload_intents set upload_mode='full' where intent_id=${literal(s)};`);
    const blocker=run("begin;select pg_advisory_xact_lock(hashtextextended('operations_hub_sellpia_patch',0));select pg_sleep(1.2);commit;",{app:'sellpia_lock_blocker'});
    // Observe the real held lock rather than sleeping to guess ordering.
    for(let n=0;n<40;n++){
      const held=await json("select coalesce(jsonb_agg(a.application_name),'[]') from pg_locks l join pg_stat_activity a using(pid) where l.locktype='advisory' and l.granted and a.application_name='sellpia_lock_blocker';");
      if(held.length)break;if(n===39)throw new Error('lock blocker never acquired');
    }
    const started=performance.now();const finished=await json(`select ${call(s)};`);const elapsed=performance.now()-started;await blocker;
    assert.equal(finished.upload_mode,'full');assert.ok(elapsed>600,`full promotion did not wait (${elapsed}ms)`);await cleanup(s);return {finished,observed_wait_ms:elapsed};
  });
  await check('full and inventory completion coexist with stable complete-v2 signatures',async()=>{
    const s=await stage(76),f=await stage(1);await run(`update operations_private.operations_hub_original_upload_intents set upload_mode='full' where intent_id=${literal(f)};`);
    const r=await Promise.allSettled([run(`select ${call(s)};`),run(`select ${call(f)};`)]);
    assert.equal(r.filter(v=>v.status==='fulfilled').length>=1,true);
    for(const v of r)if(v.status==='rejected')assert.match(v.reason.message,/최신 Sellpia snapshot이 변경/);
    const signatures=await json("select jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'config',p.proconfig) order by proname) from pg_proc p where proname in('hub_sellpia_upload_complete_v1','hub_sellpia_upload_complete_v2','finalize_operations_hub_sellpia_inventory_count');");
    await cleanup(s);await cleanup(f);return {signatures,fulfilled:r.filter(v=>v.status==='fulfilled').length};
  });
  await check('actual patch -> inventory_count -> full sequence keeps complete snapshots',async()=>{
    await run('analyze public.sellpia_stock_snapshot_rows;');
    const p=await stage(1);await run(`update operations_private.operations_hub_original_upload_intents set upload_mode='patch',selected_fields='{"inventory":true}' where intent_id=${literal(p)};`);
    const patched=await json(`select ${call(p)};`);assert.equal(patched.upload_mode,'patch');assert.equal(patched.row_count,23816);
    const i=await stage(76,id(),p);const counted=await measuredComplete(i);assert.equal(counted.result.row_count,23816);assert.equal(counted.result.base_snapshot_id,p);
    const f=await stage(1);await run(`update operations_private.operations_hub_original_upload_intents set upload_mode='full' where intent_id=${literal(f)};`);
    const full=await json(`select ${call(f)};`);assert.equal(full.upload_mode,'full');assert.equal(full.row_count,1);
    await cleanup(f);await cleanup(i);await cleanup(p);return {patched,counted,full};
  });
  await check('20475 SKU requested scale, 76 changes, complete snapshot and preservation',async()=>{
    await run('select operations_private.seed_inventory_timeout_fixture(20475,11);',{timeout:125000});const s=await stage(76);const measured=await measuredComplete(s);const preserved=await completeness(s,76,20475);await cleanup(s);return {measured,preserved};
  });
  results.status='PASS';await save();console.log(`Results saved ${outputPath}`);
}catch(error){results.status='FAIL';results.error=error.message;await save();console.error(error.message);process.exitCode=1;}
