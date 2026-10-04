import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const html = read('mockups/operations-hub/index.html');
const app = read('mockups/operations-hub/app.js');
const data = read('mockups/operations-hub/data-service.js');
const css = read('mockups/operations-hub/operations-auth.css');

assert.match(html, /<body class="operations-auth-locked">[\s\S]*?id="operations-auth-gate"[\s\S]*?id="operations-app-shell"[^>]*aria-hidden="true"[^>]*inert/);
assert.match(html, /id="operations-auth-form"[\s\S]*?id="operations-auth-username"[^>]*autocomplete="username"[\s\S]*?id="operations-auth-password"[^>]*type="password"[^>]*autocomplete="current-password"/);
assert.match(html, /id="operations-auth-error"[^>]*role="alert"[\s\S]*?id="operations-auth-status"[^>]*aria-live="polite"/);
assert.match(html, /로그인에 여러 차례 실패하면[^<]*잠시 잠길 수 있습니다[\s\S]*?세션이 만료되거나 회수되면 다시 로그인/);
assert.match(html, /id="operations-auth-logout"[^>]*>로그아웃/);
assert.doesNotMatch(html, /id="operations-auth-(?:username|password)"[^>]*\svalue=/, 'credentials must never be embedded in the page');
assert.match(html, /operations-auth\.css\?v=[^"\s]+/);
assert.match(css, /\.operations-auth-gate[\s\S]*?position:\s*fixed[\s\S]*?z-index:\s*10000/);
assert.match(css, /body\.operations-auth-locked[\s\S]*?#operations-app-shell[\s\S]*?visibility:\s*hidden/);

assert.match(app, /OPERATIONS_AUTH_STORAGE_KEY = 'system-v3-operations-session-v1'/);
assert.match(app, /sessionStorage\.getItem\(OPERATIONS_AUTH_STORAGE_KEY\)[\s\S]*?sessionStorage\.setItem\(OPERATIONS_AUTH_STORAGE_KEY[\s\S]*?sessionStorage\.removeItem\(OPERATIONS_AUTH_STORAGE_KEY\)/);
assert.doesNotMatch(app, /localStorage\.(?:getItem|setItem|removeItem)\(OPERATIONS_AUTH_STORAGE_KEY\)/, 'the operations token must never use localStorage');
assert.match(app, /initializeOperationsHubAuth[\s\S]*?checkOperationsHubSession\(stored\.token\)[\s\S]*?openAuthenticatedOperationsHub/);
assert.match(app, /startAuthenticatedOperationsHubData[\s\S]*?refreshLiveData\(\{resetPage:true\}\)/);
assert.match(app, /if \(liveData\) \{\s*initializeOperationsHubAuth\(\);/, 'initial DB reads must wait for an authenticated session check');
assert.match(app, /operations-hub-auth-required[\s\S]*?showOperationsAuthGate/);
assert.match(app, /reason === 'rate_limited'[\s\S]*?reason === 'expired_session'[\s\S]*?reason === 'revoked_session'[\s\S]*?reason === 'permission_denied'/);

assert.match(data, /async function loginOperationsHub[\s\S]*?db\.rpc\('operations_hub_login_v1',[\s\S]*?p_username:safeUsername[\s\S]*?p_password:safePassword/);
assert.match(data, /async function checkOperationsHubSession[\s\S]*?db\.rpc\('operations_hub_check_session_v1', \{p_session_token:safeToken\}\)/);
assert.match(data, /async function logoutOperationsHub[\s\S]*?db\.rpc\('operations_hub_logout_v1', \{p_session_token:safeToken\}\)[\s\S]*?finally[\s\S]*?setOperationsHubSessionToken\(''\)/);
assert.match(data, /save_operations_hub_sku_operational_value'[\s\S]*?p_session_token:requireOperationsHubSessionToken\(\)/);
assert.match(data, /const params = \{\s*p_session_token:requireOperationsHubSessionToken\(\),[\s\S]*?refresh_operations_hub_master_column_from_source_v1/);
assert.match(data, /function notifyOperationsHubAuthRequired[\s\S]*?operations-hub-auth-required/);
assert.match(data, /String\(error\.code \|\| ''\) === '42501'[\s\S]*?operationsHubAuthError/);
assert.doesNotMatch(data, /console\.(?:log|warn|error)\([^\n]*(?:safePassword|operationsHubSessionToken|p_session_token)/, 'credentials and session tokens must not be logged');

console.log('Operations hub shared operator login frontend contract: passed');
