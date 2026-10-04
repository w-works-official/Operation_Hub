import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const page = require('../mockups/operations-hub/channels-page.js');
const source = fs.readFileSync(new URL('../mockups/operations-hub/channels-page.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../mockups/operations-hub/channels-page.css', import.meta.url), 'utf8');

test('channel aliases normalize to the four supported source keys', () => {
  assert.equal(page.normalizeSource('NAVER_SMARTSTORE'), 'smartstore');
  assert.equal(page.normalizeSource('makeshop'), 'makeshop');
  assert.equal(page.normalizeSource('SELLPIA'), 'sellpia');
  assert.equal(page.normalizeSource('ably'), 'ably');
});

test('status and row summaries stay conservative for unknown records', () => {
  assert.deepEqual(page.eventStatus('completed'), {key:'done', label:'정상'});
  assert.deepEqual(page.eventStatus('statement timeout'), {key:'failed', label:'실패'});
  assert.deepEqual(page.eventStatus(''), {key:'unknown', label:'상태 미확인'});
  assert.equal(page.eventRowsLabel({processed_rows:40, total_rows:100}), '40 / 100행');
  assert.equal(page.eventRowsLabel({output_rows:8}), '8행');
});

test('view model fills missing sources and exposes queue review counts', () => {
  const view = page.buildViewModel({
    events:[{source:'smartstore', event_type:'SOURCE_UPLOAD', status:'completed'}],
    latest:{smartstore:{source:'smartstore', event_type:'SOURCE_UPLOAD', status:'completed'}}
  }, {pending:2, validated:3, failed:1, active:6, applied:9});
  assert.deepEqual(view.sources.map(item => item.source), ['sellpia','smartstore','makeshop','ably']);
  assert.equal(view.sources.find(item => item.source === 'smartstore').event.status, 'completed');
  assert.equal(view.sources.find(item => item.source === 'makeshop').event, null);
  assert.equal(view.queue.active, 6);
  assert.equal(view.queue.failed, 1);
});

test('channels page is read-only and only calls established read contracts', () => {
  assert.match(source, /loadSourceStatus\(\)/);
  assert.match(source, /loadChangeQueueStats\(\)/);
  assert.doesNotMatch(source, /saveSellpiaChanges|validateChangeQueue|cancelChangeQueue|retryChangeQueue|\.rpc\(/);
  assert.match(source, /이 화면에서는 쇼핑몰 갱신이나 전송을 실행하지 않습니다/);
  assert.match(source, /data-page="jobs"/);
  assert.match(css, /\.channels-source-grid/);
  assert.match(css, /\.live-data-badge\.warning/);
});
