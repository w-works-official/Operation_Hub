-- Secure Operations Hub original-file upload boundary.
--
-- This replaces the never-applied anon SELLPIA INSERT policy migration. The
-- browser receives exact signed upload paths from an Edge Function only after
-- the existing Operations Hub custom session is validated. No SELLPIA Storage
-- INSERT policy is granted to anon/authenticated here.

create table if not exists operations_private.operations_hub_original_upload_intents (
  intent_id uuid primary key default extensions.gen_random_uuid(),
  request_id uuid not null unique,
  session_id uuid not null,
  operator_username text not null,
  source_channel text not null check (source_channel = 'sellpia'),
  upload_mode text not null check (upload_mode in ('full', 'patch')),
  snapshot_id uuid not null unique references public.sellpia_stock_snapshots(snapshot_id),
  selected_fields jsonb not null default '{}'::jsonb check (jsonb_typeof(selected_fields) = 'object'),
  request_manifest jsonb not null check (jsonb_typeof(request_manifest) = 'array'),
  object_manifest jsonb not null check (jsonb_typeof(object_manifest) = 'array'),
  storage_files jsonb not null default '[]'::jsonb check (jsonb_typeof(storage_files) = 'array'),
  expected_file_count integer not null check (expected_file_count between 1 and 3),
  expected_total_bytes bigint not null check (expected_total_bytes between 1 and 62914560),
  expected_row_count integer not null check (expected_row_count between 1 and 100000),
  status text not null default 'uploading'
    check (status in ('uploading','uploaded','parsing','ready','failed','aborted','expired')),
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  uploaded_at timestamptz,
  parsing_at timestamptz,
  finalized_at timestamptz,
  failed_at timestamptz,
  error_message text,
  updated_at timestamptz not null default clock_timestamp()
);

create index if not exists operations_hub_original_upload_intents_status_expiry_idx
  on operations_private.operations_hub_original_upload_intents(status, expires_at);

alter table operations_private.operations_hub_original_upload_intents enable row level security;
revoke all on table operations_private.operations_hub_original_upload_intents from public, anon, authenticated;

comment on table operations_private.operations_hub_original_upload_intents is
  'Private immutable-path upload intents for Operations Hub original carriers. Raw session tokens are never stored.';

create or replace function public.hub_original_upload_intent_begin_v1(
  p_session_token text,
  p_request_id uuid,
  p_upload_mode text,
  p_files jsonb,
  p_selected_fields jsonb default '{}'::jsonb,
  p_source_row_count integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
set statement_timeout = '10s'
as $$
declare
  v_actor jsonb;
  v_existing operations_private.operations_hub_original_upload_intents%rowtype;
  v_intent_id uuid := extensions.gen_random_uuid();
  v_snapshot_id uuid := extensions.gen_random_uuid();
  v_mode text := lower(btrim(coalesce(p_upload_mode, '')));
  v_count integer;
  v_total bigint := 0;
  v_manifest jsonb := '[]'::jsonb;
  v_file jsonb;
  v_name text;
  v_extension text;
  v_mime text;
  v_size bigint;
  v_sha text;
  v_path text;
  v_source_file_name text;
  v_index integer;
begin
  v_actor := operations_private.require_operations_hub_operator_session(p_session_token);
  if p_request_id is null then raise exception using errcode='22023', message='업로드 request_id가 필요합니다.'; end if;
  if v_mode not in ('full','patch') then raise exception using errcode='22023', message='SELLPIA 업로드 mode가 올바르지 않습니다.'; end if;
  if jsonb_typeof(p_files) <> 'array' then raise exception using errcode='22023', message='파일 manifest가 배열이 아닙니다.'; end if;
  if jsonb_typeof(coalesce(p_selected_fields,'{}'::jsonb)) <> 'object' then raise exception using errcode='22023', message='선택 필드 manifest가 올바르지 않습니다.'; end if;
  if p_source_row_count is null or p_source_row_count < 1 or p_source_row_count > 100000 then
    raise exception using errcode='22023', message='SELLPIA source row 수가 올바르지 않습니다.';
  end if;

  v_count := jsonb_array_length(p_files);
  if (v_mode='full' and v_count<>3) or (v_mode='patch' and (v_count<1 or v_count>3)) then
    raise exception using errcode='22023', message=case when v_mode='full' then 'SELLPIA 전체 원본은 정확히 3개 파일이 필요합니다.' else 'SELLPIA 부분 원본은 1~3개 파일이 필요합니다.' end;
  end if;

  select * into v_existing
  from operations_private.operations_hub_original_upload_intents
  where request_id=p_request_id
  for update;
  if found then
    if v_existing.session_id is distinct from (v_actor->>'session_id')::uuid
       or v_existing.operator_username is distinct from (v_actor->>'username')
       or v_existing.upload_mode is distinct from v_mode
       or v_existing.request_manifest is distinct from p_files
       or v_existing.expected_row_count is distinct from p_source_row_count
       or v_existing.selected_fields is distinct from coalesce(p_selected_fields,'{}'::jsonb) then
      raise exception using errcode='23505', message='같은 request_id가 다른 업로드 manifest에 이미 사용되었습니다.';
    end if;
    if v_existing.status <> 'uploading' or v_existing.expires_at <= clock_timestamp() then
      raise exception using errcode='55000', message='이미 진행되었거나 만료된 업로드 intent입니다.';
    end if;
    return jsonb_build_object(
      'intent_id',v_existing.intent_id,'snapshot_id',v_existing.snapshot_id,
      'source_channel',v_existing.source_channel,'upload_mode',v_existing.upload_mode,
      'status',v_existing.status,'expires_at',v_existing.expires_at,
      'manifest',v_existing.object_manifest
    );
  end if;

  for v_index in 0..v_count-1 loop
    v_file := p_files->v_index;
    v_name := btrim(coalesce(v_file->>'name',''));
    if v_name='' or length(v_name)>255 then
      raise exception using errcode='22023', message='원본 파일명이 올바르지 않습니다.';
    end if;
    v_extension := lower(substring(v_name from '\.([A-Za-z0-9]+)$'));
    if v_extension not in ('xlsx','xls','csv','tsv','txt') then
      raise exception using errcode='22023', message=format('허용하지 않는 원본 확장자입니다: %s',coalesce(v_extension,'없음'));
    end if;
    if coalesce(v_file->>'size','') !~ '^[0-9]+$' then
      raise exception using errcode='22023', message=format('%s 파일 크기가 올바르지 않습니다.',v_name);
    end if;
    v_size := (v_file->>'size')::bigint;
    if v_size<1 or v_size>26214400 then
      raise exception using errcode='22023', message=format('%s 파일은 25 MiB 제한을 초과했거나 비어 있습니다.',v_name);
    end if;
    v_total := v_total+v_size;
    if v_total>62914560 then raise exception using errcode='22023', message='SELLPIA 업로드 총 용량은 60 MiB를 초과할 수 없습니다.'; end if;

    v_mime := lower(btrim(coalesce(v_file->>'mime_type','application/octet-stream')));
    if v_extension='xlsx' and v_mime not in ('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/octet-stream') then
      raise exception using errcode='22023', message=format('%s MIME과 확장자가 일치하지 않습니다.',v_name);
    elsif v_extension='xls' and v_mime not in ('application/vnd.ms-excel','application/octet-stream') then
      raise exception using errcode='22023', message=format('%s MIME과 확장자가 일치하지 않습니다.',v_name);
    elsif v_extension='csv' and v_mime not in ('text/csv','text/plain','application/vnd.ms-excel','application/octet-stream') then
      raise exception using errcode='22023', message=format('%s MIME과 확장자가 일치하지 않습니다.',v_name);
    elsif v_extension in ('tsv','txt') and v_mime not in ('text/plain','text/tab-separated-values','application/octet-stream') then
      raise exception using errcode='22023', message=format('%s MIME과 확장자가 일치하지 않습니다.',v_name);
    end if;

    v_sha := lower(nullif(btrim(coalesce(v_file->>'sha256','')),''));
    if v_sha is not null and v_sha !~ '^[0-9a-f]{64}$' then
      raise exception using errcode='22023', message=format('%s SHA-256 형식이 올바르지 않습니다.',v_name);
    end if;
    v_path := format('sellpia/%s/%s.%s',v_snapshot_id,lpad((v_index+1)::text,2,'0'),v_extension);
    v_manifest := v_manifest || jsonb_build_array(jsonb_build_object(
      'ordinal',v_index+1,'name',v_name,'path',v_path,'size',v_size,
      'type',v_mime,'extension',v_extension,'client_sha256',v_sha
    ));
  end loop;

  select string_agg(item->>'name',' | ' order by ordinal)
  into v_source_file_name
  from jsonb_array_elements(p_files) with ordinality source(item,ordinal);

  insert into public.sellpia_stock_snapshots(
    snapshot_id,source_file_name,source_file_size,source_row_count,valid_row_count,
    invalid_row_count,upload_status,uploaded_by,metadata
  ) values (
    v_snapshot_id,v_source_file_name,v_total,p_source_row_count,0,0,'uploading',
    'operations_hub_secure_upload',
    jsonb_build_object(
      'parser_version','operations-hub-sellpia-2026.09.20-carrier-v1',
      'upload_intent_id',v_intent_id,'upload_mode',v_mode,
      'source_files',p_files,'selected_fields',coalesce(p_selected_fields,'{}'::jsonb),
      'digest_verification','client_declared_only'
    )
  );

  insert into operations_private.operations_hub_original_upload_intents(
    intent_id,request_id,session_id,operator_username,source_channel,upload_mode,
    snapshot_id,selected_fields,request_manifest,object_manifest,expected_file_count,
    expected_total_bytes,expected_row_count,status,expires_at
  ) values (
    v_intent_id,p_request_id,(v_actor->>'session_id')::uuid,v_actor->>'username','sellpia',v_mode,
    v_snapshot_id,coalesce(p_selected_fields,'{}'::jsonb),p_files,v_manifest,v_count,
    v_total,p_source_row_count,'uploading',clock_timestamp()+interval '2 hours'
  );

  return jsonb_build_object(
    'intent_id',v_intent_id,'snapshot_id',v_snapshot_id,'source_channel','sellpia',
    'upload_mode',v_mode,'status','uploading','expires_at',clock_timestamp()+interval '2 hours',
    'manifest',v_manifest
  );
end;
$$;

create or replace function public.hub_original_upload_intent_status_v1(
  p_session_token text,
  p_intent_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare v_actor jsonb; v_intent operations_private.operations_hub_original_upload_intents%rowtype;
begin
  v_actor:=operations_private.require_operations_hub_operator_session(p_session_token);
  select * into v_intent from operations_private.operations_hub_original_upload_intents where intent_id=p_intent_id;
  if not found then raise exception using errcode='P0002',message='업로드 intent를 찾을 수 없습니다.'; end if;
  if v_intent.session_id is distinct from (v_actor->>'session_id')::uuid or v_intent.operator_username is distinct from (v_actor->>'username') then raise exception using errcode='42501',message='다른 운영 세션의 업로드 intent입니다.'; end if;
  return jsonb_build_object(
    'intent_id',v_intent.intent_id,'snapshot_id',v_intent.snapshot_id,
    'source_channel',v_intent.source_channel,'upload_mode',v_intent.upload_mode,
    'status',v_intent.status,'expires_at',v_intent.expires_at,
    'manifest',v_intent.object_manifest,'storage_files',v_intent.storage_files,
    'expected_file_count',v_intent.expected_file_count,
    'expected_total_bytes',v_intent.expected_total_bytes,
    'expected_row_count',v_intent.expected_row_count
  );
end;
$$;

create or replace function public.hub_original_upload_intent_uploaded_v1(
  p_session_token text,
  p_intent_id uuid,
  p_storage_files jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
set statement_timeout='10s'
as $$
declare
  v_actor jsonb;
  v_intent operations_private.operations_hub_original_upload_intents%rowtype;
  v_file jsonb;
  v_expected jsonb;
  v_path text;
  v_count integer;
  v_total bigint:=0;
  v_normalized jsonb:='[]'::jsonb;
begin
  v_actor:=operations_private.require_operations_hub_operator_session(p_session_token);
  select * into v_intent from operations_private.operations_hub_original_upload_intents where intent_id=p_intent_id for update;
  if not found then raise exception using errcode='P0002',message='업로드 intent를 찾을 수 없습니다.'; end if;
  if v_intent.session_id is distinct from (v_actor->>'session_id')::uuid or v_intent.operator_username is distinct from (v_actor->>'username') then raise exception using errcode='42501',message='다른 운영 세션의 업로드 intent입니다.'; end if;
  if v_intent.status in ('uploaded','parsing','ready') then
    return jsonb_build_object('intent_id',v_intent.intent_id,'snapshot_id',v_intent.snapshot_id,'status',v_intent.status,'storage_files',v_intent.storage_files);
  end if;
  if v_intent.status<>'uploading' or v_intent.expires_at<=clock_timestamp() then raise exception using errcode='55000',message='업로드 완료 처리 가능한 intent가 아닙니다.'; end if;
  if jsonb_typeof(p_storage_files)<>'array' then raise exception using errcode='22023',message='Storage 검증 결과가 배열이 아닙니다.'; end if;
  v_count:=jsonb_array_length(p_storage_files);
  if v_count<>v_intent.expected_file_count then raise exception using errcode='22023',message='Storage object 수가 manifest와 다릅니다.'; end if;
  if (select count(distinct item->>'path') from jsonb_array_elements(p_storage_files) item)<>v_count then raise exception using errcode='22023',message='중복 Storage path가 있습니다.'; end if;

  for v_file in select value from jsonb_array_elements(p_storage_files) loop
    v_path:=v_file->>'path';
    select value into v_expected from jsonb_array_elements(v_intent.object_manifest) where value->>'path'=v_path;
    if v_expected is null then raise exception using errcode='22023',message='manifest에 없는 Storage path입니다.'; end if;
    if coalesce(v_file->>'size','')!~'^[0-9]+$' or (v_file->>'size')::bigint<>(v_expected->>'size')::bigint then
      raise exception using errcode='22023',message=format('%s object 크기가 manifest와 다릅니다.',v_path);
    end if;
    v_total:=v_total+(v_file->>'size')::bigint;
    v_normalized:=v_normalized||jsonb_build_array(jsonb_build_object(
      'name',v_expected->>'name','path',v_path,'size',(v_file->>'size')::bigint,
      'type',coalesce(nullif(v_file->>'type',''),v_expected->>'type'),
      'object_id',v_file->>'object_id','etag',v_file->>'etag',
      'client_sha256',v_expected->>'client_sha256'
    ));
  end loop;
  if v_total<>v_intent.expected_total_bytes then raise exception using errcode='22023',message='Storage 총 용량이 manifest와 다릅니다.'; end if;

  update operations_private.operations_hub_original_upload_intents set
    status='uploaded',storage_files=v_normalized,uploaded_at=clock_timestamp(),updated_at=clock_timestamp()
  where intent_id=p_intent_id;
  update public.sellpia_stock_snapshots set
    metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('source_storage_files',v_normalized,'storage_verified_at',clock_timestamp())
  where snapshot_id=v_intent.snapshot_id and upload_status='uploading';

  return jsonb_build_object('intent_id',v_intent.intent_id,'snapshot_id',v_intent.snapshot_id,'status','uploaded','storage_files',v_normalized);
end;
$$;

create or replace function public.hub_sellpia_upload_rows_v1(
  p_session_token text,
  p_intent_id uuid,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
set statement_timeout='30s'
as $$
declare
  v_actor jsonb;
  v_intent operations_private.operations_hub_original_upload_intents%rowtype;
  v_count integer;
  v_inserted integer;
  v_total integer;
begin
  v_actor:=operations_private.require_operations_hub_operator_session(p_session_token);
  select * into v_intent from operations_private.operations_hub_original_upload_intents where intent_id=p_intent_id for update;
  if not found then raise exception using errcode='P0002',message='업로드 intent를 찾을 수 없습니다.'; end if;
  if v_intent.session_id is distinct from (v_actor->>'session_id')::uuid or v_intent.operator_username is distinct from (v_actor->>'username') then raise exception using errcode='42501',message='다른 운영 세션의 업로드 intent입니다.'; end if;
  if v_intent.status not in ('uploaded','parsing') then raise exception using errcode='55000',message='행 import 가능한 업로드 상태가 아닙니다.'; end if;
  if jsonb_typeof(p_rows)<>'array' then raise exception using errcode='22023',message='SELLPIA 행 payload가 배열이 아닙니다.'; end if;
  v_count:=jsonb_array_length(p_rows);
  if v_count<1 or v_count>500 then raise exception using errcode='22023',message='SELLPIA 행은 한 번에 1~500개만 저장할 수 있습니다.'; end if;

  insert into public.sellpia_stock_snapshot_rows(
    snapshot_id,sellpia_sku_code,sellpia_product_code,sellpia_product_name,sellpia_option_name,
    own_sku,stock,available_stock,integrated_available_stock,safety_stock,source_row_no,raw_payload,
    supplier_code,supplier_name,supplier_group,supplier_address,supplier_market_name,supplier_phone,
    purchase_product_name,purchase_option_name,purchase_price,order_unit,minimum_order_unit
  )
  select
    v_intent.snapshot_id,row.sellpia_sku_code,row.sellpia_product_code,row.sellpia_product_name,row.sellpia_option_name,
    row.own_sku,row.stock,row.available_stock,row.integrated_available_stock,row.safety_stock,row.source_row_no,coalesce(row.raw_payload,'{}'::jsonb),
    row.supplier_code,row.supplier_name,row.supplier_group,row.supplier_address,row.supplier_market_name,row.supplier_phone,
    row.purchase_product_name,row.purchase_option_name,row.purchase_price,row.order_unit,row.minimum_order_unit
  from jsonb_to_recordset(p_rows) as row(
    sellpia_sku_code text,sellpia_product_code text,sellpia_product_name text,sellpia_option_name text,
    own_sku text,stock integer,available_stock integer,integrated_available_stock integer,safety_stock integer,
    source_row_no integer,raw_payload jsonb,supplier_code text,supplier_name text,supplier_group text,
    supplier_address text,supplier_market_name text,supplier_phone text,purchase_product_name text,
    purchase_option_name text,purchase_price numeric,order_unit numeric,minimum_order_unit numeric
  )
  where row.sellpia_sku_code~'^[0-9]+-[0-9]+$'
  on conflict(snapshot_id,sellpia_sku_code) do nothing;
  get diagnostics v_inserted=row_count;

  update operations_private.operations_hub_original_upload_intents set
    status='parsing',parsing_at=coalesce(parsing_at,clock_timestamp()),updated_at=clock_timestamp()
  where intent_id=p_intent_id;
  select count(*)::integer into v_total from public.sellpia_stock_snapshot_rows where snapshot_id=v_intent.snapshot_id;
  return jsonb_build_object('intent_id',p_intent_id,'snapshot_id',v_intent.snapshot_id,'inserted_count',v_inserted,'row_count',v_total,'expected_row_count',v_intent.expected_row_count);
end;
$$;

create or replace function public.hub_sellpia_upload_complete_v1(
  p_session_token text,
  p_intent_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
set statement_timeout='90s'
set lock_timeout='5s'
as $$
declare
  v_actor jsonb;
  v_intent operations_private.operations_hub_original_upload_intents%rowtype;
  v_rows integer;
  v_result jsonb;
begin
  v_actor:=operations_private.require_operations_hub_operator_session(p_session_token);
  select * into v_intent from operations_private.operations_hub_original_upload_intents where intent_id=p_intent_id for update;
  if not found then raise exception using errcode='P0002',message='업로드 intent를 찾을 수 없습니다.'; end if;
  if v_intent.session_id is distinct from (v_actor->>'session_id')::uuid or v_intent.operator_username is distinct from (v_actor->>'username') then raise exception using errcode='42501',message='다른 운영 세션의 업로드 intent입니다.'; end if;
  if v_intent.status='ready' then
    return jsonb_build_object('intent_id',v_intent.intent_id,'snapshot_id',v_intent.snapshot_id,'upload_mode',v_intent.upload_mode,'status','ready','row_count',v_intent.expected_row_count);
  end if;
  if v_intent.status not in ('uploaded','parsing') then raise exception using errcode='55000',message='완료 가능한 SELLPIA 업로드 상태가 아닙니다.'; end if;
  select count(*)::integer into v_rows from public.sellpia_stock_snapshot_rows where snapshot_id=v_intent.snapshot_id;
  if v_rows<>v_intent.expected_row_count then
    raise exception using errcode='22023',message=format('SELLPIA 행 수가 manifest와 다릅니다. 기대 %s / 저장 %s',v_intent.expected_row_count,v_rows);
  end if;

  if v_intent.upload_mode='patch' then
    v_result:=public.finalize_operations_hub_sellpia_patch(v_intent.snapshot_id,v_intent.selected_fields);
  else
    update public.sellpia_stock_snapshots set
      valid_row_count=v_rows,invalid_row_count=0,upload_status='ready',completed_at=clock_timestamp(),
      metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('secure_upload_intent_id',v_intent.intent_id,'finalized_at',clock_timestamp())
    where snapshot_id=v_intent.snapshot_id and upload_status='uploading';
    if not found then raise exception using errcode='55000',message='SELLPIA snapshot 상태가 변경되어 완료할 수 없습니다.'; end if;
    v_result:=jsonb_build_object('snapshot_id',v_intent.snapshot_id,'upload_mode','full','uploaded_row_count',v_rows,'row_count',v_rows);
  end if;

  update operations_private.operations_hub_original_upload_intents set
    status='ready',finalized_at=clock_timestamp(),updated_at=clock_timestamp()
  where intent_id=p_intent_id;
  return coalesce(v_result,'{}'::jsonb)||jsonb_build_object('intent_id',p_intent_id,'status','ready');
end;
$$;

create or replace function public.hub_original_upload_intent_fail_v1(
  p_session_token text,
  p_intent_id uuid,
  p_reason text default null,
  p_aborted boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare v_actor jsonb; v_intent operations_private.operations_hub_original_upload_intents%rowtype; v_status text;
begin
  v_actor:=operations_private.require_operations_hub_operator_session(p_session_token);
  select * into v_intent from operations_private.operations_hub_original_upload_intents where intent_id=p_intent_id for update;
  if not found then raise exception using errcode='P0002',message='업로드 intent를 찾을 수 없습니다.'; end if;
  if v_intent.session_id is distinct from (v_actor->>'session_id')::uuid or v_intent.operator_username is distinct from (v_actor->>'username') then raise exception using errcode='42501',message='다른 운영 세션의 업로드 intent입니다.'; end if;
  if v_intent.status='ready' then raise exception using errcode='55000',message='ready snapshot은 실패/cleanup 상태로 변경할 수 없습니다.'; end if;
  v_status:=case when p_aborted then 'aborted' else 'failed' end;
  update operations_private.operations_hub_original_upload_intents set
    status=v_status,failed_at=clock_timestamp(),error_message=left(coalesce(p_reason,'업로드 중단'),1000),updated_at=clock_timestamp()
  where intent_id=p_intent_id;
  update public.sellpia_stock_snapshots set
    upload_status='failed',upload_note=left(coalesce(p_reason,'업로드 중단'),1000),completed_at=clock_timestamp()
  where snapshot_id=v_intent.snapshot_id and upload_status='uploading';
  return jsonb_build_object('intent_id',p_intent_id,'snapshot_id',v_intent.snapshot_id,'status',v_status,'manifest',v_intent.object_manifest);
end;
$$;

revoke all on function public.hub_original_upload_intent_begin_v1(text,uuid,text,jsonb,jsonb,integer) from public;
revoke all on function public.hub_original_upload_intent_status_v1(text,uuid) from public;
revoke all on function public.hub_original_upload_intent_uploaded_v1(text,uuid,jsonb) from public;
revoke all on function public.hub_sellpia_upload_rows_v1(text,uuid,jsonb) from public;
revoke all on function public.hub_sellpia_upload_complete_v1(text,uuid) from public;
revoke all on function public.hub_original_upload_intent_fail_v1(text,uuid,text,boolean) from public;

grant execute on function public.hub_original_upload_intent_begin_v1(text,uuid,text,jsonb,jsonb,integer) to anon,authenticated;
grant execute on function public.hub_original_upload_intent_status_v1(text,uuid) to anon,authenticated;
grant execute on function public.hub_original_upload_intent_uploaded_v1(text,uuid,jsonb) to service_role;
grant execute on function public.hub_sellpia_upload_rows_v1(text,uuid,jsonb) to anon,authenticated;
grant execute on function public.hub_sellpia_upload_complete_v1(text,uuid) to anon,authenticated;
grant execute on function public.hub_original_upload_intent_fail_v1(text,uuid,text,boolean) to anon,authenticated;

comment on function public.hub_original_upload_intent_begin_v1(text,uuid,text,jsonb,jsonb,integer) is
  'Session-gated SELLPIA upload intent. Generates snapshot UUID and exact immutable object paths; does not grant browser Storage INSERT.';
comment on function public.hub_original_upload_intent_uploaded_v1(text,uuid,jsonb) is
  'Accepts Storage evidence only from the trusted Edge Function after exact manifest verification.';
comment on function public.hub_sellpia_upload_rows_v1(text,uuid,jsonb) is
  'Session-gated, retry-safe bounded SELLPIA row import for a verified upload intent.';
comment on function public.hub_sellpia_upload_complete_v1(text,uuid) is
  'Idempotent session-gated SELLPIA snapshot finalizer; ready requires verified objects and exact row count.';
