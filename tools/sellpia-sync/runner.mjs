#!/usr/bin/env node
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {validateConfig, acquireLock, safeLog, errorCode, requireReady} from './contracts.mjs';
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
        workerToken:env.SELLPIA_SYNC_WORKER_TOKEN,timeoutMs:config.timeoutMs});
      const context=await openContext(config,{login:options.manualLogin});
      try{
        if(options.manualLogin){
          const page=context.pages()[0]||await context.newPage();
          await page.goto(config.sourceUrl,{waitUntil:'domcontentloaded',timeout:config.timeoutMs});
          log('manual_login_required',{state:'needs_login'});
          await waitForManualAuthentication(context,config,abort.signal);
        }
        await pollWorker(config,transport,{signal:abort.signal,once:options.once,log,
          runJob:(claim,configuration,connection,dependencies)=>runClaimedJob(claim,configuration,connection,{...dependencies,
            collect:(current,jobOptions)=>collectOfficial(current,{...jobOptions,browserContext:context})})});
      }finally{await context.close().catch(()=>{});}
    }
  } finally {
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
