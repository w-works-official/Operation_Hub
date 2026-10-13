-- Isolated fixture only. The runner rejects non-loopback hosts and uses a dedicated database.
-- Production has the same composite PK, SKU index and FK triggers; no user triggers.
create schema if not exists operations_private;
create schema if not exists extensions;
do $$ begin create role anon; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
create table public.sellpia_stock_snapshots (
  snapshot_id uuid primary key, source_file_name text, source_file_size bigint,
  source_row_count integer, valid_row_count integer, invalid_row_count integer,
  upload_status text not null default 'uploading' check (upload_status in ('uploading','ready','failed','archived')),
  upload_note text, uploaded_by text, metadata jsonb not null default '{}',
  created_at timestamptz not null default clock_timestamp(), completed_at timestamptz
);
create index ix_sellpia_stock_snapshots_ready_created on public.sellpia_stock_snapshots(upload_status,created_at desc);
create table public.sellpia_stock_snapshot_rows (
  snapshot_id uuid not null references public.sellpia_stock_snapshots(snapshot_id) on delete cascade,
  sellpia_sku_code text not null, sellpia_product_code text, sellpia_product_name text,
  sellpia_option_name text, own_sku text, stock integer, available_stock integer,
  integrated_available_stock integer, safety_stock integer, source_row_no integer,
  raw_payload jsonb default '{}', created_at timestamptz not null default now(),
  supplier_code text, supplier_name text, supplier_group text, supplier_address text,
  supplier_market_name text, supplier_phone text, purchase_product_name text,
  purchase_option_name text, purchase_price numeric, order_unit numeric,
  minimum_order_unit numeric, primary key(snapshot_id,sellpia_sku_code)
) with (autovacuum_enabled=false);
create index ix_sellpia_stock_snapshot_rows_sku on public.sellpia_stock_snapshot_rows(sellpia_sku_code);
create table operations_private.operations_hub_original_upload_intents (
  intent_id uuid primary key, request_id uuid not null unique, session_id uuid not null,
  operator_username text not null, source_channel text not null default 'sellpia',
  upload_mode text not null, snapshot_id uuid not null unique references public.sellpia_stock_snapshots,
  selected_fields jsonb not null default '{}', request_manifest jsonb not null default '[]',
  object_manifest jsonb not null default '[]', storage_files jsonb not null default '[]',
  expected_file_count integer not null default 1, expected_total_bytes bigint not null default 1,
  expected_row_count integer not null, status text not null default 'uploaded',
  expires_at timestamptz not null default now()+interval '2 hours',
  created_at timestamptz not null default clock_timestamp(), uploaded_at timestamptz,
  parsing_at timestamptz, finalized_at timestamptz, failed_at timestamptz,
  error_message text, updated_at timestamptz not null default clock_timestamp()
);
create function operations_private.require_operations_hub_operator_session(token text)
returns jsonb language plpgsql as $$ begin
  if token is distinct from 'isolated-operator' then raise exception using errcode='42501',message='unauthorized'; end if;
  return '{"session_id":"00000000-0000-4000-8000-000000000001","username":"isolated"}'::jsonb;
end $$;
-- These delegation stubs identify unchanged v1 dispatch. They do not model v1 behavior.
create function public.hub_sellpia_upload_rows_v1(token text,intent uuid,rows jsonb)
returns jsonb language sql as $$ select jsonb_build_object('delegated','rows_v1') $$;
create function public.hub_sellpia_upload_complete_v1(p_session_token text,p_intent_id uuid)
returns jsonb language sql as $$ select jsonb_build_object('delegated','complete_v1') $$;
create table public.operations_hub_sku_operational_master (
  sellpia_sku_code text primary key, stock_quantity integer, purchase_price numeric,
  base_price numeric, provenance jsonb
);
create view public.sellpia_stock_latest as
select r.* from public.sellpia_stock_snapshot_rows r
where r.snapshot_id=(select snapshot_id from public.sellpia_stock_snapshots where upload_status='ready' order by created_at desc limit 1);

-- Synthetic values use production-like field widths and raw JSONB shape without customer information.
-- 11 historical IDs are ANALYZEd before inserting a new base, reproducing the live missing-ID estimate.
create function operations_private.seed_inventory_timeout_fixture(p_rows integer,p_history integer default 11)
returns void language plpgsql as $$
begin
  truncate operations_private.operations_hub_original_upload_intents,public.sellpia_stock_snapshot_rows,
    public.sellpia_stock_snapshots,public.operations_hub_sku_operational_master;
  insert into public.sellpia_stock_snapshots(snapshot_id,upload_status,created_at,completed_at,valid_row_count,metadata)
  select ('00000000-0000-4000-8000-'||lpad(h::text,12,'0'))::uuid,'ready',
    '2026-10-01'::timestamptz+h*interval '1 hour','2026-10-01'::timestamptz+h*interval '1 hour',p_rows,
    jsonb_build_object('upload_mode','full','source_storage_files',jsonb_build_array('a.csv','b.csv','c.csv'))
  from generate_series(1,p_history)h;
  insert into public.sellpia_stock_snapshot_rows
  select s.snapshot_id,'SKU'||lpad(g::text,5,'0'),'P'||lpad((g/7)::text,4,'0'),
    repeat('상품정보보존',4),'옵션'||lpad(g::text,5,'0'),'OWN-'||lpad(g::text,10,'0'),
    100+g%180,case when g%17=0 then -g%7 else 90+g%180 end,95+g%180,0,g+1,
    jsonb_build_object('base_price',67000+g,'sell_price',65000+g,'purchase_price',35000+g,
      'commission',15,'purchase_vat',false,'product_status','판매중','source','sellpia-full',
      'barcode',lpad(g::text,13,'0'),'memo',repeat('상품기본정보',5),'option',g),
    s.created_at,'S'||lpad((g%140)::text,2,'0'),'테스트매입처'||lpad((g%140)::text,3,'0'),null,
    '서울특별시 종로구 테스트로 10','테스트상가-1','01000000','기본매입상품',repeat('매입옵션보존',3)||g,
    35000+g,1,1
  from public.sellpia_stock_snapshots s cross join generate_series(1,p_rows)g;
  analyze public.sellpia_stock_snapshot_rows;
  insert into public.sellpia_stock_snapshots(snapshot_id,upload_status,created_at,completed_at,valid_row_count,metadata)
  values('10000000-0000-4000-8000-000000000001','ready','2026-10-08 06:14+00','2026-10-08 06:15+00',p_rows,
    '{"upload_mode":"full","source_storage_files":["a.csv","b.csv","c.csv"]}');
  insert into public.sellpia_stock_snapshot_rows
  select '10000000-0000-4000-8000-000000000001',sellpia_sku_code,sellpia_product_code,sellpia_product_name,
    sellpia_option_name,own_sku,stock,available_stock,integrated_available_stock,safety_stock,
    source_row_no,raw_payload,created_at,supplier_code,supplier_name,supplier_group,supplier_address,
    supplier_market_name,supplier_phone,purchase_product_name,purchase_option_name,purchase_price,order_unit,minimum_order_unit
  from public.sellpia_stock_snapshot_rows where snapshot_id='00000000-0000-4000-8000-000000000001';
  insert into public.operations_hub_sku_operational_master
  select sellpia_sku_code,stock,purchase_price,(raw_payload->>'base_price')::numeric,
    jsonb_build_object('owner','existing-master','generation',42)
  from public.sellpia_stock_snapshot_rows where snapshot_id='10000000-0000-4000-8000-000000000001';
end $$;
create function operations_private.stage_inventory_timeout(p_snapshot uuid,p_count integer,p_base uuid default '10000000-0000-4000-8000-000000000001')
returns uuid language plpgsql as $$ begin
  insert into public.sellpia_stock_snapshots(snapshot_id,upload_status,created_at,metadata)
  values(p_snapshot,'uploading',clock_timestamp(),jsonb_build_object('upload_mode','inventory_count'));
  insert into operations_private.operations_hub_original_upload_intents(intent_id,request_id,session_id,operator_username,
    upload_mode,snapshot_id,selected_fields,expected_row_count,status)
  values(p_snapshot,p_snapshot,'00000000-0000-4000-8000-000000000001','isolated','inventory_count',p_snapshot,
    jsonb_build_object('inventory_count',true,'stock',true,'available_stock',true,'base_snapshot_id',p_base),p_count,'parsing');
  insert into public.sellpia_stock_snapshot_rows(snapshot_id,sellpia_sku_code,stock,available_stock,source_row_no,raw_payload)
  select p_snapshot,sellpia_sku_code,stock+1,available_stock-1,source_row_no,
    jsonb_build_object('stock',stock+1,'available_stock',available_stock-1,'raw_stock',stock+1,
      'raw_available_stock',available_stock-1,'inventory_count_file_name','isolated.xlsx')
  from public.sellpia_stock_snapshot_rows where snapshot_id=p_base order by sellpia_sku_code limit p_count;
  return p_snapshot;
end $$;
