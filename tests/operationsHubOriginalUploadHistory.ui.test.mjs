import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium} from 'playwright';

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const html = read('mockups/operations-hub/index.html');
const app = read('mockups/operations-hub/app.js');
const moduleSource = read('mockups/operations-hub/original-upload-history.js');
const css = read('mockups/operations-hub/original-upload-history.css');
let browser;

before(async () => {
  browser = await chromium.launch({headless:true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}
      : process.platform === 'win32' ? {channel:'msedge'} : {})});
});
after(async () => { await browser?.close(); });

async function fixture() {
  const page = await browser.newPage({timezoneId:'America/Los_Angeles', viewport:{width:1100,height:850}});
  const panel = html.match(/<aside id="original-upload-history"[\s\S]*?<\/aside>/)?.[0];
  assert.ok(panel, 'production HTML must provide the actual history panel');
  await page.setContent(`<section id="upload">${panel}</section><style>${css}</style>`);
  await page.evaluate(() => {
    window.historyCalls = [];
    window.historyQueue = [];
    window.historyPending = [];
    window.SystemV3Data = {loadOriginalUploadHistory:async options => {
      window.historyCalls.push({limit:options.limit, offset:options.offset, signal:options.signal});
      const result = window.historyQueue.shift();
      if (result?.defer) return new Promise(resolve => window.historyPending.push(resolve));
      if (result?.error) throw Error(result.error);
      return result || {rows:[],hasMore:false};
    }};
  });
  await page.addScriptTag({content:moduleSource});
  return page;
}

const row = (id, overrides = {}) => ({id, snapshotId:id, source:'smartstore', fileNames:['원본.xlsx'], fileCount:1,
  uploadedRows:14698, effectiveRows:16965, invalidRows:0, status:'ready', uploadMode:'patch',
  createdAt:'2026-10-20T02:34:05.000Z', completedAt:'2026-10-20T02:35:01.000Z', errorMessage:'', ...overrides});

test('history waits for verified login and renders actual counts, absolute KST dates, statuses and escaped file names', async () => {
  const page = await fixture();
  try {
    await page.evaluate(async () => { await window.SystemV3OriginalUploadHistory.refresh(); });
    assert.equal(await page.evaluate(() => window.historyCalls.length), 0);
    assert.equal(await page.locator('#original-upload-history-refresh').isDisabled(), true);
    await page.evaluate(rows => window.historyQueue.push({rows,hasMore:false}), [
      row('ready', {fileNames:['<img src=x onerror="window.injected=true">.xlsx']}),
      row('failed', {source:'sellpia',status:'failed',uploadedRows:0,effectiveRows:40000,errorMessage:'<script>업로드 실패</script>'}),
      row('uploading', {status:'uploading',fileCount:null,uploadedRows:null,effectiveRows:null,completedAt:null,fileNames:[]}),
      row('archived', {status:'archived'}), row('unknown', {status:'unexpected',createdAt:null,completedAt:null})
    ]);
    await page.evaluate(async () => { window.SystemV3OriginalUploadHistory.activate(); await window.SystemV3OriginalUploadHistory.refresh(); });
    const text = await page.locator('#original-upload-history-list').innerText();
    assert.match(text, /파일 1개 · 업로드 14,698행 · 반영 후 총 16,965행/);
    assert.match(text, /시작 2026\.10\.20 11:34:05 KST/);
    assert.match(text, /완료 2026\.10\.20 11:35:01 KST/);
    assert.match(text, /처리 56초/);
    assert.match(text, /파일 수 확인 불가 · 대상 행 수 확인 불가/);
    assert.match(text, /파일명 확인 불가/);
    assert.match(text, /보관됨/);
    assert.match(text, /확인 필요/);
    const failed = page.locator('[data-upload-id="failed"]');
    assert.match(await failed.innerText(), /파일 1개 · 대상 0행/);
    assert.match(await failed.innerText(), /종료 2026\.10\.20 11:35:01 KST/);
    assert.doesNotMatch(await failed.innerText(), /反映|반영 후|완료/);
    assert.equal(await page.locator('#original-upload-history-list img, #original-upload-history-list script').count(), 0);
    assert.equal(await page.locator('[data-upload-id="ready"] time').first().getAttribute('datetime'), '2026-10-20T02:34:05.000Z');
    assert.match(await page.locator('[data-upload-id="ready"] .upload-history-files').getAttribute('title'), /<img/);
    assert.equal(await page.locator('#original-upload-history').getAttribute('aria-busy'), 'false');
    assert.equal(await page.locator('#original-upload-history-status').getAttribute('aria-live'), 'polite');
    assert.deepEqual(await page.evaluate(() => window.historyCalls.map(({limit,offset}) => ({limit,offset}))), [{limit:6,offset:0}]);
  } finally { await page.close(); }
});

test('history pagination appends real records and refresh resets to the recent list', async () => {
  const page = await fixture();
  try {
    await page.evaluate(rows => window.historyQueue.push({rows,hasMore:true}), Array.from({length:6},(_,index)=>row(`recent-${index}`)));
    await page.evaluate(async () => { window.SystemV3OriginalUploadHistory.activate(); await window.SystemV3OriginalUploadHistory.refresh(); });
    assert.equal(await page.locator('#original-upload-history-more').isVisible(), true);
    // A new upload can shift offset pages so the last recent row reappears.
    await page.evaluate(rows => window.historyQueue.push({rows,hasMore:true}), [row('recent-5'),row('older')]);
    await page.locator('#original-upload-history-more').click();
    await page.waitForFunction(() => document.querySelectorAll('#original-upload-history-list article').length === 7);
    assert.equal(await page.locator('#original-upload-history-title').innerText(), '업로드 이력');
    assert.equal(await page.locator('[data-upload-id="recent-5"]').count(), 1);
    assert.equal(await page.locator('#original-upload-history-more').isVisible(), true);
    assert.deepEqual(await page.evaluate(() => window.historyCalls.map(({limit,offset}) => ({limit,offset}))), [{limit:6,offset:0},{limit:20,offset:6}]);
    await page.evaluate(value => window.historyQueue.push({rows:[value],hasMore:false}), row('oldest'));
    await page.locator('#original-upload-history-more').click();
    await page.waitForFunction(() => document.querySelectorAll('#original-upload-history-list article').length === 8);
    assert.equal(await page.locator('#original-upload-history-more').isVisible(), false);
    assert.deepEqual(await page.evaluate(() => window.historyCalls.map(({limit,offset}) => ({limit,offset}))), [{limit:6,offset:0},{limit:20,offset:6},{limit:20,offset:8}]);
    await page.evaluate(value => window.historyQueue.push({rows:[value],hasMore:false}), row('fresh'));
    await page.locator('#original-upload-history-refresh').click();
    await page.waitForFunction(() => document.querySelector('[data-upload-id="fresh"]'));
    assert.equal(await page.locator('#original-upload-history-list article').count(), 1);
    assert.equal(await page.locator('#original-upload-history-title').innerText(), '최근 업로드');
    assert.equal(await page.locator('#original-upload-history-more').getAttribute('data-page'), null);
  } finally { await page.close(); }
});

test('read errors visibly replace stale success data and empty history never uses example entries', async () => {
  const page = await fixture();
  try {
    await page.evaluate(value => window.historyQueue.push({rows:[value],hasMore:true}), row('stale'));
    await page.evaluate(async () => { window.SystemV3OriginalUploadHistory.activate(); await window.SystemV3OriginalUploadHistory.refresh(); });
    await page.evaluate(() => window.historyQueue.push({error:'DB 연결 확인 필요'}));
    const success = await page.evaluate(() => window.SystemV3OriginalUploadHistory.refresh());
    assert.equal(success, false);
    assert.equal(await page.locator('#original-upload-history-list article').count(), 0);
    assert.match(await page.locator('#original-upload-history-list').innerText(), /업로드 이력을 불러오지 못했습니다.*DB 연결 확인 필요/);
    assert.equal(await page.locator('#original-upload-history-more').isVisible(), false);
    assert.equal(await page.locator('#original-upload-history-refresh').isDisabled(), false);
    await page.evaluate(async () => { await window.SystemV3OriginalUploadHistory.refresh(); });
    assert.match(await page.locator('#original-upload-history-list').innerText(), /등록된 업로드 이력이 없습니다/);
    assert.doesNotMatch(await page.locator('#original-upload-history').innerText(), /27,223|11:39|34%/);
  } finally { await page.close(); }
});

test('logout aborts requests, clears records and discards late replies even when the transport ignores abort', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      window.historyQueue.push({defer:true});
      window.SystemV3OriginalUploadHistory.activate();
      window.pendingLoad = window.SystemV3OriginalUploadHistory.refresh();
    });
    assert.equal(await page.locator('#original-upload-history').getAttribute('aria-busy'), 'true');
    await page.evaluate(() => window.SystemV3OriginalUploadHistory.reset());
    assert.equal(await page.evaluate(() => window.historyCalls[0].signal.aborted), true);
    await page.evaluate(async value => { window.historyPending.shift()({rows:[value],hasMore:true}); await window.pendingLoad; }, row('late'));
    assert.equal(await page.locator('#original-upload-history-list article').count(), 0);
    assert.match(await page.locator('#original-upload-history-list').innerText(), /로그인 후/);
    await page.evaluate(async () => { await window.SystemV3OriginalUploadHistory.refresh(); });
    assert.equal(await page.evaluate(() => window.historyCalls.length), 1);
    assert.equal(await page.locator('#original-upload-history-refresh').isDisabled(), true);
    assert.equal(await page.locator('#original-upload-history').getAttribute('aria-busy'), 'false');
  } finally { await page.close(); }
});

test('newer refresh wins over an older successful response', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      window.historyQueue.push({defer:true});
      window.SystemV3OriginalUploadHistory.activate();
      window.firstLoad = window.SystemV3OriginalUploadHistory.refresh();
    });
    await page.evaluate(value => window.historyQueue.push({rows:[value],hasMore:false}), row('newest'));
    await page.evaluate(async () => { await window.SystemV3OriginalUploadHistory.refresh(); });
    await page.evaluate(async value => { window.historyPending.shift()({rows:[value],hasMore:true}); await window.firstLoad; }, row('old-response'));
    assert.equal(await page.locator('[data-upload-id="newest"]').count(), 1);
    assert.equal(await page.locator('[data-upload-id="old-response"]').count(), 0);
  } finally { await page.close(); }
});

test('application hooks include verified login, logout/expiry, navigation, global refresh and every upload outcome', () => {
  assert.match(app, /function stopAuthenticatedOperationsHubData\(\)\s*\{\s*window\.SystemV3OriginalUploadHistory\?\.reset\(\)/);
  assert.match(app, /function startAuthenticatedOperationsHubData[\s\S]*?SystemV3OriginalUploadHistory\?\.activate\(\)[\s\S]*?refreshLiveData/);
  assert.match(app.slice(app.indexOf('async function refreshLiveData'), app.indexOf('async function refreshMatrixSkus')), /SystemV3OriginalUploadHistory\.refresh\(\)/);
  const refresh = app.slice(app.indexOf('async function refreshLiveData'), app.indexOf('async function refreshMatrixSkus'));
  assert.ok(refresh.indexOf('SystemV3OriginalUploadHistory.refresh()') < refresh.indexOf('await loadLiveMatrix'), 'history reads must start even when the Matrix read fails');
  assert.match(app, /if \(pageId === 'upload'\) void window\.SystemV3OriginalUploadHistory\?\.refresh\(\)/);
  const upload = app.slice(app.indexOf("uploadButton.addEventListener('click'"), app.indexOf('let toastTimer'));
  assert.match(upload, /finally\s*\{[\s\S]*?setUploadCapability\(\);\s*void window\.SystemV3OriginalUploadHistory\?\.refresh\(\)/);
  assert.doesNotMatch(html, /27,223행|오늘 11:39|오늘 11:34|오늘 12:26|어제 17:42/);
  assert.match(html, /original-upload-history\.js\?v=20261020-upload-history-v1/);
});
