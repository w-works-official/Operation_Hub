import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../mockups/operations-hub/app.js', import.meta.url), 'utf8');
const data = fs.readFileSync(new URL('../mockups/operations-hub/data-service.js', import.meta.url), 'utf8');

assert.match(app, /MATRIX_SEARCH_DEBOUNCE_MS = 120;[\s\S]*?MATRIX_TRANSIENT_RETRY_DELAYS_MS = \[700\]/, 'matrix search must settle before loading and use at most one short retry');
assert.match(app, /matrixDataViewSignature\([\s\S]*?status:[\s\S]*?sort:[\s\S]*?excludeCombinationSkus:[\s\S]*?advancedFilter:[\s\S]*?previousDataSignature !== matrixDataViewSignature\(activeView\)/, 'visual-only preset changes must not reload matrix data');
assert.match(app, /matrixState\.requestController\?\.abort\(\)[\s\S]*?new AbortController\(\)[\s\S]*?signal:requestController\.signal/, 'a new matrix load must cancel the previous in-flight request');
assert.match(app, /requestId !== matrixState\.requestId \|\| isMatrixAbortError\(error\)\) return false;[\s\S]*?DB 조회 지연/, 'stale or intentionally aborted requests must not surface as database errors');
assert.match(app, /codeListSearchInput\.addEventListener\('keydown'[\s\S]*?event\.key !== 'Enter'[\s\S]*?clearTimeout\(matrixSearchTimer\)[\s\S]*?loadLiveMatrix\(\{resetPage:true\}\)/, 'Enter must run the current search immediately without leaving the debounce queued');
assert.match(app, /MAPPING_SYNC_POLL_INTERVAL_MS = 60000[\s\S]*?document\.hidden \|\| !dashboardVisible \|\| matrixState\.loading[\s\S]*?loadMappingSyncStatus\(\{autoRefresh:true\}\)/, 'mapping status polling must be slow and pause while hidden or loading');
assert.match(data, /function withAbortSignal\(query, signal\)[\s\S]*?query\.abortSignal\(signal\)/, 'Supabase builders must receive the browser AbortSignal');
assert.match(data, /async function attachProductMetadata\(rows, signal\)[\s\S]*?load_operations_hub_matrix_metadata_v1[\s\S]*?for \(const \[attach, prefetched\] of steps\)[\s\S]*?throwIfAborted\(signal\)/, 'one metadata request must remain cancellable before every local projection step');
assert.match(data, /async function loadProducts\(\{[\s\S]*?signal = null[\s\S]*?withAbortSignal\(db\.rpc\('load_operations_hub_matrix_page_v3'[\s\S]*?\}\), signal\)[\s\S]*?attachProductMetadata\(rows, signal\)/, 'page-first matrix and enrichment reads must share the same cancellation signal');

console.log('operations hub matrix request stability contract tests passed');
