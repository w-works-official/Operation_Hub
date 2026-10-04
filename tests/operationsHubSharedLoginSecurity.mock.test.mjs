import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const migrationPath = 'supabase/migrations/20260903021316_operations_hub_operational_master_source_refresh_v7.sql';
const migration = read(migrationPath);
const html = read('mockups/operations-hub/index.html');
const app = read('mockups/operations-hub/app.js');
const dataService = read('mockups/operations-hub/data-service.js');

function sqlFunction(source, qualifiedName) {
  const start = source.search(new RegExp(`create or replace function ${qualifiedName.replaceAll('.', '\\.')}`, 'i'));
  assert.notEqual(start, -1, `${qualifiedName} must exist`);
  const tail = source.slice(start);
  const next = tail.slice(1).search(/\ncreate or replace function /i);
  return next === -1 ? tail : tail.slice(0, next + 1);
}

test('tracked source contains no high-confidence private credentials or seeded shared password', () => {
  const tracked = execFileSync('git', ['ls-files', '-z'], {cwd:root, encoding:'utf8'})
    .split('\0')
    .filter(Boolean);
  const findings = [];
  const secretPatterns = [
    ['Supabase secret key', /sb_secret_[A-Za-z0-9_-]{8,}/g],
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
    ['credentialed database URL', /postgres(?:ql)?:\/\/[^:\s/'"]+:[^@\s/'"]+@/gi],
    ['hard-coded Operations Hub login secret', /(?:OPERATIONS_HUB|OPERATIONS_AUTH|SHARED_OPERATOR)_[A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN)\s*[:=]\s*['"][^'"]{4,}['"]/g]
  ];

  for (const relative of tracked) {
    let source;
    try {
      source = read(relative);
    } catch {
      continue;
    }
    for (const [label, pattern] of secretPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(source)) findings.push(`${relative}: ${label}`);
    }
  }

  assert.deepEqual(findings, [], `private credentials must not be committed:\n${findings.join('\n')}`);
  assert.doesNotMatch(
    migration,
    /insert\s+into\s+operations_private\.operations_hub_operator_credentials[\s\S]*?values\s*\(/i,
    'the shared username/password hash must be provisioned outside the repository'
  );
  assert.doesNotMatch(migration, /\bpassword\s+(?:text|varchar|character varying)\b/i, 'no plaintext password column may exist');
  assert.match(migration, /password_hash\s+text\s+not null/i, 'only a password hash is stored');
  assert.match(migration, /extensions\.crypt\(p_password,\s*v_credential\.password_hash\)\s*=\s*v_credential\.password_hash/i);
});

test('browser bearer token is tab-session scoped and never persisted to localStorage', () => {
  assert.match(app, /const OPERATIONS_AUTH_STORAGE_KEY = 'system-v3-operations-session-v1'/);
  assert.match(app, /sessionStorage\.getItem\(OPERATIONS_AUTH_STORAGE_KEY\)/);
  assert.match(app, /sessionStorage\.setItem\(OPERATIONS_AUTH_STORAGE_KEY/);
  assert.match(app, /sessionStorage\.removeItem\(OPERATIONS_AUTH_STORAGE_KEY\)/);
  assert.doesNotMatch(app, /localStorage\.(?:getItem|setItem|removeItem)\(OPERATIONS_AUTH_STORAGE_KEY/);
  assert.match(dataService, /let operationsHubSessionToken = ''/);
  assert.match(dataService, /function setOperationsHubSessionToken\(sessionToken\)/);
  assert.doesNotMatch(dataService, /(?:localStorage|sessionStorage)\.(?:getItem|setItem|removeItem)/,
    'the data adapter must keep the bearer token in memory and leave persistence to the session-only UI layer');
});

test('the login gate blocks the Operations Hub until the server validates a session', () => {
  assert.match(html, /<body class="operations-auth-locked">/);
  assert.match(html, /id="operations-auth-gate"/);
  assert.match(html, /id="operations-auth-password"[^>]*type="password"/);
  assert.match(html, /id="operations-app-shell"[^>]*aria-hidden="true"[^>]*inert/);
  assert.match(app, /async function initializeOperationsHubAuth\(\)[\s\S]*?checkOperationsHubSession\(stored\.token\)/);
  assert.match(app, /function showOperationsAuthGate[\s\S]*?operationsAppShell\.inert = true[\s\S]*?operations-auth-locked/);
  assert.match(app, /function openAuthenticatedOperationsHub[\s\S]*?operationsAppShell\.inert = false[\s\S]*?startAuthenticatedOperationsHubData\(\)/);
  assert.match(app, /if \(liveData\) \{\s*initializeOperationsHubAuth\(\)/);
  assert.match(app, /window\.addEventListener\('operations-hub-auth-required'[\s\S]*?showOperationsAuthGate/);
});

test('login storage uses bcrypt credentials, a bounded shared rate limit, and expiring revocable token hashes', () => {
  assert.match(migration, /create extension if not exists pgcrypto with schema extensions/i);
  assert.match(migration, /create table if not exists operations_private\.operations_hub_operator_credentials/i);
  assert.match(migration, /password_hash ~ '\^\[\$\]2\[aby\]\[\$\]\[0-9\]\{2\}\[\$\]'/i);
  assert.match(migration, /create table if not exists operations_private\.operations_hub_operator_login_guard[\s\S]*?failed_attempt_count[\s\S]*?locked_until/i);
  assert.match(migration, /failure_window_started_at <= v_now - interval '15 minutes'/i);
  assert.match(migration, /v_next_failed_count >= 5[\s\S]*?v_now \+ interval '15 minutes'/i);
  assert.match(migration, /error_code', 'rate_limited'[\s\S]*?retry_after_seconds/i);

  assert.match(migration, /create table if not exists operations_private\.operations_hub_operator_sessions[\s\S]*?token_hash text not null unique[\s\S]*?expires_at[\s\S]*?revoked_at/i);
  assert.doesNotMatch(migration, /\bsession_token\s+text\b/i, 'raw bearer tokens must not be table columns');
  assert.match(migration, /v_raw_token := encode\(extensions\.gen_random_bytes\(32\), 'hex'\)/i);
  assert.match(migration, /v_token_hash := encode\(extensions\.digest\(v_raw_token, 'sha256'\), 'hex'\)/i);
  assert.match(migration, /operator_session\.revoked_at is null[\s\S]*?operator_session\.expires_at > clock_timestamp\(\)[\s\S]*?operator_session\.created_at >= credential\.password_changed_at/i);
  assert.match(migration, /create or replace function public\.operations_hub_logout_v1[\s\S]*?set revoked_at = coalesce\(revoked_at, v_now\)/i);

  for (const table of ['operations_hub_operator_credentials', 'operations_hub_operator_login_guard', 'operations_hub_operator_sessions']) {
    assert.match(migration, new RegExp(`alter table operations_private\\.${table} enable row level security`, 'i'));
    assert.match(migration, new RegExp(`revoke all on table operations_private\\.${table} from public, anon, authenticated`, 'i'));
  }
});

test('single save and all-SKU refresh require a valid token before either preview or write logic', () => {
  const guard = sqlFunction(migration, 'operations_private.require_operations_hub_operator_session');
  const save = sqlFunction(migration, 'public.save_operations_hub_sku_operational_value');
  const bulk = sqlFunction(migration, 'public.refresh_operations_hub_master_column_from_source_v1');

  assert.match(guard, /errcode = '42501'[\s\S]*?유효한 운영 세션이 필요합니다/);
  assert.match(guard, /extensions\.digest\(p_session_token, 'sha256'\)/i);
  assert.doesNotMatch(guard, /return\s+p_session_token/i);

  assert.match(
    migration,
    /create or replace function public\.save_operations_hub_sku_operational_value\(\s*p_sellpia_sku_code text,[\s\S]*?security invoker[\s\S]*?errcode = '42501'[\s\S]*?운영 세션 토큰이 필요합니다[\s\S]*?comment on function public\.save_operations_hub_sku_operational_value\(text,text,numeric,text,text,jsonb\) is\s*'Fail-closed compatibility overload/i,
    'the legacy tokenless save overload must fail closed without touching data'
  );
  assert.match(save, /\(\s*p_session_token text,\s*p_sellpia_sku_code text,/i);
  assert.ok(save.indexOf('require_operations_hub_operator_session(p_session_token)') < save.search(/\binsert into\b/i),
    'save must authenticate before its first insert');
  assert.match(dataService, /db\.rpc\('save_operations_hub_sku_operational_value',\s*\{\s*p_session_token:requireOperationsHubSessionToken\(\)/);

  assert.match(
    migration,
    /create or replace function public\.refresh_operations_hub_master_column_from_source_v1\(\s*p_field_key text,[\s\S]*?security invoker[\s\S]*?errcode = '42501'[\s\S]*?운영 세션 토큰이 필요합니다[\s\S]*?comment on function public\.refresh_operations_hub_master_column_from_source_v1\(text,text,uuid,boolean\) is\s*'Fail-closed compatibility overload/i,
    'the legacy tokenless bulk overload, including dry-run false, must always fail closed'
  );
  assert.match(bulk, /\(\s*p_session_token text,\s*p_field_key text,/i);
  const authenticateAt = bulk.indexOf('require_operations_hub_operator_session(p_session_token)');
  assert.ok(authenticateAt >= 0 && authenticateAt < bulk.indexOf('if v_dry_run then'),
    'bulk preview and bulk apply must both authenticate before branching');
  assert.match(dataService, /p_session_token:requireOperationsHubSessionToken\(\)[\s\S]*?p_dry_run:dryRun !== false[\s\S]*?db\.rpc\('refresh_operations_hub_master_column_from_source_v1'/);
});

test('raw tokens cannot enter operational audit metadata and actor identity is server-derived', () => {
  const save = sqlFunction(migration, 'public.save_operations_hub_sku_operational_value');
  const bulk = sqlFunction(migration, 'public.refresh_operations_hub_master_column_from_source_v1');

  assert.match(save, /v_session := operations_private\.require_operations_hub_operator_session\(p_session_token\)[\s\S]*?v_actor := v_session ->> 'username'/i);
  assert.match(save, /position\(p_session_token in coalesce\(p_metadata, '\{\}'::jsonb\)::text\) > 0[\s\S]*?세션 토큰은 변경 메타데이터에 포함할 수 없습니다/i);
  assert.match(save, /- array\['session_token', 'p_session_token', 'authorization', 'token'\]::text\[\][\s\S]*?jsonb_build_object\('session_id', v_session_id\)/i);
  assert.match(bulk, /v_session := operations_private\.require_operations_hub_operator_session\(p_session_token\)[\s\S]*?v_actor := v_session ->> 'username'/i);
  assert.match(bulk, /jsonb_build_object\([\s\S]*?'operation', 'bulk_source_refresh'[\s\S]*?'session_id', v_session_id[\s\S]*?\)/i);
  assert.doesNotMatch(bulk, /'session_token'\s*,\s*p_session_token/i);
});
