import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {createRequire} from 'node:module';
import {SOURCE_HOST, SyncError, fail, inside, safeId, safeName, digest, requireReady, validateManifest,
  readJournal, writeJournal, validateOriginalFiles, orderOfficialParts} from './contracts.mjs';

const require = createRequire(import.meta.url);
export async function openContext(config, {login = false, chromium} = {}) {
  await fs.mkdir(config.profileDirectory, {recursive:true, mode:0o700});
  const engine = chromium || require('playwright').chromium;
  return engine.launchPersistentContext(config.profileDirectory, {
    headless:!login, acceptDownloads:true,
    ...(config.browserChannel !== 'chromium' ? {channel:config.browserChannel} : {}),
    // Keep credentials inside the dedicated browser profile. No tracing, HAR,
    // cookies(), storageState(), console forwarding, or APIRequestContext.
  });
}
function checkAbort(signal) { if (signal?.aborted) fail('lease_lost', 'blocked'); }
export async function ensureSession(page, config) {
  const url = new URL(page.url());
  if (url.protocol !== 'https:' || url.hostname !== SOURCE_HOST) fail('unapproved_navigation', 'blocked');
  if (await page.locator('input[type="password"]:visible').count()) fail('needs_login', 'needs_login');
  const securityChallenge = page.locator('iframe[src*="captcha"], input[autocomplete="one-time-code"]:visible');
  if (await securityChallenge.count()) fail('security_challenge', 'needs_login');
  if (config.ui.securityChallengeSelector && await page.locator(config.ui.securityChallengeSelector).isVisible()) fail('security_challenge', 'needs_login');
  if (config.ui.authenticatedSelector && !await page.locator(config.ui.authenticatedSelector).isVisible()) fail('needs_login', 'needs_login');
}
export function parseOfficialCount(text, pattern = null) {
  const match = String(text).match(pattern ? new RegExp(pattern) : /^\s*([\d,]+)\s*$/);
  if (!match?.[1] || !/^\d+(?:,\d{3})*$/.test(match[1])) fail('official_count_unverified');
  const count = Number(match[1].replaceAll(',', ''));
  if (!Number.isSafeInteger(count) || count <= 0) fail('official_count_unverified');
  return count;
}
export async function waitForManualAuthentication(context,config,signal,{pollMs=500}={}) {
  const deadline=Date.now()+config.manualLoginTimeoutMs;
  while(Date.now()<deadline){
    checkAbort(signal);
    const pages=context.pages().filter(page=>!page.isClosed());
    if(!pages.length)fail('manual_login_closed','needs_login');
    for(const page of pages){
      try{
        const current=new URL(page.url());
        if(current.protocol === 'https:' && current.hostname === SOURCE_HOST && current.pathname !== '/product_list_total.html'
            && await page.getByRole('button',{name:'로그아웃',exact:true}).isVisible()) {
          // Observe the authenticated navigation marker; never click logout.
          await page.goto(config.sourceUrl,{waitUntil:'domcontentloaded',timeout:config.timeoutMs});
        }
        await ensureSession(page,config);
        if(new URL(page.url()).pathname === '/product_list_total.html')return page;
      }catch(error){
        if(!(error instanceof SyncError) || !['needs_login','unapproved_navigation'].includes(error.code)){
          if(error?.code==='security_challenge')continue;
          throw error;
        }
      }
    }
    await sleep(pollMs,undefined,{signal}).catch(()=>checkAbort(signal));
  }
  fail('manual_login_timeout','needs_login');
}
export async function prepareOfficialDownload(page, config, signal, onStep = async()=>{}, {navigate=true} = {}) {
  const step=async(name,action)=>{
    checkAbort(signal);await onStep(name);
    try{return await action();}catch(error){
      if(signal?.aborted)fail('lease_lost','blocked');
      if(error instanceof SyncError)throw error;
      fail(`prepare_${name}_failed`);
    }
  };
  if(navigate)await step('navigation',()=>page.goto(config.sourceUrl,{waitUntil:'domcontentloaded',timeout:config.timeoutMs}));
  await step('session',()=>ensureSession(page,config));
  // The observed case-8 change handler hides search_key. Clear filters before
  // selecting it; an already empty hidden input needs no fill() interaction.
  await step('clear_search_keys',async()=>{
    for(const selector of ['#search_key','#txt_search']){
      const input=page.locator(selector);
      if(await input.inputValue() !== ''){
        if(!await input.isVisible())fail('hidden_active_search_filter','blocked');
        await input.fill('');
      }
      if(await input.inputValue() !== '')fail('official_search_filter_active');
    }
  });
  await step('select_full',()=>page.locator('#search_type').selectOption('8'));
  // Selecting "전체" opens this warning and blocks the search button. It must
  // be acknowledged before any subsequent search controls are manipulated.
  await step('warning',async()=>{
    const warning=page.getByRole('button',{name:'Ok',exact:true});
    await warning.waitFor({state:'visible',timeout:config.timeoutMs});
    await warning.click();
  });
  await step('clear_categories',async()=>{
    for(const selector of ['#market_type_req','#prd_cate_req','#prd_type_req']){
      const input=page.locator(selector);if(await input.inputValue() !== '')await input.selectOption('');
      if(await input.inputValue() !== '')fail('official_search_filter_active');
    }
  });
  await step('clear_selection',async()=>{
    for(const selector of ['#group_by_ptitle','#select_all','#grid_output_selected_chk_pager'])await page.locator(selector).uncheck();
  });
  await step('include_inactive',async()=>{
    await page.locator('#soldout_include').check();await page.locator('#discontinued_include').check();
  });
  const loading = page.locator(config.ui.loadingSelector);
  const loadingStarted = loading.waitFor({state:'visible',timeout:config.timeoutMs});
  loadingStarted.catch(()=>{});
  await step('search_click',()=>page.locator('#search_bt').click());
  await step('loading_started',()=>loadingStarted);
  await step('loading_finished',()=>loading.waitFor({state:'hidden',timeout:config.timeoutMs}));
  await step('backdrop_hidden',()=>page.locator(config.ui.loadingBackdropSelector).waitFor({state:'hidden',timeout:config.timeoutMs}));
  if (!await page.locator('#search_bt').isEnabled()) fail('official_query_incomplete');
  if (await page.locator('#more_searh_PNL button').isVisible()) fail('official_scope_incomplete');
  await step('count_visible',()=>page.locator(config.ui.rowCountSelector).waitFor({state:'visible',timeout:config.timeoutMs}));
  checkAbort(signal);
  await ensureSession(page, config);
  const expectedRowCount = parseOfficialCount(await page.locator(config.ui.rowCountSelector).innerText(), config.ui.rowCountPattern);
  if (Math.ceil(expectedRowCount/config.ui.rowsPerFile) !== 3) fail('official_part_count_changed','blocked');
  await step('csv_toolbar',()=>page.locator('span[title="CSV"]').click());
  const dialog = page.getByRole('dialog', {name:'그리드 다운로드 v1.1.14',exact:true});
  await step('grid_dialog',()=>dialog.waitFor({state:'visible',timeout:config.timeoutMs}));
  await step('csv_format',()=>dialog.locator('select:has(option[value="csv4"])').selectOption('csv4'));
  await step('all_columns',()=>dialog.locator('select:has(option[value="all"])').selectOption('all'));
  for (const title of ['선택된 항목만 다운로드','컬럼 포멧 적용(Beta)','보이는 내역대로 다운로드','그룹핑 합계행 추가']) {
    const checkbox = dialog.locator(`input[data-title="${title}"]`);
    await step('export_options',()=>checkbox.uncheck());
    if (await checkbox.isChecked()) fail('official_export_scope_mismatch');
  }
  const sourceParser = require('../../mockups/operations-hub/sellpia-source-parser.js');
  const selectedHeaders = await dialog.locator('.grid-download-selected-columns > li').allTextContents();
  if (!sourceParser.buildSellpiaColumnMap(selectedHeaders).valid) fail('official_export_columns_incomplete');
  return expectedRowCount;
}
export async function saveDownload(download, ordinal, directory, config, signal) {
  checkAbort(signal);
  try {
    const name = safeName(download.suggestedFilename());
    const extension = path.extname(name).toLowerCase();
    const localPath = inside(directory, `download-${ordinal}-${randomUUID()}${extension}`);
    await download.saveAs(localPath);
    if (await download.failure()) fail('official_download_failed');
    checkAbort(signal);
    const stat = await fs.stat(localPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > config.maxFileBytes) fail('invalid_download_size');
    const bytes = await fs.readFile(localPath);
    return {ordinal,name,size:bytes.length,sha256:digest(bytes),localPath};
  } catch (error) {
    if (error instanceof SyncError) throw error;
    fail('official_download_failed');
  }
}
export async function captureGridDownloads(page, directory, config, expectedRowCount, signal, onProgress = async()=>{}) {
  const count = Math.ceil(expectedRowCount/config.ui.rowsPerFile);
  if (count !== 3) fail('official_part_count_changed','blocked');
  const saves = [],downloads=[];let resolveCount,rejectCount,extra = false,finished=false,completedFiles=0;
  let progress = Promise.resolve();
  const counted = new Promise((resolve,reject)=>{resolveCount=resolve;rejectCount=reject;});
  counted.catch(()=>{});
  const abortCapture = ()=>rejectCount(new SyncError('lease_lost','blocked'));
  const onDownload = download=>{
    downloads.push(download);
    if (saves.length >= count) {extra=true;rejectCount(new SyncError('unexpected_official_download'));return;}
    const ordinal=saves.length+1;
    const saved=saveDownload(download,ordinal,directory,config,signal).then(file=>{
      const completed = ++completedFiles;
      progress=progress.then(()=>onProgress({phase:'downloading',completedFiles:completed,totalFiles:count,expectedRowCount}));
      progress.catch(rejectCount);
      return file;
    });
    saved.catch(rejectCount);saves.push(saved);
    if(saves.length===count)resolveCount();
  };
  page.on('download',onDownload);
  signal?.addEventListener('abort',abortCapture,{once:true});
  const deadline=setTimeout(()=>rejectCount(new SyncError('incomplete_official_download')),config.timeoutMs);
  try {
    checkAbort(signal);
    const dialog=page.getByRole('dialog',{name:'그리드 다운로드 v1.1.14',exact:true});
    await dialog.getByRole('button',{name:'그리드 다운로드',exact:true}).click();
    await counted;
    const files=await Promise.all(saves);
    await progress;
    await sleep(config.ui.settleMs ?? 1000,undefined,{signal});
    checkAbort(signal);
    if(extra)fail('unexpected_official_download');
    const finalCount=parseOfficialCount(await page.locator(config.ui.rowCountSelector).innerText(),config.ui.rowCountPattern);
    if(finalCount!==expectedRowCount)fail('official_count_changed');
    // Blob resolution can produce events out of order. Determine the order
    // from original row numbers, without rewriting or splitting any CSV bytes.
    const ordered=await orderOfficialParts(files,directory);
    finished=true;
    return ordered;
  } catch(error) {
    if(signal?.aborted)fail('lease_lost','blocked');
    if(error instanceof SyncError)throw error;
    fail('official_download_failed');
  } finally {
    clearTimeout(deadline);
    page.removeListener('download',onDownload);
    signal?.removeEventListener('abort',abortCapture);
    if(!finished)await Promise.allSettled(downloads.map(download=>download.cancel()));
    await Promise.allSettled(saves);
  }
}
export async function collectOfficial(config, {jobId, signal, onProgress = async () => {}, openBrowser = openContext,
    prepare = prepareOfficialDownload, captureDownloads = captureGridDownloads, validateFiles = validateOriginalFiles,
    browserContext = null, manualLogin = false} = {}) {
  requireReady(config);
  safeId(jobId);
  const directory = inside(config.workDirectory, jobId);
  await fs.mkdir(directory, {recursive:true, mode:0o700});
  const previous = await readJournal(directory);
  if (previous?.jobId !== undefined && previous.jobId !== jobId) fail('journal_job_mismatch');
  if (previous && ['collected','uploaded'].includes(previous.state)) {
    validateManifest(previous.collectionManifest);
    if (previous.expectedRowCount !== previous.collectionManifest.expectedRowCount || !Array.isArray(previous.files) || previous.files.length !== 3
        || previous.files.some((file,index) => ['ordinal','name','size','sha256'].some(key => file[key] !== previous.collectionManifest.files[index][key]))) fail('journal_manifest_mismatch');
    if (previous.files.some(file => path.resolve(file.localPath) !== inside(directory, `part-${file.ordinal}${path.extname(file.name).toLowerCase()}`))) fail('unsafe_local_path');
    await validateFiles(previous.files, previous.expectedRowCount);
    return {...previous, directory, resumed:true};
  }
  let context=browserContext, expectedRowCount, files = [];
  const abortContext = () => { context?.close().catch(() => {}); };
  signal?.addEventListener('abort', abortContext, {once:true});
  try {
    checkAbort(signal);
    await writeJournal(directory, {jobId,state:'collecting',files});
    if(!context)context = await openBrowser(config,{login:manualLogin});
    context.setDefaultTimeout(config.timeoutMs);
    let page = context.pages()[0] || await context.newPage();
    if(manualLogin){
      await page.goto(config.sourceUrl,{waitUntil:'domcontentloaded',timeout:config.timeoutMs});
      await onProgress({phase:'waiting',errorCode:'MANUAL_LOGIN_REQUIRED'});
      page=await waitForManualAuthentication(context,config,signal);
    }
    expectedRowCount = await prepare(page,config,signal,name=>onProgress({phase:'waiting',errorCode:`PREPARE_${name.toUpperCase()}`}),{navigate:!manualLogin});
    await onProgress({phase:'downloading',completedFiles:0,totalFiles:3,expectedRowCount});
    files = await captureDownloads(page,directory,config,expectedRowCount,signal,onProgress);
    await writeJournal(directory,{jobId,state:'collecting',files,expectedRowCount});
    checkAbort(signal);
    await onProgress({phase:'parsing',completedFiles:3,totalFiles:3,expectedRowCount});
    const parsed = await validateFiles(files, expectedRowCount);
    files = files.map((file,index) => ({...file,...parsed.files[index]}));
    const collectionManifest = validateManifest({source:'sellpia',collectionMode:'official_download',mode:'full',includeAll:true,
      filters:[],expectedRowCount,collectedAt:new Date().toISOString(),files:files.map(({ordinal,name,size,sha256}) => ({ordinal,name,size,sha256}))});
    checkAbort(signal);
    await writeJournal(directory, {jobId,state:'collected',files,expectedRowCount,collectionManifest});
    return {jobId,state:'collected',files,expectedRowCount,collectionManifest,directory,resumed:false};
  } catch (error) {
    const caught = signal?.aborted ? new SyncError('lease_lost','blocked') : error instanceof SyncError ? error : new SyncError('collector_failed');
    await writeJournal(directory, {jobId,state:caught.state,code:caught.code,files,expectedRowCount});
    throw caught;
  } finally {
    signal?.removeEventListener('abort', abortContext);
    if (context && !browserContext) await context.close().catch(() => {});
  }
}
