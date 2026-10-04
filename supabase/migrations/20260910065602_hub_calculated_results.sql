-- Persist computed outputs only. Shared Rule definitions and assignments remain
-- authoritative in their existing tables; consumers recalculate after input changes.
create table operations_private.hub_calculation_generations (
 generation_id bigint generated always as identity (maxvalue 9007199254740991) primary key,
 calculated_at timestamptz not null default clock_timestamp(),
 created_by text not null,
 reason text not null check(length(btrim(reason)) between 1 and 200),
 request_id uuid not null unique
);
create table operations_private.hub_calculated_results (
 sku text not null check(length(btrim(sku)) between 1 and 128 and sku=btrim(sku)),
 scope text not null default '' check(scope in ('','smartstore','makeshop','ably')),
 field text not null check(field in ('purchase_price','source_base_price','actual_inbound_cost','basis_sku_price','calculated_base_price','system_stock','calculated_stock','platform_registration_price','platform_option_price','platform_discount_price','platform_final_price','platform_price')),
 value numeric,
 status text not null check(status in ('calculated','error')),
 error text,
 rule_versions jsonb not null default '[]' check(jsonb_typeof(rule_versions)='array' and jsonb_array_length(rule_versions)<=128),
 result_details jsonb not null default '{}' check(jsonb_typeof(result_details)='object' and pg_column_size(result_details)<=16384),
 generation_id bigint not null references operations_private.hub_calculation_generations(generation_id),
 calculated_at timestamptz not null,
 primary key(sku,scope,field),
 check((field like 'platform_%')=(scope<>'')),
 check((status='calculated' and value is not null and value=trunc(value) and abs(value)<=9007199254740991 and (value>=0 or field='platform_option_price') and error is null)
    or (status='error' and value is null and error is not null and length(btrim(error)) between 1 and 2000))
);
alter table operations_private.hub_calculation_generations enable row level security;
alter table operations_private.hub_calculated_results enable row level security;
revoke all on operations_private.hub_calculation_generations,operations_private.hub_calculated_results from public,anon,authenticated;
revoke all on sequence operations_private.hub_calculation_generations_generation_id_seq from public,anon,authenticated;

create function public.hub_calculation_begin_v1(p_session_token text,p_reason text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare actor jsonb; run operations_private.hub_calculation_generations%rowtype;
begin
 actor:=operations_private.require_operations_hub_operator_session(p_session_token);
 if p_request_id is null or coalesce(length(btrim(p_reason)),0) not between 1 and 200 then raise exception '계산 작업의 사유와 요청 ID가 필요합니다.';end if;
 insert into operations_private.hub_calculation_generations(created_by,reason,request_id) values(actor->>'username',btrim(p_reason),p_request_id) on conflict(request_id) do nothing;
 select * into run from operations_private.hub_calculation_generations where request_id=p_request_id;
 if run.created_by is distinct from actor->>'username' then raise exception '다른 운영자의 계산 요청 ID를 재사용할 수 없습니다.';end if;
 return jsonb_build_object('generation_id',run.generation_id,'calculated_at',run.calculated_at);
end $$;

create function public.hub_calculation_results_upsert_v1(p_session_token text,p_generation_id bigint,p_rows jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog set lock_timeout='5s' as $$
declare actor jsonb; run operations_private.hub_calculation_generations%rowtype; received integer; written integer;
begin
 actor:=operations_private.require_operations_hub_operator_session(p_session_token);
 if jsonb_typeof(p_rows) is distinct from 'array' then raise exception '계산 결과 rows는 배열이어야 합니다.';end if;
 received:=jsonb_array_length(p_rows);
 if received not between 1 and 1000 or pg_column_size(p_rows)>2097152 then raise exception '계산 결과는 요청당 1~1,000개, 최대 2MB입니다.';end if;
 if exists(select 1 from jsonb_array_elements(p_rows) x where jsonb_typeof(x) is distinct from 'object') then raise exception '계산 결과 항목 형식 오류';end if;
 if exists(select 1 from jsonb_array_elements(p_rows) x cross join lateral jsonb_object_keys(x) k where k not in ('sku','scope','field','value','status','error','rule_versions','result_details')) then raise exception '계산 결과에 규칙 설정 또는 지원하지 않는 항목을 저장할 수 없습니다.';end if;
 if exists(select 1 from jsonb_array_elements(p_rows) x where x ? 'result_details' and jsonb_typeof(x->'result_details') is distinct from 'object') then raise exception 'result_details는 객체여야 합니다.';end if;
 if exists(select 1 from jsonb_array_elements(p_rows) x cross join lateral jsonb_object_keys(coalesce(x->'result_details','{}')) k where k<>'discount_terms') then raise exception 'result_details에는 discount_terms만 저장할 수 있습니다.';end if;
 if exists(select 1 from jsonb_array_elements(p_rows) x where x->'result_details' ? 'discount_terms' and jsonb_typeof(x->'result_details'->'discount_terms') is distinct from 'array') then raise exception 'discount_terms는 배열이어야 합니다.';end if;
 if exists(select 1 from jsonb_array_elements(p_rows) x where jsonb_array_length(coalesce(x->'result_details'->'discount_terms','[]'))>16) then raise exception '할인 조건은 최대 16개입니다.';end if;
 if exists(select 1 from jsonb_array_elements(p_rows) x cross join lateral jsonb_array_elements(coalesce(x->'result_details'->'discount_terms','[]')) t where jsonb_typeof(t) is distinct from 'object') then raise exception '할인 조건 항목은 객체여야 합니다.';end if;
 if exists(select 1 from jsonb_array_elements(p_rows) x where x ? 'rule_versions' and jsonb_typeof(x->'rule_versions') is distinct from 'array') then raise exception 'rule_versions는 배열이어야 합니다.';end if;
 if exists(select 1 from jsonb_array_elements(p_rows) x cross join lateral jsonb_array_elements(coalesce(x->'rule_versions','[]')) v
   where jsonb_typeof(v) is distinct from 'object') then raise exception '규칙 버전 항목 형식 오류';end if;
 if exists(select 1 from jsonb_array_elements(p_rows) x cross join lateral jsonb_array_elements(coalesce(x->'rule_versions','[]')) v
   where coalesce(v->>'id','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    or coalesce(v->>'version','') !~ '^[1-9][0-9]{0,8}$'
    or (v ? 'assignmentVersion' and coalesce(v->>'assignmentVersion','') !~ '^[1-9][0-9]{0,8}$')
    or exists(select 1 from jsonb_object_keys(v) k where k not in ('id','version','assignmentVersion'))) then raise exception '규칙 버전 메타데이터 오류';end if;
 if exists(select 1 from jsonb_to_recordset(p_rows) x(sku text,scope text,field text) group by sku,coalesce(scope,''),field having count(*)>1) then raise exception '같은 SKU·판매처·필드가 요청 안에서 중복되었습니다.';end if;
 -- Serialize retries for one generation; different generations can compute in parallel.
 select * into run from operations_private.hub_calculation_generations where generation_id=p_generation_id for update;
 if not found or run.created_by is distinct from actor->>'username' then raise exception '유효한 계산 작업이 필요합니다.';end if;
 if exists(select 1 from jsonb_to_recordset(p_rows) x(sku text,scope text,field text,value numeric,status text,error text,rule_versions jsonb,result_details jsonb)
   join operations_private.hub_calculated_results r on r.sku=x.sku and r.scope=coalesce(x.scope,'') and r.field=x.field
   where r.generation_id=p_generation_id and (r.value,r.status,r.error,r.rule_versions,r.result_details) is distinct from (x.value,coalesce(x.status,'calculated'),x.error,coalesce(x.rule_versions,'[]'::jsonb),coalesce(x.result_details,'{}'::jsonb))) then raise exception '같은 계산 작업의 결과를 다른 값으로 재사용할 수 없습니다.';end if;
 insert into operations_private.hub_calculated_results as stored(sku,scope,field,value,status,error,rule_versions,result_details,generation_id,calculated_at)
 select x.sku,coalesce(x.scope,''),x.field,x.value,coalesce(x.status,'calculated'),x.error,coalesce(x.rule_versions,'[]'),coalesce(x.result_details,'{}'),run.generation_id,run.calculated_at
 from jsonb_to_recordset(p_rows) x(sku text,scope text,field text,value numeric,status text,error text,rule_versions jsonb,result_details jsonb)
 order by x.sku,coalesce(x.scope,''),x.field
 on conflict(sku,scope,field) do update set value=excluded.value,status=excluded.status,error=excluded.error,rule_versions=excluded.rule_versions,result_details=excluded.result_details,generation_id=excluded.generation_id,calculated_at=excluded.calculated_at
 where stored.generation_id<excluded.generation_id;
 get diagnostics written=row_count;
 return jsonb_build_object('generation_id',run.generation_id,'received',received,'upserted',written,'unchanged_or_older',received-written);
end $$;

create function public.hub_calculation_results_read_v1(p_session_token text,p_skus text[],p_scope text default null,p_fields text[] default null,p_after_key jsonb default null,p_limit integer default 1000)
returns jsonb language plpgsql security definer stable set search_path=pg_catalog as $$
declare result jsonb;
begin
 perform operations_private.require_operations_hub_operator_session(p_session_token);
 if coalesce(cardinality(p_skus),0) not between 1 and 1000 or p_limit is null or p_limit not between 1 and 1000 then raise exception '계산 결과 조회는 요청당 SKU 1~1,000개, 결과 최대 1,000개입니다.';end if;
 if p_scope is not null and p_scope not in ('','smartstore','makeshop','ably') then raise exception '판매처 범위 오류';end if;
 if p_fields is not null and cardinality(p_fields)>16 then raise exception '조회 필드가 너무 많습니다.';end if;
 if p_after_key is not null and (jsonb_typeof(p_after_key) is distinct from 'object' or p_after_key->>'sku' is null or p_after_key->>'scope' is null or p_after_key->>'field' is null) then raise exception '계산 결과 페이지 키 오류';end if;
 with matching_keys as materialized(
  select r.sku,r.scope,r.field from operations_private.hub_calculated_results r
  where r.sku in(select distinct unnest(p_skus)) and (p_scope is null or r.scope=p_scope) and (p_fields is null or r.field=any(p_fields))
 ), page as materialized(
  select r.* from operations_private.hub_calculated_results r join matching_keys k using(sku,scope,field)
  where p_after_key is null or (r.sku,r.scope,r.field)>(p_after_key->>'sku',p_after_key->>'scope',p_after_key->>'field')
  order by r.sku,r.scope,r.field limit p_limit+1
 ), visible as materialized(select * from page order by sku,scope,field limit p_limit), identities as materialized(
  select m.sellpia_sku_code,m.smartstore_product_code,m.smartstore_option_code,m.makeshop_product_code,m.makeshop_option_code,m.ably_product_code,m.ably_option_code
  from operations_private.operations_hub_matrix_export_cache m where m.sellpia_sku_code in(select sku from visible where scope<>'' union select unnest(p_skus) where p_scope in ('smartstore','makeshop','ably'))
 ), resolved as (
  select v.*,case v.scope when 'smartstore' then m.smartstore_product_code when 'makeshop' then m.makeshop_product_code when 'ably' then m.ably_product_code end seller_product_code,
   case v.scope when 'smartstore' then m.smartstore_option_code when 'makeshop' then m.makeshop_option_code when 'ably' then m.ably_option_code end seller_option_code
  from visible v left join identities m on m.sellpia_sku_code=v.sku
 ), missing as (
  select m.sellpia_sku_code,p_scope source_channel,
   case p_scope when 'smartstore' then m.smartstore_product_code when 'makeshop' then m.makeshop_product_code when 'ably' then m.ably_product_code end seller_product_code,
   case p_scope when 'smartstore' then m.smartstore_option_code when 'makeshop' then m.makeshop_option_code when 'ably' then m.ably_option_code end seller_option_code,
   '계산 결과 오류 또는 누락: '||string_agg(f.field,', ' order by f.field) reason
  from identities m cross join unnest(coalesce(p_fields,array['platform_registration_price','platform_discount_price','platform_option_price','platform_final_price'])) f(field)
  where p_scope in ('smartstore','makeshop','ably') and m.sellpia_sku_code in(select unnest(p_skus))
   and nullif(btrim(case p_scope when 'smartstore' then m.smartstore_product_code when 'makeshop' then m.makeshop_product_code when 'ably' then m.ably_product_code end),'') is not null
   and not exists(select 1 from operations_private.hub_calculated_results r where r.sku=m.sellpia_sku_code and r.scope=p_scope and r.field=f.field and r.status='calculated')
  group by m.sellpia_sku_code,m.smartstore_product_code,m.smartstore_option_code,m.makeshop_product_code,m.makeshop_option_code,m.ably_product_code,m.ably_option_code
 )
 select jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(v)||jsonb_build_object('mapping_missing',v.scope<>'' and nullif(btrim(v.seller_product_code),'') is null) order by sku,scope,field) from resolved v),'[]'),
  'total',(select count(*) from matching_keys),
  'missing_skus',coalesce((select jsonb_agg(s order by s) from (select distinct unnest(p_skus) s) requested where not exists(select 1 from matching_keys k where k.sku=requested.s)),'[]'),
  'missing',coalesce((select jsonb_agg(to_jsonb(m) order by sellpia_sku_code) from missing m),'[]'),
  'next_key',case when (select count(*) from page)>p_limit then (select jsonb_build_object('sku',sku,'scope',scope,'field',field) from visible order by sku desc,scope desc,field desc limit 1) else null end)
 into result;
 return result;
end $$;

revoke all on function public.hub_calculation_begin_v1(text,text,uuid),public.hub_calculation_results_upsert_v1(text,bigint,jsonb),public.hub_calculation_results_read_v1(text,text[],text,text[],jsonb,integer) from public;
grant execute on function public.hub_calculation_begin_v1(text,text,uuid),public.hub_calculation_results_upsert_v1(text,bigint,jsonb),public.hub_calculation_results_read_v1(text,text[],text,text[],jsonb,integer) to anon,authenticated;
notify pgrst,'reload schema';
