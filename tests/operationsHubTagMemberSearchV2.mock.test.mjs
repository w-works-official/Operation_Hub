import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const sql=fs.readFileSync('supabase/migrations/20260921064415_hub_tag_member_search_v2.sql','utf8');
const service=fs.readFileSync('mockups/operations-hub/data-service.js','utf8');
const manager=fs.readFileSync('mockups/operations-hub/tag-management-v2.js','utf8');

test('tag search validates session and tag, caps search page, and never mutates data',()=>{
  assert.match(sql,/create or replace function public\.hub_tag_member_search_v2/);
  assert.match(sql,/security definer\s+set search_path to 'pg_catalog'/);
  assert.match(sql,/require_operations_hub_operator_session\(p_session_token\)/);
  assert.match(sql,/where tag\.tag_id = p_tag_id and tag\.is_active/);
  assert.match(sql,/length\(v_query\) > 100/);
  assert.match(sql,/least\(100, greatest\(1, coalesce\(p_page_size, 100\)\)\)/);
  assert.doesNotMatch(sql,/\b(insert|update|delete|merge|truncate)\s+(?:into|from|public\.|operations_private\.)/i);
  assert.match(sql,/revoke all on function public\.hub_tag_member_search_v2\(text,uuid,text,integer,integer\) from public/);
});

test('tag search reads only current source scalars and checks assignment after pagination',()=>{
  assert.match(sql,/from public\.sellpia_stock_snapshots snapshot[\s\S]*?where snapshot\.upload_status = 'ready'/);
  assert.match(sql,/from public\.sellpia_stock_snapshot_rows source[\s\S]*?source\.snapshot_id = v_snapshot_id/);
  assert.match(sql,/source\.sellpia_sku_code,\s*source\.own_sku,\s*source\.sellpia_product_code,\s*source\.sellpia_product_name,\s*source\.sellpia_option_name/);
  assert.match(sql,/page_rows as materialized \([\s\S]*?limit v_page_size offset/);
  assert.match(sql,/tag_applied', exists \([\s\S]*?assignment\.is_active[\s\S]*?assignment\.tag_scope = 'option'[\s\S]*?assignment\.tag_scope = 'product'/);
  assert.doesNotMatch(sql,/operations_hub_matrix_managed_live|operations_hub_matrix_export_cache|loadProductsBySkus|seller_inventory_snapshot_rows/);
});

test('tag manager search uses the compact RPC while applied-list path remains unchanged',()=>{
  assert.match(service,/async function loadTagMemberSearch[\s\S]*?db\.rpc\('hub_tag_member_search_v2'/);
  assert.match(service,/loadTagMembers,\s*loadTagMemberSearch,/);
  assert.match(manager,/if\(state\.memberSearch\)\{\s*result=await D\(\)\.loadTagMemberSearch/);
  assert.match(manager,/__tagApplied:row\.tag_applied===true/);
  assert.match(manager,/else\{\s*result=await D\(\)\.loadTagMembers/);
  assert.doesNotMatch(manager,/loadProducts\(\{page:state\.page/);
});
