import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(
  new URL('../supabase/migrations/20260903021316_operations_hub_operational_master_source_refresh_v7.sql', import.meta.url),
  'utf8'
).replaceAll('\r\n','\n');

const between = (start, end, from = migration) => {
  const startIndex = from.indexOf(start);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  const endIndex = from.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return from.slice(startIndex, endIndex);
};

const credentialsTable = between(
  'create table if not exists operations_private.operations_hub_operator_credentials',
  'create table if not exists operations_private.operations_hub_operator_login_guard'
);
const sessionsTable = between(
  'create table if not exists operations_private.operations_hub_operator_sessions',
  'create index if not exists operations_hub_operator_sessions_credential_active_idx'
);
const requireSession = between(
  'create or replace function operations_private.require_operations_hub_operator_session',
  'revoke all on function operations_private.require_operations_hub_operator_session'
);
const login = between(
  'create or replace function public.operations_hub_login_v1',
  'comment on function public.operations_hub_login_v1'
);
const checkSession = between(
  'create or replace function public.operations_hub_check_session_v1',
  'comment on function public.operations_hub_check_session_v1'
);
const logout = between(
  'create or replace function public.operations_hub_logout_v1',
  'comment on function public.operations_hub_logout_v1'
);
const protectedSave = between(
  'create or replace function public.save_operations_hub_sku_operational_value(\n  p_session_token text',
  'comment on function public.save_operations_hub_sku_operational_value(text,text,text,numeric,text,text,jsonb)'
);
const protectedBulk = between(
  'create or replace function public.refresh_operations_hub_master_column_from_source_v1(\n  p_session_token text',
  'comment on function public.refresh_operations_hub_master_column_from_source_v1(text,text,text,uuid,boolean)'
);

assert.match(migration, /create extension if not exists pgcrypto with schema extensions/i);
assert.match(credentialsTable, /password_hash text not null[\s\S]*?password_hash ~ '\^\[\$\]2\[aby\]\[\$\]\[0-9\]\{2\}\[\$\]'/i);
assert.match(credentialsTable, /username = lower\(btrim\(username\)\)/i);
assert.doesNotMatch(migration, /insert into operations_private\.operations_hub_operator_credentials/i,
  'credential secrets must be provisioned in a separate admin-only SQL action');

for (const tableName of [
  'operations_hub_operator_credentials',
  'operations_hub_operator_login_guard',
  'operations_hub_operator_sessions'
]) {
  assert.match(migration, new RegExp(`alter table operations_private\\.${tableName} enable row level security`, 'i'));
  assert.match(migration, new RegExp(`revoke all on table operations_private\\.${tableName} from public, anon, authenticated`, 'i'));
}

assert.match(sessionsTable, /token_hash text not null unique/i);
assert.doesNotMatch(sessionsTable, /session_token|raw_token/i,
  'the session table may persist only token hashes');
assert.match(requireSession, /extensions\.digest\(p_session_token, 'sha256'\)/i);
assert.match(requireSession, /revoked_at is null[\s\S]*?expires_at > clock_timestamp\(\)[\s\S]*?credential\.is_active/i);
assert.match(requireSession, /errcode = '42501'/i);
assert.match(requireSession, /set search_path = pg_catalog/i);

assert.match(login, /extensions\.crypt\(p_password, v_credential\.password_hash\) = v_credential\.password_hash/i);
assert.match(login, /extensions\.gen_salt\('bf', 12\)/i);
assert.match(login, /v_next_failed_count >= 5[\s\S]*?interval '15 minutes'/i);
assert.match(login, /'rate_limit_scope', 'shared_operator'/i);
assert.match(login, /set failed_attempt_count = 0[\s\S]*?locked_until = null/i,
  'successful login must reset the shared rate limiter');
assert.match(login, /encode\(extensions\.gen_random_bytes\(32\), 'hex'\)/i);
assert.match(login, /encode\(extensions\.digest\(v_raw_token, 'sha256'\), 'hex'\)/i);
assert.match(login, /'session_token', v_raw_token[\s\S]*?'expires_at', v_expires_at/i);
assert.match(migration, /create trigger operations_hub_operator_credentials_prepare[\s\S]*?before insert or update/i);
assert.match(migration, /new\.password_hash is distinct from old\.password_hash[\s\S]*?new\.password_changed_at := clock_timestamp\(\)/i,
  'password rotation must advance the revocation boundary automatically');
assert.match(migration, /create trigger operations_hub_operator_credentials_revoke_sessions[\s\S]*?after update of password_hash, is_active[\s\S]*?revoke_operations_hub_sessions_after_credential_change/i,
  'password rotation or credential disablement must revoke active sessions');

assert.match(checkSession, /'invalid_session'[\s\S]*?'revoked_session'[\s\S]*?'expired_session'/i);
assert.match(logout, /set revoked_at = coalesce\(revoked_at, v_now\)[\s\S]*?revoke_reason = coalesce\(revoke_reason, 'logout'\)/i);
assert.match(logout, /'logged_out', true/i);

for (const [name, body] of [['save', protectedSave], ['bulk', protectedBulk]]) {
  assert.ok(
    body.indexOf('require_operations_hub_operator_session(p_session_token)') < body.indexOf("if v_field not in"),
    `${name} must authenticate before validating or operating on the requested field`
  );
  assert.match(body, /v_actor := v_session ->> 'username'/i,
    `${name} audit actor must come from the verified session`);
  assert.doesNotMatch(body, /v_actor text :=[^;]*p_actor/i,
    `${name} must not trust caller-provided p_actor`);
}

assert.match(protectedSave, /position\(p_session_token in coalesce\(p_metadata[\s\S]*?session_token[\s\S]*?authorization[\s\S]*?'session_id', v_session_id/i,
  'raw session tokens must be rejected and reserved token keys stripped before audit metadata is stored');
assert.match(protectedSave, /position\(p_session_token in v_sku\) > 0[\s\S]*?세션 토큰은 SKU 값에 포함할 수 없습니다/i,
  'a raw session token must not be smuggled into a persisted SKU key');
assert.match(protectedBulk, /'session_id', v_session_id/i);
assert.doesNotMatch(protectedBulk, /'session_token'/i);

assert.match(migration, /create or replace function public\.save_operations_hub_sku_operational_value\([\s\S]*?p_sellpia_sku_code text[\s\S]*?security invoker[\s\S]*?errcode = '42501'[\s\S]*?session token is missing/i,
  'the former save signature must be a fail-closed no-write authorization blocker');
assert.match(migration, /create or replace function public\.refresh_operations_hub_master_column_from_source_v1\([\s\S]*?p_field_key text[\s\S]*?security invoker[\s\S]*?errcode = '42501'[\s\S]*?session token is missing/i,
  'the former bulk signature must be a fail-closed no-write authorization blocker');

for (const signature of [
  'public.operations_hub_login_v1(text,text)',
  'public.operations_hub_check_session_v1(text)',
  'public.operations_hub_logout_v1(text)',
  'public.save_operations_hub_sku_operational_value(text,text,text,numeric,text,text,jsonb)',
  'public.refresh_operations_hub_master_column_from_source_v1(text,text,text,uuid,boolean)'
]) {
  const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(migration, new RegExp(`revoke all on function ${escaped} from public;[\\s\\S]*?grant execute on function ${escaped} to anon, authenticated;`, 'i'));
}

console.log('Operations Hub shared-operator auth/session V7 contract: passed');
