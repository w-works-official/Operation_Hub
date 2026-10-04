import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
const sql=fs.readFileSync('supabase/migrations/20260917024240_carrier_seller_product_lookup_indexes.sql','utf8');
const identitySql=fs.readFileSync('supabase/migrations/20260922053853_optimize_carrier_seller_identity_lookup.sql','utf8');
const source=fs.readFileSync('mockups/operations-hub/data-service.js','utf8');
test('each carrier product equality lookup has a matching covering index',()=>{
 assert.equal((sql.match(/create index /g)||[]).length,3);
 for(const channel of ['smartstore','makeshop','ably']){
  assert.ok(sql.includes(`(${channel}_product_code,sellpia_sku_code) include (${channel}_option_code)`));
  assert.ok(sql.includes(`where ${channel}_product_code is not null`));
  assert.ok(identitySql.includes(`matrix.${channel}_product_code = any(p_product_codes)`));
 }
 assert.match(source,/hub_carrier_seller_identity_read_v1[\s\S]*?p_product_codes:chunk,[\s\S]*?p_offset:from,[\s\S]*?p_limit:1000/,'carrier identity RPC remains bounded and paginated');
 assert.match(identitySql,/cardinality\(p_product_codes\) not between 1 and 100/);
 assert.match(identitySql,/require_operations_hub_operator_session\(p_session_token\)/);
 assert.match(identitySql,/set statement_timeout='8s'/);
 assert.doesNotMatch(identitySql,/operations_hub_matrix_cached/,'identity RPC reads only the indexed cache table');
 assert.match(source,/operations_hub_link_suppressions/,'carrier mapping must honor operator disconnect suppressions');
 assert.match(source,/carrier link suppressions/,'suppression lookup is reported separately from identity lookup');
 assert.match(source,/suppressed\.has\(mappingKey\(row\.sku,row\.product_code,row\.option_code\)\)/,'suppressed exact seller identity must be removed before ambiguity classification');
});
test('index-only migration leaves data, existing indexes, access and timeouts unchanged',()=>{
 assert.doesNotMatch(sql,/\b(?:drop|alter|grant|revoke|update|delete|insert|truncate|set)\b/i);
 assert.doesNotMatch(sql,/statement_timeout|recalculate|materializ/i);
});
