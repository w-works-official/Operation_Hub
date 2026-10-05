import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import test from 'node:test';

let PGlite;
try { ({PGlite}=await import('@electric-sql/pglite')); }
catch {
  try {
    const fallback=process.env.PGLITE_MODULE;
    if(fallback) ({PGlite}=await import(pathToFileURL(fallback)));
  } catch {}
}

const migration=fs.readFileSync(new URL('../supabase/migrations/20261001031902_operations_hub_retention_lifecycle_v2.sql',import.meta.url),'utf8');
const legacyCronMigration=fs.readFileSync(new URL('../supabase/migrations/20261001031840_remove_legacy_matrix_refresh_crons_v1.sql',import.meta.url),'utf8');
const core=migration.slice(0,migration.indexOf('create or replace function operations_private.prune_operations_hub_cron_history_v2'));
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;

test('retention plan preserves active lineage and provenance, archives only old unprotected rows, and is idempotent',{skip:!PGlite&&'Install @electric-sql/pglite'},async()=>{
  const db=new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create schema operations_private; create schema storage;
      create table public.sellpia_stock_snapshots(
        snapshot_id uuid primary key, upload_status text not null,
        source_row_count integer default 0, valid_row_count integer default 0,
        upload_note text, metadata jsonb not null default '{}'::jsonb,
        created_at timestamptz not null, completed_at timestamptz,
        constraint ck_sellpia_stock_snapshots_status check(upload_status in('uploading','ready','failed'))
      );
      create table public.sellpia_stock_snapshot_rows(
        snapshot_id uuid not null references public.sellpia_stock_snapshots(snapshot_id) on delete cascade,
        sellpia_sku_code text not null, primary key(snapshot_id,sellpia_sku_code)
      );
      create table public.seller_inventory_snapshots(
        snapshot_id uuid primary key, source_channel text not null,
        upload_status text not null, upload_mode text not null default 'full',
        base_snapshot_id uuid references public.seller_inventory_snapshots(snapshot_id),
        upload_note text, metadata jsonb not null default '{}'::jsonb,
        created_at timestamptz not null, completed_at timestamptz,
        constraint seller_inventory_snapshots_upload_status_check check(upload_status in('uploading','ready','failed'))
      );
      create table public.seller_inventory_snapshot_rows(
        snapshot_id uuid not null references public.seller_inventory_snapshots(snapshot_id) on delete cascade,
        product_code text not null, option_code text not null default '',
        primary key(snapshot_id,product_code,option_code)
      );
      create table operations_private.operations_hub_matrix_refresh_state(
        singleton boolean primary key, sellpia_snapshot_id uuid
      );
      create table operations_private.operations_hub_original_upload_intents(
        intent_id uuid primary key, snapshot_id uuid not null unique references public.sellpia_stock_snapshots(snapshot_id),
        status text not null
      );
      create table operations_private.hub_baseline_versions(source_snapshot_id uuid);
      create table public.operations_hub_active_seller_drafts(source_snapshot_id uuid);
      create table public.operations_hub_change_queue(source_snapshot_id uuid);
      create table public.operations_hub_export_items(source_snapshot_id uuid);
      create table storage.objects(id uuid primary key,name text not null);
    `);
    await db.exec(core);

    const sellpiaBase=id(100),sellpiaCurrent=id(101),activeIntent=id(102),expiredIntent=id(103),failed=id(104);
    await db.exec(`
      insert into public.sellpia_stock_snapshots values
        ('${sellpiaBase}','ready',1,1,null,'{"upload_mode":"full"}','2025-01-01','2025-01-01'),
        ('${sellpiaCurrent}','ready',1,1,null,'{"upload_mode":"patch","base_snapshot_id":"${sellpiaBase}"}','2026-09-30','2026-09-30'),
        ('${activeIntent}','ready',1,1,null,'{"upload_mode":"full"}','2024-01-02','2024-01-02'),
        ('${expiredIntent}','ready',1,1,null,'{"upload_mode":"full"}','2024-01-01','2024-01-01'),
        ('${failed}','failed',1,0,null,'{}','2024-01-01','2024-01-01');
      insert into operations_private.operations_hub_matrix_refresh_state values(true,'${sellpiaCurrent}');
      insert into operations_private.operations_hub_original_upload_intents values
        ('${id(201)}','${activeIntent}','parsing'),
        ('${id(202)}','${expiredIntent}','ready');
      insert into storage.objects values('${id(301)}','sellpia/${expiredIntent}/01.xlsx');
    `);
    for(let n=110;n<121;n++) await db.exec(`insert into public.sellpia_stock_snapshots values('${id(n)}','ready',1,1,null,'{"upload_mode":"full"}','2025-02-${String(n-109).padStart(2,'0')}','2025-02-${String(n-109).padStart(2,'0')}')`);
    const sellpiaIds=[sellpiaBase,sellpiaCurrent,activeIntent,expiredIntent,failed,...Array.from({length:11},(_,i)=>id(110+i))];
    for(const [index,snapshot] of sellpiaIds.entries()) await db.exec(`insert into public.sellpia_stock_snapshot_rows values('${snapshot}','S-${index}')`);

    const sellerBase=id(400),sellerCurrent=id(401),sellerBaseline=id(402),sellerQueued=id(403),sellerOld=id(404);
    await db.exec(`
      insert into public.seller_inventory_snapshots values
        ('${sellerBase}','smartstore','ready','full',null,null,'{}','2024-01-01','2024-01-01'),
        ('${sellerCurrent}','smartstore','ready','patch','${sellerBase}',null,'{}','2026-09-30','2026-09-30'),
        ('${sellerBaseline}','smartstore','ready','full',null,null,'{}','2024-01-02','2024-01-02'),
        ('${sellerQueued}','smartstore','ready','full',null,null,'{}','2024-01-03','2024-01-03'),
        ('${sellerOld}','smartstore','ready','full',null,null,'{}','2024-01-04','2024-01-04');
      insert into operations_private.hub_baseline_versions values('${sellerBaseline}');
      insert into public.operations_hub_change_queue values('${sellerQueued}');
    `);
    for(let n=410;n<417;n++) await db.exec(`insert into public.seller_inventory_snapshots values('${id(n)}','smartstore','ready','full',null,null,'{}','2025-03-${String(n-409).padStart(2,'0')}','2025-03-${String(n-409).padStart(2,'0')}')`);
    const sellerIds=[sellerBase,sellerCurrent,sellerBaseline,sellerQueued,sellerOld,...Array.from({length:7},(_,i)=>id(410+i))];
    for(const [index,snapshot] of sellerIds.entries()) await db.exec(`insert into public.seller_inventory_snapshot_rows values('${snapshot}','P-${index}','')`);

    const plan=await db.query(`select * from operations_private.operations_hub_snapshot_retention_plan_v2('2026-10-01T00:00:00Z')`);
    const planned=new Set(plan.rows.map(row=>row.snapshot_id));
    assert.ok(planned.has(expiredIntent),'completed upload intent does not pin snapshot child rows forever');
    assert.ok(planned.has(failed),'old failed child rows are eligible');
    assert.ok(planned.has(sellerOld),'old unreferenced seller snapshot is eligible');
    assert.ok(!planned.has(sellpiaCurrent));
    assert.ok(!planned.has(sellpiaBase),'current Sellpia patch ancestry is protected');
    assert.ok(!planned.has(activeIntent),'in-flight intent is protected');
    assert.ok(!planned.has(sellerBase),'current seller patch ancestry is protected');
    assert.ok(!planned.has(sellerBaseline),'baseline reference is protected');
    assert.ok(!planned.has(sellerQueued),'operational change reference is protected');

    const beforeParents=(await db.query('select count(*)::int count from public.sellpia_stock_snapshots')).rows[0].count;
    const beforeIntents=(await db.query('select count(*)::int count from operations_private.operations_hub_original_upload_intents')).rows[0].count;
    await db.query(`select operations_private.archive_operations_hub_snapshot_history_v2('2026-10-01T00:00:00Z')`);
    assert.equal((await db.query('select count(*)::int count from public.sellpia_stock_snapshots')).rows[0].count,beforeParents);
    assert.equal((await db.query('select count(*)::int count from operations_private.operations_hub_original_upload_intents')).rows[0].count,beforeIntents);
    assert.equal((await db.query(`select upload_status from public.sellpia_stock_snapshots where snapshot_id='${expiredIntent}'`)).rows[0].upload_status,'archived');
    assert.equal((await db.query(`select upload_status from public.sellpia_stock_snapshots where snapshot_id='${failed}'`)).rows[0].upload_status,'failed');
    assert.equal((await db.query(`select count(*)::int count from public.sellpia_stock_snapshot_rows where snapshot_id in ('${expiredIntent}','${failed}')`)).rows[0].count,0);
    assert.equal((await db.query(`select count(*)::int count from public.sellpia_stock_snapshot_rows where snapshot_id in ('${sellpiaCurrent}','${sellpiaBase}','${activeIntent}')`)).rows[0].count,3);
    assert.equal((await db.query('select count(*)::int count from storage.objects')).rows[0].count,1);

    const second=(await db.query(`select operations_private.archive_operations_hub_snapshot_history_v2('2026-10-01T00:00:00Z') result`)).rows[0].result;
    assert.equal(Number(second.sellpia_child_rows_removed),0);
    assert.equal(Number(second.seller_child_rows_removed),0);
  } finally { await db.close(); }
});

test('cron-log retention has an independent 14-day cutoff and is idempotent',{skip:!PGlite&&'Install @electric-sql/pglite'},async()=>{
  const db=new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create schema operations_private; create schema cron;
      create table cron.job_run_details(runid bigint primary key,end_time timestamptz);
    `);
    const policy=migration.slice(0,migration.indexOf('alter table public.sellpia_stock_snapshots'));
    const cronStart=migration.indexOf('create or replace function operations_private.prune_operations_hub_cron_history_v2');
    const cronEnd=migration.indexOf('-- Compatibility entry point for manual operators.');
    await db.exec(`${policy}\n${migration.slice(cronStart,cronEnd)}`);
    await db.exec(`insert into cron.job_run_details values
      (1,'2026-09-10T00:00:00Z'),
      (2,'2026-09-21T00:00:00Z'),
      (3,null)`);
    const first=(await db.query(`select operations_private.prune_operations_hub_cron_history_v2('2026-10-01T00:00:00Z') result`)).rows[0].result;
    assert.equal(Number(first.cron_job_runs_removed),1);
    assert.deepEqual((await db.query('select runid from cron.job_run_details order by runid')).rows.map(row=>Number(row.runid)),[2,3]);
    const second=(await db.query(`select operations_private.prune_operations_hub_cron_history_v2('2026-10-01T00:00:00Z') result`)).rows[0].result;
    assert.equal(Number(second.cron_job_runs_removed),0);
  } finally { await db.close(); }
});

test('legacy cron migration parses and removes only status-only jobs when background replacements are active',{skip:!PGlite&&'Install @electric-sql/pglite'},async()=>{
  const db=new PGlite();
  try {
    await db.exec(`
      create schema operations_private; create schema cron;
      create table cron.job(jobid bigint primary key,jobname text,schedule text,command text,active boolean);
      create table operations_private.operations_hub_matrix_refresh_state(
        singleton boolean primary key,legacy_auto_refresh_enabled boolean,legacy_auto_refresh_schedule text
      );
      insert into operations_private.operations_hub_matrix_refresh_state values(true,false,'*/2 * * * *');
      create function cron.unschedule(p_job_id bigint) returns boolean language plpgsql as $$
      begin delete from cron.job where jobid=p_job_id; return found; end $$;
      create function operations_private.refresh_operations_hub_matrix_core_if_stale(p_actor text)
      returns jsonb language plpgsql as $$ begin return jsonb_build_object('status','background_managed'); end $$;
      create function operations_private.refresh_operations_hub_matrix_export_cache_if_stale(p_actor text)
      returns jsonb language plpgsql as $$ begin return jsonb_build_object('status','background_managed'); end $$;
      insert into cron.job values
        (1,'operations-hub-legacy-mapping-refresh','*/2 * * * *','select operations_private.refresh_operations_hub_matrix_core_if_stale(''cron'')',true),
        (2,'operations-hub-csv-export-cache-refresh','1-59/2 * * * *','select operations_private.refresh_operations_hub_matrix_export_cache_if_stale(''cron'')',true),
        (14,'system-v3-core-cache-refresh-v1','* * * * *','select operations_private.refresh_operations_hub_matrix_core_if_stale_background(''pg_cron'')',true),
        (15,'system-v3-export-cache-refresh-v1','* * * * *','select operations_private.refresh_operations_hub_matrix_export_cache_if_stale_background(''pg_cron'')',true);
    `);
    await db.exec(legacyCronMigration);
    assert.deepEqual((await db.query('select jobid from cron.job order by jobid')).rows.map(row=>Number(row.jobid)),[14,15]);
    assert.deepEqual((await db.query('select legacy_auto_refresh_enabled,legacy_auto_refresh_schedule from operations_private.operations_hub_matrix_refresh_state')).rows[0],{
      legacy_auto_refresh_enabled:false,
      legacy_auto_refresh_schedule:'*/2 * * * *',
    });
  } finally { await db.close(); }
});

