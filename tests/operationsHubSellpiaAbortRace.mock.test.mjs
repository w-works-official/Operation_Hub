import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const edge = fs.readFileSync('supabase/functions/operations-hub-original-files/index.ts', 'utf8');
const abortSource = edge.slice(edge.indexOf('async function abortUpload('), edge.indexOf('\nfunction validateStoredPath('))
  .replace('(sessionToken: string, body: Record<string, unknown>)', '(sessionToken, body)');
assert.ok(abortSource.startsWith('async function abortUpload('), 'execute the current Edge abort implementation');

const snapshotId = '00000000-0000-4000-8000-000000000076';
const intentId = '00000000-0000-4000-8000-000000000077';
const session = 'a'.repeat(64);
const manifest = [
  {path: `sellpia/${snapshotId}/inventory-01.xlsx`},
  {path: `sellpia/${snapshotId}/inventory-02.xlsx`},
  {path: 'sellpia/unrelated-snapshot/original.xlsx'},
];
const readyError = () => Object.assign(new Error('ready snapshot은 실패/cleanup 상태로 변경할 수 없습니다.'), {code: '55000'});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}

function harness({initialStatus = 'parsing', removeError = null, transitionError = null} = {}) {
  const state = {intentStatus: initialStatus, snapshotStatus: initialStatus === 'ready' ? 'ready' : 'uploading', rows: 76};
  const calls = [];
  const statusRead = deferred();
  const transitionRequested = deferred();
  const storageStarted = deferred();
  let pendingLock = Promise.resolve();
  let remainingRemoveError = removeError;
  let storageGate = null;

  // Emulate the intent FOR UPDATE contract: completion and failure transitions
  // queue on one lock, while a status SELECT sees the last committed state.
  function withIntentLock(callback) {
    const release = deferred();
    const previous = pendingLock;
    pendingLock = previous.then(() => release.promise);
    return previous.then(callback).finally(() => release.resolve());
  }

  const guardClient = {async rpc(name, params) {
    assert.equal(params.p_session_token, session);
    assert.equal(params.p_intent_id, intentId);
    calls.push(name);
    if (name === 'hub_original_upload_intent_status_v1') {
      const result = {intent_id: intentId, snapshot_id: snapshotId, status: state.intentStatus, manifest};
      statusRead.resolve(result);
      return {data: result, error: null};
    }
    assert.equal(name, 'hub_original_upload_intent_fail_v1');
    assert.equal(params.p_aborted, true);
    transitionRequested.resolve();
    return withIntentLock(async () => {
      if (transitionError) return {data: null, error: transitionError};
      if (state.intentStatus === 'ready') return {data: null, error: readyError()};
      state.intentStatus = 'aborted';
      if (state.snapshotStatus === 'uploading') state.snapshotStatus = 'failed';
      return {data: {intent_id: intentId, snapshot_id: snapshotId, status: 'aborted', manifest}, error: null};
    });
  }};
  const adminClient = {storage: {from(bucket) {
    assert.equal(bucket, 'seller-originals');
    return {async remove(paths) {
      calls.push({storageRemove: [...paths]});
      storageStarted.resolve();
      if (storageGate) await storageGate.promise;
      const error = remainingRemoveError;
      remainingRemoveError = null;
      return {error};
    }};
  }}};
  const context = {guardClient, adminClient, BUCKET: 'seller-originals',
    cleanText: value => String(value ?? '').trim(), asArray: value => Array.isArray(value) ? value : []};
  vm.createContext(context);
  vm.runInContext(abortSource, context);

  return {state, calls, statusRead, transitionRequested, storageStarted,
    abort: () => context.abortUpload(session, {intent_id: intentId, reason: 'canceling statement due to statement timeout', path: 'sellpia/unrelated-snapshot/original.xlsx'}),
    pauseStorage: () => {storageGate = deferred(); return storageGate;},
    async complete({gate = null, entered = null, timeout = false, loseResponse = false} = {}) {
      const result = await withIntentLock(async () => {
        entered?.resolve();
        if (gate) await gate.promise;
        if (timeout) throw Object.assign(new Error('canceling statement due to statement timeout'), {code: '57014'});
        if (!['uploaded', 'parsing'].includes(state.intentStatus)) throw Object.assign(new Error('완료 가능한 업로드 상태가 아닙니다.'), {code: '55000'});
        state.intentStatus = 'ready';
        state.snapshotStatus = 'ready';
        return {status: 'ready'};
      });
      if (loseResponse) throw new Error('network connection closed after commit');
      return result;
    },
  };
}

test('completion wins after a stale parsing status read: lost response never deletes ready originals', async () => {
  const h = harness();
  const gate = deferred();
  const entered = deferred();
  const completion = h.complete({gate, entered, loseResponse: true});
  const completionRejected = assert.rejects(completion, /network connection closed after commit/);
  await entered.promise;
  const aborted = h.abort();
  const abortRejected = assert.rejects(aborted, error => error.code === '55000');
  await h.transitionRequested.promise;
  assert.equal((await h.statusRead.promise).status, 'parsing');
  assert.equal(h.calls.filter(call => call.storageRemove).length, 0, 'cleanup must wait for the locked transition');
  gate.resolve();
  await completionRejected;
  await abortRejected;
  assert.equal(h.state.intentStatus, 'ready');
  assert.equal(h.state.snapshotStatus, 'ready');
  assert.equal(h.state.rows, 76);
  assert.equal(h.calls.filter(call => call.storageRemove).length, 0);
});

test('abort wins the intent lock: DB becomes failed before Storage and later completion cannot promote it', async () => {
  const h = harness();
  const storageGate = h.pauseStorage();
  const aborted = h.abort();
  await h.storageStarted.promise;
  assert.equal(h.state.intentStatus, 'aborted');
  assert.equal(h.state.snapshotStatus, 'failed');
  await assert.rejects(h.complete(), error => error.code === '55000');
  storageGate.resolve();
  const result = await aborted;
  assert.equal(result.status, 'aborted');
  assert.equal(result.removed_paths, 2);
  assert.equal(result.boundary, 'signed-upload-v1');
  assert.deepEqual(h.calls.find(call => call.storageRemove).storageRemove, manifest.slice(0, 2).map(file => file.path));
  assert.equal(h.state.rows, 76, 'audit rows remain stored; cleanup only removes authorized originals');
});

test('Storage failure leaves an aborted/failed intent that safely retries cleanup', async () => {
  const h = harness({removeError: Object.assign(new Error('Storage unavailable'), {code: '503'})});
  await assert.rejects(h.abort(), /Storage unavailable/);
  assert.equal(h.state.intentStatus, 'aborted');
  assert.equal(h.state.snapshotStatus, 'failed');
  await assert.rejects(h.complete(), error => error.code === '55000');
  const result = await h.abort();
  assert.equal(result.status, 'aborted');
  assert.equal(result.removed_paths, 2);
  assert.equal(h.calls.filter(call => call.storageRemove).length, 2);
  assert.equal(h.state.rows, 76);
});

test('timeout while completion holds the intent: abort waits, then records failure and cleans originals', async () => {
  const h = harness();
  const gate = deferred();
  const entered = deferred();
  const completion = h.complete({gate, entered, timeout: true});
  const completionRejected = assert.rejects(completion, error => error.code === '57014');
  await entered.promise;
  const aborted = h.abort();
  await h.transitionRequested.promise;
  assert.equal(h.calls.filter(call => call.storageRemove).length, 0);
  gate.resolve();
  await completionRejected;
  const result = await aborted;
  assert.equal(result.status, 'aborted');
  assert.equal(h.state.snapshotStatus, 'failed');
  assert.equal(h.state.rows, 76);
  assert.equal(h.calls.filter(call => call.storageRemove).length, 1);
});

test('ready initial status and failed DB transition both refuse all Storage deletion', async () => {
  const ready = harness({initialStatus: 'ready'});
  await assert.rejects(ready.abort(), error => error.code === '55000');
  assert.equal(ready.calls.length, 1);
  assert.equal(ready.calls.filter(call => call.storageRemove).length, 0);
  const denied = harness({transitionError: Object.assign(new Error('lock timeout'), {code: '55P03'})});
  await assert.rejects(denied.abort(), error => error.code === '55P03');
  assert.equal(denied.state.snapshotStatus, 'uploading');
  assert.equal(denied.calls.filter(call => call.storageRemove).length, 0);
});
