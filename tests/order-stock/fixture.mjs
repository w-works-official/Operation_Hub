// Real PostgreSQL (WASM), real production save function + new migration.
// Only surrounding schema/auth fixture is synthetic. No remote database access.
import {PGlite} from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const readMigration = name => readFileSync(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8');
export async function createFixtureDatabase() {
const db = new PGlite();
const read = name => readFileSync(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8');
const original = read('20260903021316_operations_hub_operational_master_source_refresh_v7.sql');
await db.exec(`
  create role anon; create role authenticated;
  create schema operations_private;
  create table public.operations_hub_sku_operational_master (
    sellpia_sku_code text primary key, base_price numeric, stock_quantity integer,
    purchase_price numeric, order_unit numeric, minimum_order_unit numeric,
    price_version bigint not null default 0, stock_version bigint not null default 0,
    purchase_price_version bigint not null default 0, order_unit_version bigint not null default 0,
    minimum_order_unit_version bigint not null default 0,
    price_updated_at timestamptz, stock_updated_at timestamptz, purchase_price_updated_at timestamptz,
    order_unit_updated_at timestamptz, minimum_order_unit_updated_at timestamptz,
    updated_by text,created_at timestamptz,updated_at timestamptz
  );
  create table public.sellpia_stock_latest(sellpia_sku_code text primary key,
    purchase_price numeric,order_unit numeric,minimum_order_unit numeric,
    snapshot_id uuid not null default gen_random_uuid(),created_at timestamptz default now(),
    stock integer,raw_payload jsonb default '{}');
  create table public.operations_hub_sku_operational_events(
    sellpia_sku_code text,field_key text,before_value numeric,after_value numeric,
    change_source text,actor text,metadata jsonb,created_at timestamptz);
  create table public.operations_hub_sellpia_overrides(sellpia_sku_code text primary key,
    current_stock integer,sale_price numeric,updated_by text,updated_at timestamptz);
  create table public.operations_hub_inbound_cost_settings(sellpia_sku_code text primary key,
    manual_cost numeric,formula_tag_id bigint,updated_at timestamptz);
  create table public.operations_hub_inbound_cost_formula_tags(tag_id bigint primary key,
    tag_name text,tag_color text,is_active boolean,multiply_value numeric,divide_value numeric,
    add_value numeric,rounding_unit numeric,rounding_mode text);
  create function operations_private.require_operations_hub_operator_session(token text)
    returns jsonb language plpgsql as $$ begin
      if token not in ('test-only-valid-session','test-only-other-user','test-only-new-session') or token is null
        then raise exception using errcode='42501',message='invalid session'; end if;
      return jsonb_build_object('username',case when token='test-only-other-user' then 'other' else 'operator' end,
        'session_id','11111111-1111-4111-8111-111111111111'); end; $$;
  revoke all on function operations_private.require_operations_hub_operator_session(text) from public;
`);
await db.exec(original.slice(original.indexOf('create or replace view public.operations_hub_sku_operational_live'),
  original.indexOf('revoke all on public.operations_hub_sku_operational_live')));
const signature = 'create or replace function public.save_operations_hub_sku_operational_value(\n';
const normalized = original.replaceAll('\r\n','\n');
const start = normalized.indexOf(signature);
await db.exec(normalized.slice(start, normalized.indexOf('\n$$;', start)+4));
const procurement=read('20260825052000_sellpia_procurement_and_actual_inbound_cost.sql').replaceAll('\r\n','\n');
const costStart=procurement.indexOf('create or replace function public.calculate_operations_hub_inbound_cost(');
await db.exec(procurement.slice(costStart,procurement.indexOf('\n$$;',costStart)+4));
const viewStart=normalized.indexOf('create or replace view public.operations_hub_inbound_cost_live');
await db.exec(normalized.slice(viewStart,normalized.indexOf(';',viewStart)+1));

return db;
}

