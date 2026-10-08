-- Prefetch batch-scoped Matrix stock, exact legacy identity owners, and suppressions
-- so full workbook imports avoid per-row database queries.
create or replace function operations_private.ably_mapping_import_core_v1(
  p_batch_key text,
  p_file_name text,
  p_file_sha256 text,
  p_rows jsonb,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
set statement_timeout = '60s'
set lock_timeout = '5s'
as $$
declare
  v_row jsonb;
  v_product text;
  v_option text;
  v_solution text;
  v_candidate text;
  v_stock integer;
  v_safety integer;
  v_row_no integer;
  v_old public.operations_hub_ably_inventory_mappings%rowtype;
  v_new public.operations_hub_ably_inventory_mappings%rowtype;
  v_current_stock integer;
  v_code_count integer;
  v_code_counts jsonb := '{}'::jsonb;
  v_matrix_stock_map jsonb := '{}'::jsonb;
  v_manual_owner_map jsonb := '{}'::jsonb;
  v_suppression_map jsonb := '{}'::jsonb;
  v_manual_entry jsonb;
  v_suppressed boolean;
  v_manual_agrees boolean;
  v_manual_owner_count integer;
  v_eligible boolean;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_preserved integer := 0;
  v_verified integer := 0;
  v_review integer := 0;
  v_conflict integer := 0;
  v_seen integer := 0;
  v_result jsonb;
begin
  if p_batch_key is null or length(p_batch_key) < 16 or p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='22023', message='유효한 배치 키와 SHA-256 파일 지문이 필요합니다.';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception using errcode='22023', message='원본 행은 JSON 배열이어야 합니다.';
  end if;
  if jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 10000 then
    raise exception using errcode='22023', message='원본 행은 배열이어야 하며 10,000행을 넘을 수 없습니다.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_rows) as x(r)
    group by r->>'product_code', coalesce(r->>'option_code','') having count(*) > 1
  ) then
    raise exception using errcode='23505', message='동일한 상품 번호 + 옵션 번호가 파일에서 중복되었습니다.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_rows) as x(r)
    where coalesce(r->>'source_stock','') !~ '^([0-9]+)?$'
       or coalesce(r->>'safety_stock','') !~ '^([0-9]+)?$'
       or coalesce(r->>'source_row_no','') !~ '^[1-9][0-9]*$'
  ) then
    raise exception using errcode='22023', message='재고·안전재고·원본 행 번호 형식이 올바르지 않습니다.';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) as x(r) where coalesce(r->>'product_code','') = '') then
    raise exception using errcode='22023', message='상품 번호 A열은 비어 있을 수 없습니다.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_file_sha256,0));
  if exists (select 1 from operations_private.operations_hub_ably_mapping_import_batches b where b.file_sha256=p_file_sha256) then
    select b.result into v_result from operations_private.operations_hub_ably_mapping_import_batches b where b.file_sha256=p_file_sha256;
    return v_result || jsonb_build_object('idempotent',true);
  end if;
  if exists (select 1 from operations_private.operations_hub_ably_mapping_import_batches b where b.batch_key=p_batch_key and b.file_sha256<>p_file_sha256) then
    raise exception using errcode='23505', message='배치 키가 다른 파일에 이미 사용되었습니다.';
  end if;

  -- Build lookup maps once, scoped to this batch. This replaces three database
  -- lookups per source row while preserving exact identity, owner-count,
  -- suppression, and current-stock semantics.
  select coalesce(jsonb_object_agg(code, code_count), '{}'::jsonb)
    into v_code_counts
    from (
      select coalesce(r->>'solution_code','') as code, count(*) as code_count
      from jsonb_array_elements(p_rows) as x(r)
      where coalesce(r->>'solution_code','') <> ''
      group by coalesce(r->>'solution_code','')
    ) counts;

  with batch_skus as (
    select distinct substring(r->>'solution_code' from 9) as sku
    from jsonb_array_elements(p_rows) as x(r)
    where left(coalesce(r->>'solution_code',''),8)='sellpia_'
      and length(coalesce(r->>'solution_code',''))>8
  )
  select coalesce(jsonb_object_agg(matrix.sellpia_sku_code,to_jsonb(matrix.sellpia_current_stock)), '{}'::jsonb)
    into v_matrix_stock_map
    from batch_skus b
    join public.operations_hub_matrix_live matrix on matrix.sellpia_sku_code=b.sku;

  with batch_identities as (
    select r->>'product_code' as product_code,coalesce(r->>'option_code','') as option_code,
      case when left(coalesce(r->>'solution_code',''),8)='sellpia_' and length(coalesce(r->>'solution_code',''))>8
        then substring(r->>'solution_code' from 9) else null end as candidate_sku_code
    from jsonb_array_elements(p_rows) as x(r)
  ), owner_counts as (
    select b.product_code,b.option_code,count(distinct m.sellpia_sku_code)::integer as owner_count,
      coalesce(bool_or(m.sellpia_sku_code=b.candidate_sku_code),false) as candidate_agrees
    from batch_identities b
    left join public.operations_hub_manual_links m
      on m.source_channel='ably' and m.product_code=b.product_code and m.option_code=b.option_code
    group by b.product_code,b.option_code
  ), per_product as (
    select product_code,jsonb_object_agg(option_code,jsonb_build_object('owner_count',owner_count,'candidate_agrees',candidate_agrees)) as options
    from owner_counts group by product_code
  )
  select coalesce(jsonb_object_agg(product_code,options),'{}'::jsonb)
    into v_manual_owner_map from per_product;

  with batch_identities as (
    select distinct r->>'product_code' as product_code,coalesce(r->>'option_code','') as option_code
    from jsonb_array_elements(p_rows) as x(r)
  ), suppressed as (
    select distinct b.product_code,b.option_code
    from batch_identities b
    join public.operations_hub_link_suppressions s
      on s.source_channel='ably' and s.product_code=b.product_code and s.option_code=b.option_code
  ), per_product as (
    select product_code,jsonb_object_agg(option_code,'true'::jsonb) as options
    from suppressed group by product_code
  )
  select coalesce(jsonb_object_agg(product_code,options),'{}'::jsonb)
    into v_suppression_map from per_product;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_seen := v_seen + 1;
    v_product := v_row->>'product_code';
    v_option := coalesce(v_row->>'option_code','');
    v_solution := coalesce(v_row->>'solution_code','');
    v_candidate := case when left(v_solution,8)='sellpia_' and length(v_solution)>8 then substring(v_solution from 9) else null end;
    v_stock := nullif(v_row->>'source_stock','')::integer;
    v_safety := nullif(v_row->>'safety_stock','')::integer;
    v_row_no := (v_row->>'source_row_no')::integer;

    v_code_count := case when v_solution='' then 0 else coalesce((v_code_counts->>v_solution)::integer,0) end;
    v_suppressed := coalesce((v_suppression_map #> array[v_product,v_option])='true'::jsonb,false);
    v_manual_entry := v_manual_owner_map #> array[v_product,v_option];
    v_manual_owner_count := coalesce((v_manual_entry->>'owner_count')::integer,0);
    v_manual_agrees := v_manual_owner_count=1 and coalesce((v_manual_entry->>'candidate_agrees')::boolean,false);
    v_current_stock := nullif(v_matrix_stock_map->>v_candidate,'')::integer;
    v_eligible := v_candidate is not null and v_code_count=1 and v_manual_agrees
      and v_current_stock is not null and v_stock is not null and v_stock=v_current_stock and not v_suppressed;

    select mapping.* into v_old from public.operations_hub_ably_inventory_mappings mapping
      where mapping.product_code=v_product and mapping.option_code=v_option for update;
    if not found then
      insert into public.operations_hub_ably_inventory_mappings(
        product_code,option_code,solution_code,candidate_sku_code,sellpia_sku_code,
        mapping_state,review_reasons,stock_policy,individual_stock,is_active,source_stock,safety_stock,
        source_batch_key,source_file_name,source_file_sha256,source_row_no,source_provenance,created_by,updated_by
      ) values (
        v_product,v_option,v_solution,v_candidate,v_candidate,
        case when v_manual_owner_count>1 then 'conflict' when v_eligible then 'verified' else 'review' end,
        case when v_manual_owner_count>1 then array['ambiguous_manual_identity_owners']::text[]
             when v_code_count>1 then array['duplicate_solution_code']::text[]
             when v_suppressed then array['legacy_suppression_active']::text[]
             when not v_manual_agrees then array['no_exact_manual_identity_match']::text[]
             when v_current_stock is distinct from v_stock then array['source_stock_differs']::text[]
             when v_candidate is null then array['candidate_missing']::text[] else '{}'::text[] end,
        case when v_eligible then 'shared' else 'review' end,null,v_eligible,v_stock,v_safety,p_batch_key,p_file_name,p_file_sha256,v_row_no,
        jsonb_build_object('source_column_product','A','source_column_option','H','source_column_solution','J','source_column_stock','N','source_column_safety','O'),p_actor,p_actor
      ) returning * into v_new;
      v_inserted:=v_inserted+1;
      insert into operations_private.operations_hub_ably_mapping_history(product_code,option_code,event_type,before_value,after_value,changed_by,reason)
      values(v_product,v_option,'source_import',null,to_jsonb(v_new),p_actor,'initial source row');
    else
      if v_old.solution_code is distinct from v_solution then
        update public.operations_hub_ably_inventory_mappings mapping set
          solution_code=v_solution,candidate_sku_code=v_candidate,source_stock=v_stock,safety_stock=v_safety,
          source_batch_key=p_batch_key,source_file_name=p_file_name,source_file_sha256=p_file_sha256,source_row_no=v_row_no,
          mapping_state='review',
          review_reasons=case when v_code_count>1 then array['duplicate_solution_code']::text[] else array['source_solution_code_changed']::text[] end,
          is_active=false,source_provenance=mapping.source_provenance || jsonb_build_object('last_source_change_at',now()),updated_by=p_actor,updated_at=now()
        where mapping.product_code=v_product and mapping.option_code=v_option returning * into v_new;
        v_updated:=v_updated+1;
        insert into operations_private.operations_hub_ably_mapping_history(product_code,option_code,event_type,before_value,after_value,changed_by,reason)
        values(v_product,v_option,'source_import',to_jsonb(v_old),to_jsonb(v_new),p_actor,'literal solution code changed; kept prior mapped SKU and policy');
      else
        update public.operations_hub_ably_inventory_mappings mapping set
          source_stock=v_stock,safety_stock=v_safety,source_batch_key=p_batch_key,source_file_name=p_file_name,
          source_file_sha256=p_file_sha256,source_row_no=v_row_no,
          mapping_state=case when v_code_count>1 or v_suppressed then 'review' else mapping.mapping_state end,
          review_reasons=case when v_code_count>1 then array['duplicate_solution_code']::text[]
             when v_suppressed then array['legacy_suppression_active']::text[]
             when v_current_stock is distinct from v_stock then array['source_stock_differs']::text[]
             else mapping.review_reasons end,
          is_active=mapping.is_active and v_code_count=1 and not v_suppressed,
          source_provenance=mapping.source_provenance || jsonb_build_object('last_source_row_no',v_row_no),updated_by=p_actor,updated_at=now()
        where mapping.product_code=v_product and mapping.option_code=v_option returning * into v_new;
        v_preserved:=v_preserved+1;
        if (to_jsonb(v_old)-'source_stock'-'safety_stock'-'source_batch_key'-'source_file_name'-'source_file_sha256'-'source_row_no'-'source_provenance'-'updated_by'-'updated_at')
          is distinct from (to_jsonb(v_new)-'source_stock'-'safety_stock'-'source_batch_key'-'source_file_name'-'source_file_sha256'-'source_row_no'-'source_provenance'-'updated_by'-'updated_at') then
          insert into operations_private.operations_hub_ably_mapping_history(product_code,option_code,event_type,before_value,after_value,changed_by,reason)
          values(v_product,v_option,'source_import',to_jsonb(v_old),to_jsonb(v_new),p_actor,'source observation refreshed; operator fields preserved');
        end if;
      end if;
    end if;
    if v_new.mapping_state='verified' then v_verified:=v_verified+1; elsif v_new.mapping_state='conflict' then v_conflict:=v_conflict+1; else v_review:=v_review+1; end if;
  end loop;

  v_result:=jsonb_build_object('batch_key',p_batch_key,'source_sha256',p_file_sha256,'source_row_count',v_seen,
    'inserted',v_inserted,'updated',v_updated,'preserved_operator_state',v_preserved,'verified',v_verified,'review',v_review,'conflict',v_conflict,'idempotent',false);
  insert into operations_private.operations_hub_ably_mapping_import_batches(batch_key,file_name,file_sha256,source_row_count,result,imported_by)
  values(p_batch_key,p_file_name,p_file_sha256,v_seen,v_result,p_actor);
  return v_result;
end;
$$;

revoke all on function operations_private.ably_mapping_import_core_v1(text,text,text,jsonb,text) from public,anon,authenticated;
