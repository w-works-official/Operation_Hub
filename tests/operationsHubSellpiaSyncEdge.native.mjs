import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {backendFixtureSQL,backendMatrixFixtureSQL} from './helpers/sellpia-sync-backend-fixture.mjs';

// Opt-in native local QA. Actual shipped Deno Edge and official PostgREST call
// the private disposable PostgreSQL database below. No Storage implementation
// is emulated, and no source collection, Production host or file upload occurs.
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const database='operation_hub_sync_edge_qa';
if(process.env.SELLPIA_SYNC_NATIVE_QA!=='true')throw Error('Explicit local QA opt-in is required');
const host=process.env.SELLPIA_QA_PG_HOST||'127.0.0.1';
const port=Number(process.env.SELLPIA_QA_PG_PORT||55474);
if(host!=='127.0.0.1'||port!==55474)throw Error('Only the assigned isolated cluster is allowed');
const required=['SELLPIA_QA_PSQL','SELLPIA_QA_POSTGREST','SELLPIA_QA_DENO','SELLPIA_QA_PASSWORD_FILE','SELLPIA_QA_PRIVATE_DIR','SELLPIA_QA_REPORT'];
for(const key of required)if(!process.env[key])throw Error(`Missing local setting ${key}`);
const privateDir=path.resolve(process.env.SELLPIA_QA_PRIVATE_DIR);
if(!path.relative(repo,privateDir).startsWith('..'))throw Error('Private runtime must remain outside Git');
await fs.mkdir(privateDir,{recursive:true,mode:0o700});
const password=(await fs.readFile(process.env.SELLPIA_QA_PASSWORD_FILE,'utf8')).trim();
const jwtSecret=crypto.randomBytes(32).toString('hex');
const operator=crypto.randomBytes(32).toString('hex'),otherOperator=crypto.randomBytes(32).toString('hex');
const workers={'qa-pc-one':crypto.randomBytes(32).toString('hex'),'qa-pc-two':crypto.randomBytes(32).toString('hex')};
const jwt=role=>{const a=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),b=Buffer.from(JSON.stringify({role,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url');return `${a}.${b}.${crypto.createHmac('sha256',jwtSecret).update(`${a}.${b}`).digest('base64url')}`;};
const serviceJwt=jwt('service_role'),anonJwt=jwt('anon');
await fs.writeFile(path.join(privateDir,'edge-native.env.local'),JSON.stringify({jwtSecret,serviceJwt,anonJwt,operator,otherOperator,workers}),{mode:0o600});
const pgEnv={...process.env,PATH:`${path.dirname(process.env.SELLPIA_QA_PSQL)}${path.delimiter}${process.env.PATH||''}`,PGHOST:host,PGPORT:String(port),PGUSER:'postgres',PGPASSWORD:password,PGCLIENTENCODING:'UTF8'};
const redact=value=>[password,jwtSecret,serviceJwt,anonJwt,operator,otherOperator,...Object.values(workers)].reduce((s,secret)=>s.split(secret).join('[redacted]'),String(value));
function exec(binary,args,{input='',env=pgEnv}={}){return new Promise((resolve,reject)=>{const child=spawn(binary,args,{cwd:repo,env,windowsHide:true,stdio:['pipe','pipe','pipe']});let output='',diagnostic='';child.stdout.on('data',b=>{output+=b});child.stderr.on('data',b=>{diagnostic+=b});child.on('error',()=>reject(Error('Local native command could not start')));child.on('exit',code=>code===0?resolve(output):reject(Error(`Local native command failed (${code}): ${redact(diagnostic).split('\n').slice(0,2).join(' ').slice(0,300)}`)));child.stdin.on('error',()=>{});child.stdin.end(input);});}
const psql=(sql,db=database)=>exec(process.env.SELLPIA_QA_PSQL,['-X','-q','-t','-A','-v','ON_ERROR_STOP=1','-d',db],{input:sql});
// Reject reuse rather than resetting an unknown schema or another QA owner's DB.
const exists=(await psql(`select 1 from pg_database where datname='${database}';`,'postgres')).trim();
if(exists){
  if(process.env.SELLPIA_QA_REUSE_EMPTY_DB!=='true'||Number((await psql("select count(*) from pg_tables where schemaname not in ('pg_catalog','information_schema');")).trim())!==0)throw Error('Dedicated Edge QA database already exists; review it before reuse');
}else await psql(`create database ${database};`,'postgres');
let bootstrap=await backendFixtureSQL();
bootstrap=bootstrap.replace('create role service_role bypassrls;',()=> 'do $$ begin create role service_role bypassrls; exception when duplicate_object then null; end $$;');
await psql(bootstrap);
await psql(await backendMatrixFixtureSQL());
await psql(`create or replace function operations_private.require_operations_hub_operator_session(token text) returns jsonb language plpgsql as $$ begin
  if token='${operator}' then return '{"session_id":"00000000-0000-4000-8000-000000000001","username":"isolated-one"}'::jsonb;
  elsif token='${otherOperator}' then return '{"session_id":"00000000-0000-4000-8000-000000000002","username":"isolated-two"}'::jsonb;
  else raise exception using errcode='42501',message='unauthorized';end if;end $$;`);

const availablePort=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const restPort=await availablePort(),proxyPort=await availablePort(),edgePort=await availablePort();
const processes=[];let proxy;const checks=[];let storageCalls=0;
const check=async(name,fn)=>{await fn();checks.push({name,status:'PASS'});};
const start=(binary,args,env)=>{const child=spawn(binary,args,{cwd:repo,env,windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.resume();child.stderr.resume();processes.push(child);return child;};
const waitReady=async(url,predicate=r=>r.status<500)=>{for(let i=0;i<150;i++){try{const r=await fetch(url);if(predicate(r))return;}catch{}await new Promise(r=>setTimeout(r,200));}throw Error('Local service readiness timed out');};
try{
  const pgBin=path.dirname(process.env.SELLPIA_QA_PSQL);
  start(process.env.SELLPIA_QA_POSTGREST,[],{...process.env,PATH:`${pgBin}${path.delimiter}${process.env.PATH||''}`,PGRST_DB_URI:`postgresql://postgres:${encodeURIComponent(password)}@${host}:${port}/${database}`,PGRST_DB_SCHEMAS:'public',PGRST_DB_ANON_ROLE:'anon',PGRST_JWT_SECRET:jwtSecret,PGRST_SERVER_HOST:'127.0.0.1',PGRST_SERVER_PORT:String(restPort)});
  await waitReady(`http://127.0.0.1:${restPort}/`);
  // URL prefix adapter only: it forwards actual PostgREST requests byte-for-byte
  // and deliberately refuses every Storage route. It does not fake RPC results.
  proxy=http.createServer(async(req,res)=>{
    if(!req.url.startsWith('/rest/v1/')){storageCalls++;res.writeHead(503);res.end('Storage QA not configured');return;}
    const chunks=[];for await(const part of req)chunks.push(part);const body=Buffer.concat(chunks);
    try{const reply=await fetch(`http://127.0.0.1:${restPort}${req.url.slice('/rest/v1'.length)}`,{method:req.method,headers:Object.fromEntries(Object.entries(req.headers).filter(([k])=>!['host','connection','content-length'].includes(k))),body:['GET','HEAD'].includes(req.method)?undefined:body});res.writeHead(reply.status,{'content-type':reply.headers.get('content-type')||'application/json'});res.end(Buffer.from(await reply.arrayBuffer()));}catch{res.writeHead(503);res.end();}
  });await new Promise(resolve=>proxy.listen(proxyPort,'127.0.0.1',resolve));
  const wrapper=path.join(privateDir,'edge-native-wrapper.mjs');
  await fs.writeFile(wrapper,`const serve=Deno.serve;Deno.serve=(handler)=>serve({hostname:'127.0.0.1',port:${edgePort}},handler);await import(${JSON.stringify(pathToFileURL(path.join(repo,'supabase/functions/operations-hub-sellpia-sync/index.ts')).href)});`);
  start(process.env.SELLPIA_QA_DENO,['run','--allow-env','--allow-net','--allow-read','--node-modules-dir=auto','--no-lock',wrapper],{...process.env,SUPABASE_URL:`http://127.0.0.1:${proxyPort}`,SUPABASE_ANON_KEY:anonJwt,SUPABASE_SERVICE_ROLE_KEY:serviceJwt,SELLPIA_SYNC_ENABLED:'true',SELLPIA_SYNC_APPLY_ENABLED:'false',SELLPIA_SYNC_WORKERS_JSON:JSON.stringify(workers)});
  const endpoint=`http://127.0.0.1:${edgePort}/functions/v1/operations-hub-sellpia-sync`;
  await waitReady(endpoint,r=>r.status===400);
  const browserHeaders=token=>({'content-type':'application/json',origin:'https://w-works-official.github.io','x-operations-hub-session':token});
  const workerHeaders=id=>({'content-type':'application/json','x-sellpia-sync-worker-token':workers[id]});
  const request=async(action,body={},headers=browserHeaders(operator))=>{const r=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({action,...body})});const result=await r.json();return {status:r.status,...result};};
  let job,claim;
  const requestId=crypto.randomUUID();
  await check('actual Edge rejects missing operator session',async()=>assert.equal((await request('availability',{}, {'content-type':'application/json',origin:'https://w-works-official.github.io'})).status,401));
  await check('actual Edge rejects unapproved Origin',async()=>assert.equal((await request('availability',{}, {...browserHeaders(operator),origin:'https://unapproved.invalid'})).status,403));
  await check('actual custom operator guard resolves session through actual PostgREST',async()=>{const r=await request('availability');assert.equal(r.status,200);assert.equal(r.applyEnabled,false);assert.equal(r.runner.online,false);assert.equal(r.applicationPolicy.approvedSourceFingerprint,null);});
  await check('per-worker auth rejects another PC secret',async()=>assert.equal((await request('hello',{workerId:'qa-pc-two',status:'connected'},workerHeaders('qa-pc-one'))).status,401));
  await check('actual worker health persists and authenticated availability sees online',async()=>{assert.equal((await request('hello',{workerId:'qa-pc-one',status:'connected'},workerHeaders('qa-pc-one'))).status,200);assert.equal((await request('availability')).runner.online,true);});
  await check('actual queue enqueues collector-only full job with separate patch policy',async()=>{const r=await request('enqueue',{requestId,mode:'full',applicationMode:'patch',selectedFields:{inventory:true},baselineSnapshotId:null,applyProduction:true});assert.equal(r.status,200);job=r.job;assert.equal(job.mode,'full');assert.equal(job.applicationMode,'patch');assert.equal(job.applyProduction,false);assert.equal(job.selectedFields.price,false);});
  await check('actual concurrent duplicate requests create one immutable job',async()=>{const rs=await Promise.all(Array.from({length:12},()=>request('enqueue',{requestId,mode:'full',applicationMode:'patch',selectedFields:{inventory:true},baselineSnapshotId:null})));assert.ok(rs.every(r=>r.status===200&&r.job.jobId===job.jobId&&r.deduplicated));});
  await check('operator ownership denies cross-account status and history excludes job',async()=>{assert.equal((await request('status',{jobId:job.jobId},browserHeaders(otherOperator))).status,401);assert.equal((await request('history',{},browserHeaders(otherOperator))).jobs.length,0);});
  await check('actual claim returns valid collecting lease with no apply authority',async()=>{claim=await request('claim',{workerId:'qa-pc-one'},workerHeaders('qa-pc-one'));assert.equal(claim.status,200);assert.equal(claim.job.jobId,job.jobId);assert.equal(claim.job.applyProduction,false);assert.equal(claim.job.state,'collecting');assert.ok(claim.leaseToken);});
  await check('second PC cannot claim or heartbeat another live lease',async()=>{assert.equal((await request('claim',{workerId:'qa-pc-two'},workerHeaders('qa-pc-two'))).job,null);assert.equal((await request('heartbeat',{workerId:'qa-pc-two',jobId:job.jobId,leaseToken:claim.leaseToken},workerHeaders('qa-pc-two'))).status,409);});
  await check('actual operator cancellation revokes late heartbeat and is idempotent',async()=>{assert.equal((await request('cancel',{jobId:job.jobId})).job.state,'cancelled');assert.equal((await request('cancel',{jobId:job.jobId})).job.state,'cancelled');assert.equal((await request('heartbeat',{workerId:'qa-pc-one',jobId:job.jobId,leaseToken:claim.leaseToken},workerHeaders('qa-pc-one'))).status,409);});
  await check('default-off apply refuses request before import',async()=>assert.equal((await request('apply-init',{jobId:job.jobId,sourceFingerprint:'a'.repeat(64)})).code,'APPLY_DISABLED'));
  await check('server-owned Storage paths and verified artifacts cannot be forged',async()=>{assert.equal((await request('enqueue',{requestId:crypto.randomUUID(),path:'forbidden'})).status,400);assert.equal((await request('upload-finalize',{workerId:'qa-pc-one',jobId:job.jobId,leaseToken:claim.leaseToken,verifiedArtifacts:[]},workerHeaders('qa-pc-one'))).status,400);});
  await check('actual private schema ACL rejects anonymous direct job read',async()=>assert.equal((await psql("select has_table_privilege('anon','operations_private.sellpia_sync_jobs','select');")).trim(),'f'));
  assert.equal(storageCalls,0);
  const report={time:new Date().toISOString(),environment:'loopback dedicated native PostgreSQL + official PostgREST + actual shipped Deno Edge',database,checks,passed:checks.length,failed:0,storageCalls,storageQA:'NOT RUN: official Windows storage unavailable; no replacement Storage or mock',snapshotWrites:0,matrixProof:'schema uses actual shipped Matrix projection/refresh; no source import performed',productionCalls:0};
  await fs.mkdir(path.dirname(process.env.SELLPIA_QA_REPORT),{recursive:true});await fs.writeFile(process.env.SELLPIA_QA_REPORT,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:checks.length,failed:0,storageQA:'NOT RUN',productionCalls:0}));
}finally{
  for(const child of processes)child.kill();
  await Promise.all(processes.map(child=>child.exitCode!==null?Promise.resolve():new Promise(resolve=>{child.once('exit',resolve);setTimeout(resolve,3000);})));if(proxy)await new Promise(resolve=>proxy.close(resolve));
}
