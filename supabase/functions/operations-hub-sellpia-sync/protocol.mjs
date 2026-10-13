// Pure queue protocol. No source rows, credentials, network or production apply.
export const VERSION = '2026.10.13-preview-only-v1';
export const LEASE_MS = 120_000;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 60 * 1024 * 1024;
export const DOWNLOAD_TTL_SECONDS = 300;
export const FIELD_NAMES = Object.freeze(['inventory','price','basePrice','purchasePrice','basic','status']);
export const BROWSER_ACTIONS = new Set(['enqueue','status','artifacts','cancel','cancel-request','receipt']);
export const WORKER_ACTIONS = new Set(['claim','heartbeat','report','upload-init','upload-finalize']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
export function fail(code, message) { throw Object.assign(new Error(message), {code}); }
export function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
export function uuid(value) { if (typeof value !== 'string' || !UUID.test(value)) fail('INVALID_REQUEST','유효한 작업 식별자가 필요합니다.'); return value.toLowerCase(); }
export function allowedOrigin(origin) { return origin === 'https://w-works-official.github.io' || /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(origin || ''); }
export function secureWorkerRequest(url, origin) { const u = new URL(url); return !origin && (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost','127.0.0.1'].includes(u.hostname))); }
export function sessionHeader(value) { if (!DIGEST.test(value || '')) fail('UNAUTHORIZED','유효한 운영 세션이 필요합니다.'); return value; }
export async function sha256(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export async function workerTokenMatches(candidate, expected) {
  if (typeof expected !== 'string' || expected.length < 32 || typeof candidate !== 'string' || candidate.length > 512) return false;
  const a = await sha256(candidate), b = await sha256(expected);
  let diff = 0; for (let i=0;i<a.length;i++) diff |= a.charCodeAt(i)^b.charCodeAt(i);
  return diff === 0;
}
export function normalizeEnqueue(body) {
  const requestId = uuid(body.requestId);
  const mode = body.mode === undefined ? 'full' : body.mode;
  if (!['full','patch'].includes(mode)) fail('INVALID_REQUEST','전체 또는 명시적인 부분 갱신 모드가 필요합니다.');
  const selected = body.selectedFields;
  if (selected !== undefined && (!plain(selected) || Object.keys(selected).some(k=>!FIELD_NAMES.includes(k)) || Object.values(selected).some(v=>typeof v!=='boolean'))) fail('INVALID_REQUEST','갱신 필드 형식이 올바르지 않습니다.');
  const selectedFields = Object.fromEntries(FIELD_NAMES.map(k=>[k, mode==='full' ? true : selected?.[k]===true]));
  if (mode==='full' && selected && FIELD_NAMES.some(k=>selected[k]!==true)) fail('INVALID_REQUEST','전체 원본은 모든 필드를 포함해야 합니다.');
  if (mode==='patch' && !FIELD_NAMES.some(k=>selectedFields[k])) fail('INVALID_REQUEST','부분 갱신 필드를 명시해주세요.');
  return {requestId, mode, selectedFields, baselineSnapshotId:body.baselineSnapshotId==null?null:uuid(body.baselineSnapshotId), applyProduction:false};
}
function integer(value, min=0) { return Number.isSafeInteger(value) && value >= min; }
export function normalizeManifest(manifest, mode) {
  if (!plain(manifest) || manifest.source!=='sellpia' || manifest.collectionMode!=='official_download' || manifest.mode!==mode || !Array.isArray(manifest.filters) || !integer(manifest.expectedRowCount,1)) fail('INVALID_MANIFEST','공식 원본 수집 근거가 완전하지 않습니다.');
  if (mode==='full' && (manifest.includeAll!==true || manifest.filters.length)) fail('INVALID_MANIFEST','전체 원본에는 모든 상품과 필터 해제 근거가 필요합니다.');
  if (mode==='patch' && (manifest.includeAll!==false || !manifest.filters.length || manifest.filters.some(x=>typeof x!=='string'||x.length>100))) fail('INVALID_MANIFEST','부분 원본은 조회 범위를 명시해야 합니다.');
  const files = manifest.files;
  if (!Array.isArray(files) || (mode==='full' ? files.length!==3 : files.length<1||files.length>3)) fail('INVALID_MANIFEST','원본 파일 개수를 확인해주세요.');
  const names = new Set();
  const normalized = [...files].sort((a,b)=>a.ordinal-b.ordinal).map((f,i)=>{
    if (!plain(f) || f.ordinal!==i+1 || typeof f.name!=='string' || f.name.length<1 || f.name.length>180 || /[\x00-\x1f/\\]/.test(f.name) || !/\.(csv|xlsx|xls)$/i.test(f.name) || !integer(f.size,1) || f.size>MAX_FILE_BYTES || !DIGEST.test(f.sha256||'')) fail('INVALID_MANIFEST','원본 파일 이름·순서·크기·checksum을 확인해주세요.');
    if(names.has(f.name))fail('INVALID_MANIFEST','원본 파일 이름이 중복되어 있습니다.');names.add(f.name);
    return {ordinal:f.ordinal,name:f.name,size:f.size,sha256:f.sha256};
  });
  if (normalized.reduce((n,f)=>n+f.size,0)>MAX_TOTAL_BYTES) fail('INVALID_MANIFEST','전체 원본은 60 MiB 이하만 허용합니다.');
  return {source:'sellpia',collectionMode:'official_download',mode,includeAll:manifest.includeAll,filters:[...manifest.filters],expectedRowCount:manifest.expectedRowCount,files:normalized};
}
export function cleanSummary(value={}) {
  if (!plain(value)) fail('INVALID_REQUEST','진행 집계 형식이 올바르지 않습니다.');
  const keys=['phase','completedFiles','totalFiles','rowCount','loadedRows','expectedRowCount','errorCode'];
  if (Object.keys(value).some(k=>!keys.includes(k))) fail('INVALID_REQUEST','집계 외 원문 데이터는 제출할 수 없습니다.');
  const out={};
  for (const [k,v] of Object.entries(value)) {
    if (k==='phase' ? !['waiting','downloading','parsing','hashing','uploading','verified'].includes(v) : k==='errorCode' ? typeof v!=='string'||! /^[A-Z0-9_]{1,64}$/.test(v) : !integer(v)) fail('INVALID_REQUEST','진행 집계 값이 올바르지 않습니다.');
    out[k]=v;
  }
  return out;
}
function canonical(value){return Array.isArray(value)?value.map(canonical):plain(value)?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;}
export function normalizeReceipt(value,job){
  const keys=['valid','rowCount','applyProduction','state','sourceFingerprint','baselineSnapshotId','summary'];
  if(!plain(value)||Object.keys(value).some(k=>!keys.includes(k))||value.valid!==true||!integer(value.rowCount,1)||value.rowCount!==job.collectionManifest?.expectedRowCount||value.applyProduction===true||value.state!==undefined&&value.state!=='previewed')fail('INVALID_REQUEST','미리보기 검증 집계를 확인해주세요.');
  const out={valid:true,rowCount:value.rowCount,applyProduction:false,state:'previewed'};
  if(value.sourceFingerprint!==undefined){if(!DIGEST.test(value.sourceFingerprint))fail('INVALID_REQUEST','원본 fingerprint를 확인해주세요.');out.sourceFingerprint=value.sourceFingerprint;}
  if(value.baselineSnapshotId!==undefined){const baseline=value.baselineSnapshotId===null?null:uuid(value.baselineSnapshotId);if(baseline!==job.baselineSnapshotId)fail('CONFLICT','미리보기 기준 snapshot이 요청과 다릅니다.');out.baselineSnapshotId=baseline;}
  if(value.summary!==undefined){
    const s=value.summary, allowed=['source','mode','fileCount','rowCount','expectedRowCount','baselineRowCount','deltaRowCount','fieldPolicy','strictNumeric','productionApply','reviewRequired','reviewReasons','comparison'];
    if(!plain(s)||Object.keys(s).some(k=>!allowed.includes(k)))fail('INVALID_REQUEST','원문 없이 검증 집계만 기록할 수 있습니다.');
    for(const k of ['fileCount','rowCount','expectedRowCount','baselineRowCount'])if(s[k]!==undefined&&s[k]!==null&&(!integer(s[k])||s[k]>10_000_000))fail('INVALID_REQUEST','미리보기 건수를 확인해주세요.');
    if(s.deltaRowCount!==undefined&&s.deltaRowCount!==null&&(!Number.isSafeInteger(s.deltaRowCount)||Math.abs(s.deltaRowCount)>10_000_000))fail('INVALID_REQUEST','미리보기 차이 건수를 확인해주세요.');
    if(s.source!==undefined&&s.source!=='sellpia'||s.mode!==undefined&&s.mode!==job.mode||s.rowCount!==undefined&&s.rowCount!==out.rowCount||s.expectedRowCount!==undefined&&s.expectedRowCount!==out.rowCount||s.fileCount!==undefined&&s.fileCount!==job.manifest.length||s.productionApply!==undefined&&s.productionApply!==false||s.strictNumeric!==undefined&&s.strictNumeric!==true||s.fieldPolicy!==undefined&&s.fieldPolicy!==(job.mode==='full'?'sellpia-full-source-v1':'sellpia-selected-fields-v1')||s.reviewRequired!==undefined&&typeof s.reviewRequired!=='boolean'||s.reviewReasons!==undefined&&(!Array.isArray(s.reviewReasons)||s.reviewReasons.length>1||s.reviewReasons.some(x=>x!=='source_row_count_drop')))fail('INVALID_REQUEST','미리보기 정책 집계를 확인해주세요.');
    if(s.comparison!==undefined){
      const c=s.comparison, countKeys=['newRowCount','baselineRowCount','changedCount','unchangedCount','addedCount','removedCount','preservedCount','unknownCount','knownChangedCount','knownUnchangedCount'];
      if(!plain(c)||Object.keys(c).some(k=>!countKeys.includes(k)&&k!=='fieldCounts'))fail('INVALID_REQUEST','필드 비교 건수만 기록할 수 있습니다.');
      for(const k of countKeys)if(c[k]!==undefined&&c[k]!==null&&(!integer(c[k])||c[k]>10_000_000))fail('INVALID_REQUEST','필드 비교 건수를 확인해주세요.');
      if(c.newRowCount!==undefined&&c.newRowCount!==out.rowCount)fail('INVALID_REQUEST','비교 원본 건수가 다릅니다.');
      if(c.fieldCounts!==undefined&&(!plain(c.fieldCounts)||Object.keys(c.fieldCounts).some(k=>!FIELD_NAMES.includes(k))||Object.values(c.fieldCounts).some(v=>!integer(v)||v>out.rowCount)))fail('INVALID_REQUEST','필드별 비교 건수를 확인해주세요.');
    }
    out.summary=s;
  }
  return canonical(out);
}
export function publicJob(job) {
  if (!job) return null;
  const {jobId,requestId,mode,selectedFields,baselineSnapshotId,state,createdAt,updatedAt,summary,collectionManifest,receipt}=job;
  return {jobId,requestId,mode,selectedFields,baselineSnapshotId,state,createdAt,updatedAt,summary,collectionManifest:collectionManifest||null,receipt:receipt||null,applyProduction:false};
}
export function assertLease(job, workerId, hash, now) {
  if (!job || job.state!=='collecting' || job.workerId!==workerId || job.leaseHash!==hash || !integer(job.leaseExpiresAt,1) || job.leaseExpiresAt<=now) fail('LEASE_LOST','작업 권한이 만료되었거나 취소되었습니다.');
}
export function serverPaths(jobId, files) { return files.map(f=>({...f,path:`sellpia-sync/${uuid(jobId)}/${f.ordinal}.${f.name.split('.').pop().toLowerCase()}`})); }
export async function verifyArtifactBytes(manifest, readBytes) {
  let total=0; const verified=[];
  // Sequential download + digest keeps only one bounded artifact in memory.
  for (const file of manifest) {
    if (!integer(file.size,1) || file.size>MAX_FILE_BYTES || (total+=file.size)>MAX_TOTAL_BYTES) fail('INVALID_ARTIFACT','원본 용량 제한을 초과했습니다.');
    const buffer=await readBytes(file);
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength!==file.size || buffer.byteLength>MAX_FILE_BYTES) fail('INVALID_ARTIFACT','실제 원본 크기가 선언과 다릅니다.');
    if (await sha256(buffer)!==file.sha256) fail('INVALID_ARTIFACT','실제 원본 checksum이 선언과 다릅니다.');
    verified.push({...file,verified:true});
  }
  return verified;
}

export class QueueProtocol {
  constructor(store,{now=()=>Date.now(),randomUUID=()=>crypto.randomUUID(),randomToken=()=>[...crypto.getRandomValues(new Uint8Array(32))].map(x=>x.toString(16).padStart(2,'0')).join('')}={}) { Object.assign(this,{store,now,randomUUID,randomToken}); }
  async dispatch(action,body,actor) {
    if (!(actor?.kind==='browser' ? BROWSER_ACTIONS : actor?.kind==='worker' ? WORKER_ACTIONS : new Set()).has(action)) fail('UNAUTHORIZED','이 작업을 수행할 권한이 없습니다.');
    if (action==='enqueue'||action==='cancel-request') {
      const input=normalizeEnqueue(body), payloadHash=await sha256(JSON.stringify(input)), newId=this.randomUUID();
      if(action==='enqueue'&&input.mode!=='full')fail('AUTOMATION_FULL_ONLY','자동 수집은 전체 원본만 지원합니다. 부분 갱신은 기존 수동 업로드를 사용해주세요.');
      return this.store.transact(({jobs,now})=>{
        const prior=jobs.find(j=>j.requestId===input.requestId);
        if (prior) {
          if(prior.payloadHash!==payloadHash) fail('CONFLICT','같은 요청 ID의 내용이 변경되었습니다.');
          if(action==='cancel-request'&&prior.state!=='cancelled')Object.assign(prior,{state:'cancelled',leaseHash:null,leaseExpiresAt:null,updatedAt:new Date(now).toISOString()});
          return {job:publicJob(prior),deduplicated:true};
        }
        if (action==='enqueue'&&jobs.filter(j=>['queued','collecting'].includes(j.state)).length>=100) fail('CONFLICT','대기 작업이 많습니다. 기존 작업 완료 후 다시 시도해주세요.');
        // A requestId tombstone shares enqueue's payload hash and CAS selector.
        // Whichever commits first, late/retried enqueue cannot create work after
        // cancellation has been confirmed, including when its reply was lost.
        const cancelled=action==='cancel-request';
        const job={...input,jobId:newId,payloadHash,state:cancelled?'cancelled':'queued',createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),summary:cancelled?{errorCode:'CANCELLED_BY_REQUEST'}:{phase:'waiting'},leaseHash:null,leaseExpiresAt:null,workerId:null,manifest:[],verifiedArtifacts:[]};
        jobs.push(job);return {job:publicJob(job),deduplicated:false};
      },{requestId:input.requestId});
    }
    if (action==='claim') {
      const leaseToken=this.randomToken(), leaseHash=await sha256(leaseToken);
      return this.store.transact(({jobs,now})=>{
        for(const job of jobs) if(job.state==='collecting'&&job.leaseExpiresAt<=now) {job.state='failed';job.summary={errorCode:'LEASE_EXPIRED'};job.leaseHash=null;job.leaseExpiresAt=null;job.updatedAt=new Date(now).toISOString();}
        if(jobs.some(j=>j.state==='collecting'))return {job:null,busy:true};
        const job=jobs.filter(j=>j.state==='queued').sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.jobId.localeCompare(b.jobId))[0];
        if(!job)return {job:null,busy:false};
        Object.assign(job,{state:'collecting',workerId:actor.workerId,leaseHash,leaseExpiresAt:now+LEASE_MS,updatedAt:new Date(now).toISOString(),summary:{phase:'downloading'}});
        return {job:publicJob(job),leaseToken,leaseExpiresAt:job.leaseExpiresAt};
      },{});
    }
    const jobId=uuid(body.jobId), leaseHash=actor.kind==='worker'?await sha256(body.leaseToken||''):null;
    return this.store.transact(({jobs,now})=>{
      const job=jobs.find(j=>j.jobId===jobId);if(!job)fail('NOT_FOUND','작업을 찾을 수 없습니다.');
      if(action==='upload-finalize'&&['collected','previewed'].includes(job.state)&&job.completedWorkerId===actor.workerId&&job.completedLeaseHash===leaseHash)return {job:publicJob(job),deduplicated:true};
      if(actor.kind==='worker')assertLease(job,actor.workerId,leaseHash,now);
      const touch=()=>{job.updatedAt=new Date(now).toISOString();};
      if(action==='status')return {job:publicJob(job)};
      if(action==='artifacts') {
        if(!['collected','previewed'].includes(job.state))fail('CONFLICT','검증된 원본이 아직 준비되지 않았습니다.');
        return {job:publicJob(job),manifest:job.verifiedArtifacts};
      }
      if(action==='cancel') {
        if(job.state==='cancelled')return {job:publicJob(job)};
        if(['failed','needs_login'].includes(job.state))fail('CONFLICT','종료된 작업은 취소할 수 없습니다.');
        job.state='cancelled';job.leaseHash=null;job.leaseExpiresAt=null;touch();return {job:publicJob(job)};
      }
      if(action==='receipt') {
        if(!['collected','previewed'].includes(job.state))fail('CONFLICT','원본 검증 후 미리보기를 기록할 수 있습니다.');
        const receipt=normalizeReceipt(body.receipt,job);
        if(job.receipt&&JSON.stringify(job.receipt)!==JSON.stringify(receipt))fail('CONFLICT','완료된 미리보기 집계는 변경할 수 없습니다.');
        job.receipt=receipt;job.state='previewed';touch();return {job:publicJob(job)};
      }
      if(action==='heartbeat') {job.leaseExpiresAt=now+LEASE_MS;touch();return {job:publicJob(job),leaseExpiresAt:job.leaseExpiresAt};}
      if(action==='report') {
        if(!['collecting','failed','needs_login'].includes(body.state))fail('INVALID_REQUEST','원본 수집 완료는 파일 검증으로만 확정합니다.');
        job.summary=cleanSummary(body.summary||{});job.state=body.state;
        if(body.state!=='collecting'){job.leaseHash=null;job.leaseExpiresAt=null;}touch();return {job:publicJob(job)};
      }
      if(action==='upload-init') {
        const manifest=normalizeManifest(body.collectionManifest,job.mode);
        if(job.collectionManifest&&JSON.stringify(job.collectionManifest)!==JSON.stringify(manifest))fail('CONFLICT','선언한 원본 manifest는 변경할 수 없습니다.');
        job.collectionManifest=manifest;job.manifest=serverPaths(jobId,manifest.files);touch();return {job:publicJob(job),manifest:job.manifest,leaseExpiresAt:job.leaseExpiresAt};
      }
      if(action==='upload-finalize') {
        if(!job.manifest.length||!Array.isArray(body.verifiedArtifacts)||JSON.stringify(body.verifiedArtifacts.map(({verified,...f})=>f))!==JSON.stringify(job.manifest)||body.verifiedArtifacts.some(f=>f.verified!==true))fail('INVALID_ARTIFACT','실제 바이트 검증을 완료한 원본만 제출할 수 있습니다.');
        job.verifiedArtifacts=body.verifiedArtifacts;job.state='collected';job.completedLeaseHash=job.leaseHash;job.completedWorkerId=job.workerId;job.leaseHash=null;job.leaseExpiresAt=null;job.summary={phase:'verified',completedFiles:job.manifest.length,totalFiles:job.manifest.length,rowCount:job.collectionManifest.expectedRowCount};touch();return {job:publicJob(job)};
      }
      fail('INVALID_REQUEST','지원하지 않는 요청입니다.');
    },{jobId,leaseGuard:actor.kind==='worker'?{jobId,workerId:actor.workerId,leaseHash}:null});
  }
}

// Test adapter: serialized, copy-on-write transactions with failed-write rollback.
export class MemoryQueueStore {
  constructor({now=()=>Date.now()}={}){this.now=now;this.jobs=[];this.tail=Promise.resolve();}
  async read(){await this.tail;return {jobs:structuredClone(this.jobs),now:this.now(),revision:0};}
  transact(fn){const run=this.tail.then(()=>{const state={jobs:structuredClone(this.jobs),now:this.now()};const result=fn(state);this.jobs=state.jobs;return structuredClone(result);});this.tail=run.catch(()=>{});return run;}
}
