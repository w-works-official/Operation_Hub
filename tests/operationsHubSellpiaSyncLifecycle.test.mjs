import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {acquireLock,digest,SyncError} from '../tools/sellpia-sync/contracts.mjs';
import {WorkerTransport,validateApiUrl} from '../tools/sellpia-sync/transport.mjs';
import {pollWorker,runClaimedJob} from '../tools/sellpia-sync/worker.mjs';
import {waitForWorkerAuthentication,watchStopRequests} from '../tools/sellpia-sync/runner.mjs';

async function temporary(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'sellpia-lifecycle-'));
  t.after(async()=>{
    assert.equal(path.dirname(directory),os.tmpdir());
    assert.ok(path.basename(directory).startsWith('sellpia-lifecycle-'));
    await fs.rm(directory,{recursive:true,force:true});
  });
  return directory;
}
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});

test('local QA HTTP requires an explicit flag, exact loopback host and port without credentials',()=>{
  const endpoint='/functions/v1/operations-hub-sellpia-sync';
  assert.equal(validateApiUrl(`http://127.0.0.1:54321${endpoint}`,{localQA:true}).hostname,'127.0.0.1');
  for(const url of [`http://127.0.0.1:54321${endpoint}`,`http://localhost${endpoint}`,`http://127.0.0.1.evil:54321${endpoint}`,`http://user:secret@127.0.0.1:54321${endpoint}`]) {
    assert.throws(()=>validateApiUrl(url),{code:'invalid_worker_api_url'});
  }
  assert.throws(()=>validateApiUrl(`http://192.168.1.2:54321${endpoint}`,{localQA:true}));
});

test('idle runner reports connected through authenticated outbound health without creating a job',async()=>{
  const calls=[];
  await pollWorker({verifiedReady:true,workerId:'qa-pc',pollIntervalMs:1000},
    {hello:async(...args)=>calls.push(args),claim:async()=>null},{once:true,log:()=>{}});
  assert.equal(calls.length,1);assert.deepEqual(calls[0].slice(0,2),['qa-pc','connected']);
});

test('session expiry pauses worker for human login then claims a new job, without repeating the failed job',async()=>{
  const health=[],jobs=[],stop=new AbortController();let attempts=0,reauth=0;
  const config={verifiedReady:true,workerId:'qa-pc',pollIntervalMs:1000};
  await pollWorker(config,{hello:async(_,status)=>health.push(status),claim:async()=>({jobId:++attempts})},
    {signal:stop.signal,log:()=>{},onNeedsLogin:async()=>{reauth++;},runJob:async claim=>{
      jobs.push(claim.jobId);
      if(claim.jobId===1)throw new SyncError('needs_login','needs_login');
      stop.abort();
    }});
  assert.equal(reauth,1);assert.deepEqual(jobs,[1,2]);assert.ok(health.includes('needs_login'));
});

test('manual authentication remains in the same caller-owned context and reports needs_login until completion',async()=>{
  const calls=[],navigations=[],controller=new AbortController();
  const context={pages:()=>[{goto:async url=>navigations.push(url)}]};
  await waitForWorkerAuthentication(context,{workerId:'qa-pc',sourceUrl:'https://curiouswiz.sellpia.com/product_list_total.html',timeoutMs:1000,heartbeatIntervalMs:1000},
    {hello:async(_,status)=>calls.push(status)},controller.signal,{log:()=>{},authenticate:async actual=>assert.equal(actual,context)});
  assert.deepEqual(calls,['needs_login','connected']);assert.equal(navigations.length,1);
});

test('restart reclaims a confirmed dead local PID and preserves live or unverified lock ownership',async t=>{
  const directory=await temporary(t),file=path.join(directory,'runner.lock');
  await fs.writeFile(file,JSON.stringify({owner:'dead-owner',pid:12345}));
  const release=await acquireLock(directory,'new-owner',{isAlive:()=>false});
  assert.equal(JSON.parse(await fs.readFile(file,'utf8')).owner,'new-owner');
  await assert.rejects(acquireLock(directory,'competing-owner',{isAlive:()=>true}),{code:'runner_already_active'});
  await release();
  await fs.writeFile(file,'invalid');
  await assert.rejects(acquireLock(directory),{code:'runner_lock_unverified'});
  assert.equal(await fs.readFile(file,'utf8'),'invalid');
});

test('lost successful finalize reply retries the same binding with one init and three uploads',async t=>{
  const directory=await temporary(t),files=[];
  for(let ordinal=1;ordinal<=3;ordinal++) {
    const bytes=Buffer.from(`synthetic-${ordinal}`),localPath=path.join(directory,`part-${ordinal}.csv`);
    await fs.writeFile(localPath,bytes);files.push({ordinal,name:`part-${ordinal}.csv`,size:bytes.length,sha256:digest(bytes),localPath});
  }
  const manifest={source:'sellpia',collectionMode:'official_download',mode:'full',includeAll:true,filters:[],expectedRowCount:3,
    files:files.map(({localPath,...rest})=>rest)};
  const calls=[];let finalized=0,onFinalize=0;
  const binding={jobId:'qa-job',workerId:'qa-pc',leaseToken:'synthetic-lease'};
  const transport=new WorkerTransport({apiUrl:'https://project.supabase.co/functions/v1/operations-hub-sellpia-sync',workerToken:'synthetic-worker',
    fetchImpl:async(url,options)=>{
      if(options.method==='PUT') {calls.push('put');assert.equal(options.headers['x-sellpia-sync-worker-token'],undefined);return json({});}
      const body=JSON.parse(options.body);calls.push(body.action);
      if(body.action==='upload-init')return json({ok:true,manifest:manifest.files.map(file=>({...file,path:`staging/${file.name}`,method:'PUT',signedUrl:`https://project.supabase.co/storage/v1/object/upload/sign/bucket/staging/${file.name}?token=synthetic-signed`}))});
      if(body.action==='upload-finalize') {
        assert.deepEqual(body,{...binding,action:'upload-finalize'});
        if(++finalized===1)throw Error('synthetic response lost');
        return json({ok:true,job:{state:'collected'},deduplicated:true});
      }
      throw Error('unexpected request');
    }});
  const result=await transport.uploadCollection(binding,{collectionManifest:manifest,files},undefined,{onFinalize:()=>onFinalize++});
  assert.equal(result.job.state,'collected');assert.equal(onFinalize,1);
  assert.deepEqual(calls,['upload-init','put','put','put','upload-finalize','upload-finalize']);
});

test('worker health rejects arbitrary status and sends worker credential only to the exact queue endpoint',async()=>{
  const calls=[],transport=new WorkerTransport({apiUrl:'https://project.supabase.co/functions/v1/operations-hub-sellpia-sync',workerToken:'synthetic-worker',fetchImpl:async(url,options)=>{
    calls.push({url,options});return json({ok:true,recorded:true});
  }});
  await transport.hello('qa-pc','connected');
  assert.equal(calls.length,1);assert.equal(calls[0].options.redirect,'error');
  assert.deepEqual(JSON.parse(calls[0].options.body),{workerId:'qa-pc',status:'connected',version:'1.0.0',action:'hello'});
  assert.throws(()=>transport.hello('qa-pc','arbitrary'),{code:'invalid_worker_health'});
});

test('finalization waits for an already pending heartbeat before consuming the lease',async t=>{
  const directory=await temporary(t),order=[];
  let startHeartbeat,releaseHeartbeat;
  const started=new Promise(resolve=>startHeartbeat=resolve);
  const pending=new Promise(resolve=>releaseHeartbeat=resolve);
  const expiry=Date.now()+120000;
  const claim={job:{jobId:'heartbeat-race',mode:'full',applyProduction:false},leaseToken:'synthetic-lease',leaseExpiresAt:expiry};
  const result=await runClaimedJob(claim,{verifiedReady:true,workerId:'qa-pc',heartbeatIntervalMs:2},{
    report:async()=>{},heartbeat:async()=>{order.push('heartbeat-start');startHeartbeat();await pending;order.push('heartbeat-end');return {leaseExpiresAt:expiry};},
    uploadCollection:async(_binding,_collection,signal,{onFinalize})=>{
      await started;
      const drained=onFinalize();
      order.push('finalize-wait');releaseHeartbeat();await drained;
      assert.equal(signal.aborted,false);order.push('server-finalized');return {job:{state:'collected'}};
    }
  },{log:()=>{},collect:async()=>{await started;return {jobId:'heartbeat-race',directory,files:[],expectedRowCount:3};}});
  assert.equal(result.job.state,'collected');
  assert.deepEqual(order,['heartbeat-start','finalize-wait','heartbeat-end','server-finalized']);
});

test('private stop request requires the current PID and lock owner, then aborts cleanly',async t=>{
  const directory=await temporary(t),controller=new AbortController(),request=path.join(directory,'stop-request.json');
  const stop=watchStopRequests(directory,'current-owner',controller,{pid:12345,intervalMs:5});
  t.after(stop);
  await fs.writeFile(request,JSON.stringify({pid:12345,owner:'old-owner'}));
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(controller.signal.aborted,false);
  await fs.writeFile(request,JSON.stringify({pid:12345,owner:'current-owner'}));
  await new Promise(resolve=>controller.signal.addEventListener('abort',resolve,{once:true}));
  assert.equal(controller.signal.aborted,true);await assert.rejects(fs.stat(request),{code:'ENOENT'});
});
