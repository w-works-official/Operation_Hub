import {setTimeout as sleep} from 'node:timers/promises';
import {SyncError, fail, errorCode, safeLog, requireReady, writeJournal} from './contracts.mjs';
import {collectOfficial} from './collector.mjs';
import {leaseBinding, leaseTime} from './transport.mjs';

export async function runClaimedJob(claim, config, transport, {collect = collectOfficial, signal, log = safeLog} = {}) {
  const binding = leaseBinding(claim, config.workerId);
  const abort = new AbortController();
  const mergedSignal = signal ? AbortSignal.any([signal,abort.signal]) : abort.signal;
  let leaseExpiresAt = leaseTime(claim.leaseExpiresAt), heartbeatRunning = false, heartbeatPending = Promise.resolve();
  const checkLease = () => {
    if (Date.now() >= leaseExpiresAt) abort.abort();
    if (mergedSignal.aborted) fail('lease_lost', 'blocked');
  };
  const timer = setInterval(() => {
    if (heartbeatRunning || mergedSignal.aborted) return;
    if (Date.now() >= leaseExpiresAt) { abort.abort(); return; }
    heartbeatRunning = true;
    heartbeatPending=(async()=>{
      try {
        const result = await transport.heartbeat(binding, mergedSignal);
        const nextExpiry = leaseTime(result.leaseExpiresAt);
        if (!Number.isFinite(nextExpiry) || nextExpiry <= Date.now()) abort.abort();
        else leaseExpiresAt = nextExpiry;
      } catch { abort.abort(); }
      finally { heartbeatRunning = false; }
    })();
  },config.heartbeatIntervalMs);
  try {
    requireReady(config);
    checkLease();
    log('job_claimed', {jobId:binding.jobId,state:'collecting'});
    await transport.report(binding,'collecting',{phase:'waiting'},mergedSignal);
    const collection = await collect(config, {jobId:binding.jobId,signal:mergedSignal,onProgress:async summary => {
      checkLease();
      await transport.report(binding,'collecting',summary,mergedSignal);
    }});
    checkLease();
    await transport.report(binding,'collecting',{phase:'uploading',completedFiles:3,totalFiles:3,expectedRowCount:collection.expectedRowCount},mergedSignal);
    const completed = await transport.uploadCollection(binding, collection, mergedSignal,{onFinalize:async()=>{
      clearInterval(timer);
      await heartbeatPending;
      checkLease();
    }});
    // Finalization consumes the server lease. A concurrent final heartbeat can
    // see LEASE_LOST after this successful acknowledgement; the verified server
    // result is authoritative and must not be turned into a false failure.
    clearInterval(timer);
    if (completed?.job?.state !== 'collected') fail('server_collection_not_verified');
    await writeJournal(collection.directory, {...collection,state:'uploaded'});
    log('job_collected', {jobId:binding.jobId,state:'collected',fileCount:3,rowCount:collection.expectedRowCount});
    return completed;
  } catch (error) {
    const code = mergedSignal.aborted ? 'lease_lost' : errorCode(error);
    if (!mergedSignal.aborted && Date.now() < leaseExpiresAt && !(error instanceof SyncError && error.code === 'lease_lost')) {
      const state = error?.state === 'needs_login' ? 'needs_login' : 'failed';
      await transport.report(binding,state,{errorCode:code.toUpperCase()},mergedSignal).catch(() => {});
    }
    log('job_stopped', {jobId:binding.jobId,code,state:error?.state || 'failed'});
    throw new SyncError(code,error?.state || 'failed');
  } finally { clearInterval(timer); }
}
export async function pollWorker(config, transport, {signal, once = false, runJob = runClaimedJob, log = safeLog, onNeedsLogin} = {}) {
  requireReady(config);
  let backoff = config.pollIntervalMs;
  while (!signal?.aborted) {
    try {
      await transport.hello?.(config.workerId,'connected',signal);
      const claim = await transport.claim(config.workerId, signal);
      if (claim) {
        await transport.hello?.(config.workerId,'busy',signal);
        await runJob(claim,config,transport,{signal,log});
        await transport.hello?.(config.workerId,'connected',signal);
      }
      if (once) return;
      backoff = config.pollIntervalMs;
    } catch (error) {
      log('worker_stopped', {code:errorCode(error),state:error?.state || 'failed'});
      if (error?.state === 'needs_login') {
        await transport.hello?.(config.workerId,'needs_login',signal);
        if (!onNeedsLogin || once) throw error;
        await onNeedsLogin(signal);
        await transport.hello?.(config.workerId,'connected',signal);
        backoff = config.pollIntervalMs;
        continue;
      }
      if (error?.state === 'blocked' || once) throw error;
      backoff = Math.min(backoff * 2, 60000);
    }
    await sleep(backoff,undefined,{signal}).catch(() => {});
  }
}
