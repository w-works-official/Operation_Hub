import fs from 'node:fs/promises';
import {SyncError, fail, safeId, safeName, digest, validateJob, validateManifest} from './contracts.mjs';

const API_PATH = '/functions/v1/operations-hub-sellpia-sync';
export function validateApiUrl(value, {localQA = false} = {}) {
  let url;
  try { url = new URL(value); } catch { fail('worker_api_url_required'); }
  const loopbackQA = localQA === true && url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname) && !!url.port;
  if ((!loopbackQA && url.protocol !== 'https:') || url.username || url.password || url.pathname !== API_PATH || url.search || url.hash) fail('invalid_worker_api_url');
  return url;
}
export function leaseBinding(claim, workerId) {
  validateJob(claim?.job);
  safeId(workerId);
  if (typeof claim.leaseToken !== 'string' || !claim.leaseToken || claim.leaseToken.length > 2048
      || leaseTime(claim.leaseExpiresAt) <= Date.now()) fail('invalid_worker_lease');
  return {jobId:claim.job.jobId,workerId,leaseToken:claim.leaseToken};
}
export function leaseTime(value) {
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) fail('invalid_worker_lease');
  return timestamp;
}
export class WorkerTransport {
  constructor({apiUrl,workerToken,fetchImpl = fetch,timeoutMs = 30000,localQA = false}) {
    this.apiUrl = validateApiUrl(apiUrl,{localQA});
    if (typeof workerToken !== 'string' || !workerToken.trim() || /[\r\n]/.test(workerToken)) fail('worker_token_required');
    this.workerToken = workerToken;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }
  async request(action, body, signal) {
    let response;
    try {
      response = await this.fetchImpl(this.apiUrl.href, {method:'POST',redirect:'error',
        headers:{'content-type':'application/json','x-sellpia-sync-worker-token':this.workerToken},
        body:JSON.stringify({...body,action}),signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs)});
    } catch { fail('worker_transport_unavailable'); }
    let result;
    try { result = await response.json(); } catch { fail('invalid_worker_response'); }
    if (response.status === 401 || response.status === 403) fail('worker_authentication_failed', 'blocked');
    if (result?.code === 'DISABLED') fail('worker_server_disabled', 'blocked');
    if (result?.code === 'LEASE_LOST' || response.status === 410) fail('lease_lost', 'blocked');
    if (result?.code === 'INVALID_ARTIFACT') fail('staging_verification_failed');
    if (!response.ok || result?.ok === false) fail('worker_request_failed');
    if (result?.ok !== true) fail('invalid_worker_response');
    return result;
  }
  async claim(workerId, signal) {
    safeId(workerId);
    const result = await this.request('claim', {workerId}, signal);
    if (result?.job === null) return null;
    leaseBinding(result, workerId);
    return result;
  }
  hello(workerId, status = 'connected', signal) {
    safeId(workerId);
    if (!['connected','needs_login','starting','busy'].includes(status)) fail('invalid_worker_health');
    return this.request('hello',{workerId,status,version:'1.0.0'},signal);
  }
  async heartbeat(binding, signal) {
    const result = await this.request('heartbeat', binding, signal);
    if (leaseTime(result?.leaseExpiresAt) <= Date.now()) fail('invalid_worker_lease');
    return result;
  }
  report(binding, state, summary = {}, signal) {
    if (!['collecting','needs_login','failed'].includes(state)) fail('invalid_worker_report');
    const allowed = new Set(['phase','completedFiles','totalFiles','rowCount','loadedRows','expectedRowCount','errorCode']);
    const clean = {};
    for (const [key,value] of Object.entries(summary)) {
      if (!allowed.has(key)) continue;
      if (key === 'errorCode' && /^[A-Z0-9_]{1,64}$/.test(value)) clean[key] = value;
      else if (key === 'phase' && ['waiting','downloading','parsing','hashing','uploading','verified'].includes(value)) clean[key] = value;
      else if (Number.isSafeInteger(value) && value >= 0) clean[key] = value;
    }
    return this.request('report', {...binding,state,summary:clean}, signal);
  }
  async uploadCollection(binding, collection, signal, {onFinalize = ()=>{}} = {}) {
    const collectionManifest = validateManifest(collection.collectionManifest);
    const result = await this.request('upload-init', {...binding,collectionManifest}, signal);
    if (!Array.isArray(result?.manifest) || result.manifest.length !== 3) fail('invalid_staging_manifest');
    for (const [index,signed] of result.manifest.entries()) {
      const expected = collectionManifest.files[index], file = collection.files[index];
      safeName(signed.name);
      if (signed.ordinal !== expected.ordinal || signed.name !== expected.name || signed.size !== expected.size || signed.sha256 !== expected.sha256) fail('staging_manifest_mismatch');
      const bytes = await fs.readFile(file.localPath);
      if (bytes.length !== expected.size || digest(bytes) !== expected.sha256) fail('local_artifact_digest_mismatch');
      await this.uploadSigned(signed, bytes, signal);
    }
    await onFinalize();
    // An acknowledged import is idempotent on this exact job/lease binding.
    // Retry only the acknowledgement; do not create another upload or job.
    for (let attempt = 0; ; attempt++) {
      try { return await this.request('upload-finalize', binding, signal); }
      catch (error) {
        if (attempt >= 2 || signal?.aborted || !['worker_transport_unavailable','invalid_worker_response'].includes(error?.code)) throw error;
      }
    }
  }
  async uploadSigned(signed, bytes, signal) {
    let url;
    try { url = new URL(signed.signedUrl); } catch { fail('invalid_signed_upload_url'); }
    if (signed.method !== 'PUT' || url.origin !== this.apiUrl.origin || url.username || url.password || url.hash
        || !url.pathname.startsWith('/storage/v1/object/upload/sign/') || !url.searchParams.get('token')
        || [...url.searchParams.keys()].some(key => key !== 'token') || typeof signed.path !== 'string' || !signed.path
        || !decodeURIComponent(url.pathname).endsWith(`/${signed.path}`)) fail('invalid_signed_upload_url');
    let response;
    try {
      response = await this.fetchImpl(url.href, {method:'PUT',redirect:'error',
        headers:{'content-type':'application/octet-stream','x-upsert':'false','cache-control':'max-age=0'},body:bytes,
        signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs)});
    } catch { fail('staging_upload_failed'); }
    if (!response.ok) fail('staging_upload_failed');
  }
}
