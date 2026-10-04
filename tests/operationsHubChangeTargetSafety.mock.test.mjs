import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(
  new URL('../supabase/migrations/20260903055337_operations_hub_change_target_safety_v1.sql', import.meta.url),
  'utf8',
);
const selectedSourceRefreshMigration = fs.readFileSync(
  new URL('../supabase/migrations/20260903055355_operations_hub_selected_source_refresh_batch_v1.sql', import.meta.url),
  'utf8',
);

assert.ok(migration.length > 20_000, 'the target-safety migration must contain the complete replacement functions');
assert.doesNotMatch(migration, /delete\s+from\s+public\.operations_hub_change_queue/i, 'historical changes must never be deleted');
assert.match(
  migration,
  /stage_operations_hub_seller_inventory_match_batch\(\s*p_session_token text[\s\S]*?security definer[\s\S]*?require_operations_hub_operator_session\(p_session_token\)/i,
  'inventory staging must derive authority from an expiring operator session',
);
assert.match(
  migration,
  /prepare_operations_hub_change_export\(\s*p_session_token text[\s\S]*?security definer[\s\S]*?require_operations_hub_operator_session\(p_session_token\)/i,
  'export preparation must derive authority from an expiring operator session',
);
assert.match(
  migration,
  /stage_operations_hub_seller_inventory_match_batch\(\s*p_sources text\[][\s\S]*?errcode = '42501'[\s\S]*?운영 세션 토큰이 필요합니다/i,
  'the former no-token inventory staging signature must fail closed',
);
assert.match(
  migration,
  /prepare_operations_hub_change_export\(\s*p_export_batch_id uuid[\s\S]*?errcode = '42501'[\s\S]*?운영 세션 토큰이 필요합니다/i,
  'the former no-token export signature must fail closed',
);

assert.match(
  migration,
  /add column if not exists seller_option_code_normalized text[\s\S]*?set seller_option_code_normalized = coalesce\(nullif\(btrim\(seller_option_code\), ''\), ''\)[\s\S]*?alter column seller_option_code_normalized set not null/i,
  'blank and null seller option codes must share one normalized exact target',
);
assert.match(migration, /set local lock_timeout = '5s'/i, 'the additive backfill must fail fast instead of waiting on an operational lock');
assert.match(
  migration,
  /where status = 'processing'[\s\S]*?errcode = '55006'[\s\S]*?처리 중인 판매처 수정안/i,
  'one-time consolidation must abort if any proposal is actively processing',
);
assert.match(
  migration,
  /case queue\.status[\s\S]*?when 'processing' then 0[\s\S]*?when 'validated' then 1[\s\S]*?when 'pending' then 2[\s\S]*?when 'failed' then 3/i,
  'historical consolidation must preserve the strongest reviewed state before recency',
);
assert.match(
  migration,
  /operations_hub_change_queue_active_exact_target_uidx[\s\S]*?lower\(btrim\(source_channel\)\)[\s\S]*?btrim\(seller_product_code\)[\s\S]*?seller_option_code_normalized[\s\S]*?field_key[\s\S]*?status in \('pending', 'validated', 'failed', 'processing'\)/i,
  'one active proposal must be enforced per actual marketplace upload target',
);
assert.match(
  migration,
  /guard_operations_hub_change_target_v1\([\s\S]*?pg_advisory_xact_lock[\s\S]*?for update[\s\S]*?status = 'cancelled'[\s\S]*?v_existing\.after_value is distinct from new\.after_value[\s\S]*?new\.target_safety_state := 'conflict'/i,
  'all existing seller-draft writers must receive serialized exact-target replace-or-conflict semantics',
);
assert.match(
  migration,
  /guard_operations_hub_change_target_v1\([\s\S]*?v_existing\.status = 'processing'[\s\S]*?errcode = '55006'[\s\S]*?status = 'cancelled'/i,
  'the central target guard must block rather than silently supersede a processing proposal',
);
for (const writer of [
  'value_draft',
  'price_draft_v2',
  'discount_draft',
  'rule_draft',
]) {
  assert.match(
    migration,
    new RegExp(`create or replace function public\\.save_operations_hub_seller_${writer}\\([\\s\\S]*?pg_advisory_xact_lock[\\s\\S]*?queue\\.status = 'processing'[\\s\\S]*?errcode = '55006'[\\s\\S]*?seller_option_code_normalized[\\s\\S]*?queue\\.status in \\('pending', 'validated', 'failed'\\)`),
    `${writer} must serialize, block processing, and retire drafts by the exact physical target`,
  );
}
assert.doesNotMatch(
  migration,
  /create or replace function public\.save_operations_hub_seller_(?:value_draft|price_draft_v2|discount_draft|rule_draft)\([\s\S]*?where queue\.sellpia_sku_code\s*=\s*(?:p_sku|v_sku)[\s\S]*?get diagnostics v_cancelled = row_count;/i,
  'seller draft writers must not retain SKU-only cancellation on their unchanged-return path',
);
assert.match(
  migration,
  /duplicate_groups as materialized[\s\S]*?status = 'cancelled'[\s\S]*?통합되어 대체됨[\s\S]*?target_safety_state = case[\s\S]*?then 'conflict'/i,
  'existing duplicates must be superseded without losing a visible conflicting representative',
);
assert.match(
  migration,
  /validation_errors = case[\s\S]*?서로 다른 수정값이 있습니다/i,
  'historical conflicts must be visible through the existing queue error UI',
);

assert.match(
  migration,
  /stage_operations_hub_seller_inventory_match_batch\([\s\S]*?scoped_components as materialized[\s\S]*?target_candidates as materialized[\s\S]*?target_page as materialized[\s\S]*?expanded_components as materialized/i,
  'inventory generation must page targets first and then expand every component',
);
assert.match(
  migration,
  /operations_hub_listing_component_projection[\s\S]*?bool_or\(component\.mapping_source = 'explicit'\)[\s\S]*?min\(floor\(component\.sellpia_available_stock::numeric \/ component\.component_qty\)\)/i,
  'explicit seller BOM inventory must be consolidated with required quantities',
);
assert.match(
  migration,
  /not rollup\.is_explicit[\s\S]*?rollup\.component_count > 1[\s\S]*?rollup\.distinct_stock_count > 1 then 'conflict'/i,
  'legacy multi-SKU targets with disagreeing values must be blocked instead of choosing one',
);
assert.match(
  migration,
  /target_component_skus,[\s\S]*?target_safety_state, target_safety_details[\s\S]*?case when v_target\.safety_state = 'ready' then 'pending' else 'failed' end/i,
  'one failed representative must retain component provenance for an ambiguous target',
);
assert.match(
  migration,
  /array\[v_target\.source_channel\][\s\S]*?'operations_hub_frontend'[\s\S]*?'actor', v_actor/i,
  'staged rows must remain operable under queue RLS while retaining the authenticated actor in safety details',
);
assert.match(
  migration,
  /update public\.operations_hub_change_queue queue[\s\S]*?정확한 판매처 대상 수정안으로 구형 전체채널 수정안을 대체함[\s\S]*?queue\.source_channel is null/i,
  'new exact-target generation must supersede overlapping legacy global proposals',
);
assert.match(
  migration,
  /These statements are deliberately sequential[\s\S]*?update public\.operations_hub_change_queue queue[\s\S]*?get diagnostics v_affected = row_count;[\s\S]*?insert into public\.operations_hub_change_queue/i,
  'replacement must update before insert instead of modifying one table in unordered CTE siblings',
);
assert.match(
  migration,
  /Take the same canonical target lock[\s\S]*?pg_advisory_xact_lock[\s\S]*?sellpia_current_stock[\s\S]*?queue\.status = 'processing'[\s\S]*?update public\.operations_hub_change_queue queue/i,
  'batch staging must take the canonical exact-target lock and block processing before any queue row update',
);
assert.match(
  selectedSourceRefreshMigration,
  /if v_item\.target_kind <> 'system' then[\s\S]*?pg_advisory_xact_lock\(hashtextextended\([\s\S]*?lower\(btrim\(v_item\.source_channel\)\)[\s\S]*?btrim\(v_item\.seller_product_code\)[\s\S]*?seller_option_code[\s\S]*?sellpia_(?:current_stock|sale_price)[\s\S]*?operations_hub_selected_source_refresh_target:[\s\S]*?update public\.operations_hub_change_queue queue/i,
  'selected-source refresh must take the shared seller-target lock before its private lock and exact queue update',
);
assert.doesNotMatch(
  migration,
  /cancelled_exact as \([\s\S]*?inserted as \(/i,
  'same-table replacement must not rely on data-modifying CTE execution order',
);
assert.match(
  migration,
  /create or replace view public\.operations_hub_active_seller_drafts[\s\S]*?projected_sku[\s\S]*?operations_hub_listing_component_projection/i,
  'one exact-target proposal must project back onto every component SKU in the matrix',
);

assert.match(
  migration,
  /prepare_operations_hub_change_export\([\s\S]*?resolved as materialized[\s\S]*?target_groups as materialized[\s\S]*?proposal_count > 1[\s\S]*?value_count > 1 or target\.has_blocked_proposal/i,
  'export preparation must resolve and preflight exact targets before creating items',
);
assert.match(
  migration,
  /requested as materialized[\s\S]*?eligibility as materialized[\s\S]*?queue\.status = 'validated'[\s\S]*?queue\.target_safety_state = 'ready'[\s\S]*?v_eligible_count <> v_requested_count[\s\S]*?누락·범위외·미검토·차단 ID/i,
  'export must fail the whole request when any requested ID is missing, out of scope, unvalidated, or blocked',
);
assert.match(
  migration,
  /if v_duplicate_groups > 0 or v_conflict_groups > 0 then[\s\S]*?status, error_message[\s\S]*?'failed'[\s\S]*?return query select 0, v_blocked, 'failed'::text/i,
  'duplicate or conflicting targets must create a visible failed export batch',
);
assert.match(
  migration,
  /queue\.target_safety_state = 'ready'[\s\S]*?selected_changes as materialized/i,
  'only target-safety-ready changes may reach export items',
);
assert.match(
  migration,
  /product_source_count as materialized \([\s\S]*?select snapshot\.source_channel, row_item\.product_code[\s\S]*?group by snapshot\.source_channel, row_item\.product_code/i,
  'export option coverage must take source_channel from the snapshot, not the snapshot-row table',
);
assert.doesNotMatch(
  migration,
  /product_source_count as materialized \([\s\S]*?(?:select|group by) row_item\.source_channel/i,
  'seller inventory snapshot rows do not expose source_channel',
);

for (const rpc of [
  'list_operations_hub_change_batch_summaries_v1',
  'preview_operations_hub_change_target_safety_v1',
]) {
  assert.match(migration, new RegExp(`create or replace function public\\.${rpc}`), `${rpc} must be exposed`);
  assert.match(migration, new RegExp(`grant execute on function public\\.${rpc}`), `${rpc} needs an explicit API grant`);
}
assert.match(
  migration,
  /list_operations_hub_change_batch_summaries_v1\([\s\S]*?security invoker[\s\S]*?greatest\(1, least\(coalesce\(p_limit, 30\), 30\)\)/i,
  'batch summaries must obey RLS and remain bounded to the latest 30 batches',
);
for (const signal of ['duplicate_target_groups', 'conflicting_target_groups', 'superseded_count', 'is_stale']) {
  assert.match(migration, new RegExp(signal), `batch summaries must expose ${signal}`);
}
assert.match(
  migration,
  /preview_operations_hub_change_target_safety_v1\([\s\S]*?issue_type[\s\S]*?active_change_ids[\s\S]*?proposed_values[\s\S]*?component_skus/i,
  'the operator must be able to inspect exact-target conflicts without a write',
);

// Executable rule examples keep the intended consolidation semantics explicit.
function calculateTarget(components, explicit) {
  if (!components.length || components.some(component => component.available == null)) {
    return {state: 'incomplete', value: null};
  }
  if (explicit) {
    return {
      state: 'ready',
      value: Math.min(...components.map(component => Math.floor(component.available / component.qty))),
    };
  }
  const values = new Set(components.map(component => component.available));
  if (components.length > 1 && values.size > 1) return {state: 'conflict', value: null};
  return {state: 'ready', value: components[0].available};
}

assert.deepEqual(
  calculateTarget([{available: 12, qty: 2}, {available: 5, qty: 1}], true),
  {state: 'ready', value: 5},
  'explicit BOM stock is the quantity-aware limiting component',
);
assert.deepEqual(
  calculateTarget([{available: 7, qty: 1}, {available: 7, qty: 1}], false),
  {state: 'ready', value: 7},
  'legacy duplicate links are safe only when every proposal agrees',
);
assert.deepEqual(
  calculateTarget([{available: 7, qty: 1}, {available: 3, qty: 1}], false),
  {state: 'conflict', value: null},
  'legacy duplicate links with different values are never resolved arbitrarily',
);

console.log('Operations Hub exact seller-target safety: passed');
