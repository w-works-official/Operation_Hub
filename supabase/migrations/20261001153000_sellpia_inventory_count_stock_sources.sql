-- SKU-scoped Sellpia inventory-count snapshots and read-only stock-source projection.
-- This migration is intentionally additive. Existing full/patch upload functions remain unchanged.

alter table operations_private.operations_hub_original_upload_intents
  drop constraint if exists operations_hub_original_upload_intents_upload_mode_check;
alter table operations_private.operations_hub_original_upload_intents
  add constraint operations_hub_original_upload_intents_upload_mode_check
  check (upload_mode in ('full','patch','inventory_count'));
alter table operations_private.operations_hub_original_upload_intents
  drop constraint if exists operations_hub_original_upload_intents_expected_file_count_check;
alter table operations_private.operations_hub_original_upload_intents
  add constraint operations_hub_original_upload_intents_expected_file_count_check
  check (expected_file_count between 1 and 10);

create or replace function public.hub_original_upload_intent_begin_v2(
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
set search_path=pg_catalog
set statement_timeout='10s'
as $$
declare
  v_actor jsonb;
  v_existing operations_private.operations_hub_original_upload_intents%rowtype;
  v_intent_id uuid:=extensions.gen_random_uuid();
  v_snapshot_id uuid:=extensions.gen_random_uuid();
  v_count integer;
  v_total bigint:=0;
  v_manifest jsonb:='[]'::jsonb;
  v_file jsonb;
  v_name text;
  v_size bigint;
  v_mime text;
  v_sha text;
  v_path text;
  v_source_file_name text;
  v_index integer;
begin
  if lower(btrim(coalesce(p_upload_mode,'')))<>'inventory_count' then
    return public.hub_original_upload_intent_begin_v1(p_session_token,p_request_id,p_upload_mode,p_files,p_selected_fields,p_source_row_count);
  end if;
  v_actor:=operations_private.require_operations_hub_operator_session(p_session_token);
  if p_request_id is null then raise exception using errcode='22023',message='업로드 request_id가 필요합니다.'; end if;
  if jsonb_typeof(p_files)<>'array' or jsonb_typeof(coalesce(p_selected_fields,'{}'::jsonb))<>'object' then
    raise exception using errcode='22023',message='재고조사 manifest가 올바르지 않습니다.';
  end if;
  if p_source_row_count is null or p_source_row_count<1 or p_source_row_count>100000 then
    raise exception using errcode='22023',message='실제 변경 SKU 수가 올바르지 않습니다.';
  end if;
  if coalesce((p_selected_fields->>'inventory_count')::boolean,false) is not true
     or coalesce((p_selected_fields->>'stock')::boolean,false) is not true
     or coalesce((p_selected_fields->>'available_stock')::boolean,false) is not true
     or nullif(btrim(coalesce(p_selected_fields->>'base_snapshot_id','')),'') is null then
    raise exception using errcode='22023',message='재고조사 stock-only 계약 또는 기준 snapshot이 없습니다.';
  end if;
  v_count:=jsonb_array_length(p_files);
  if v_count<1 or v_count>10 then raise exception using errcode='22023',message='재고조사 파일은 1~10개까지 선택할 수 있습니다.'; end if;

  select * into v_existing from operations_private.operations_hub_original_upload_intents where request_id=p_request_id for update;
  if found then
    if v_existing.session_id is distinct from (v_actor->>'session_id')::uuid
       or v_existing.operator_username is distinct from (v_actor->>'username')
       or v_existing.upload_mode<>'inventory_count'
       or v_existing.request_manifest is distinct from p_files
       or v_existing.expected_row_count is distinct from p_source_row_count
       or v_existing.selected_fields is distinct from p_selected_fields then
      raise exception using errcode='23505',message='같은 request_id가 다른 재고조사 manifest에 이미 사용되었습니다.';
    end if;
    if v_existing.status<>'uploading' or v_existing.expires_at<=clock_timestamp() then
      raise exception using errcode='55000',message='이미 진행되었거나 만료된 업로드 intent입니다.';
    end if;
    return jsonb_build_object('intent_id',v_existing.intent_id,'snapshot_id',v_existing.snapshot_id,'source_channel','sellpia','upload_mode','inventory_count','status',v_existing.status,'expires_at',v_existing.expires_at,'manifest',v_existing.object_manifest);
  end if;

  for v_index in 0..v_count-1 loop
    v_file:=p_files->v_index;
    v_name:=btrim(coalesce(v_file->>'name',''));
    if v_name='' or length(v_name)>255 or lower(v_name)!~'\.xlsx$' then
      raise exception using errcode='22023',message='재고조사 원본은 XLSX 파일만 사용할 수 있습니다.';
    end if;
    if coalesce(v_file->>'size','')!~'^[0-9]+$' then raise exception using errcode='22023',message=format('%s 파일 크기가 올바르지 않습니다.',v_name); end if;
    v_size:=(v_file->>'size')::bigint;
    if v_size<1 or v_size>26214400 then raise exception using errcode='22023',message=format('%s 파일은 25 MiB 제한을 초과했거나 비어 있습니다.',v_name); end if;
    v_total:=v_total+v_size;
    if v_total>62914560 then raise exception using errcode='22023',message='재고조사 업로드 총 용량은 60 MiB를 초과할 수 없습니다.'; end if;
    v_mime:=lower(btrim(coalesce(v_file->>'mime_type','application/octet-stream')));
    if v_mime not in ('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/octet-stream') then
      raise exception using errcode='22023',message=format('%s MIME과 XLSX 확장자가 일치하지 않습니다.',v_name);
    end if;
    v_sha:=lower(nullif(btrim(coalesce(v_file->>'sha256','')),''));
    if v_sha is not null and v_sha!~'^[0-9a-f]{64}$' then raise exception using errcode='22023',message=format('%s SHA-256 형식이 올바르지 않습니다.',v_name); end if;
    v_path:=format('sellpia/%s/inventory-%s.xlsx',v_snapshot_id,lpad((v_index+1)::text,2,'0'));
    v_manifest:=v_manifest||jsonb_build_array(jsonb_build_object('ordinal',v_index+1,'name',v_name,'path',v_path,'size',v_size,'type',v_mime,'extension','xlsx','client_sha256',v_sha));
  end loop;
  select string_agg(item->>'name',' | ' order by ordinal) into v_source_file_name
  from jsonb_array_elements(p_files) with ordinality source(item,ordinal);

  insert into public.sellpia_stock_snapshots(snapshot_id,source_file_name,source_file_size,source_row_count,valid_row_count,invalid_row_count,upload_status,uploaded_by,metadata)
  values(v_snapshot_id,v_source_file_name,v_total,p_source_row_count,0,0,'uploading','operations_hub_inventory_count',
    jsonb_build_object('parser_version','operations-hub-inventory-count-v1','upload_intent_id',v_intent_id,'upload_mode','inventory_count','source_type','sellpia_inventory_count','source_files',p_files,'selected_fields',p_selected_fields,'digest_verification','client_declared_only'));
  insert into operations_private.operations_hub_original_upload_intents(intent_id,request_id,session_id,operator_username,source_channel,upload_mode,snapshot_id,selected_fields,request_manifest,object_manifest,expected_file_count,expected_total_bytes,expected_row_count,status,expires_at)
  values(v_intent_id,p_request_id,(v_actor->>'session_id')::uuid,v_actor->>'username','sellpia','inventory_count',v_snapshot_id,p_selected_fields,p_files,v_manifest,v_count,v_total,p_source_row_count,'uploading',clock_timestamp()+interval '2 hours');
  return jsonb_build_object('intent_id',v_intent_id,'snapshot_id',v_snapshot_id,'source_channel','sellpia','upload_mode','inventory_count','status','uploading','expires_at',clock_timestamp()+interval '2 hours','manifest',v_manifest);
end
$$;

create or replace function public.hub_sellpia_upload_rows_v2(p_session_token text,p_intent_id uuid,p_rows jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog set statement_timeout='30s' as $$
declare v_actor jsonb; v_intent operations_private.operations_hub_original_upload_intents%rowtype; v_count integer; v_inserted integer; v_total integer;
begin
  select * into v_intent from operations_private.operations_hub_original_upload_intents where intent_id=p_intent_id;
  if found and v_intent.upload_mode<>'inventory_count' then return public.hub_sellpia_upload_rows_v1(p_session_token,p_intent_id,p_rows); end if;
  v_actor:=operations_private.require_operations_hub_operator_session(p_session_token);
  select * into v_intent from operations_private.operations_hub_original_upload_intents where intent_id=p_intent_id for update;
  if not found then raise exception using errcode='P0002',message='업로드 intent를 찾을 수 없습니다.'; end if;
  if v_intent.session_id is distinct from (v_actor->>'session_id')::uuid or v_intent.operator_username is distinct from (v_actor->>'username') then raise exception using errcode='42501',message='다른 운영 세션의 업로드 intent입니다.'; end if;
  if v_intent.status not in ('uploaded','parsing') then raise exception using errcode='55000',message='행 import 가능한 업로드 상태가 아닙니다.'; end if;
  if jsonb_typeof(p_rows)<>'array' then raise exception using errcode='22023',message='재고조사 행 payload가 배열이 아닙니다.'; end if;
  v_count:=jsonb_array_length(p_rows);
  if v_count<1 or v_count>500 then raise exception using errcode='22023',message='재고조사 행은 한 번에 1~500개만 저장할 수 있습니다.'; end if;
  if exists(select 1 from jsonb_array_elements(p_rows) r where btrim(coalesce(r->>'sellpia_sku_code',''))='' or coalesce(r->>'stock','')!~'^-?[0-9]+$' or coalesce(r->>'available_stock','')!~'^-?[0-9]+$') then
    raise exception using errcode='22023',message='상품코드 또는 재고 정수값이 올바르지 않습니다.';
  end if;
  if exists(
    select 1 from jsonb_array_elements(p_rows) r
    where (r->>'stock')::numeric not between -2147483648 and 2147483647
       or (r->>'available_stock')::numeric not between -2147483648 and 2147483647
  ) then
    raise exception using errcode='22003',message='재고 값이 DB 정수 범위를 초과했습니다.';
  end if;
  insert into public.sellpia_stock_snapshot_rows(snapshot_id,sellpia_sku_code,stock,available_stock,source_row_no,raw_payload)
  select v_intent.snapshot_id,btrim(r->>'sellpia_sku_code'),(r->>'stock')::integer,(r->>'available_stock')::integer,nullif(r->>'source_row_no','')::integer,coalesce(r->'raw_payload','{}'::jsonb)
  from jsonb_array_elements(p_rows) r on conflict(snapshot_id,sellpia_sku_code) do nothing;
  get diagnostics v_inserted=row_count;
  update operations_private.operations_hub_original_upload_intents set status='parsing',parsing_at=coalesce(parsing_at,clock_timestamp()),updated_at=clock_timestamp() where intent_id=p_intent_id;
  select count(*)::integer into v_total from public.sellpia_stock_snapshot_rows where snapshot_id=v_intent.snapshot_id;
  return jsonb_build_object('intent_id',p_intent_id,'snapshot_id',v_intent.snapshot_id,'inserted_count',v_inserted,'row_count',v_total,'expected_row_count',v_intent.expected_row_count);
end
$$;

create or replace function public.finalize_operations_hub_sellpia_inventory_count(p_snapshot_id uuid,p_selected_fields jsonb)
returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare v_patch public.sellpia_stock_snapshots%rowtype; v_base uuid; v_latest uuid; v_uploaded integer; v_matched integer; v_preserved integer; v_final integer; v_affected jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('operations_hub_sellpia_patch',0));
  select * into v_patch from public.sellpia_stock_snapshots where snapshot_id=p_snapshot_id for update;
  if not found or v_patch.upload_status<>'uploading' then raise exception '처리 가능한 재고조사 snapshot이 아닙니다.'; end if;
  v_base:=nullif(btrim(coalesce(p_selected_fields->>'base_snapshot_id','')),'')::uuid;
  select snapshot_id into v_latest from public.sellpia_stock_snapshots where upload_status='ready' and snapshot_id<>p_snapshot_id order by created_at desc limit 1;
  if v_base is null or v_latest is distinct from v_base then raise exception using errcode='55000',message='미리보기 이후 최신 Sellpia snapshot이 변경되었습니다. 다시 미리보기해주세요.'; end if;
  select count(*)::integer,jsonb_agg(sellpia_sku_code order by sellpia_sku_code) into v_uploaded,v_affected from public.sellpia_stock_snapshot_rows where snapshot_id=p_snapshot_id;
  if v_uploaded<1 then raise exception '실제 변경 SKU가 없습니다.'; end if;
  select count(*)::integer into v_matched from public.sellpia_stock_snapshot_rows patch join public.sellpia_stock_snapshot_rows base on base.snapshot_id=v_base and base.sellpia_sku_code=patch.sellpia_sku_code where patch.snapshot_id=p_snapshot_id;
  if v_matched<>v_uploaded then raise exception using errcode='22023',message='현재 System V3에서 식별되지 않는 상품코드가 포함되어 있습니다.'; end if;
  if exists(select 1 from public.sellpia_stock_snapshot_rows patch join public.sellpia_stock_snapshot_rows base on base.snapshot_id=v_base and base.sellpia_sku_code=patch.sellpia_sku_code where patch.snapshot_id=p_snapshot_id and patch.stock is not distinct from base.stock and patch.available_stock is not distinct from base.available_stock) then
    raise exception using errcode='55000',message='미리보기와 달리 변경되지 않은 SKU가 payload에 포함되었습니다.';
  end if;
  update public.sellpia_stock_snapshot_rows patch set
    sellpia_product_code=base.sellpia_product_code,sellpia_product_name=base.sellpia_product_name,sellpia_option_name=base.sellpia_option_name,own_sku=base.own_sku,
    integrated_available_stock=base.integrated_available_stock,safety_stock=base.safety_stock,
    supplier_code=base.supplier_code,supplier_name=base.supplier_name,supplier_group=base.supplier_group,supplier_address=base.supplier_address,supplier_market_name=base.supplier_market_name,supplier_phone=base.supplier_phone,
    purchase_product_name=base.purchase_product_name,purchase_option_name=base.purchase_option_name,purchase_price=base.purchase_price,order_unit=base.order_unit,minimum_order_unit=base.minimum_order_unit,
    raw_payload=coalesce(base.raw_payload,'{}'::jsonb)||coalesce(patch.raw_payload,'{}'::jsonb)||jsonb_build_object('inventory_count_snapshot_id',p_snapshot_id,'inventory_count_base_snapshot_id',v_base)
  from public.sellpia_stock_snapshot_rows base where patch.snapshot_id=p_snapshot_id and base.snapshot_id=v_base and base.sellpia_sku_code=patch.sellpia_sku_code;
  insert into public.sellpia_stock_snapshot_rows(snapshot_id,sellpia_sku_code,sellpia_product_code,sellpia_product_name,sellpia_option_name,own_sku,stock,available_stock,integrated_available_stock,safety_stock,source_row_no,raw_payload,supplier_code,supplier_name,supplier_group,supplier_address,supplier_market_name,supplier_phone,purchase_product_name,purchase_option_name,purchase_price,order_unit,minimum_order_unit)
  select p_snapshot_id,base.sellpia_sku_code,base.sellpia_product_code,base.sellpia_product_name,base.sellpia_option_name,base.own_sku,base.stock,base.available_stock,base.integrated_available_stock,base.safety_stock,base.source_row_no,coalesce(base.raw_payload,'{}'::jsonb)||jsonb_build_object('preserved_from_snapshot_id',v_base),base.supplier_code,base.supplier_name,base.supplier_group,base.supplier_address,base.supplier_market_name,base.supplier_phone,base.purchase_product_name,base.purchase_option_name,base.purchase_price,base.order_unit,base.minimum_order_unit
  from public.sellpia_stock_snapshot_rows base where base.snapshot_id=v_base and not exists(select 1 from public.sellpia_stock_snapshot_rows patch where patch.snapshot_id=p_snapshot_id and patch.sellpia_sku_code=base.sellpia_sku_code);
  get diagnostics v_preserved=row_count;
  select count(*)::integer into v_final from public.sellpia_stock_snapshot_rows where snapshot_id=p_snapshot_id;
  update public.sellpia_stock_snapshots set valid_row_count=v_final,invalid_row_count=0,upload_status='ready',upload_note=format('재고조사 stock-only %s개 SKU · 기존 %s개 SKU 유지',v_uploaded,v_preserved),metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('upload_mode','inventory_count','source_type','sellpia_inventory_count','base_snapshot_id',v_base,'uploaded_row_count',v_uploaded,'preserved_row_count',v_preserved,'final_row_count',v_final,'affected_skus',coalesce(v_affected,'[]'::jsonb),'selected_fields',p_selected_fields),completed_at=clock_timestamp() where snapshot_id=p_snapshot_id;
  return jsonb_build_object('snapshot_id',p_snapshot_id,'base_snapshot_id',v_base,'upload_mode','inventory_count','uploaded_row_count',v_uploaded,'preserved_row_count',v_preserved,'row_count',v_final,'affected_skus',coalesce(v_affected,'[]'::jsonb));
end
$$;

create or replace function public.hub_sellpia_upload_complete_v2(p_session_token text,p_intent_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog set statement_timeout='90s' set lock_timeout='5s' as $$
declare v_actor jsonb; v_intent operations_private.operations_hub_original_upload_intents%rowtype; v_rows integer; v_result jsonb;
begin
  select * into v_intent from operations_private.operations_hub_original_upload_intents where intent_id=p_intent_id;
  if found and v_intent.upload_mode<>'inventory_count' then return public.hub_sellpia_upload_complete_v1(p_session_token,p_intent_id); end if;
  v_actor:=operations_private.require_operations_hub_operator_session(p_session_token);
  select * into v_intent from operations_private.operations_hub_original_upload_intents where intent_id=p_intent_id for update;
  if not found then raise exception using errcode='P0002',message='업로드 intent를 찾을 수 없습니다.'; end if;
  if v_intent.session_id is distinct from (v_actor->>'session_id')::uuid or v_intent.operator_username is distinct from (v_actor->>'username') then raise exception using errcode='42501',message='다른 운영 세션의 업로드 intent입니다.'; end if;
  if v_intent.status='ready' then select jsonb_build_object('intent_id',v_intent.intent_id,'snapshot_id',v_intent.snapshot_id,'upload_mode','inventory_count','status','ready','row_count',s.valid_row_count,'affected_skus',coalesce(s.metadata->'affected_skus','[]'::jsonb)) into v_result from public.sellpia_stock_snapshots s where s.snapshot_id=v_intent.snapshot_id; return v_result; end if;
  if v_intent.status not in ('uploaded','parsing') then raise exception using errcode='55000',message='완료 가능한 재고조사 업로드 상태가 아닙니다.'; end if;
  select count(*)::integer into v_rows from public.sellpia_stock_snapshot_rows where snapshot_id=v_intent.snapshot_id;
  if v_rows<>v_intent.expected_row_count then raise exception using errcode='22023',message=format('재고조사 변경 행 수가 manifest와 다릅니다. 기대 %s / 저장 %s',v_intent.expected_row_count,v_rows); end if;
  v_result:=public.finalize_operations_hub_sellpia_inventory_count(v_intent.snapshot_id,v_intent.selected_fields);
  update operations_private.operations_hub_original_upload_intents set status='ready',finalized_at=clock_timestamp(),updated_at=clock_timestamp() where intent_id=p_intent_id;
  return coalesce(v_result,'{}'::jsonb)||jsonb_build_object('intent_id',p_intent_id,'status','ready');
end
$$;

create or replace function public.hub_sellpia_stock_sources_read_v1(p_session_token text,p_skus text[])
returns jsonb language plpgsql security definer set search_path=pg_catalog set statement_timeout='15s' as $$
declare v_actor jsonb; v_snapshot uuid; v_rows jsonb;
begin
  v_actor:=operations_private.require_operations_hub_operator_session(p_session_token);
  if coalesce(cardinality(p_skus),0)<1 or cardinality(p_skus)>1000 then raise exception using errcode='22023',message='재고 source 조회는 1~1,000개 SKU여야 합니다.'; end if;
  select snapshot_id into v_snapshot from public.sellpia_stock_snapshots where upload_status='ready' order by created_at desc limit 1;
  if v_snapshot is null then raise exception using errcode='P0002',message='최신 Sellpia snapshot이 없습니다.'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('sellpia_sku_code',r.sellpia_sku_code,'sellpia_current_stock',r.stock,'sellpia_available_stock',r.available_stock) order by r.sellpia_sku_code),'[]'::jsonb) into v_rows
  from public.sellpia_stock_snapshot_rows r where r.snapshot_id=v_snapshot and r.sellpia_sku_code=any(p_skus);
  return jsonb_build_object('snapshot_id',v_snapshot,'rows',v_rows);
end
$$;

alter table public.operations_hub_export_batches
  add column if not exists stock_source text;
alter table public.operations_hub_export_batches
  drop constraint if exists operations_hub_export_batches_export_mode_check;
alter table public.operations_hub_export_batches
  add constraint operations_hub_export_batches_export_mode_check
  check (export_mode in ('change_queue','inventory_match','stock_only'));
alter table public.operations_hub_export_batches
  drop constraint if exists operations_hub_export_batches_stock_source_check;
alter table public.operations_hub_export_batches
  add constraint operations_hub_export_batches_stock_source_check
  check (stock_source is null or stock_source in ('stock','available_stock'));

create or replace function public.hub_stock_export_audit_v1(
  p_session_token text,
  p_export_batch_id uuid,
  p_source_channels text[],
  p_stock_source text,
  p_item_count integer,
  p_file_manifest jsonb
)
returns jsonb language plpgsql security definer set search_path=pg_catalog set statement_timeout='10s' as $$
declare v_actor jsonb; v_existing public.operations_hub_export_batches%rowtype;
begin
  v_actor:=operations_private.require_operations_hub_operator_session(p_session_token);
  if p_export_batch_id is null then raise exception using errcode='22023',message='재고 내보내기 batch id가 필요합니다.'; end if;
  if p_stock_source not in ('stock','available_stock') then raise exception using errcode='22023',message='재고 내보내기 기준이 올바르지 않습니다.'; end if;
  if coalesce(cardinality(p_source_channels),0)<1 or not (p_source_channels <@ array['smartstore','makeshop','ably']::text[]) then raise exception using errcode='22023',message='재고 내보내기 판매처가 올바르지 않습니다.'; end if;
  if p_item_count is null or p_item_count<0 then raise exception using errcode='22023',message='재고 내보내기 반영 건수가 올바르지 않습니다.'; end if;
  if jsonb_typeof(coalesce(p_file_manifest,'null'::jsonb))<>'array' then raise exception using errcode='22023',message='재고 내보내기 파일 manifest가 올바르지 않습니다.'; end if;
  select * into v_existing from public.operations_hub_export_batches where export_batch_id=p_export_batch_id;
  if found then
    if v_existing.export_mode<>'stock_only' or v_existing.source_channels is distinct from p_source_channels or v_existing.stock_source is distinct from p_stock_source or v_existing.item_count is distinct from p_item_count or v_existing.file_manifest is distinct from p_file_manifest then
      raise exception using errcode='23505',message='같은 batch id가 다른 재고 내보내기 계약에 이미 사용되었습니다.';
    end if;
    return jsonb_build_object('export_batch_id',v_existing.export_batch_id,'status',v_existing.status,'stock_source',v_existing.stock_source,'item_count',v_existing.item_count,'idempotent',true);
  end if;
  insert into public.operations_hub_export_batches(export_batch_id,export_mode,source_channels,status,item_count,file_manifest,stock_source,requested_by,exported_at)
  values(p_export_batch_id,'stock_only',p_source_channels,'exported',p_item_count,p_file_manifest,p_stock_source,'operations_hub_frontend',clock_timestamp());
  return jsonb_build_object('export_batch_id',p_export_batch_id,'status','exported','stock_source',p_stock_source,'item_count',p_item_count,'idempotent',false,'operator',v_actor->>'username');
end
$$;

revoke all on function public.hub_original_upload_intent_begin_v2(text,uuid,text,jsonb,jsonb,integer) from public;
revoke all on function public.hub_sellpia_upload_rows_v2(text,uuid,jsonb) from public;
revoke all on function public.hub_sellpia_upload_complete_v2(text,uuid) from public;
revoke all on function public.finalize_operations_hub_sellpia_inventory_count(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.hub_sellpia_stock_sources_read_v1(text,text[]) from public;
revoke all on function public.hub_stock_export_audit_v1(text,uuid,text[],text,integer,jsonb) from public;
grant execute on function public.hub_original_upload_intent_begin_v2(text,uuid,text,jsonb,jsonb,integer) to anon,authenticated;
grant execute on function public.hub_sellpia_upload_rows_v2(text,uuid,jsonb) to anon,authenticated;
grant execute on function public.hub_sellpia_upload_complete_v2(text,uuid) to anon,authenticated;
grant execute on function public.hub_sellpia_stock_sources_read_v1(text,text[]) to anon,authenticated;
grant execute on function public.hub_stock_export_audit_v1(text,uuid,text[],text,integer,jsonb) to anon,authenticated;

comment on function public.finalize_operations_hub_sellpia_inventory_count(uuid,jsonb) is 'Materializes a stock/available-stock-only snapshot over an exact ready base. All other Sellpia fields are preserved.';
comment on function public.hub_sellpia_stock_sources_read_v1(text,text[]) is 'Session-gated physical/available stock read for seller stock-only export projection.';
comment on function public.hub_stock_export_audit_v1(text,uuid,text[],text,integer,jsonb) is 'Records the selected physical/available stock source before a stock-only carrier download begins.';
notify pgrst,'reload schema';
