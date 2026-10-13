#!/usr/bin/env node
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {validateConfig, acquireLock, safeLog, errorCode, requireReady, inside} from './contracts.mjs';
import {openContext, collectOfficial, waitForManualAuthentication} from './collector.mjs';
import {WorkerTransport} from './transport.mjs';
import {pollWorker,runClaimedJob} from './worker.mjs';

export function parseArguments(args) {
  const [command,...rest] = args;
  if (!['login','collect','worker','check-config'].includes(command)) throw Error('usage');
  let configPath, once = false,manualLogin=false,repeat=1;
  for (let index = 0; index < rest.length; index++) {
    if (rest[index] === '--config' && rest[index+1]) configPath = rest[++index];
    else if (rest[index] === '--once' && command === 'worker') once = true;
    else if(rest[index] === '--login' && ['collect','worker'].includes(command))manualLogin=true;
    else if(rest[index] === '--repeat' && command === 'collect' && /^[123]$/.test(rest[index+1] || ''))repeat=Number(rest[++index]);
    else throw Error('usage');
  }
  if (!configPath) throw Error('usage');
  return {command,configPath,once,manualLogin,repeat};
}
export async function waitForManualLoginClose(context, signal) {
  const handlers=new Map();let closeContext,stop,watch;
  await new Promise(resolve=>{
    const check=()=>{
      if(!context.pages().length||context.pages().every(page=>page.isClosed()))resolve();
    };
    watch=page=>{
      const onClose=()=>setImmediate(check);
      handlers.set(page,onClose);page.on('close',onClose);
    };
    closeContext=resolve;stop=resolve;
    for(const page of context.pages())watch(page);
    context.on('page',watch);context.once('close',closeContext);
    if(signal?.aborted)resolve();else signal?.addEventListener('abort',stop,{once:true});
    check();
  });
  context.removeListener('page',watch);context.removeListener('close',closeContext);
  signal?.removeEventListener('abort',stop);
  for(const [page,onClose] of handlers)page.removeListener('close',onClose);
}
export async function waitForWorkerAuthentication(context, config, transport, signal,
    {authenticate = waitForManualAuthentication, log = safeLog} = {}) {
  let reporting = false;
  const report = async()=>{
    if (reporting || signal?.aborted) return;
    reporting = true;
    try { await transport.hello(config.workerId,'needs_login',signal); }
    catch { /* The next normal queue request will enforce authentication. */ }
    finally { reporting = false; }
  };
  await report();
  const timer=setInterval(report,config.heartbeatIntervalMs);
  try {
    const page=context.pages()[0]||await context.newPage();
    await page.goto(config.sourceUrl,{waitUntil:'domcontentloaded',timeout:config.timeoutMs});
    log('manual_login_required',{state:'needs_login'});
    while(!signal?.aborted) {
      try {await authenticate(context,config,signal);break;}
      catch(error) {
        if(error?.code!=='manual_login_timeout')throw error;
        // A resident worker stays available for later human reauthentication.
        // It does not repeatedly navigate or attempt a login on its own.
        log('authentication_waiting',{state:'needs_login'});
      }
    }
    if(signal?.aborted)throw Object.assign(new Error('worker_stopped'),{state:'blocked'});
  } finally { clearInterval(timer); }
  await transport.hello(config.workerId,'connected',signal);
}
export function watchStopRequests(workDirectory, owner, controller, {pid=process.pid,intervalMs=1000}={}) {
  const requestPath=inside(workDirectory,'stop-request.json');let reading=false;
  const check=async()=>{
    if(reading||controller.signal.aborted)return;
    reading=true;
    try {
      const request=JSON.parse(await fs.readFile(requestPath,'utf8'));
      if(request.pid===pid&&request.owner===owner) {
        await fs.unlink(requestPath);
        controller.abort();
      }
    } catch { /* Missing, stale or unverified requests cannot stop this owner. */ }
    finally {reading=false;}
  };
  const timer=setInterval(check,intervalMs);timer.unref();
  return ()=>clearInterval(timer);
}
export async function main(args = process.argv.slice(2), {env = process.env, log = safeLog} = {}) {
  const options = parseArguments(args);
  const input = JSON.parse(await fs.readFile(path.resolve(options.configPath),'utf8'));
  const config = validateConfig(input);
  if (options.command === 'check-config') {
    log('configuration_checked', {state:config.verifiedReady ? 'ready' : 'blocked',code:config.verifiedReady ? 'verified_contract_configured' : 'official_download_contract_unverified'});
    return;
  }
  if (options.command !== 'login') requireReady(config);
  const release = await acquireLock(config.workDirectory);
  const abort = new AbortController();
  const stopWatcher=watchStopRequests(config.workDirectory,release.owner,abort);
  const stop = () => abort.abort();
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
  try {
    if (options.command === 'login') {
      const context = await openContext(config,{login:true});
      try {
        const page = context.pages()[0] || await context.newPage();
        await page.goto(config.sourceUrl,{waitUntil:'domcontentloaded',timeout:config.timeoutMs});
        log('manual_login_required', {state:'needs_login'});
        // Operator logs in directly. The runner never enters or reads credentials.
        await waitForManualLoginClose(context,abort.signal);
      } finally { await context.close().catch(() => {}); }
      log('profile_closed');
    } else if (options.command === 'collect') {
      const context=await openContext(config,{login:options.manualLogin});
      try{
        for(let attempt=1;attempt<=options.repeat;attempt++){
          const result=await collectOfficial(config,{jobId:randomUUID(),signal:abort.signal,browserContext:context,
            manualLogin:options.manualLogin && attempt===1,
            onProgress:summary=>log('collect_progress',{code:summary.errorCode,fileCount:summary.completedFiles,rowCount:summary.expectedRowCount,attempt})});
          log('local_collection_ready',{jobId:result.jobId,state:'collected',fileCount:3,rowCount:result.expectedRowCount,attempt});
        }
      }finally{await context.close().catch(()=>{});}
      // This command never creates a cloud job or invokes Hub snapshot upload.
    } else {
      const transport = new WorkerTransport({apiUrl:env.SELLPIA_SYNC_API_URL || input.apiUrl,
        workerToken:env.SELLPIA_SYNC_WORKER_TOKEN,timeoutMs:config.timeoutMs,localQA:input.localQA === true});
      await transport.hello(config.workerId,'starting',abort.signal);
      // Keep a headed context alive so a session expiry can be recovered by the
      // operator without passing credentials to the worker or restarting a job.
      const context=await openContext(config,{login:true});
      try{
        await waitForWorkerAuthentication(context,config,transport,abort.signal,{log});
        await pollWorker(config,transport,{signal:abort.signal,once:options.once,log,
          onNeedsLogin:signal=>waitForWorkerAuthentication(context,config,transport,signal,{log}),
          runJob:(claim,configuration,connection,dependencies)=>runClaimedJob(claim,configuration,connection,{...dependencies,
            collect:(current,jobOptions)=>collectOfficial(current,{...jobOptions,browserContext:context})})});
      }finally{await context.close().catch(()=>{});}
    }
  } finally {
    stopWatcher();
    process.removeListener('SIGINT',stop); process.removeListener('SIGTERM',stop);
    await release();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    safeLog('runner_stopped',{code:error?.message === 'usage' ? 'usage' : errorCode(error),state:error?.state || 'failed'});
    process.exitCode = 1;
  });
}
