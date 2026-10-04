import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../mockups/operations-hub/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../mockups/operations-hub/app.js', import.meta.url), 'utf8');
const data = fs.readFileSync(new URL('../mockups/operations-hub/data-service.js', import.meta.url), 'utf8');

assert.match(html, /id="matrix-page-size"[\s\S]*?value="50"[\s\S]*?value="100"[\s\S]*?value="200"/, 'users must be able to choose 50, 100, or 200 rows');
assert.match(app, /MATRIX_PAGE_SIZE_KEY[\s\S]*?\[50, 100, 200\]\.includes[\s\S]*?pageSize:initialMatrixPageSize/, 'the selected page size must be validated and restored');
assert.match(app, /pageSize:matrixState\.pageSize[\s\S]*?matrixState\.page \* matrixState\.pageSize/, 'loading and next-page bounds must use the selected size');
assert.match(app, /matrixPageSizeSelect\.addEventListener\('change'[\s\S]*?localStorage\.setItem\(MATRIX_PAGE_SIZE_KEY[\s\S]*?loadLiveMatrix\(\{resetPage:true, resetScroll:true\}\)/, 'changing the size must persist, reset pagination, and return the matrix to the top');
assert.match(data, /MATRIX_PAGE_SIZES = new Set\(\[50, 100, 200\]\)[\s\S]*?load_operations_hub_matrix_page_v3[\s\S]*?p_page_size:safePageSize/, 'the page-first RPC must accept one bounded 50, 100, or 200-row request');
assert.match(html, /id="matrix-page"[^>]*type="number"[^>]*min="1"[\s\S]*id="matrix-total-pages"/, 'the matrix footer must expose a numeric page jump input and total page count');
assert.match(app, /moveToEnteredMatrixPage[\s\S]*Math\.ceil\(matrixState\.total \/ matrixState\.pageSize\)[\s\S]*Math\.max\(1, Math\.min\(totalPages[\s\S]*event\.key === 'Enter'/, 'entered pages must be clamped to the valid range and load on Enter');
assert.match(app, /function applyViewPreset[\s\S]*?previousDataSignature !== matrixDataViewSignature\(activeView\)\) loadLiveMatrix\(\);/, 'data-changing view settings must preserve the current page while visual-only changes skip the query');
assert.match(app, /const totalPages = Math\.max\(1, Math\.ceil\(result\.count \/ result\.pageSize\)\)[\s\S]*?matrixState\.page > totalPages[\s\S]*?matrixState\.page = totalPages[\s\S]*?loadLiveMatrix\(\{resetScroll\}\)/, 'a preserved page that no longer exists must clamp to the last valid page');
assert.match(app, /matrix-prev[\s\S]*?loadLiveMatrix\(\{resetScroll:true\}\)[\s\S]*?matrix-next[\s\S]*?loadLiveMatrix\(\{resetScroll:true\}\)[\s\S]*?matrixPageInput[\s\S]*?loadLiveMatrix\(\{resetScroll:true\}\)/, 'previous, next, and entered-page navigation must request a vertical scroll reset');
assert.match(app, /if \(resetScroll && matrixShell\) matrixShell\.scrollTop = 0/, 'a successful page load must reset only the matrix vertical scroll container');

console.log('Operations hub matrix page size contract: passed');
