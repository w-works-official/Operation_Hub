-- Additive Ably solution-code mapping ledger. Legacy mapping and suppression
-- tables remain untouched; this table is an operator review boundary only.

create table if not exists public.operations_hub_ably_inventory_mappings (
  product_code text not null check (length(btrim(product_code)) > 0),
  option_code text not null default '',
  solution_code text not null default '',
  candidate_sku_code text,
  sellpia_sku_code text,
  mapping_state text not null default 'review'
    check (mapping_state in ('verified','review','conflict')),
  review_reasons text[] not null default '{}'::text[],
  stock_policy text not null default 'review'
    check (stock_policy in ('shared','individual','excluded','review')),
  individual_stock integer check (individual_stock is null or individual_stock >= 0),
  source_stock integer check (source_stock is null or source_stock >= 0),
  safety_stock integer check (safety_stock is null or safety_stock >= 0),
  is_active boolean not null default false,
  source_batch_key text,
  source_file_name text,
  source_file_sha256 text,
  source_row_no integer check (source_row_no is null or source_row_no > 0),
  source_snapshot_id uuid,
  source_provenance jsonb not null default '{}'::jsonb,
  created_by text not null default 'operations_hub_frontend',
  created_at timestamptz not null default now(),
  updated_by text not null default 'operations_hub_frontend',
  updated_at timestamptz not null default now(),
  primary key (product_code, option_code),
  check (stock_policy <> 'individual' or individual_stock is not null),
  check (stock_policy = 'individual' or individual_stock is null),
  check (not is_active or (mapping_state = 'verified' and stock_policy in ('shared','individual') and length(solution_code)>0))
);

comment on table public.operations_hub_ably_inventory_mappings is
  'Ably A+H seller identity mapping ledger. Literal J is retained separately; rows require review before use and never mutate legacy mappings.';
comment on column public.operations_hub_ably_inventory_mappings.solution_code is
  'Exact literal value from Ably workbook column J; do not trim suffixes or infer a new code.';
comment on column public.operations_hub_ably_inventory_mappings.candidate_sku_code is
  'Review-only candidate obtained by removing only the literal sellpia_ prefix.';

create index if not exists operations_hub_ably_mapping_solution_idx
  on public.operations_hub_ably_inventory_mappings(solution_code, product_code, option_code);
create index if not exists operations_hub_ably_mapping_state_idx
  on public.operations_hub_ably_inventory_mappings(mapping_state, is_active, product_code, option_code);
create unique index if not exists operations_hub_ably_mapping_active_solution_code_idx
  on public.operations_hub_ably_inventory_mappings(solution_code) where is_active;

alter table public.operations_hub_ably_inventory_mappings enable row level security;
revoke all on table public.operations_hub_ably_inventory_mappings from public, anon, authenticated;

create table if not exists operations_private.operations_hub_ably_mapping_import_batches (
  batch_key text primary key,
  file_name text not null,
  file_sha256 text not null unique,
  source_row_count integer not null,
  result jsonb not null default '{}'::jsonb,
  imported_by text not null,
  imported_at timestamptz not null default now()
);

create table if not exists operations_private.operations_hub_ably_mapping_history (
  event_id bigint generated always as identity primary key,
  product_code text not null,
  option_code text not null,
  event_type text not null check (event_type in ('source_import','operator_update')),
  before_value jsonb,
  after_value jsonb not null,
  changed_by text not null,
  reason text,
  changed_at timestamptz not null default now()
);
create index if not exists operations_hub_ably_mapping_history_identity_idx
  on operations_private.operations_hub_ably_mapping_history(product_code, option_code, changed_at desc);

alter table operations_private.operations_hub_ably_mapping_import_batches enable row level security;
alter table operations_private.operations_hub_ably_mapping_history enable row level security;
revoke all on table operations_private.operations_hub_ably_mapping_import_batches from public, anon, authenticated;
revoke all on table operations_private.operations_hub_ably_mapping_history from public, anon, authenticated;

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

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_seen := v_seen + 1;
    v_product := v_row->>'product_code';
    v_option := coalesce(v_row->>'option_code','');
    v_solution := coalesce(v_row->>'solution_code','');
    v_candidate := case when left(v_solution,8)='sellpia_' and length(v_solution)>8 then substring(v_solution from 9) else null end;
    v_stock := nullif(v_row->>'source_stock','')::integer;
    v_safety := nullif(v_row->>'safety_stock','')::integer;
    v_row_no := (v_row->>'source_row_no')::integer;

    select count(*) into v_code_count
      from jsonb_array_elements(p_rows) as x(item)
      where coalesce(item->>'solution_code','')=v_solution and v_solution<>'';
    select exists (
      select 1 from public.operations_hub_link_suppressions s
      where s.source_channel='ably' and s.product_code=v_product and s.option_code=v_option
    ) into v_suppressed;
    select count(distinct m.sellpia_sku_code),coalesce(bool_or(m.sellpia_sku_code=v_candidate),false)
      into v_manual_owner_count,v_manual_agrees
      from public.operations_hub_manual_links m
      where m.source_channel='ably' and m.product_code=v_product and m.option_code=v_option;
    v_manual_agrees:=v_manual_owner_count=1 and v_manual_agrees;
    select matrix.sellpia_current_stock into v_current_stock
      from public.operations_hub_matrix_live matrix where matrix.sellpia_sku_code=v_candidate limit 1;
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

create or replace function operations_private.ably_mapping_import_session_v1(p_session_token text,p_batch_key text,p_file_name text,p_file_sha256 text,p_rows jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog set statement_timeout='60s' as $$
declare v_session jsonb;
begin
  v_session:=operations_private.require_operations_hub_operator_session(p_session_token);
  return operations_private.ably_mapping_import_core_v1(p_batch_key,p_file_name,p_file_sha256,p_rows,coalesce(v_session->>'username','operations_hub_operator'));
end;
$$;
revoke all on function operations_private.ably_mapping_import_session_v1(text,text,text,text,jsonb) from public;
grant execute on function operations_private.ably_mapping_import_session_v1(text,text,text,text,jsonb) to anon,authenticated;

create or replace function operations_private.ably_mapping_load_v1(p_session_token text)
returns jsonb language plpgsql security definer set search_path=pg_catalog set statement_timeout='25s' as $$
declare v_count integer; v_rows jsonb; v_fingerprint text;
begin
  perform operations_private.require_operations_hub_operator_session(p_session_token);
  select count(*) into v_count from public.operations_hub_ably_inventory_mappings;
  if v_count>10000 then raise exception using errcode='54000',message='에이블리 매핑이 10,000건을 넘어 읽기 한도를 초과했습니다.'; end if;
  select coalesce(jsonb_agg(to_jsonb(row_value) order by row_value.product_code,row_value.option_code),'[]'::jsonb),
         md5(coalesce(string_agg(concat_ws('|',row_value.product_code,row_value.option_code,row_value.solution_code,row_value.candidate_sku_code,
           row_value.sellpia_sku_code,row_value.mapping_state,row_value.stock_policy,row_value.individual_stock::text,row_value.source_stock::text,
           row_value.safety_stock::text,row_value.source_file_sha256,row_value.source_row_no::text,row_value.review_reasons::text,
           row_value.is_active::text,row_value.suppression_active::text,row_value.updated_at::text),'\n' order by row_value.product_code,row_value.option_code),''))
    into v_rows,v_fingerprint
  from (
    select m.product_code,m.option_code,m.solution_code,m.candidate_sku_code,m.sellpia_sku_code,m.mapping_state,m.review_reasons,
      m.stock_policy,m.individual_stock,m.source_stock,m.safety_stock,m.is_active,m.source_batch_key,m.source_file_name,m.source_file_sha256,
      m.source_row_no,m.updated_by,m.updated_at,coalesce(suppressed.active,false) as suppression_active,
      matrix.sellpia_current_stock as current_sellpia_stock,
      (m.source_stock is distinct from matrix.sellpia_current_stock) as stock_mismatch
    from public.operations_hub_ably_inventory_mappings m
    left join lateral (select exists(select 1 from public.operations_hub_link_suppressions s where s.source_channel='ably'
      and s.product_code=m.product_code and s.option_code=m.option_code) as active) suppressed on true
    left join public.operations_hub_matrix_live matrix on matrix.sellpia_sku_code=m.sellpia_sku_code
  ) row_value;
  return jsonb_build_object('rows',v_rows,'count',v_count,'revision',v_fingerprint,'fingerprint',v_fingerprint);
end;
$$;

create or replace function operations_private.ably_mapping_update_v1(
  p_session_token text,p_product_code text,p_option_code text,p_sellpia_sku_code text,
  p_mapping_state text,p_stock_policy text,p_individual_stock integer,p_is_active boolean,p_reason text
)
returns jsonb language plpgsql security definer set search_path=pg_catalog set statement_timeout='25s' set lock_timeout='3s' as $$
declare v_session jsonb; v_before public.operations_hub_ably_inventory_mappings%rowtype; v_after public.operations_hub_ably_inventory_mappings%rowtype;
 v_suppressed boolean; v_duplicate boolean; v_matrix_exists boolean;
begin
  v_session:=operations_private.require_operations_hub_operator_session(p_session_token);
  if coalesce(btrim(p_reason),'')='' then raise exception using errcode='22023',message='수정 사유를 입력하세요.'; end if;
  if p_mapping_state is null or p_mapping_state not in ('verified','review','conflict')
     or p_stock_policy is null or p_stock_policy not in ('shared','individual','excluded','review') then
    raise exception using errcode='22023',message='매핑 상태 또는 재고 정책 값이 올바르지 않습니다.';
  end if;
  if p_stock_policy='individual' and (p_individual_stock is null or p_individual_stock<0) then raise exception using errcode='22023',message='개별 재고 수량을 입력하세요.'; end if;
  if p_stock_policy<>'individual' and p_individual_stock is not null then raise exception using errcode='22023',message='개별 재고 정책에만 개별 수량을 입력할 수 있습니다.'; end if;
  select mapping.* into v_before from public.operations_hub_ably_inventory_mappings mapping
    where mapping.product_code=p_product_code and mapping.option_code=coalesce(p_option_code,'') for update;
  if not found then raise exception using errcode='P0002',message='대상 매핑 행이 없습니다. 먼저 원본을 가져오세요.'; end if;
  select exists(select 1 from public.operations_hub_link_suppressions s where s.source_channel='ably' and s.product_code=p_product_code
    and s.option_code=coalesce(p_option_code,'')) into v_suppressed;
  select exists(select 1 from public.operations_hub_ably_inventory_mappings other where other.solution_code=v_before.solution_code
    and other.solution_code<>'' and (other.product_code,other.option_code)<>(p_product_code,coalesce(p_option_code,''))
    and other.is_active) into v_duplicate;
  select exists(select 1 from public.operations_hub_matrix_live matrix where matrix.sellpia_sku_code=p_sellpia_sku_code) into v_matrix_exists;
  if p_mapping_state='verified' and (p_sellpia_sku_code is null or not v_matrix_exists) then raise exception using errcode='22023',message='검증된 매핑은 현재 Matrix에 존재하는 SKU가 필요합니다.'; end if;
  if p_mapping_state='verified' and v_suppressed then raise exception using errcode='23514',message='동일한 상품+옵션에 활성 연결 억제가 있어 매핑을 검증할 수 없습니다.'; end if;
  if p_is_active and (p_mapping_state<>'verified' or p_stock_policy not in ('shared','individual') or v_suppressed or v_duplicate or not v_matrix_exists or length(v_before.solution_code)=0) then
    raise exception using errcode='23514',message='검증 상태·재고 정책·활성 억제·중복 코드·Matrix SKU 조건을 통과하지 못해 활성화할 수 없습니다.';
  end if;
  update public.operations_hub_ably_inventory_mappings mapping set
    sellpia_sku_code=nullif(btrim(p_sellpia_sku_code),''),mapping_state=p_mapping_state,stock_policy=p_stock_policy,
    individual_stock=p_individual_stock,is_active=coalesce(p_is_active,false),review_reasons=array['operator_reviewed']::text[],
    updated_by=coalesce(v_session->>'username','operations_hub_operator'),updated_at=now()
  where mapping.product_code=p_product_code and mapping.option_code=coalesce(p_option_code,'') returning * into v_after;
  insert into operations_private.operations_hub_ably_mapping_history(product_code,option_code,event_type,before_value,after_value,changed_by,reason)
  values(p_product_code,coalesce(p_option_code,''),'operator_update',to_jsonb(v_before),to_jsonb(v_after),coalesce(v_session->>'username','operations_hub_operator'),btrim(p_reason));
  return to_jsonb(v_after) || jsonb_build_object('suppression_active',v_suppressed);
end;
$$;

create or replace function operations_private.ably_mapping_verified_read_v1(
  p_session_token text,p_product_codes text[],p_skus text[]
)
returns jsonb language plpgsql security definer set search_path=pg_catalog set statement_timeout='15s' as $$
declare v_rows jsonb; v_blocked jsonb; v_fingerprint text; v_product_count integer:=coalesce(cardinality(p_product_codes),0); v_sku_count integer:=coalesce(cardinality(p_skus),0);
begin
  perform operations_private.require_operations_hub_operator_session(p_session_token);
  if v_product_count=0 and v_sku_count=0 then raise exception using errcode='22023',message='상품 번호 또는 Sellpia SKU 범위를 지정하세요.'; end if;
  if v_product_count>1000 or v_sku_count>1000 then raise exception using errcode='22023',message='매핑 조회 범위는 필터별 1,000개까지입니다.'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('product_code',m.product_code,'option_code',m.option_code,
      'sku',m.sellpia_sku_code,'solution_code',m.solution_code) order by m.product_code,m.option_code),'[]'::jsonb)
    into v_rows
  from public.operations_hub_ably_inventory_mappings m
  where m.mapping_state='verified' and m.sellpia_sku_code is not null
    and ((v_product_count>0 and m.product_code=any(p_product_codes)) or (v_sku_count>0 and m.sellpia_sku_code=any(p_skus)))
    and not exists(select 1 from public.operations_hub_link_suppressions s where s.source_channel='ably'
      and s.product_code=m.product_code and s.option_code=m.option_code);

  with scoped_rows as (
    select m.product_code,m.option_code,m.mapping_state
    from public.operations_hub_ably_inventory_mappings m
    where (v_product_count>0 and m.product_code=any(p_product_codes)) or (v_sku_count>0 and m.sellpia_sku_code=any(p_skus))
    union
    select s.product_code,s.option_code,'review'::text as mapping_state
    from public.operations_hub_link_suppressions s
    where s.source_channel='ably' and (
      (v_product_count>0 and s.product_code=any(p_product_codes))
      or (v_sku_count>0 and exists(select 1 from public.operations_hub_ably_inventory_mappings m
        where m.product_code=s.product_code and m.option_code=s.option_code and m.sellpia_sku_code=any(p_skus)))
    )
  ), scoped as (
    select product_code,option_code,bool_or(mapping_state='conflict') as has_conflict
    from scoped_rows group by product_code,option_code
  )
  select coalesce(jsonb_agg(jsonb_build_object('product_code',scoped.product_code,'option_code',scoped.option_code,
      'reason',case when exists(select 1 from public.operations_hub_link_suppressions s where s.source_channel='ably'
        and s.product_code=scoped.product_code and s.option_code=scoped.option_code) then 'legacy_suppression_active' else 'mapping_conflict' end)
      order by scoped.product_code,scoped.option_code),'[]'::jsonb)
    into v_blocked
  from scoped
  where scoped.has_conflict
     or exists(select 1 from public.operations_hub_link_suppressions s where s.source_channel='ably'
       and s.product_code=scoped.product_code and s.option_code=scoped.option_code);

  v_fingerprint:=md5(v_rows::text||'|'||v_blocked::text);
  return jsonb_build_object('rows',v_rows,'blocked_identities',v_blocked,'fingerprint',v_fingerprint);
end;
$$;

create or replace function operations_private.import_ably_inventory_mappings_admin_v1(p_batch_key text,p_file_name text,p_file_sha256 text,p_rows jsonb)
returns jsonb language sql security definer set search_path=pg_catalog set statement_timeout='60s' as $$
  select operations_private.ably_mapping_import_core_v1(p_batch_key,p_file_name,p_file_sha256,p_rows,'authorized_initial_seed')
$$;
revoke all on function operations_private.import_ably_inventory_mappings_admin_v1(text,text,text,jsonb) from public,anon,authenticated;

create or replace function public.load_ably_inventory_mappings_v1(p_session_token text)
returns jsonb language sql security invoker set search_path=pg_catalog set statement_timeout='25s' as $$
  select operations_private.ably_mapping_load_v1(p_session_token)
$$;
create or replace function public.import_operations_hub_ably_mappings_v1(p_session_token text,p_batch_key text,p_file_name text,p_file_sha256 text,p_rows jsonb)
returns jsonb language sql security invoker set search_path=pg_catalog set statement_timeout='60s' as $$
  select operations_private.ably_mapping_import_session_v1(p_session_token,p_batch_key,p_file_name,p_file_sha256,p_rows)
$$;
create or replace function public.update_operations_hub_ably_mapping_v1(p_session_token text,p_product_code text,p_option_code text,p_sellpia_sku_code text,p_mapping_state text,p_stock_policy text,p_individual_stock integer,p_is_active boolean,p_reason text)
returns jsonb language sql security invoker set search_path=pg_catalog set statement_timeout='25s' as $$
  select operations_private.ably_mapping_update_v1(p_session_token,p_product_code,p_option_code,p_sellpia_sku_code,p_mapping_state,p_stock_policy,p_individual_stock,p_is_active,p_reason)
$$;

revoke all on function operations_private.ably_mapping_load_v1(text) from public,anon,authenticated;
revoke all on function operations_private.ably_mapping_update_v1(text,text,text,text,text,text,integer,boolean,text) from public,anon,authenticated;
grant execute on function operations_private.ably_mapping_load_v1(text) to anon,authenticated;
grant execute on function operations_private.ably_mapping_update_v1(text,text,text,text,text,text,integer,boolean,text) to anon,authenticated;
revoke all on function operations_private.ably_mapping_verified_read_v1(text,text[],text[]) from public,anon,authenticated;
grant execute on function operations_private.ably_mapping_verified_read_v1(text,text[],text[]) to anon,authenticated;
revoke all on function public.load_ably_inventory_mappings_v1(text) from public;
revoke all on function public.import_operations_hub_ably_mappings_v1(text,text,text,text,jsonb) from public;
revoke all on function public.update_operations_hub_ably_mapping_v1(text,text,text,text,text,text,integer,boolean,text) from public;
grant execute on function public.load_ably_inventory_mappings_v1(text) to anon,authenticated;
grant execute on function public.import_operations_hub_ably_mappings_v1(text,text,text,text,jsonb) to anon,authenticated;
grant execute on function public.update_operations_hub_ably_mapping_v1(text,text,text,text,text,text,integer,boolean,text) to anon,authenticated;

create or replace function public.load_ably_verified_export_mappings_v1(p_session_token text,p_product_codes text[] default null,p_skus text[] default null)
returns jsonb language sql security invoker set search_path=pg_catalog set statement_timeout='15s' as $$
  select operations_private.ably_mapping_verified_read_v1(p_session_token,p_product_codes,p_skus)
$$;
revoke all on function public.load_ably_verified_export_mappings_v1(text,text[],text[]) from public;
grant execute on function public.load_ably_verified_export_mappings_v1(text,text[],text[]) to anon,authenticated;
