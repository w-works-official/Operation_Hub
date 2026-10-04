import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const service = fs.readFileSync(new URL('../mockups/operations-hub/data-service.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../mockups/operations-hub/app.js', import.meta.url), 'utf8');

function queueReader({pageError = null, auditError = null} = {}) {
  const calls = [];
  const row = {change_id:7, status:'validated', sellpia_sku_code:'5566-1'};
  const db = {from(table) {
    calls.push(table);
    const query = {
      select() { return this; }, order() { return this; }, limit() { return this; },
      in() { return this; }, eq() { return this; }, overlaps() { return this; }, contains() { return this; },
      then(resolve, reject) {
        const result = table === 'operations_hub_change_queue'
          ? {data:pageError ? null : [row], count:pageError ? null : 1, error:pageError}
          : {data:auditError ? null : [{change_id:7,status:'exported',updated_at:'2026-09-21T00:00:00Z'}], error:auditError};
        return Promise.resolve(result).then(resolve, reject);
      }
    };
    return query;
  }};
  const warnings = [];
  const context = {db, cleanText:value=>String(value??'').trim(), console:{warn:(...args)=>warnings.push(args)}};
  vm.createContext(context);
  const start = service.indexOf('  async function attachChangeExportAudit(');
  const end = service.indexOf('  async function loadChangeBatchSummaries(', start);
  assert.ok(start > 0 && end > start);
  vm.runInContext(service.slice(start,end)+'\nthis.readQueue=loadChangeQueue;', context);
  return {read:context.readQueue,calls,warnings};
}

test('optional file-audit timeout retains the queue page without claiming export proof', async () => {
  const reader = queueReader({auditError:{message:'canceling statement due to statement timeout'}});
  const result = await reader.read();
  assert.equal(result.count,1);
  assert.equal(result.rows.length,1);
  assert.equal(result.rows[0].sellpia_sku_code,'5566-1');
  assert.equal(result.rows[0].has_exported_file,undefined);
  assert.match(result.auditError,/statement timeout/);
  assert.deepEqual(reader.calls,['operations_hub_change_queue','operations_hub_export_items']);
  assert.equal(reader.warnings.length,1);
});

test('successful file audit still supplies confirmation proof', async () => {
  const result = await queueReader().read();
  assert.equal(result.auditError,'');
  assert.equal(result.rows[0].has_exported_file,true);
  assert.equal(result.rows[0].exported_file_count,1);
});

test('primary queue read errors still fail explicitly', async () => {
  const reader = queueReader({pageError:{message:'canceling statement due to statement timeout'}});
  await assert.rejects(reader.read(),{message:/statement timeout/});
  assert.deepEqual(reader.calls,['operations_hub_change_queue']);
});

test('failed UI refresh keeps prior rows visible, disables their actions, and exposes retry', async () => {
  const start = app.indexOf('async function loadChangeQueue({silent = false} = {})');
  const end = app.indexOf('async function openQueueEvents(', start);
  assert.ok(start > 0 && end > start);
  const badge = {className:'',textContent:'',title:''};
  const checkbox = {checked:true,disabled:false};
  const queueBody = {innerHTML:'previous rows',querySelectorAll:()=>[checkbox]};
  const queueState = {rows:[{change_id:7}],loading:false,stale:false,selectedBatchId:null};
  const nodes = new Map([['queue-live-status',badge],['queue-status-filter',{value:'active'}],['queue-source-filter',{value:'all'}]]);
  let selectionUpdated = 0;
  const context = {
    queueState, queueBody,
    liveData:{loadChangeQueue:async()=>{throw Error('canceling statement due to statement timeout');}},
    document:{getElementById:id=>nodes.get(id)},
    window:{__systemV3DirectExportBusy:false},
    updateQueueSelection:()=>{selectionUpdated++;},
    queueScopeSources:()=>[],
    console:{error:()=>{}},
    escapeHtml:value=>String(value)
  };
  vm.createContext(context);
  vm.runInContext(app.slice(start,end)+'\nthis.readQueue=loadChangeQueue;',context);
  await context.readQueue();
  assert.equal(queueBody.innerHTML,'previous rows');
  assert.equal(queueState.rows.length,1);
  assert.equal(queueState.loading,false);
  assert.equal(queueState.stale,true);
  assert.equal(checkbox.checked,false);
  assert.equal(checkbox.disabled,true);
  assert.ok(selectionUpdated > 0);
  assert.match(badge.textContent,/이전 목록 유지/);
  assert.match(badge.title,/새로고침으로 다시 조회/);
});
