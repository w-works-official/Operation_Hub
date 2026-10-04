import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../mockups/operations-hub/app.js', import.meta.url), 'utf8');
const handlers = app.slice(app.indexOf('function openSellerExport('), app.indexOf("document.getElementById('matrix-match-stock-btn').addEventListener"));
const progress = app.slice(app.indexOf('function showSellerExportProgress('), app.indexOf('async function refreshSellerOriginalStates('));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
function harness({batches, refreshError = false, action = 'draft'} = {}) {
  const elements = new Map();
  const document = {getElementById(id) {
    if (!elements.has(id)) elements.set(id, {disabled:false, textContent:'', hidden:false, style:{}});
    return elements.get(id);
  }};
  const state = {running:false, action, selectedSkus:['pinned-sku'], cancelRequested:false, draftCancellable:false};
  const calls = [], notices = [], refreshed = [];
  const context = {
    document, sellerExportState:state, sellerExportModal:{hidden:false}, sellerExport:null,
    selectedExportSources:() => ['smartstore'], createRequestId:() => 'test-batch',
    formatNumber:String, showToast:text => notices.push(text), console:{error() {}},
    window:{dispatchEvent(){}},CustomEvent:class {constructor(type,options){this.type=type;this.detail=options.detail;}},
    // Draft target must use the opening snapshot, not a subsequently changed selection.
    selectedMatrixSkus:() => ['wrong-new-selection'],
    liveData:{stageSellerInventoryDraftBatch:async args => {
      calls.push(args);
      return batches[calls.length - 1];
    }},
    loadLiveMatrix:async () => { refreshed.push('matrix'); if (refreshError) throw new Error('refresh failed'); },
    loadChangeQueue:async () => { refreshed.push('queue'); },
    loadLiveDashboardMetrics:async () => { refreshed.push('dashboard'); }
  };
  vm.createContext(context);
  vm.runInContext(progress + handlers + '\nthis.api = {runSellerExport, closeSellerExport, openSellerExport};', context);
  return {state, calls, notices, refreshed, ...context.api, node:id => document.getElementById(`seller-export-${id}`), modal:context.sellerExportModal};
}
const result = (more = true) => ({processed_count:100, total_count:300, staged_count:43, cancelled_count:2, next_cursor:more ? '100' : null, has_more:more});

// Cancel during an outstanding RPC: do not hide the modal, abort the transaction,
// send a second batch, or discard the saved count when the first RPC completes.
{
  const batch = deferred();
  const h = harness({batches:[batch.promise]});
  h.state.selectedSkus = [];
  const running = h.runSellerExport();
  assert.equal(h.node('cancel').disabled, false);
  assert.equal(h.node('close').disabled, true);
  h.closeSellerExport();
  h.closeSellerExport();
  assert.equal(h.state.cancelRequested, true);
  assert.equal(h.modal.hidden, false);
  assert.match(h.node('progress-title').textContent, /中断|중단 요청/);
  await h.runSellerExport();
  h.openSellerExport({action:'export'});
  assert.equal(h.calls.length, 1, 'duplicate run must be ignored');
  assert.equal(h.state.action, 'draft', 'reopening cannot change an active run');
  batch.resolve(result());
  await running;
  assert.equal(h.calls.length, 1, 'no remaining batch may run after cancellation');
  assert.match(h.node('progress-title').textContent, /생성 중단/);
  assert.match(h.node('progress-detail').textContent, /100 \/ 300.*43건 저장·유지.*2건은 교체/);
  assert.equal(h.node('progress-percent').textContent, '33%');
  assert.equal(h.refreshed.length, 3);
  assert.equal(h.state.running, false);
  assert.equal(h.node('run').disabled, false);
  h.closeSellerExport();
  assert.equal(h.modal.hidden, true);
}
// Normal completion, pinned selection, and subsequent runs reset cancellation.
{
  const h = harness({batches:[result(), result(false), result(false)]});
  await h.runSellerExport();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(Array.from(h.calls[0].skus), ['pinned-sku']);
  assert.equal(h.calls[1].afterSku, '100');
  assert.match(h.node('progress-title').textContent, /생성 완료/);
  assert.match(h.node('progress-detail').textContent, /86건/);
  h.state.cancelRequested = true;
  await h.runSellerExport();
  assert.equal(h.calls.length, 3);
}
// A cancellation received during the last batch cannot claim unprocessed rows.
{
  const batch = deferred();
  const h = harness({batches:[batch.promise]});
  const running = h.runSellerExport();
  h.closeSellerExport();
  batch.resolve(result(false));
  await running;
  assert.match(h.node('progress-title').textContent, /생성 완료/);
  assert.match(h.node('progress-detail').textContent, /남은 작업은 없습니다/);
}
// A failed refresh must not relabel saved work as failed or restart processing.
{
  const batch = deferred();
  const h = harness({batches:[batch.promise], refreshError:true});
  const running = h.runSellerExport();
  h.closeSellerExport();
  batch.resolve(result());
  await running;
  assert.match(h.node('progress-title').textContent, /생성 중단/);
  assert.ok(h.notices.some(text => /화면 갱신에 실패/.test(text)));
}
// Lost RPC acknowledgement is not proof of rollback or successful cancellation.
{
  const batch = deferred();
  const h = harness({batches:[result(), batch.promise]});
  const running = h.runSellerExport();
  await new Promise(resolve => setImmediate(resolve));
  h.closeSellerExport();
  batch.reject(new Error('connection lost'));
  await running;
  assert.match(h.node('progress-title').textContent, /생성 실패/);
  assert.match(h.node('progress-detail').textContent, /100 SKU \/ 수정안 43건.*마지막 요청의 반영 여부/);
  assert.equal(h.node('cancel').disabled, false);
  assert.equal(h.calls.length, 2);
}
// The shared close handler does not misrepresent ZIP export as cancellable.
{
  const h = harness({action:'export'});
  h.state.running = true;
  h.closeSellerExport();
  assert.equal(h.modal.hidden, false);
  assert.equal(h.state.cancelRequested, false);
}
assert.match(app, /'seller-export-cancel'\)\.addEventListener\('click', closeSellerExport\)/);
assert.match(app, /'seller-export-close'\)\.addEventListener\('click', closeSellerExport\)/);
assert.match(app, /event.key === 'Escape' && !sellerExportModal.hidden\) closeSellerExport\(\)/);
console.log('Inventory draft cancellation: 6 async scenarios and cancel/close/Escape bindings passed');
