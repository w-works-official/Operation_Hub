-- Preserve the complete snapshot, JSONB provenance, API and timeout contracts.
-- No Production changes are authorized by this migration file's creation.
-- Refuse to overwrite a parallel session's function edits. Reapplying this
-- reviewed migration/rollback is allowed; any other definition requires review.
do $sellpia_timeout_guard$
begin
  if not exists (select 1 from pg_catalog.pg_proc
    where oid='public.finalize_operations_hub_sellpia_inventory_count(uuid,jsonb)'::regprocedure
      and md5(replace(prosrc,chr(13)||chr(10),chr(10))) in ('cfa25b34c76381cf384981cd4daf2fb0','93d010cd561c58d3b4e91d5e3bb8a8de')
      and proconfig=array['search_path=public, pg_temp']::text[] and not prosecdef) then
    raise exception using errcode='55000',message='Inventory-count finalizer drift: re-read and review before applying.';
  end if;
  if not exists (select 1 from pg_catalog.pg_proc
    where oid='public.hub_sellpia_upload_complete_v1(text,uuid)'::regprocedure
      and md5(replace(prosrc,chr(13)||chr(10),chr(10))) in ('fb82f205edd36f622581b643f1d7aebe','397b8b18e326a58a49944a10e977c071')
      and proconfig=array['search_path=pg_catalog','statement_timeout=90s','lock_timeout=5s']::text[] and prosecdef) then
    raise exception using errcode='55000',message='Sellpia completion v1 drift: re-read and review before applying.';
  end if;
  if not exists (select 1 from pg_catalog.pg_proc
    where oid='operations_private.hub_sellpia_patch_read_v3(text,uuid,uuid,text[],text,text,integer,integer,boolean)'::regprocedure
      and md5(replace(prosrc,chr(13)||chr(10),chr(10))) in ('55f559c604b3502c6b56c312533ac646','b327042ae96c5894b6633307ec5a6511')
      and proconfig=array['search_path=pg_catalog','statement_timeout=60s']::text[] and prosecdef and provolatile='s') then
    raise exception using errcode='55000',message='Sellpia carrier reader v3 drift: re-read and review before applying.';
  end if;
end
$sellpia_timeout_guard$;

CREATE OR REPLACE FUNCTION public.finalize_operations_hub_sellpia_inventory_count(p_snapshot_id uuid, p_selected_fields jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  -- Freeze the uploaded key set before inserting into the same indexed table.
  -- Both SKU columns are NOT NULL (the composite primary key), so NOT IN has
  -- the same exclusion semantics as the old NOT EXISTS. Its hashed SubPlan
  -- avoids rescanning a target index range that grows during this statement.
  with uploaded_skus as materialized (
    select sellpia_sku_code from public.sellpia_stock_snapshot_rows
    where snapshot_id=p_snapshot_id
  )
  insert into public.sellpia_stock_snapshot_rows(snapshot_id,sellpia_sku_code,sellpia_product_code,sellpia_product_name,sellpia_option_name,own_sku,stock,available_stock,integrated_available_stock,safety_stock,source_row_no,raw_payload,supplier_code,supplier_name,supplier_group,supplier_address,supplier_market_name,supplier_phone,purchase_product_name,purchase_option_name,purchase_price,order_unit,minimum_order_unit)
  select p_snapshot_id,base.sellpia_sku_code,base.sellpia_product_code,base.sellpia_product_name,base.sellpia_option_name,base.own_sku,base.stock,base.available_stock,base.integrated_available_stock,base.safety_stock,base.source_row_no,coalesce(base.raw_payload,'{}'::jsonb)||jsonb_build_object('preserved_from_snapshot_id',v_base),base.supplier_code,base.supplier_name,base.supplier_group,base.supplier_address,base.supplier_market_name,base.supplier_phone,base.purchase_product_name,base.purchase_option_name,base.purchase_price,base.order_unit,base.minimum_order_unit
  from public.sellpia_stock_snapshot_rows base where base.snapshot_id=v_base and base.sellpia_sku_code not in (select sellpia_sku_code from uploaded_skus);
  get diagnostics v_preserved=row_count;
  select count(*)::integer into v_final from public.sellpia_stock_snapshot_rows where snapshot_id=p_snapshot_id;
  update public.sellpia_stock_snapshots set valid_row_count=v_final,invalid_row_count=0,upload_status='ready',upload_note=format('재고조사 stock-only %s개 SKU · 기존 %s개 SKU 유지',v_uploaded,v_preserved),metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('upload_mode','inventory_count','source_type','sellpia_inventory_count','base_snapshot_id',v_base,'uploaded_row_count',v_uploaded,'preserved_row_count',v_preserved,'final_row_count',v_final,'affected_skus',coalesce(v_affected,'[]'::jsonb),'selected_fields',p_selected_fields),completed_at=clock_timestamp() where snapshot_id=p_snapshot_id;
  return jsonb_build_object('snapshot_id',p_snapshot_id,'base_snapshot_id',v_base,'upload_mode','inventory_count','uploaded_row_count',v_uploaded,'preserved_row_count',v_preserved,'row_count',v_final,'affected_skus',coalesce(v_affected,'[]'::jsonb));
end
$function$;

CREATE OR REPLACE FUNCTION public.hub_sellpia_upload_complete_v1(p_session_token text, p_intent_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
 SET statement_timeout TO '90s'
 SET lock_timeout TO '5s'
AS $function$
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
    -- Full replacement must serialize with patch/inventory-count finalization.
    -- An inventory preview's base proof is checked while holding this lock.
    perform pg_advisory_xact_lock(hashtextextended('operations_hub_sellpia_patch',0));
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
$function$;
-- The stock-only snapshot keeps the full carrier in its existing base lineage.
CREATE OR REPLACE FUNCTION operations_private.hub_sellpia_patch_read_v3(p_session_token text, p_snapshot_id uuid, p_state_snapshot_id uuid, p_skus text[] DEFAULT NULL::text[], p_search text DEFAULT ''::text, p_search_type text DEFAULT 'sku'::text, p_offset integer DEFAULT 0, p_limit integer DEFAULT 100, p_with_results boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
 SET statement_timeout TO '60s'
AS $function$
declare
  v_codes text[];
  v_latest_snapshot_id uuid;
  v_carrier_snapshot_id uuid;
  v_result jsonb;
  v_term text:=btrim(coalesce(p_search,''));
  v_pattern text;
  v_exact_match boolean;
begin
  perform operations_private.require_operations_hub_operator_session(p_session_token);
  if p_snapshot_id is null or p_state_snapshot_id is null
     or p_search_type is null
     or p_search_type not in ('sku','own_code','name')
     or p_offset is null or p_offset<0
     or p_limit is null or p_limit not between 1 and 500
     or cardinality(p_skus)>5000 then
    raise exception '유효하지 않은 조회 범위';
  end if;
  select s.snapshot_id into v_latest_snapshot_id
    from public.sellpia_stock_snapshots s
   where s.upload_status='ready'
   order by s.completed_at desc nulls last,s.created_at desc,s.snapshot_id desc
   limit 1;
  if v_latest_snapshot_id is distinct from p_state_snapshot_id then
    raise exception 'Sellpia 원본 상태가 변경됐습니다. 미리보기를 다시 실행하세요.';
  end if;

  with recursive lineage as (
    select s.snapshot_id,s.metadata,1 as depth,array[s.snapshot_id] as seen
      from public.sellpia_stock_snapshots s
     where s.snapshot_id=v_latest_snapshot_id and s.upload_status='ready'
    union all
    select parent.snapshot_id,parent.metadata,child.depth+1,child.seen||parent.snapshot_id
      from lineage child
      join public.sellpia_stock_snapshots parent
        on parent.snapshot_id=nullif(child.metadata->>'base_snapshot_id','')::uuid
       and parent.upload_status='ready'
     where lower(coalesce(child.metadata->>'upload_mode','full')) in ('patch','inventory_count')
       and child.depth<256
       and not parent.snapshot_id=any(child.seen)
  )
  select l.snapshot_id into v_carrier_snapshot_id
    from lineage l
   where lower(coalesce(l.metadata->>'upload_mode','full'))='full'
     and case when jsonb_typeof(l.metadata->'source_storage_files')='array'
              then jsonb_array_length(l.metadata->'source_storage_files')=3
              else false end
   order by l.depth desc limit 1;
  if v_carrier_snapshot_id is distinct from p_snapshot_id then
    raise exception '선택한 Sellpia 전체 원본이 현재 상태의 carrier가 아닙니다.';
  end if;

  v_pattern:=replace(replace(replace(v_term,E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_')||'%';
  if p_skus is not null then
    v_codes:=p_skus;
  elsif v_term='' then
    raise exception 'SKU 또는 검색어를 입력하세요.';
  else
    select exists(
      select 1 from operations_private.operations_hub_matrix_export_cache c
      where case p_search_type
        when 'sku' then c.sellpia_sku_code=v_term
        when 'own_code' then coalesce(c.sellpia_own_code,c.own_code)=v_term
        else false
      end
    ) into v_exact_match;
    select array_agg(c.sellpia_sku_code order by c.sellpia_sku_code)
      into v_codes
      from operations_private.operations_hub_matrix_export_cache c
     where case p_search_type
       when 'sku' then case when v_exact_match then c.sellpia_sku_code=v_term else c.sellpia_sku_code like v_pattern escape E'\\' end
       when 'own_code' then case when v_exact_match then coalesce(c.sellpia_own_code,c.own_code)=v_term else coalesce(c.sellpia_own_code,c.own_code) like v_pattern escape E'\\' end
       else position(lower(v_term) in lower(concat_ws(' ',c.sellpia_product_name,c.sellpia_option_name)))>0
     end;
  end if;

  with wanted as (
    select distinct s from unnest(v_codes) s
  ), selected as (
    select s from wanted order by s offset p_offset limit p_limit
  ), proofs as materialized (
    select s,operations_private.hub_sku_input_fingerprint_v1(s,'') fp
      from selected
     where p_with_results
       and exists(
         select 1
           from operations_private.hub_rule_assignments a
           join operations_private.hub_rules ru on ru.id=a.rule_id and ru.is_active
          where a.sku=s and a.scope=''
       )
  ), rows as (
    select jsonb_build_object(
      'sellpia_sku_code',s,
      'sellpia_product_code',raw.sellpia_product_code,
      'sellpia_product_name',raw.sellpia_product_name,
      'sellpia_option_name',raw.sellpia_option_name,
      'own_code',c.own_code,
      'sellpia_source_purchase_price',raw.purchase_price,
      'sellpia_purchase_price',coalesce(m.purchase_price,current_raw.purchase_price),
      'sellpia_source_sale_price',nullif(raw.raw_payload->>'base_price','')::numeric,
      'sellpia_source_stock',raw.stock,
      'system_base_price',m.base_price,
      'system_stock',m.stock_quantity,
      '__missing',raw.sellpia_sku_code is null or current_raw.sellpia_sku_code is null,
      '__hubInternalPrices',case when p_with_results then coalesce((
        select jsonb_object_agg(r.field,jsonb_build_object(
          'value',r.value,
          'error',r.error,
          'generationId',r.generation_id,
          'versions',r.rule_versions,
          'provenanceMismatch',exists(
            select 1
              from operations_private.hub_rule_assignments a
              join operations_private.hub_rules ru on ru.id=a.rule_id and ru.is_active
             where a.sku=s and a.scope='' and a.target_field=r.field
               and not exists(
                 select 1 from jsonb_array_elements(coalesce(r.rule_versions,'[]')) v
                  where v->>'id'=ru.id::text
                    and v->>'version'=ru.version::text
                    and v->>'assignmentVersion'=a.version::text
               )
          ),
          'activeOutputRules',(
            select coalesce(jsonb_agg(jsonb_build_object(
              'id',ru.id,'name',ru.name,'version',ru.version,'assignmentVersion',a.version
            )),'[]')
              from operations_private.hub_rule_assignments a
              join operations_private.hub_rules ru on ru.id=a.rule_id and ru.is_active
             where a.sku=s and a.scope='' and a.target_field=r.field
          ),
          'stale',r.status<>'calculated' or r.result_details->>'input_fingerprint' is distinct from proof.fp
        ))
          from operations_private.hub_calculated_results r
         where r.sku=s and r.scope=''
           and r.field in ('actual_inbound_cost','calculated_base_price')
      ),'{}') else '{}'::jsonb end,
      '__activeBaseOwner',exists(
        select 1
          from operations_private.hub_rule_assignments a
          join operations_private.hub_rules ru on ru.id=a.rule_id and ru.is_active
         where a.sku=s and a.scope='' and a.target_field='calculated_base_price'
      )
    ) as row
      from selected
      left join public.sellpia_stock_snapshot_rows raw
        on raw.snapshot_id=p_snapshot_id and raw.sellpia_sku_code=s
      left join public.sellpia_stock_snapshot_rows current_raw
        on current_raw.snapshot_id=v_latest_snapshot_id and current_raw.sellpia_sku_code=s
      left join public.operations_hub_sku_operational_master m
        on m.sellpia_sku_code=s
      left join operations_private.operations_hub_matrix_export_cache c
        on c.sellpia_sku_code=s
      left join proofs proof using(s)
  )
  select jsonb_build_object(
    'snapshot_id',p_snapshot_id,
    'state_snapshot_id',v_latest_snapshot_id,
    'rows',coalesce(jsonb_agg(row),'[]'),
    'count',(select count(*) from wanted)
  ) into v_result from rows;
  return v_result;
end;
$function$;
