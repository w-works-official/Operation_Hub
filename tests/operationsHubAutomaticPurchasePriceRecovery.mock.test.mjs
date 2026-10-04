import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync('supabase/migrations/20260921133000_pending_purchase_price_recalculation_v2.sql','utf8');
const dataService = fs.readFileSync('mockups/operations-hub/data-service.js','utf8');
const app = fs.readFileSync('mockups/operations-hub/app.js','utf8');
const html = fs.readFileSync('mockups/operations-hub/index.html','utf8');

assert.match(migration, /require_operations_hub_operator_session\(p_session_token\)/, 'pending recovery read must validate the operator session');
assert.match(migration, /assignment\.target_field = 'actual_inbound_cost'[\s\S]*rule\.source_field = 'purchase_price'/, 'only active purchase-price Rule owners enter automatic recovery');
assert.match(migration, /calculated\.sku is null[\s\S]*calculated\.status <> 'calculated'[\s\S]*calculated\.error is not null[\s\S]*calculated\.calculated_at < relevant\.source_updated_at/i, 'missing, failed, and source-newer results must be resumed');
assert.match(migration, /least\(200, greatest\(1,[\s\S]*limit v_limit/i, 'the read must remain bounded');
assert.doesNotMatch(migration, /\b(insert|update|delete|truncate)\b/i, 'the pending detector must be read-only');
assert.match(migration, /revoke all on function[\s\S]*grant execute[\s\S]*to anon, authenticated/i, 'the RPC must only be callable through its session-gated body');

assert.match(dataService, /read_operations_hub_pending_purchase_price_recalculation_v2[\s\S]*pendingCount[\s\S]*affected_skus/, 'the data service must normalize the bounded pending scope');
assert.match(app, /pendingPurchasePriceRecoveryPromise[\s\S]*return pendingPurchasePriceRecoveryPromise/, 'automatic recovery must be single-flight');
assert.match(app, /PENDING_PURCHASE_PRICE_RECOVERY_BATCH_SIZE = 100[\s\S]*materializeHubPrices\(pending\.skus,[\s\S]*sources:\[\][\s\S]*automatic-purchase-price-recovery/, 'pending calculations must resume the internal price chain in bounded materialization batches');
assert.doesNotMatch(app, /materializeHubPrices\(pending\.skus,[\s\S]{0,300}sources:\['smartstore'/, 'purchase-price recovery must not expand into unrelated seller materialization');
assert.match(app, /markMatrixAffected\(affected\)[\s\S]*if \(matrixDataset\) await refreshMatrixSkus\(affected\)/, 'completed batches must patch affected Matrix rows without a full reload');
assert.match(app, /pending\.pendingCount >= previousPendingCount && batchKey === previousBatchKey/, 'a persistently failing batch must stop after proving no forward progress');
assert.match(app, /pendingPurchasePriceRecoveryNextAttemptAt = Date\.now\(\) \+ 5 \* 60 \* 1000/, 'persistent errors must back off instead of retrying continuously');
assert.match(app, /refreshLiveData\(\{resetPage:true\}\)\.finally\(\(\) => schedulePendingPurchasePriceRecovery\(\)\)/, 'login startup must resume unfinished calculations after initial reads settle');
assert.match(html, /data-service\.js\?v=[^"']+[\s\S]*app\.js\?v=[^"']+/, 'changed frontend assets must be cache-busted');

console.log('Operations Hub automatic purchase-price recovery contract: passed');
