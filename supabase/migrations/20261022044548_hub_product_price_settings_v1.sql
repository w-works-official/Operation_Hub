-- Persist explicit Smartstore registration/basic-amount preferences only.
-- Fixed option finals, rules, source files, mappings and accepted decisions
-- remain independent and are recomputed/validated by each export preview.
set local lock_timeout='2s';
set local statement_timeout='30s';

create table if not exists operations_private.hub_product_price_settings(
 source_channel text not null check(source_channel='smartstore'),
 product_code text not null check(length(product_code) between 1 and 128 and product_code=btrim(product_code)),
 base_price bigint not null check(base_price between 0 and 9007199254740991),
 basic_discount bigint not null check(basic_discount between 0 and base_price),
 revision bigint not null check(revision between 1 and 9007199254740991),
 created_at timestamptz not null default clock_timestamp(),
 created_by text not null,
 updated_at timestamptz not null default clock_timestamp(),
 updated_by text not null,
 primary key(source_channel,product_code)
);
create table if not exists operations_private.hub_product_price_setting_requests(
 request_id uuid primary key,
 operator_username text not null,
 source_channel text not null check(source_channel='smartstore'),
 request_body jsonb not null,
 response_body jsonb not null,
 created_at timestamptz not null default clock_timestamp()
);
alter table operations_private.hub_product_price_settings enable row level security;
alter table operations_private.hub_product_price_setting_requests enable row level security;
revoke all on operations_private.hub_product_price_settings,
 operations_private.hub_product_price_setting_requests from public,anon,authenticated,service_role;

create or replace function operations_private.hub_product_price_settings_read_session_v1(
 p_session_token text,p_source text,p_product_codes text[]
)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog set statement_timeout='20s'
as $read$
declare v_source text:=lower(btrim(coalesce(p_source,'')));v_settings jsonb;
begin
 perform operations_private.require_operations_hub_operator_session(p_session_token);
 if v_source<>'smartstore' then raise exception using errcode='22023',message='상품별 가격 설정은 스마트스토어만 지원합니다.';end if;
 if coalesce(cardinality(p_product_codes),0) not between 1 and 200 or exists(
  select 1 from unnest(p_product_codes) p where p is null or length(p) not between 1 and 128 or p<>btrim(p)
 ) then raise exception using errcode='22023',message='상품별 가격 설정 조회는 유효한 상품코드 1~200개가 필요합니다.';end if;
 select coalesce(jsonb_agg(jsonb_build_object('source_channel',s.source_channel,'product_code',s.product_code,
  'base_price',s.base_price,'basic_discount',s.basic_discount,'revision',s.revision,
  'updated_at',s.updated_at,'updated_by',s.updated_by) order by s.product_code),'[]'::jsonb)
 into v_settings from operations_private.hub_product_price_settings s
 where s.source_channel=v_source and s.product_code=any(p_product_codes);
 return jsonb_build_object('contract_version',1,'source',v_source,'settings',v_settings);
end;
$read$;

create or replace function operations_private.hub_product_price_settings_save_session_v1(
 p_session_token text,p_source text,p_settings jsonb,p_request_id uuid
)
returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog set statement_timeout='20s'
as $save$
declare
 v_actor jsonb;v_username text;v_source text:=lower(btrim(coalesce(p_source,'')));
 v_item jsonb;v_canonical jsonb;v_response jsonb;v_saved jsonb;
 v_receipt operations_private.hub_product_price_setting_requests%rowtype;
 v_snapshot uuid;v_current bigint;v_changed bigint;v_lock integer;
begin
 v_actor:=operations_private.require_operations_hub_operator_session(p_session_token);
 v_username:=nullif(v_actor->>'username','');
 if v_username is null then raise exception using errcode='42501',message='운영 사용자 정보를 확인할 수 없습니다.';end if;
 if v_source<>'smartstore' then raise exception using errcode='22023',message='상품별 가격 설정은 스마트스토어만 지원합니다.';end if;
 if p_request_id is null or jsonb_typeof(p_settings) is distinct from 'array'
  or jsonb_array_length(p_settings) not between 1 and 500
 then raise exception using errcode='22023',message='상품별 가격 설정 저장은 요청 ID와 상품 1~500개가 필요합니다.';end if;
 for v_item in select value from jsonb_array_elements(p_settings)loop
  if jsonb_typeof(v_item) is distinct from 'object' or not(v_item ?& array['product_code','base_price','basic_discount','expected_revision'])
   or exists(select 1 from jsonb_object_keys(v_item) k where k not in('product_code','base_price','basic_discount','expected_revision'))
   or jsonb_typeof(v_item->'product_code') is distinct from 'string'
   or length(v_item->>'product_code') not between 1 and 128
   or v_item->>'product_code'<>btrim(v_item->>'product_code')
  then raise exception using errcode='22023',message='상품별 가격 설정에는 상품코드·기준가·기본할인·예상 revision만 저장할 수 있습니다.';end if;
  if exists(select 1 from unnest(array['base_price','basic_discount','expected_revision']) k
   where jsonb_typeof(v_item->k) is distinct from 'number' or v_item->>k !~ '^[0-9]+$')
  then raise exception using errcode='22023',message='가격과 예상 revision은 0 이상의 정수여야 합니다.';end if;
  if (v_item->>'base_price')::numeric>9007199254740991
   or (v_item->>'basic_discount')::numeric>(v_item->>'base_price')::numeric
   or (v_item->>'expected_revision')::numeric>9007199254740990
  then raise exception using errcode='22023',message='가격 또는 예상 revision이 안전한 정수 범위를 벗어납니다.';end if;
 end loop;
 if (select count(distinct value->>'product_code') from jsonb_array_elements(p_settings))<>jsonb_array_length(p_settings)
 then raise exception using errcode='22023',message='같은 상품의 가격 설정을 한 요청에서 중복 저장할 수 없습니다.';end if;
 select jsonb_build_object('source',v_source,'settings',jsonb_agg(jsonb_build_object(
  'product_code',x.product_code,'base_price',x.base_price,'basic_discount',x.basic_discount,'expected_revision',x.expected_revision)
  order by x.product_code)) into v_canonical
 from jsonb_to_recordset(p_settings)x(product_code text,base_price bigint,basic_discount bigint,expected_revision bigint);

 -- Serialize repeated UUIDs first, then product keys in actual advisory-key
 -- order. Hash collisions add contention only; row CAS remains authoritative.
 perform pg_advisory_xact_lock(hashtext('hub_product_price_setting_request_v1'),hashtext(p_request_id::text));
 select * into v_receipt from operations_private.hub_product_price_setting_requests where request_id=p_request_id;
 if found then
  if v_receipt.operator_username<>v_username then raise exception using errcode='42501',message='다른 운영 사용자의 가격 설정 요청 ID입니다.';end if;
  if v_receipt.source_channel<>v_source or v_receipt.request_body<>v_canonical
  then raise exception using errcode='22023',message='같은 요청 ID를 다른 상품 가격 설정에 재사용할 수 없습니다.';end if;
  return v_receipt.response_body||jsonb_build_object('idempotent',true);
 end if;
 for v_lock in select distinct hashtext(v_source||':'||(value->>'product_code'))
  from jsonb_array_elements(v_canonical->'settings') order by 1
 loop perform pg_advisory_xact_lock(hashtext('hub_product_price_setting_product_v1'),v_lock);end loop;

 select s.snapshot_id into v_snapshot from public.seller_inventory_snapshots s
 where s.source_channel=v_source and s.upload_status='ready'
 order by s.completed_at desc nulls last,s.created_at desc,s.snapshot_id desc limit 1;
 if v_snapshot is null or exists(select 1 from jsonb_array_elements(v_canonical->'settings') i
  where not exists(select 1 from public.seller_inventory_snapshot_rows r
   where r.snapshot_id=v_snapshot and r.product_code=i->>'product_code'))
 then raise exception using errcode='22023',message='최신 판매처 원본에 없는 상품의 가격 설정은 저장할 수 없습니다.';end if;

 -- Validate every revision before any mutation. The guarded INSERT/UPDATE
 -- below repeats CAS so external owner writes cannot silently bypass it.
 for v_item in select value from jsonb_array_elements(v_canonical->'settings')loop
  select revision into v_current from operations_private.hub_product_price_settings
   where source_channel=v_source and product_code=v_item->>'product_code';
  if coalesce(v_current,0)<>(v_item->>'expected_revision')::bigint
  then raise exception using errcode='40001',message='다른 작업에서 상품 가격 설정이 변경되었습니다. 최신 설정을 다시 불러와주세요.';end if;
 end loop;
 for v_item in select value from jsonb_array_elements(v_canonical->'settings')loop
  v_changed:=null;
  if (v_item->>'expected_revision')::bigint=0 then
   insert into operations_private.hub_product_price_settings(source_channel,product_code,base_price,basic_discount,revision,created_by,updated_by)
   values(v_source,v_item->>'product_code',(v_item->>'base_price')::bigint,(v_item->>'basic_discount')::bigint,1,v_username,v_username)
   on conflict(source_channel,product_code)do nothing returning revision into v_changed;
  else
   update operations_private.hub_product_price_settings set base_price=(v_item->>'base_price')::bigint,
    basic_discount=(v_item->>'basic_discount')::bigint,revision=revision+1,updated_at=clock_timestamp(),updated_by=v_username
   where source_channel=v_source and product_code=v_item->>'product_code'
    and revision=(v_item->>'expected_revision')::bigint returning revision into v_changed;
  end if;
  if v_changed is null then raise exception using errcode='40001',message='상품 가격 설정 revision이 변경되어 전체 저장을 취소했습니다.';end if;
 end loop;
 select coalesce(jsonb_agg(jsonb_build_object('source_channel',s.source_channel,'product_code',s.product_code,
  'base_price',s.base_price,'basic_discount',s.basic_discount,'revision',s.revision,
  'updated_at',s.updated_at,'updated_by',s.updated_by) order by s.product_code),'[]'::jsonb)
 into v_saved from operations_private.hub_product_price_settings s where s.source_channel=v_source
 and s.product_code in(select value->>'product_code' from jsonb_array_elements(v_canonical->'settings'));
 v_response:=jsonb_build_object('contract_version',1,'source',v_source,'request_id',p_request_id,'settings',v_saved,'idempotent',false);
 insert into operations_private.hub_product_price_setting_requests(request_id,operator_username,source_channel,request_body,response_body)
 values(p_request_id,v_username,v_source,v_canonical,v_response);
 return v_response;
end;
$save$;

create or replace function public.hub_product_price_settings_read_v1(p_session_token text,p_source text,p_product_codes text[])
returns jsonb language sql stable security invoker set search_path=pg_catalog set statement_timeout='20s'
as $rpc$ select operations_private.hub_product_price_settings_read_session_v1(p_session_token,p_source,p_product_codes);$rpc$;
create or replace function public.hub_product_price_settings_save_v1(p_session_token text,p_source text,p_settings jsonb,p_request_id uuid)
returns jsonb language sql volatile security invoker set search_path=pg_catalog set statement_timeout='20s'
as $rpc$ select operations_private.hub_product_price_settings_save_session_v1(p_session_token,p_source,p_settings,p_request_id);$rpc$;

revoke all on function operations_private.hub_product_price_settings_read_session_v1(text,text,text[]),
 operations_private.hub_product_price_settings_save_session_v1(text,text,jsonb,uuid),
 public.hub_product_price_settings_read_v1(text,text,text[]),public.hub_product_price_settings_save_v1(text,text,jsonb,uuid)
 from public,anon,authenticated,service_role;
grant execute on function operations_private.hub_product_price_settings_read_session_v1(text,text,text[]),
 operations_private.hub_product_price_settings_save_session_v1(text,text,jsonb,uuid),
 public.hub_product_price_settings_read_v1(text,text,text[]),public.hub_product_price_settings_save_v1(text,text,jsonb,uuid)
 to anon,authenticated;
notify pgrst,'reload schema';
