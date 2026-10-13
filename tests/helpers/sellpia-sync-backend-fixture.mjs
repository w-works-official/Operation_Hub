import fs from 'node:fs/promises';
const read=p=>fs.readFile(new URL(p,import.meta.url),'utf8');
// Isolated schema from timeout QA plus shipped upload/patch/finalize functions.
// No network, Production credentials, raw commercial files or direct importer.
export async function backendFixtureSQL(){
  const fixture=await read('../fixtures/sellpiaInventoryCountTimeout.sql');
  const boundary=await read('../../supabase/migrations/20260920025225_operations_hub_original_upload_boundary_v1.sql');
  const definitions=JSON.parse(await read('../fixtures/sellpiaInventoryCountBaselineFunctions.json'));
  const inventory=await read('../../supabase/migrations/20261001153000_sellpia_inventory_count_stock_sources.sql');
  const start=inventory.indexOf('create or replace function public.hub_original_upload_intent_begin_v2(');
  const begin=inventory.slice(start,inventory.indexOf('$$;',start)+3);
  const rollback=await read('../../supabase/rollback/20261013045421_sellpia_inventory_count_fixed_key_copy.sql');
  const baselineDDL=(rollback.match(/CREATE OR REPLACE FUNCTION[\s\S]*?\$function\$;/gi)||[]).join('\n');
  const optimized=await read('../../supabase/migrations/20261013045421_sellpia_inventory_count_fixed_key_copy.sql');
  const operational=await read('../../supabase/migrations/20261013071210_sellpia_sync_operational_queue.sql');
  return `create role service_role bypassrls;${fixture}
    create extension if not exists pgcrypto with schema extensions;
    drop function public.hub_sellpia_upload_rows_v1(text,uuid,jsonb);
    ${boundary}${begin}
    ${definitions.map(f=>f.definition+';').join('\n')}${baselineDDL}${optimized}
    create schema storage;
    create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);
    alter table storage.objects enable row level security;
    grant usage on schema storage to anon,authenticated,service_role;
    grant select,insert,update,delete on storage.objects to anon,authenticated,service_role;
    create policy fixture_permissive on storage.objects for all to anon,authenticated using(true) with check(true);
    create table operations_private.test_matrix_state(snapshot_id uuid);
    insert into operations_private.test_matrix_state values(null);
    create view public.operations_hub_sellpia_matrix_sync_status as
      select m.snapshot_id matrix_snapshot_id,
      m.snapshot_id is distinct from (select snapshot_id from public.sellpia_stock_snapshots where upload_status='ready' order by completed_at desc nulls last,created_at desc limit 1) rebuild_pending
      from operations_private.test_matrix_state m;
    ${operational}`;
}

// Native isolated QA can replace the explicit unit-test Matrix proof above
// with the current shipped projection and real concurrent materialized refresh.
// Dependency tables have synthetic contents; function/view SQL is unmodified.
export async function backendMatrixFixtureSQL(){
  const matrix=(await read('../../supabase/migrations/20260820150000_sellpia_authoritative_matrix.sql')).replace(/select operations_private\.refresh_operations_hub_matrix_core\([^;]+;/gi,'');
  return `drop view public.operations_hub_sellpia_matrix_sync_status;
    drop view public.sellpia_stock_latest;
    create schema review;create schema catalog;
    create table review.final_excel_mapping_import(import_id uuid primary key,source_channel text,sellpia_sku text,channel_code text,channel_product_name text,channel_option_name text,match_tier text,match_score numeric,imported_at timestamptz);
    create table review.sheet_manual_mappings(manual_mapping_id uuid primary key,source_channel text,sellpia_sku text,channel_code text,channel_product_name text,channel_option_name text,match_tier text,match_score numeric,confirmed_at timestamptz,updated_at timestamptz);
    create table catalog.sellpia_products(p_code text primary key,own_code text,raw_payload jsonb,legacy_image_url text,updated_at timestamptz);
    create table operations_private.operations_hub_matrix_refresh_state(singleton boolean primary key check(singleton),core_refreshed_at timestamptz,refreshed_by text,core_row_count integer,legacy_mapping_at timestamptz);
    ${matrix}
    create materialized view operations_private.operations_hub_matrix_core as select * from public.operations_hub_matrix;
    create unique index operations_hub_matrix_core_sku_idx on operations_private.operations_hub_matrix_core(sellpia_sku_code);
    grant usage on schema operations_private to anon,authenticated,service_role;
    grant select on operations_private.operations_hub_matrix_refresh_state to anon,authenticated;
    insert into operations_private.operations_hub_matrix_refresh_state(singleton,core_row_count) values(true,0);`;
}
