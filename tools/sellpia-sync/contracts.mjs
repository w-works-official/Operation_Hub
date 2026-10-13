import {createHash, randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

export const SOURCE_URL = 'https://curiouswiz.sellpia.com/product_list_total.html';
export const SOURCE_HOST = 'curiouswiz.sellpia.com';
export const CONTRACT_VERSION = 1;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 60 * 1024 * 1024;
const require = createRequire(import.meta.url);
const repoDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const safeIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;

export class SyncError extends Error {
  constructor(code, state = 'failed') { super(code); this.name = 'SyncError'; this.code = code; this.state = state; }
}
export function fail(code, state) { throw new SyncError(code, state); }
export function errorCode(error) { return error instanceof SyncError ? error.code : 'collector_failed'; }
export function safeId(value) {
  if (typeof value !== 'string' || !safeIdPattern.test(value)) fail('invalid_job_id');
  return value;
}
export function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export function safeName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 180 || /[\x00-\x1f<>:"/\\|?*]/.test(value)
      || /[ .]$/.test(value) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value)) fail('invalid_download_name');
  if (!/\.(?:csv|xls|xlsx)$/i.test(value)) fail('unsupported_download_type');
  return value;
}
export function inside(root, ...segments) {
  const base = path.resolve(root), target = path.resolve(base, ...segments);
  const relative = path.relative(base, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('unsafe_local_path');
  return target;
}
export function defaultDirectories(env = process.env) {
  const base = env.LOCALAPPDATA || env.XDG_STATE_HOME || path.join(env.USERPROFILE || env.HOME || process.cwd(), '.local', 'state');
  return {profileDirectory:path.join(base, 'OperationHubSellpiaSync', 'profile'), workDirectory:path.join(base, 'OperationHubSellpiaSync', 'runs')};
}
export function validateConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_config');
  if (input.localQA !== undefined && typeof input.localQA !== 'boolean') fail('invalid_config');
  const defaults = defaultDirectories();
  const source = new URL(input.sourceUrl || SOURCE_URL);
  if (source.href !== SOURCE_URL) fail('unapproved_source_url');
  const config = {...defaults, ...input, sourceUrl:SOURCE_URL, verifiedReady:input.verifiedReady === true,
    browserChannel:input.browserChannel || 'msedge', timeoutMs:input.timeoutMs ?? 60000,
    pollIntervalMs:input.pollIntervalMs ?? 5000, heartbeatIntervalMs:input.heartbeatIntervalMs ?? 30000,
    manualLoginTimeoutMs:input.manualLoginTimeoutMs ?? 600000,
    maxFileBytes:input.maxFileBytes ?? MAX_FILE_BYTES, ui:input.ui || {}};
  if (!['msedge', 'chrome', 'chromium'].includes(config.browserChannel)) fail('invalid_browser_channel');
  for (const key of ['profileDirectory', 'workDirectory']) {
    if (typeof config[key] !== 'string' || !path.isAbsolute(config[key])) fail('absolute_runtime_directory_required');
    const relative = path.relative(repoDirectory, path.resolve(config[key]));
    if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) fail('runtime_directory_inside_repository');
  }
  for (const [parent, child] of [[config.profileDirectory,config.workDirectory],[config.workDirectory,config.profileDirectory]]) {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) fail('profile_and_artifacts_must_be_separate');
  }
  for (const [key, min, max] of [['timeoutMs',1000,300000],['manualLoginTimeoutMs',30000,1800000],['pollIntervalMs',1000,60000],['heartbeatIntervalMs',1000,60000],['maxFileBytes',1024,MAX_FILE_BYTES]]) {
    if (!Number.isSafeInteger(config[key]) || config[key] < min || config[key] > max) fail('invalid_runtime_limit');
  }
  if (config.ui.strategy !== 'grid_csv' || config.ui.format !== 'csv4' || config.ui.rowsPerFile !== 10000) fail('unsupported_official_download_strategy');
  if (config.verifiedReady) {
    const ui = config.ui;
    if (typeof ui.authenticatedSelector !== 'string' || !ui.authenticatedSelector || typeof ui.rowCountSelector !== 'string' || !ui.rowCountSelector
        || typeof ui.loadingSelector !== 'string' || !ui.loadingSelector || typeof ui.loadingBackdropSelector !== 'string' || !ui.loadingBackdropSelector) fail('official_download_contract_incomplete');
  }
  if (!Number.isSafeInteger(config.ui.settleMs ?? 1000) || (config.ui.settleMs ?? 1000) < 100 || (config.ui.settleMs ?? 1000) > 10000) fail('invalid_runtime_limit');
  return config;
}
export function requireReady(config) {
  if (!config.verifiedReady) fail('official_download_contract_unverified', 'blocked');
}
export function validateJob(job) {
  safeId(job?.jobId);
  if (job.mode !== 'full' || job.applyProduction !== false) fail('unsupported_job_scope');
  return job;
}
export function validateManifest(manifest) {
  if (manifest?.source !== 'sellpia' || manifest.collectionMode !== 'official_download' || manifest.mode !== 'full'
      || manifest.includeAll !== true || !Array.isArray(manifest.filters) || manifest.filters.length
      || !Number.isSafeInteger(manifest.expectedRowCount) || manifest.expectedRowCount <= 0
      || !Array.isArray(manifest.files) || manifest.files.length !== 3) fail('invalid_collection_manifest');
  const names = new Set();
  for (const [index, file] of manifest.files.entries()) {
    safeName(file.name);
    if (file.ordinal !== index + 1 || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_FILE_BYTES || !/^[a-f0-9]{64}$/.test(file.sha256)
        || names.has(file.name)) fail('invalid_collection_manifest');
    names.add(file.name);
  }
  if (manifest.files.reduce((total,file) => total + file.size,0) > MAX_TOTAL_BYTES) fail('invalid_collection_manifest');
  for (const key of ['collectedAt','sourceGeneratedAt']) {
    if (manifest[key] !== undefined && (typeof manifest[key] !== 'string' || !Number.isFinite(Date.parse(manifest[key])))) fail('invalid_collection_manifest');
  }
  return manifest;
}
export function safeLog(event, details = {}, sink = console.log) {
  const allowed = ['jobId','code','state','fileCount','rowCount','ordinal','attempt'];
  const output = {event, at:new Date().toISOString()};
  for (const key of allowed) if (key in details) {
    const value = details[key];
    if (['fileCount','rowCount','ordinal','attempt'].includes(key) && Number.isSafeInteger(value)) output[key] = value;
    else if (typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value)) output[key] = value;
  }
  sink(JSON.stringify(output));
}
export async function acquireLock(workDirectory, owner = randomUUID(), {isAlive = pid=>{
  try { process.kill(pid,0); return true; }
  catch(error) { return error.code !== 'ESRCH'; }
}} = {}) {
  await fs.mkdir(workDirectory, {recursive:true, mode:0o700});
  const lockPath = inside(workDirectory, 'runner.lock');
  let handle;
  try { handle = await fs.open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const recoveryPath=inside(workDirectory,'runner-recovery.lock');
    let recovery;
    try { recovery=await fs.open(recoveryPath,'wx',0o600); }
    catch { fail('runner_already_active','blocked'); }
    try {
      let prior;
      try { prior=JSON.parse(await fs.readFile(lockPath,'utf8')); }
      catch { fail('runner_lock_unverified','blocked'); }
      if (!Number.isSafeInteger(prior.pid) || prior.pid <= 0 || typeof prior.owner !== 'string' || isAlive(prior.pid)) fail('runner_already_active','blocked');
      // Reclaim only a confirmed dead local owner, never a live/unknown PID.
      await fs.unlink(lockPath);
      try { handle=await fs.open(lockPath,'wx',0o600); }
      catch { fail('runner_already_active','blocked'); }
    } finally { await recovery.close(); await fs.unlink(recoveryPath); }
  }
  await handle.writeFile(JSON.stringify({owner, pid:process.pid, createdAt:new Date().toISOString()}));
  await handle.close();
  const release = async () => {
    const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    if (lock.owner !== owner) fail('lock_owner_changed');
    await fs.unlink(lockPath);
  };
  release.owner=owner;
  return release;
}
export async function writeJournal(directory, journal) {
  await fs.mkdir(directory, {recursive:true, mode:0o700});
  const journalPath = inside(directory, 'journal.json'), temporary = inside(directory, `journal-${randomUUID()}.tmp`);
  // Never store worker credentials, signed upload URLs, cookies, or lease tokens.
  const states = ['collecting','collected','uploaded','failed','needs_login','blocked'];
  if (!states.includes(journal.state)) fail('invalid_journal_state');
  const cleanFiles = (journal.files || []).map(file => ({ordinal:file.ordinal,name:safeName(file.name),
    ...(file.originalName ? {originalName:safeName(file.originalName)} : {}),size:file.size,sha256:file.sha256,
    localPath:file.localPath,...(Number.isSafeInteger(file.rowCount) ? {rowCount:file.rowCount,minRowNo:file.minRowNo,maxRowNo:file.maxRowNo} : {})}));
  const clean = {version:CONTRACT_VERSION, jobId:safeId(journal.jobId), state:journal.state, updatedAt:new Date().toISOString(),
    ...(journal.expectedRowCount ? {expectedRowCount:journal.expectedRowCount} : {}), files:cleanFiles,
    ...(journal.collectionManifest ? {collectionManifest:validateManifest(journal.collectionManifest)} : {}),
    ...(journal.code ? {code:journal.code} : {})};
  await fs.writeFile(temporary, JSON.stringify(clean, null, 2), {mode:0o600});
  await fs.rename(temporary, journalPath);
}
export async function readJournal(directory) {
  try { return JSON.parse(await fs.readFile(inside(directory, 'journal.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; fail('invalid_local_journal'); }
}
export async function validateOriginalFiles(files, expectedRowCount, {parser, XLSX} = {}) {
  if (!Number.isSafeInteger(expectedRowCount) || expectedRowCount <= 0 || files.length !== 3) fail('incomplete_official_download');
  const sourceParser = parser || require('../../mockups/operations-hub/sellpia-source-parser.js');
  const workbookParser = XLSX || require('../../tests/vendor/xlsx-0.18.5.full.min.js');
  const fileObjects = [];
  for (const file of files) {
    const bytes = await fs.readFile(file.localPath);
    if (bytes.length !== file.size || digest(bytes) !== file.sha256) fail('local_artifact_digest_mismatch');
    fileObjects.push({name:file.name, size:bytes.length, arrayBuffer:async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)});
  }
  const parsed = await sourceParser.parseSellpiaFiles(fileObjects, {mode:'full', XLSX:workbookParser,strictNumeric:true});
  // Detailed parser errors can contain supplier/product values; keep them local to the parser.
  if (!parsed?.valid || parsed.rowCount !== expectedRowCount) fail('official_source_validation_failed');
  return {rowCount:parsed.rowCount, files:parsed.files.map(file => ({rowCount:file.rowCount,minRowNo:file.minRowNo,maxRowNo:file.maxRowNo}))};
}
export async function orderOfficialParts(files, directory) {
  const parser = require('../../mockups/operations-hub/sellpia-source-parser.js');
  const XLSX = require('../../tests/vendor/xlsx-0.18.5.full.min.js');
  const ranges = [];
  for (const file of files) {
    const bytes = await fs.readFile(file.localPath);
    if (bytes.length !== file.size || digest(bytes) !== file.sha256) fail('local_artifact_digest_mismatch');
    const parsed = await parser.parseSellpiaFile({name:file.name,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)}, {XLSX,strictNumeric:true});
    if (!parsed.valid || !parsed.rows.length) fail('official_source_validation_failed');
    ranges.push({...file,minRowNo:Math.min(...parsed.rows.map(row=>row.source_row_no)),maxRowNo:Math.max(...parsed.rows.map(row=>row.source_row_no)),rowCount:parsed.rows.length});
  }
  ranges.sort((a,b)=>a.minRowNo-b.minRowNo);
  const ordered = [];
  for (const [index,file] of ranges.entries()) {
    const ordinal = index+1,originalName=safeName(file.originalName || file.name);
    const extension=path.extname(originalName).toLowerCase(),prefix=`part-${ordinal}-`;
    // The official exporter timestamps names at second precision; simultaneous
    // parts can have the same suggested name. Alias metadata only, preserving
    // every original byte and the original name in the local journal.
    const name=safeName(`${prefix}${originalName.slice(0,-extension.length).slice(0,180-prefix.length-extension.length)}${extension}`);
    const localPath = inside(directory,`part-${ordinal}${extension}`);
    await fs.rename(file.localPath,localPath);
    ordered.push({...file,ordinal,name,originalName,localPath});
  }
  return ordered;
}
