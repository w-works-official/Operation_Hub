-- Operations Hub only. Picking is accessed with GET; its schema and scraper are unchanged.
-- Custom operator sessions are the existing app authentication boundary (not Supabase Auth).
create table operations_private.inventory_movements (
 event_key text primary key, sku text not null, applied integer not null,
 revision bigint not null default 1, action_id uuid not null
);
create table operations_private.inventory_actions (
 action_id uuid primary key, actor text not null, request_hash text not null,
 kind text not null, items jsonb not null default '[]',
 status text not null default 'saved' check(status in ('saved','undone')),
 created_at timestamptz not null default clock_timestamp(), undone_at timestamptz
);
create index inventory_actions_actor_date on operations_private.inventory_actions(actor,created_at desc);
alter table operations_private.inventory_movements enable row level security;
alter table operations_private.inventory_actions enable row level security;
revoke all on operations_private.inventory_movements,operations_private.inventory_actions from public,anon,authenticated;

-- Fixed host and read-only endpoint. No user-provided URL, service key, or customer details.
create function operations_private.inventory_order_source(p_date date,p_offset integer,p_ids jsonb default null)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare v_response extensions.http_response; v_filter text; v_rows jsonb; v_ids text; v_chunk jsonb; v_all jsonb := '[]';
begin
 if p_date is null or p_offset is null or p_offset<0 or p_offset>100000 then raise exception '접수일과 조회 범위를 확인해주세요.'; end if;
 v_filter := '&receipt_date=eq.'||p_date::text||'&order=item_no.asc&limit=201&offset='||p_offset;
 if p_ids is not null then
  if jsonb_typeof(p_ids)<>'array' or jsonb_array_length(p_ids) not between 1 and 200 then raise exception '한 번에 1~200개 주문을 선택해주세요.'; end if;
  if jsonb_array_length(p_ids)>40 then
   for v_chunk in select jsonb_agg(x order by n) from jsonb_array_elements(p_ids) with ordinality a(x,n) group by (n-1)/40 order by (n-1)/40 loop
    v_all:=v_all||operations_private.inventory_order_source(p_date,0,v_chunk);
   end loop;
   return v_all;
  end if;
  select string_agg('"'||replace(replace(x#>>'{}',E'\\',E'\\\\'),'"',E'\\"')||'"',',') into v_ids from jsonb_array_elements(p_ids) x;
  v_filter := '&receipt_date=eq.'||p_date::text||'&item_no='||extensions.urlencode('in.('||v_ids||')')||'&order=item_no.asc&limit=201';
 end if;
 select * into v_response from extensions.http(('GET',
  'https://vgxocngpykhlkosiaeew.supabase.co/rest/v1/order_items?select=item_no,ord_no,p_code,qty,o_amount,o_status,receipt_date,p_name,p_option'||v_filter,
  array[extensions.http_header('apikey','sb_publishable_XVnKGJo66GZiYTq5Ivu8dA_SjBVvX0g')],null,null)::extensions.http_request);
 if v_response.status<>200 then raise exception '피킹 주문 조회 실패 (%). 재고는 변경하지 않았습니다.',v_response.status; end if;
 v_rows:=v_response.content::jsonb;
 if jsonb_typeof(v_rows)<>'array' then raise exception '주문 응답 형식 오류'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object(
  'id',r->>'item_no','key',jsonb_build_array('picking-order',r->>'ord_no',r->>'item_no')::text,
  'sku',btrim(r->>'p_code'),'quantity',coalesce((r->>'qty')::integer,(r->>'o_amount')::integer),'product_name',r->>'p_name','option_name',r->>'p_option',
  'date',r->>'receipt_date','source_status',r->>'o_status',
  'source_hash',encode(sha256(convert_to(r::text,'UTF8')),'hex')) order by n),'[]')
  from jsonb_array_elements(v_rows) with ordinality a(r,n));
end; $$;
revoke all on function operations_private.inventory_order_source(date,integer,jsonb) from public,anon,authenticated;

create function operations_private.inventory_describe(p_rows jsonb)
returns jsonb language sql stable security invoker set search_path=pg_catalog as $$
 select coalesce(jsonb_agg(r || jsonb_build_object('before',m.stock_quantity,'stock_revision',m.stock_version::text,
  'applied',coalesce(l.applied,0),'ledger_revision',coalesce(l.revision,0)::text,
  'reason',case when nullif(r->>'id','') is null or nullif(r->>'sku','') is null then '주문항목 또는 SKU 없음'
   when coalesce(r->>'source_status','') not in ('재고매칭','상품매칭','송장입력') then '자동 판단하지 않는 주문 상태: '||coalesce(r->>'source_status','미상')
   when coalesce(r->>'quantity','') !~ '^[1-9][0-9]{0,8}$' then '주문 수량 확인 필요'
   when m.stock_quantity is null then '현재재고 없음: 기준재고를 먼저 설정하세요'
   when l.sku is not null and l.sku<>r->>'sku' then '기존 반영 주문의 SKU 변경: 이전 작업 복구 필요'
   else '' end) order by n),'[]')
 from jsonb_array_elements(p_rows) with ordinality a(r,n)
 left join public.operations_hub_sku_operational_master m on m.sellpia_sku_code=r->>'sku'
 left join operations_private.inventory_movements l on l.event_key=r->>'key';
$$;
revoke all on function operations_private.inventory_describe(jsonb) from public,anon,authenticated;

create function operations_private.inventory_list(p_session_token text,p_date date,p_offset integer)
returns jsonb language plpgsql security definer set search_path=pg_catalog set statement_timeout='20s' as $$
declare v_rows jsonb;
begin
 perform operations_private.require_operations_hub_operator_session(p_session_token);
 v_rows:=operations_private.inventory_order_source(p_date,p_offset);
 return jsonb_build_object('has_more',jsonb_array_length(v_rows)>200,'offset',p_offset,
  'rows',operations_private.inventory_describe((select coalesce(jsonb_agg(r order by n),'[]') from jsonb_array_elements(v_rows) with ordinality a(r,n) where n<=200)));
end; $$;

create function operations_private.inventory_save(p_session_token text,p_action_id uuid,p_date date,p_mode text,p_rows jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog set statement_timeout='25s' set lock_timeout='3s' as $$
declare v_session jsonb; v_old operations_private.inventory_actions%rowtype; v_hash text;
 v_source jsonb; v_prepared jsonb:='[]'; v_result jsonb:='[]'; v_r jsonb; v_now jsonb;
 v_group record; v_m public.operations_hub_sku_operational_master%rowtype;
 v_l operations_private.inventory_movements%rowtype; v_moves jsonb; v_delta bigint; v_desired integer;
 v_reason text; v_after integer; v_ids jsonb;
begin
 v_session:=operations_private.require_operations_hub_operator_session(p_session_token);
 if p_action_id is null or coalesce(p_mode,'') not in ('deduct','included') or p_date is null
  or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) not between 1 and 200
  or octet_length(p_rows::text)>250000 then raise exception '주문 선택과 적용 방식을 확인해주세요.'; end if;
 if position(p_session_token in p_rows::text)>0 then raise exception '인증정보를 작업 내용에 저장할 수 없습니다.'; end if;
 if (select count(distinct r->>'id') from jsonb_array_elements(p_rows) r)<>jsonb_array_length(p_rows) then raise exception '중복되거나 없는 주문항목 ID'; end if;
 v_hash:=encode(sha256(convert_to(jsonb_build_array(p_date,p_mode,p_rows)::text,'UTF8')),'hex');
 -- Same global journal order as workspace actions, then field lock, then sorted stock rows.
 perform pg_advisory_xact_lock(hashtextextended('operations_hub_workspace_actions_v1',0));
 select * into v_old from operations_private.inventory_actions where action_id=p_action_id;
 if found then
  if v_old.actor<>v_session->>'username' or v_old.request_hash<>v_hash then raise exception '다른 요청에 사용된 작업 ID'; end if;
  return jsonb_build_object('action_id',p_action_id,'status',v_old.status,'items',v_old.items,'replayed',true);
 end if;
 select jsonb_agg(r->'id') into v_ids from jsonb_array_elements(p_rows) r;
 v_source:=operations_private.inventory_order_source(p_date,0,v_ids);
 perform pg_advisory_xact_lock_shared(hashtextextended('operations_hub_master_field:system_stock',0));
 perform 1 from public.operations_hub_sku_operational_master where sellpia_sku_code in
  (select r->>'sku' from jsonb_array_elements(v_source) r) order by sellpia_sku_code for update;
 v_source:=operations_private.inventory_describe(v_source);
 for v_r in select * from jsonb_array_elements(p_rows) loop
  select r into v_now from jsonb_array_elements(v_source) r where r->>'id'=v_r->>'id';
  v_reason:=case when v_now is null then '접수일 조회에서 사라진 주문: 다시 조회하세요'
   when v_now->>'source_hash' is distinct from v_r->>'source_hash' then '조회 후 주문 내용 변경: 다시 조회하세요'
   when v_now->>'stock_revision' is distinct from v_r->>'stock_revision' or v_now->'before' is distinct from v_r->'before' then '조회 후 현재재고 변경: 다시 조회하세요'
   when v_now->>'ledger_revision' is distinct from v_r->>'ledger_revision' then '다른 작업에서 이미 반영: 다시 조회하세요'
   else v_now->>'reason' end;
  if coalesce(v_reason,'')<>'' then
   v_result:=v_result||jsonb_build_array(jsonb_build_object('id',v_r->>'id','sku',v_r->>'sku','status','excluded','reason',v_reason));
  else v_prepared:=v_prepared||jsonb_build_array(v_now); end if;
 end loop;
 insert into operations_private.inventory_actions(action_id,actor,request_hash,kind)
 values(p_action_id,v_session->>'username',v_hash,p_mode);
 for v_group in select r->>'sku' sku,jsonb_agg(r) rows from jsonb_array_elements(v_prepared) r group by 1 order by 1 loop
  begin
   select * into strict v_m from public.operations_hub_sku_operational_master where sellpia_sku_code=v_group.sku;
   v_delta:=0; v_moves:='[]';
   for v_r in select * from jsonb_array_elements(v_group.rows) loop
    select * into v_l from operations_private.inventory_movements where event_key=v_r->>'key';
    v_desired:=-(v_r->>'quantity')::integer;
    if coalesce(v_l.applied,0)=v_desired then continue; end if;
    if p_mode='included' and v_l.event_key is not null then raise exception '이미 반영된 주문은 원본 포함 처리할 수 없습니다. 차이만 반영하거나 이전 작업을 취소하세요.'; end if;
    if p_mode='deduct' then v_delta:=v_delta+v_desired-coalesce(v_l.applied,0); end if;
    v_moves:=v_moves||jsonb_build_array(jsonb_build_object('key',v_r->>'key','id',v_r->>'id','previous',to_jsonb(v_l),'desired',v_desired));
   end loop;
   if jsonb_array_length(v_moves)=0 then
    v_result:=v_result||jsonb_build_array(jsonb_build_object('sku',v_group.sku,'status','skipped','reason','이미 반영됨'));
    continue;
   end if;
   if v_m.stock_quantity::bigint+v_delta not between 0 and 2147483647 then raise exception '현재재고 부족 또는 허용 수량 초과'; end if;
   v_after:=v_m.stock_quantity+v_delta;
   if v_delta<>0 then
    perform 1 from public.save_operations_hub_sku_operational_value(p_session_token,v_group.sku,'system_stock',v_after,'manual','operations-hub',jsonb_build_object('inventory_action_id',p_action_id));
   end if;
   for v_r in select * from jsonb_array_elements(v_moves) loop
    insert into operations_private.inventory_movements(event_key,sku,applied,action_id)
     values(v_r->>'key',v_group.sku,(v_r->>'desired')::integer,p_action_id)
     on conflict(event_key) do update set applied=excluded.applied,revision=inventory_movements.revision+1,action_id=excluded.action_id;
   end loop;
   select stock_version into v_delta from public.operations_hub_sku_operational_master where sellpia_sku_code=v_group.sku;
   v_result:=v_result||jsonb_build_array(jsonb_build_object('sku',v_group.sku,'status','saved','before',v_m.stock_quantity,
    'after',v_after,'after_revision',v_delta::text,'movements',v_moves));
  exception when others then
   v_result:=v_result||jsonb_build_array(jsonb_build_object('sku',v_group.sku,'status','excluded','reason',sqlerrm));
  end;
 end loop;
 update operations_private.inventory_actions set items=v_result where action_id=p_action_id;
 return jsonb_build_object('action_id',p_action_id,'status','saved','items',v_result);
end; $$;

create function operations_private.inventory_undo(p_session_token text,p_action_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog set statement_timeout='20s' set lock_timeout='3s' as $$
declare v_session jsonb; v_action operations_private.inventory_actions%rowtype; v_r jsonb; v_e jsonb; v_m record;
begin
 v_session:=operations_private.require_operations_hub_operator_session(p_session_token);
 perform pg_advisory_xact_lock(hashtextextended('operations_hub_workspace_actions_v1',0));
 select * into v_action from operations_private.inventory_actions where action_id=p_action_id and actor=v_session->>'username' for update;
 if not found then raise exception '본인의 재고 반영 작업만 취소할 수 있습니다.'; end if;
 if v_action.status='undone' then return jsonb_build_object('status','undone','replayed',true); end if;
 perform pg_advisory_xact_lock_shared(hashtextextended('operations_hub_master_field:system_stock',0));
 perform 1 from public.operations_hub_sku_operational_master where sellpia_sku_code in
  (select r->>'sku' from jsonb_array_elements(v_action.items) r where r->>'status'='saved') order by sellpia_sku_code for update;
 for v_r in select * from jsonb_array_elements(v_action.items) r where r->>'status'='saved' loop
  select stock_quantity,stock_version into v_m from public.operations_hub_sku_operational_master where sellpia_sku_code=v_r->>'sku';
  if v_m.stock_quantity is distinct from (v_r->>'after')::integer or v_m.stock_version::text is distinct from v_r->>'after_revision' then
   return jsonb_build_object('status','conflict','reason','이후 재고가 수정되어 전체 실행취소를 멈췄습니다.','sku',v_r->>'sku'); end if;
  if exists(select 1 from jsonb_array_elements(v_r->'movements') e left join operations_private.inventory_movements l on l.event_key=e->>'key' where l.action_id is distinct from p_action_id) then
   return jsonb_build_object('status','conflict','reason','이후 주문 반영 이력이 변경됐습니다.'); end if;
 end loop;
 for v_r in select * from jsonb_array_elements(v_action.items) r where r->>'status'='saved' loop
  if v_r->'before' is distinct from v_r->'after' then
   perform 1 from public.save_operations_hub_sku_operational_value(p_session_token,v_r->>'sku','system_stock',(v_r->>'before')::numeric,'manual','operations-hub',jsonb_build_object('inventory_undo_id',p_action_id));
  end if;
  for v_e in select * from jsonb_array_elements(v_r->'movements') loop
   if v_e->'previous' is null or v_e->'previous'='null'::jsonb or v_e->'previous'->>'event_key' is null then
    delete from operations_private.inventory_movements where event_key=v_e->>'key';
   else
    update operations_private.inventory_movements set applied=(v_e->'previous'->>'applied')::integer,
     revision=revision+1,action_id=(v_e->'previous'->>'action_id')::uuid where event_key=v_e->>'key';
   end if;
  end loop;
 end loop;
 update operations_private.inventory_actions set status='undone',undone_at=clock_timestamp() where action_id=p_action_id;
 return jsonb_build_object('status','undone','action_id',p_action_id);
end; $$;

create function operations_private.inventory_history(p_session_token text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v_session jsonb;
begin
 v_session:=operations_private.require_operations_hub_operator_session(p_session_token);
 return (select coalesce(jsonb_agg(to_jsonb(a) order by created_at desc),'[]') from
  (select action_id,kind,status,items,created_at from operations_private.inventory_actions where actor=v_session->>'username' order by created_at desc limit 30) a);
end; $$;

-- Public invoker wrappers expose only the authenticated operations, not private tables/source helper.
create function public.list_operations_hub_order_stock_v1(p_session_token text,p_date date,p_offset integer default 0)
returns jsonb language sql security invoker set search_path=pg_catalog set statement_timeout='25s' as $$ select operations_private.inventory_list(p_session_token,p_date,p_offset); $$;
create function public.save_operations_hub_order_stock_v1(p_session_token text,p_action_id uuid,p_date date,p_mode text,p_rows jsonb)
returns jsonb language sql security invoker set search_path=pg_catalog set statement_timeout='25s' as $$ select operations_private.inventory_save(p_session_token,p_action_id,p_date,p_mode,p_rows); $$;
create function public.undo_operations_hub_order_stock_v1(p_session_token text,p_action_id uuid)
returns jsonb language sql security invoker set search_path=pg_catalog set statement_timeout='25s' as $$ select operations_private.inventory_undo(p_session_token,p_action_id); $$;
create function public.list_operations_hub_stock_history_v1(p_session_token text)
returns jsonb language sql security invoker set search_path=pg_catalog set statement_timeout='25s' as $$ select operations_private.inventory_history(p_session_token); $$;
revoke all on function operations_private.inventory_list(text,date,integer),operations_private.inventory_save(text,uuid,date,text,jsonb),operations_private.inventory_undo(text,uuid),operations_private.inventory_history(text) from public,anon,authenticated;
revoke all on function public.list_operations_hub_order_stock_v1(text,date,integer),public.save_operations_hub_order_stock_v1(text,uuid,date,text,jsonb),public.undo_operations_hub_order_stock_v1(text,uuid),public.list_operations_hub_stock_history_v1(text) from public,anon,authenticated;
grant execute on function operations_private.inventory_list(text,date,integer),operations_private.inventory_save(text,uuid,date,text,jsonb),operations_private.inventory_undo(text,uuid),operations_private.inventory_history(text) to anon,authenticated;
grant execute on function public.list_operations_hub_order_stock_v1(text,date,integer),public.save_operations_hub_order_stock_v1(text,uuid,date,text,jsonb),public.undo_operations_hub_order_stock_v1(text,uuid),public.list_operations_hub_stock_history_v1(text) to anon,authenticated;
