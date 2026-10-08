-- Accepted price decisions are immutable events. The current state is keyed by
-- carrier identity so aliases in the internal SKU graph cannot diverge.
create table operations_private.hub_price_decision_groups (
  source_channel text not null check (source_channel in ('smartstore','makeshop','ably')),
  seller_product_code text not null,
  revision bigint not null default 0 check (revision >= 0),
  mapping_fingerprint text,
  current_request_id uuid,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (source_channel, seller_product_code),
  check (length(btrim(seller_product_code)) between 1 and 256)
);

create table operations_private.hub_price_decision_events (
  event_id bigint generated always as identity primary key,
  request_id uuid not null,
  source_channel text not null check (source_channel in ('smartstore','makeshop','ably')),
  seller_product_code text not null,
  seller_option_code text not null default '',
  sellpia_sku_code text not null,
  group_revision bigint not null check (group_revision > 0),
  decision_source text not null check (decision_source in ('matrix_manual','pricing_rule','sellpia_apply','rollback')),
  reason text not null check (length(btrim(reason)) between 1 and 500),
  price jsonb not null check (jsonb_typeof(price)='object'),
  intent jsonb not null default '{}'::jsonb check (jsonb_typeof(intent)='object'),
  proof jsonb not null default '{}'::jsonb check (jsonb_typeof(proof)='object'),
  previous_event_id bigint,
  actor text not null,
  effective_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  unique (request_id, source_channel, seller_product_code, seller_option_code),
  check (length(btrim(seller_product_code)) between 1 and 256),
  check (length(seller_option_code) <= 512),
  check (length(sellpia_sku_code) between 1 and 128)
);
create index hub_price_decision_events_history_idx
  on operations_private.hub_price_decision_events(source_channel,seller_product_code,event_id desc);

create function operations_private.reject_hub_price_decision_event_mutation_v1()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  raise exception '가격 결정 이력은 append-only입니다.';
end $$;
revoke all on function operations_private.reject_hub_price_decision_event_mutation_v1() from public,anon,authenticated;
create trigger hub_price_decision_events_immutable_row
  before update or delete on operations_private.hub_price_decision_events
  for each row execute function operations_private.reject_hub_price_decision_event_mutation_v1();
create trigger hub_price_decision_events_immutable_truncate
  before truncate on operations_private.hub_price_decision_events
  for each statement execute function operations_private.reject_hub_price_decision_event_mutation_v1();

create table operations_private.hub_effective_price_states (
  source_channel text not null check (source_channel in ('smartstore','makeshop','ably')),
  seller_product_code text not null,
  seller_option_code text not null default '',
  sellpia_sku_code text not null,
  price jsonb not null check (jsonb_typeof(price)='object'),
  intent jsonb not null default '{}'::jsonb check (jsonb_typeof(intent)='object'),
  event_id bigint not null references operations_private.hub_price_decision_events(event_id),
  revision bigint not null check (revision > 0),
  decision_source text not null check (decision_source in ('matrix_manual','pricing_rule','sellpia_apply','rollback')),
  effective_at timestamptz not null,
  primary key (source_channel,seller_product_code,seller_option_code),
  check (length(btrim(seller_product_code)) between 1 and 256),
  check (length(seller_option_code) <= 512),
  check (length(sellpia_sku_code) between 1 and 128)
);
create index hub_effective_price_states_sku_idx
  on operations_private.hub_effective_price_states(sellpia_sku_code,source_channel);

create table operations_private.hub_price_decision_requests (
  request_id uuid primary key,
  actor text not null,
  payload_fingerprint text not null,
  request_body jsonb not null check (jsonb_typeof(request_body)='object'),
  result jsonb not null check (jsonb_typeof(result)='object'),
  created_at timestamptz not null default clock_timestamp()
);

alter table operations_private.hub_price_decision_groups enable row level security;
alter table operations_private.hub_price_decision_events enable row level security;
alter table operations_private.hub_effective_price_states enable row level security;
alter table operations_private.hub_price_decision_requests enable row level security;
revoke all on operations_private.hub_price_decision_groups,
  operations_private.hub_price_decision_events,
  operations_private.hub_effective_price_states,
  operations_private.hub_price_decision_requests from public,anon,authenticated;
revoke all on sequence operations_private.hub_price_decision_events_event_id_seq from public,anon,authenticated;

create function operations_private.hub_price_decision_mapping_fingerprint_v1(p_source text,p_product text)
returns text language sql stable set search_path=pg_catalog as $$
  select md5(coalesce(jsonb_agg(jsonb_build_object(
    'mapping_source',m.mapping_source,'listing_id',m.listing_id,'component_id',m.component_id,
    'option_code',coalesce(nullif(btrim(m.option_code),''),''),'sku',m.sellpia_sku_code,
    'component_qty',m.component_qty,'component_role',m.component_role
  ) order by coalesce(nullif(btrim(m.option_code),''),''),m.sellpia_sku_code,m.mapping_source,m.listing_id,m.component_id)::text,'[]'))
  from public.operations_hub_listing_component_projection m
  where m.source_channel=p_source and btrim(m.product_code)=btrim(p_product)
$$;
revoke all on function operations_private.hub_price_decision_mapping_fingerprint_v1(text,text) from public,anon,authenticated;

create function public.hub_price_decision_matrix_read_v1(p_session_token text,p_skus text[])
returns jsonb language plpgsql security definer stable set search_path=pg_catalog set statement_timeout='15s' as $$
declare v_result jsonb;
begin
  perform operations_private.require_operations_hub_operator_session(p_session_token);
  if coalesce(cardinality(p_skus),0) not between 1 and 2000 or exists(select 1 from unnest(p_skus) s where length(btrim(s)) not between 1 and 128) then
    raise exception '가격 결정 상태 조회는 SKU 1~2,000개가 필요합니다.';
  end if;
  if not exists (
    select 1 from operations_private.hub_effective_price_states state
    where state.sellpia_sku_code=any(p_skus)
  ) and not exists (
    select 1 from operations_private.hub_effective_price_states state
    join public.operations_hub_listing_component_projection component
      on component.source_channel=state.source_channel
     and btrim(component.product_code)=state.seller_product_code
     and coalesce(nullif(btrim(component.option_code),''),'')=state.seller_option_code
     and component.sellpia_sku_code=any(p_skus)
  ) then return jsonb_build_object('rows','[]'::jsonb); end if;

  with rows as (
    select distinct component.sellpia_sku_code as sku,state.source_channel,state.seller_product_code,
      state.seller_option_code,state.price,state.event_id,state.revision,state.decision_source,state.effective_at,
      (group_state.revision is not null and group_state.mapping_fingerprint=
        operations_private.hub_price_decision_mapping_fingerprint_v1(state.source_channel,state.seller_product_code)) as mapping_valid
    from public.operations_hub_listing_component_projection component
    join operations_private.hub_effective_price_states state
      on state.source_channel=component.source_channel
     and state.seller_product_code=btrim(component.product_code)
     and state.seller_option_code=coalesce(nullif(btrim(component.option_code),''),'')
    left join operations_private.hub_price_decision_groups group_state
      on group_state.source_channel=state.source_channel and group_state.seller_product_code=state.seller_product_code
    where component.sellpia_sku_code=any(p_skus)
    union all
    select state.sellpia_sku_code,state.source_channel,state.seller_product_code,
      state.seller_option_code,state.price,state.event_id,state.revision,state.decision_source,state.effective_at,false
    from operations_private.hub_effective_price_states state
    where state.sellpia_sku_code=any(p_skus)
      and not exists(select 1 from public.operations_hub_listing_component_projection component
        where component.sellpia_sku_code=state.sellpia_sku_code
          and component.source_channel=state.source_channel
          and btrim(component.product_code)=state.seller_product_code
          and coalesce(nullif(btrim(component.option_code),''),'')=state.seller_option_code)
  )
  select jsonb_build_object('rows',coalesce(jsonb_agg(jsonb_build_object(
    'sku',rows.sku,'source_channel',rows.source_channel,
    'seller_product_code',rows.seller_product_code,'seller_option_code',rows.seller_option_code,
    'price',rows.price,'event_id',rows.event_id,'revision',rows.revision,
    'decision_source',rows.decision_source,'effective_at',rows.effective_at,
    'mapping_valid',coalesce(rows.mapping_valid,false)
  ) order by rows.sku,rows.source_channel,rows.seller_product_code,rows.seller_option_code),'[]'::jsonb))
  into v_result
  from rows;
  return v_result;
end $$;

create function public.hub_price_decision_read_v1(p_session_token text,p_source text,p_skus text[])
returns jsonb language plpgsql security definer stable set search_path=pg_catalog set statement_timeout='20s' as $$
declare
  v_source text:=lower(btrim(coalesce(p_source,'')));
  v_groups jsonb:='[]'::jsonb;
  v_group record;
  v_member_skus text[];
  v_snapshot uuid;
  v_sellpia_snapshot uuid;
  v_sellpia_observed_at timestamptz;
  v_sellpia_prices jsonb;
  v_fp jsonb;
  v_targets jsonb;
  v_revision bigint;
  v_stored_fingerprint text;
  v_fingerprint text;
  v_limit_targets integer:=0;
  v_rows jsonb;
begin
  perform operations_private.require_operations_hub_operator_session(p_session_token);
  if v_source not in ('smartstore','makeshop','ably') then raise exception '지원하지 않는 판매처입니다.'; end if;
  if coalesce(cardinality(p_skus),0) not between 1 and 200 or exists(select 1 from unnest(p_skus) s where length(btrim(s)) not between 1 and 128) then
    raise exception '가격 결정 그룹 조회는 SKU 1~200개가 필요합니다.';
  end if;
  for v_group in
    select distinct btrim(requested.product_code) as product_code
    from unnest(p_skus) requested_sku
    join public.operations_hub_listing_component_projection requested
      on requested.sellpia_sku_code=requested_sku and requested.source_channel=v_source
    where nullif(btrim(requested.product_code),'') is not null
    order by 1
  loop
    select array_agg(distinct member.sellpia_sku_code order by member.sellpia_sku_code)
      into v_member_skus
    from public.operations_hub_listing_component_projection member
    where member.source_channel=v_source and btrim(member.product_code)=v_group.product_code;
    if coalesce(cardinality(v_member_skus),0)=0 then continue; end if;
    if cardinality(v_member_skus)>200 or v_limit_targets+cardinality(v_member_skus)>1000 then
      raise exception '가격 결정 그룹이 요청 크기 제한을 넘었습니다.';
    end if;
    v_limit_targets:=v_limit_targets+cardinality(v_member_skus);
    v_fingerprint:=operations_private.hub_price_decision_mapping_fingerprint_v1(v_source,v_group.product_code);
    select coalesce(group_state.revision,0),group_state.mapping_fingerprint into v_revision,v_stored_fingerprint
    from (select 1) seed
    left join operations_private.hub_price_decision_groups group_state
      on group_state.source_channel=v_source and group_state.seller_product_code=v_group.product_code;
    select snapshot.snapshot_id into v_snapshot
    from public.seller_inventory_snapshots snapshot
    where snapshot.source_channel=v_source and snapshot.upload_status='ready'
    order by snapshot.completed_at desc nulls last,snapshot.created_at desc,snapshot.snapshot_id desc limit 1;
    select snapshot.snapshot_id into v_sellpia_snapshot
    from public.sellpia_stock_snapshots snapshot
    where snapshot.upload_status='ready'
    order by coalesce(snapshot.completed_at,snapshot.created_at) desc,snapshot.created_at desc,snapshot.snapshot_id desc limit 1;
    select snapshot.completed_at into v_sellpia_observed_at
    from public.sellpia_stock_snapshots snapshot where snapshot.snapshot_id=v_sellpia_snapshot;
    select coalesce(jsonb_object_agg(source_row.sellpia_sku_code,
      nullif(regexp_replace(coalesce(source_row.raw_payload->>'sell_price',''),'[^0-9.-]','','g'),'')::numeric), '{}'::jsonb)
      into v_sellpia_prices
    from public.sellpia_stock_snapshot_rows source_row
    where source_row.snapshot_id=v_sellpia_snapshot and source_row.sellpia_sku_code=any(v_member_skus);
    v_fp:=public.hub_input_fingerprints_v1(p_session_token,v_member_skus,v_source);
    if jsonb_typeof(v_fp) is distinct from 'object' then raise exception '가격 입력 fingerprint 응답 형식 오류'; end if;
    select coalesce(jsonb_agg(option_target order by option_target->>'seller_option_code'),'[]'::jsonb)
      into v_targets
    from (
      select jsonb_build_object(
      'sku',min(member.sellpia_sku_code),
      'member_skus',jsonb_agg(distinct member.sellpia_sku_code order by member.sellpia_sku_code),
      'seller_product_code',v_group.product_code,
      'seller_option_code',coalesce(nullif(btrim(member.option_code),''),''),
      'price',case when source_row.snapshot_id is null then null else jsonb_build_object(
        'base',coalesce(source_row.base_price,nullif(source_row.raw_payload->>'base_price','')::numeric,source_row.price),
        'discounted',coalesce(source_row.discounted_base_price,source_row.base_price,source_row.price),
        'option',coalesce(source_row.option_price,nullif(source_row.raw_payload->>'option_price','')::numeric,0),
        'final',coalesce(source_row.final_price,source_row.price),
        'terms',coalesce(source_row.discount_terms,'[]'::jsonb)
      ) end,
      'raw_payload',source_row.raw_payload,'source_row_no',source_row.source_row_no,
      'source_valid',source_row.snapshot_id is not null,
      'current_state',to_jsonb(state)
      ) as option_target
    
    from public.operations_hub_listing_component_projection member
    left join public.seller_inventory_snapshot_rows source_row
      on source_row.snapshot_id=v_snapshot and source_row.product_code=v_group.product_code
     and coalesce(nullif(btrim(source_row.option_code),''),'')=coalesce(nullif(btrim(member.option_code),''),'')
    left join operations_private.hub_effective_price_states state
      on state.source_channel=v_source and state.seller_product_code=v_group.product_code
     and state.seller_option_code=coalesce(nullif(btrim(member.option_code),''),'')
    where member.source_channel=v_source and btrim(member.product_code)=v_group.product_code
    group by coalesce(nullif(btrim(member.option_code),''),''),source_row.snapshot_id,source_row.raw_payload,source_row.price,
      source_row.base_price,source_row.discounted_base_price,source_row.option_price,source_row.final_price,
      source_row.discount_terms,source_row.source_row_no,state
    ) grouped_options;
    v_groups:=v_groups||jsonb_build_array(jsonb_build_object(
      'source_channel',v_source,'seller_product_code',v_group.product_code,
      'revision',v_revision,'mapping_fingerprint',v_fingerprint,
      'mapping_valid',v_revision=0 or v_stored_fingerprint=v_fingerprint,
      'input_fingerprints',v_fp,'snapshot_id',v_snapshot,'sellpia_snapshot_id',v_sellpia_snapshot,
      'source_observed_at',v_sellpia_observed_at,'sellpia_prices',v_sellpia_prices,
      'targets',v_targets
    ));
  end loop;
  select coalesce(jsonb_agg(row_item order by row_item->>'sku',row_item->>'source_channel',row_item->>'seller_product_code',row_item->>'seller_option_code'),'[]'::jsonb)
    into v_rows
  from jsonb_array_elements(public.hub_price_decision_matrix_read_v1(p_session_token,p_skus)->'rows') row_item
  where row_item->>'source_channel'=v_source;
  return jsonb_build_object('rows',coalesce(v_rows,'[]'::jsonb),'groups',v_groups);
end $$;

create function public.hub_price_decision_apply_v1(p_session_token text,p_request_id uuid,p_body jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog set statement_timeout='45s' as $$
declare
  v_actor jsonb;
  v_actor_name text;
  v_source text;
  v_decision_source text;
  v_reason text;
  v_payload_fingerprint text;
  v_existing operations_private.hub_price_decision_requests%rowtype;
  v_group jsonb;
  v_target jsonb;
  v_action jsonb;
  v_product text;
  v_revision bigint;
  v_fingerprint text;
  v_current_fps jsonb;
  v_skus text[];
  v_expected_options text[];
  v_payload_options text[];
  v_snapshot uuid;
  v_sellpia_snapshot uuid;
  v_sellpia_source_price numeric;
  v_sellpia_observed_at timestamptz;
  v_action_sku text;
  v_action_kind text;
  v_action_option text;
  v_action_product text;
  v_action_terms jsonb;
  v_action_current_price jsonb;
  v_action_base numeric;
  v_action_discounted numeric;
  v_action_option_price numeric;
  v_action_final numeric;
  v_action_anchor numeric;
  v_result_item integer;
  v_action_decision jsonb;
  v_action_decisions jsonb:='[]'::jsonb;
  v_stored_fingerprint text;
  v_saved record;
  v_items jsonb:='[]'::jsonb;
  v_rows jsonb:='[]'::jsonb;
  v_group_results jsonb:='[]'::jsonb;
  v_target_count integer;
  v_group_count integer;
  v_new_revision bigint;
  v_event_id bigint;
  v_previous_event_id bigint;
  v_price jsonb;
  v_calculated_discounted numeric;
  v_intent jsonb;
  v_event_source text;
  v_member_skus text[];
  v_mapping_drift_products text[]:='{}'::text[];
  v_rollback_request_id uuid;
  v_rollback_target_event_id bigint;
  v_primary_product text;
  v_primary_option text;
begin
  v_actor:=operations_private.require_operations_hub_operator_session(p_session_token);
  v_actor_name:=v_actor->>'username';
  if p_request_id is null or jsonb_typeof(p_body) is distinct from 'object' then raise exception '가격 결정 요청 형식 오류'; end if;
  v_source:=lower(btrim(coalesce(p_body->>'source','')));
  v_decision_source:=p_body->>'decision_source';
  v_reason:=btrim(coalesce(p_body->>'reason',''));
  if v_source not in ('smartstore','makeshop','ably') then raise exception '지원하지 않는 판매처입니다.'; end if;
  if v_decision_source not in ('matrix_manual','pricing_rule','sellpia_apply','rollback') then raise exception '지원하지 않는 가격 결정 출처입니다.'; end if;
  if length(v_reason) not between 1 and 500 or jsonb_typeof(p_body->'groups') is distinct from 'array'
     or jsonb_array_length(p_body->'groups') not between 1 and 50 then raise exception '가격 결정 그룹 또는 사유를 확인해주세요.'; end if;
  if p_body ? 'manual_actions' and jsonb_typeof(p_body->'manual_actions') is distinct from 'array' then raise exception 'manual_actions 형식 오류'; end if;
  if coalesce(jsonb_array_length(p_body->'manual_actions'),0)>1000 or
     (select coalesce(sum(jsonb_array_length(group_item->'targets')),0) from jsonb_array_elements(p_body->'groups') group_item)>1000 then
    raise exception '가격 결정 요청이 대상 수 제한을 넘었습니다.';
  end if;
  if v_decision_source='matrix_manual' and coalesce(jsonb_array_length(p_body->'manual_actions'),0)=0 then
    raise exception '수동 가격 결정에는 저장할 manual action이 필요합니다.';
  elsif v_decision_source<>'matrix_manual' and coalesce(jsonb_array_length(p_body->'manual_actions'),0)>0 then
    raise exception '수동 대기열 저장은 matrix_manual 결정에서만 허용됩니다.';
  end if;
  v_payload_fingerprint:=encode(sha256(convert_to(p_body::text,'UTF8')),'hex');

  if v_decision_source='rollback' then
    if coalesce(p_body->>'rollback_event_id','') !~ '^[1-9][0-9]{0,18}$' then raise exception 'rollback 참조 event 형식 오류'; end if;
    select event.request_id into v_rollback_request_id
    from operations_private.hub_price_decision_events event
    where event.event_id=(p_body->>'rollback_event_id')::bigint and event.source_channel=v_source;
    if not found then raise exception 'rollback 참조 결정을 찾을 수 없습니다.'; end if;
    if not exists(select 1 from operations_private.hub_price_decision_events event
      where event.event_id=(p_body->>'rollback_event_id')::bigint
        and event.seller_product_code in (select group_item->>'seller_product_code' from jsonb_array_elements(p_body->'groups') group_item)) then
      raise exception 'rollback 참조 결정의 상품 그룹이 요청에 포함되지 않았습니다.';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('hub-price-request:'||p_request_id::text,0));
  select * into v_existing from operations_private.hub_price_decision_requests request where request.request_id=p_request_id;
  if found then
    if v_existing.actor is distinct from v_actor_name or v_existing.payload_fingerprint is distinct from v_payload_fingerprint
       or v_existing.request_body is distinct from p_body then
      raise exception '가격 결정 요청 ID가 다른 운영자 또는 payload에 이미 사용되었습니다.';
    end if;
    return v_existing.result;
  end if;

  -- Serialize group revisions in deterministic product order.
  for v_product in select x->>'seller_product_code' from jsonb_array_elements(p_body->'groups') x order by 1 loop
    perform pg_advisory_xact_lock(hashtextextended(v_source||chr(31)||v_product,0));
  end loop;
  if (select count(distinct x->>'seller_product_code') from jsonb_array_elements(p_body->'groups') x)<>jsonb_array_length(p_body->'groups') then
    raise exception '같은 상품 그룹이 요청 안에서 중복되었습니다.';
  end if;

  for v_group in select x from jsonb_array_elements(p_body->'groups') x order by x->>'seller_product_code' loop
    v_product:=btrim(v_group->>'seller_product_code');
    if length(v_product) not between 1 and 256 or jsonb_typeof(v_group->'targets') is distinct from 'array'
       or jsonb_array_length(v_group->'targets') not between 1 and 200 then raise exception '가격 결정 대상 형식 오류'; end if;
    if coalesce(v_group->>'expected_revision','') !~ '^(0|[1-9][0-9]{0,17})$' then raise exception '그룹 revision 형식 오류'; end if;
    v_revision:=(v_group->>'expected_revision')::bigint;
    v_fingerprint:=operations_private.hub_price_decision_mapping_fingerprint_v1(v_source,v_product);
    if v_fingerprint is null or v_fingerprint is distinct from v_group->>'mapping_fingerprint' then raise exception '판매처 연결이 변경되었습니다. 가격을 다시 확인해주세요.'; end if;
    insert into operations_private.hub_price_decision_groups(source_channel,seller_product_code)
      values(v_source,v_product) on conflict do nothing;
    select group_row.revision,group_row.mapping_fingerprint into v_new_revision,v_stored_fingerprint
    from operations_private.hub_price_decision_groups group_row
    where group_row.source_channel=v_source and group_row.seller_product_code=v_product for update;
    if v_new_revision>0 and v_stored_fingerprint is distinct from v_fingerprint then
      v_mapping_drift_products:=array_append(v_mapping_drift_products,v_product);
    end if;
    if v_new_revision is distinct from (v_group->>'expected_revision')::bigint then raise exception '가격 결정 revision이 변경되었습니다. 다시 계산해주세요.'; end if;

    select array_agg(distinct member.sellpia_sku_code order by member.sellpia_sku_code),
           array_agg(distinct coalesce(nullif(btrim(member.option_code),''),'') order by coalesce(nullif(btrim(member.option_code),''),''))
      into v_member_skus,v_expected_options
    from public.operations_hub_listing_component_projection member
    where member.source_channel=v_source and btrim(member.product_code)=v_product;
    select array_agg(distinct coalesce(nullif(btrim(target->>'seller_option_code'),''),'') order by coalesce(nullif(btrim(target->>'seller_option_code'),''),''))
      into v_payload_options from jsonb_array_elements(v_group->'targets') target;
    if coalesce(v_payload_options,'{}') is distinct from coalesce(v_expected_options,'{}') then raise exception '가격 결정 요청에 옵션이 누락되었거나 변경되었습니다.'; end if;
    if (select count(*) from jsonb_array_elements(v_group->'targets'))<>cardinality(v_expected_options) then raise exception '가격 결정 옵션 tuple이 중복되었습니다.'; end if;

    select snapshot.snapshot_id into v_snapshot
    from public.seller_inventory_snapshots snapshot where snapshot.source_channel=v_source and snapshot.upload_status='ready'
    order by snapshot.completed_at desc nulls last,snapshot.created_at desc,snapshot.snapshot_id desc limit 1;
    if v_snapshot is null or v_snapshot is distinct from nullif(v_group->>'snapshot_id','')::uuid then raise exception '판매처 원본 스냅샷이 갱신되었습니다.'; end if;
    v_current_fps:=public.hub_input_fingerprints_v1(p_session_token,v_member_skus,v_source);
    if v_current_fps is distinct from v_group->'input_fingerprints' then raise exception '가격 입력 또는 Rule이 변경되었습니다. 다시 계산해주세요.'; end if;
    if v_group ? 'sellpia_snapshot_id' then
      select snapshot.snapshot_id into v_sellpia_snapshot from public.sellpia_stock_snapshots snapshot where snapshot.upload_status='ready'
      order by coalesce(snapshot.completed_at,snapshot.created_at) desc,snapshot.created_at desc,snapshot.snapshot_id desc limit 1;
      if v_sellpia_snapshot is distinct from nullif(v_group->>'sellpia_snapshot_id','')::uuid then raise exception '셀피아 원본 스냅샷이 갱신되었습니다.'; end if;
    end if;

    -- Reject incomplete carrier facts and client supplied non-integral prices.
    for v_target in select x from jsonb_array_elements(v_group->'targets') x loop
      if jsonb_typeof(v_target->'price') is distinct from 'object'
         or coalesce(v_target->>'sku','')='' or (v_target->>'seller_product_code') is distinct from v_product
         or v_target->>'seller_option_code' is null then raise exception '가격 결정 target tuple 형식 오류'; end if;
      if not exists(select 1 from public.operations_hub_listing_component_projection member
        where member.source_channel=v_source and btrim(member.product_code)=v_product
          and coalesce(nullif(btrim(member.option_code),''),'')=coalesce(nullif(btrim(v_target->>'seller_option_code'),''),'')
          and member.sellpia_sku_code=v_target->>'sku') then raise exception '가격 결정 SKU와 판매처 tuple이 일치하지 않습니다.'; end if;
      if not exists(select 1 from public.seller_inventory_snapshot_rows source_row
        where source_row.snapshot_id=v_snapshot and source_row.product_code=v_product
          and coalesce(nullif(btrim(source_row.option_code),''),'')=coalesce(nullif(btrim(v_target->>'seller_option_code'),''),'')) then raise exception '최신 판매처 원본에 해당 옵션이 없습니다.'; end if;
      if v_decision_source='sellpia_apply' then
        if coalesce(v_target->'intent'->'source_prices'->>(v_target->>'sku'),'') !~ '^(0|[1-9][0-9]{0,14})$'
           or nullif(v_target->'intent'->>'source_observed_at','') is null then
          raise exception 'Sellpia 원본 가격과 관찰시각 proof가 없습니다.';
        end if;
        select nullif(regexp_replace(coalesce(source_row.raw_payload->>'sell_price',''),'[^0-9.-]','','g'),'')::numeric,
          snapshot.completed_at
          into v_sellpia_source_price,v_sellpia_observed_at
        from public.sellpia_stock_snapshots snapshot
        join public.sellpia_stock_snapshot_rows source_row on source_row.snapshot_id=snapshot.snapshot_id
        where snapshot.snapshot_id=v_sellpia_snapshot and source_row.sellpia_sku_code=v_target->>'sku';
        if not found or v_sellpia_source_price is distinct from (v_target->'intent'->'source_prices'->>(v_target->>'sku'))::numeric
           or v_sellpia_observed_at is distinct from (v_target->'intent'->>'source_observed_at')::timestamptz then
          raise exception 'Sellpia 가격 후보가 최신 원본 스냅샷과 일치하지 않습니다. 다시 확인해주세요.';
        end if;
      end if;
      v_price:=v_target->'price';
      v_calculated_discounted:=operations_private.calculate_operations_hub_discounted_base(
        v_source,(v_price->>'base')::numeric,v_price->'terms',(v_price->>'discounted')::numeric);
      if coalesce(v_price->>'base','') !~ '^(0|[1-9][0-9]{0,14})$'
          or coalesce(v_price->>'discounted','') !~ '^(0|[1-9][0-9]{0,14})$'
          or coalesce(v_price->>'option','') !~ '^-?(0|[1-9][0-9]{0,14})$'
          or coalesce(v_price->>'final','') !~ '^(0|[1-9][0-9]{0,14})$'
          or (v_price->>'final')::numeric<>(v_price->>'discounted')::numeric+(v_price->>'option')::numeric
          or (v_decision_source<>'matrix_manual' and (v_price->>'discounted')::numeric is distinct from v_calculated_discounted)
          or jsonb_typeof(v_price->'terms') is distinct from 'array' then raise exception '가격 tuple이 유효하지 않습니다.'; end if;
      if v_decision_source='rollback' then
        select event.price,event.intent,event.event_id into v_price,v_intent,v_rollback_target_event_id
        from operations_private.hub_price_decision_events event
        where event.request_id=v_rollback_request_id and event.source_channel=v_source
          and event.seller_product_code=v_product
          and event.seller_option_code=coalesce(nullif(btrim(v_target->>'seller_option_code'),''),'');
        if found then
          if v_price is distinct from v_target->'price' then raise exception 'rollback 대상이 과거 그룹 결정과 일치하지 않습니다.'; end if;
          v_action_decisions:=v_action_decisions||jsonb_build_array(jsonb_build_object(
            'sku',v_target->>'sku','seller_product_code',v_product,
            'seller_option_code',coalesce(nullif(btrim(v_target->>'seller_option_code'),''),''),
            'price',v_price,'intent',coalesce(v_intent,'{}'::jsonb),'rollback_event_id',v_rollback_target_event_id));
        else
          select state.price into v_price from operations_private.hub_effective_price_states state
          where state.source_channel=v_source and state.seller_product_code=v_product
            and state.seller_option_code=coalesce(nullif(btrim(v_target->>'seller_option_code'),''),'');
          if not found then
            select jsonb_build_object('base',coalesce(source_row.base_price,source_row.price),
              'discounted',coalesce(source_row.discounted_base_price,source_row.base_price,source_row.price),
              'option',coalesce(source_row.option_price,0),'final',coalesce(source_row.final_price,source_row.price),
              'terms',coalesce(source_row.discount_terms,'[]'::jsonb)) into v_price
            from public.seller_inventory_snapshot_rows source_row
            where source_row.snapshot_id=v_snapshot and source_row.product_code=v_product
              and coalesce(nullif(btrim(source_row.option_code),''),'')=coalesce(nullif(btrim(v_target->>'seller_option_code'),''),'');
          end if;
          if v_price is distinct from v_target->'price' then
            raise exception 'rollback 그룹의 미변경 옵션은 현재 승인 또는 seller 가격을 유지해야 합니다.';
          end if;
        end if;
      end if;
    end loop;

    if exists(
      select 1 from jsonb_array_elements(v_group->'targets') t
      where t->'price'->'base' is distinct from (select x->'price'->'base' from jsonb_array_elements(v_group->'targets') x limit 1)
         or t->'price'->'terms' is distinct from (select x->'price'->'terms' from jsonb_array_elements(v_group->'targets') x limit 1)
    ) then raise exception '같은 판매처 상품의 공통 판매가와 할인조건이 일치하지 않습니다.'; end if;
  end loop;

  -- Existing queue writes and accepted decision writes share this RPC transaction.
  for v_action in select x from jsonb_array_elements(coalesce(p_body->'manual_actions','[]'::jsonb)) x loop
    v_action_kind:=v_action->>'kind'; v_action_sku:=v_action->>'sku';
    if v_action_kind='price' then
      select btrim(case v_source when 'smartstore' then matrix.smartstore_product_code
        when 'makeshop' then matrix.makeshop_product_code else matrix.ably_product_code end),
        coalesce(nullif(btrim(case v_source when 'smartstore' then matrix.smartstore_option_code
          when 'makeshop' then matrix.makeshop_option_code else matrix.ably_option_code end),''),'')
        into v_primary_product,v_primary_option
      from public.operations_hub_matrix_cached matrix where matrix.sellpia_sku_code=v_action_sku;
      if not found or v_primary_product is null then raise exception '수동 가격 action의 Matrix primary 판매처 연결을 찾을 수 없습니다.'; end if;
      v_action_product:=v_primary_product; v_action_option:=v_primary_option;
      if btrim(coalesce(v_action->>'seller_product_code','')) is distinct from v_action_product
         or coalesce(nullif(btrim(v_action->>'seller_option_code'),''),'') is distinct from v_action_option
         or not exists(select 1 from jsonb_array_elements(p_body->'groups') group_item
          cross join lateral jsonb_array_elements(group_item->'targets') target
          where group_item->>'seller_product_code'=v_action_product
            and target->>'seller_product_code'=v_action_product
            and coalesce(nullif(btrim(target->>'seller_option_code'),''),'')=v_action_option
            and (target->>'sku'=v_action_sku or coalesce(target->'member_skus','[]'::jsonb) ? v_action_sku)) then
        raise exception '수동 가격 action이 증명된 Matrix primary seller tuple과 일치하지 않습니다.';
      end if;
      select state.price into v_action_current_price
      from operations_private.hub_effective_price_states state
      where state.source_channel=v_source and state.seller_product_code=v_action_product
        and state.seller_option_code=v_action_option;
      if not found then
        select jsonb_build_object('base',coalesce(source_row.base_price,source_row.price),
          'discounted',coalesce(source_row.discounted_base_price,source_row.base_price,source_row.price),
          'option',coalesce(source_row.option_price,0),'final',coalesce(source_row.final_price,source_row.price),
          'terms',coalesce(source_row.discount_terms,'[]'::jsonb)) into v_action_current_price
        from public.seller_inventory_snapshots snapshot
        join public.seller_inventory_snapshot_rows source_row on source_row.snapshot_id=snapshot.snapshot_id
        where snapshot.source_channel=v_source and snapshot.upload_status='ready'
          and source_row.product_code=v_action_product and coalesce(nullif(btrim(source_row.option_code),''),'')=v_action_option
        order by snapshot.completed_at desc nulls last,snapshot.created_at desc,snapshot.snapshot_id desc limit 1;
      end if;
      if v_action_current_price is null then raise exception '수동 가격 action의 현재 seller tuple을 찾을 수 없습니다.'; end if;
      v_action_terms:=coalesce(v_action_current_price->'terms','[]'::jsonb);
      select * into v_saved from public.save_operations_hub_seller_price_draft_v2(
        v_action_sku,v_source,(v_action->>'target_base_price')::numeric,coalesce(v_action->>'input_mode','option'),
        nullif(v_action->>'option_price','')::numeric,nullif(v_action->>'target_final_price','')::numeric,
        coalesce(v_action->>'option_price_source','manual'),coalesce(v_action->>'base_price_source','manual'),
        nullif(v_action->>'price_rule_set_id','')::bigint,p_request_id);
      v_items:=v_items||jsonb_build_array(jsonb_build_object('sku',v_action_sku,'result',to_jsonb(v_saved)));
      v_action_base:=(v_action->>'target_base_price')::numeric;
      v_action_discounted:=operations_private.calculate_operations_hub_discounted_base(
        v_source,v_action_base,v_action_terms,(v_action_current_price->>'discounted')::numeric);
      if coalesce(v_action->>'input_mode','option')='final' then
        v_action_final:=(v_action->>'target_final_price')::numeric;
        v_action_option_price:=v_action_final-v_action_discounted;
      else
        v_action_option_price:=coalesce(nullif(v_action->>'option_price','')::numeric,(v_action_current_price->>'option')::numeric,0);
        v_action_final:=v_action_discounted+v_action_option_price;
      end if;
      if v_saved.change_id is not null then
        update public.operations_hub_change_queue set price_base_after=v_action_base,
          price_discounted_base_after=v_action_discounted,price_option_after=v_action_option_price,
          price_final_after=v_action_final,price_discount_terms_after=v_action_terms,
          after_value=to_jsonb(v_action_final)
        where change_id=v_saved.change_id;
      end if;
      v_result_item:=jsonb_array_length(v_items)-1;
      v_items:=jsonb_set(v_items,array[v_result_item::text,'result','draft_base_price'],to_jsonb(v_action_base),true);
      v_items:=jsonb_set(v_items,array[v_result_item::text,'result','draft_discounted_base_price'],to_jsonb(v_action_discounted),true);
      v_items:=jsonb_set(v_items,array[v_result_item::text,'result','draft_option_price'],to_jsonb(v_action_option_price),true);
      v_items:=jsonb_set(v_items,array[v_result_item::text,'result','draft_final_price'],to_jsonb(v_action_final),true);
      v_items:=jsonb_set(v_items,array[v_result_item::text,'result','draft_discount_terms'],v_action_terms,true);
      v_action_decision:=jsonb_build_object('sku',v_action_sku,'seller_product_code',v_action_product,'seller_option_code',v_action_option,
        'base',v_action_base,'discounted',v_action_discounted,
        'option',v_action_option_price,'final',v_action_final,
        'terms',v_action_terms,'intent',jsonb_build_object('kind','price','input_mode',v_saved.saved_input_mode,
          'base_changed',v_action_base is distinct from (v_action_current_price->>'base')::numeric,
          'option_price_source',v_action->>'option_price_source','base_price_source',v_action->>'base_price_source',
          'price_rule_set_id',v_action->'price_rule_set_id'));
      v_action_decisions:=v_action_decisions||jsonb_build_array(v_action_decision);
    elsif v_action_kind='discount' then
      select btrim(case v_source when 'smartstore' then matrix.smartstore_product_code
        when 'makeshop' then matrix.makeshop_product_code else matrix.ably_product_code end),
        coalesce(nullif(btrim(case v_source when 'smartstore' then matrix.smartstore_option_code
          when 'makeshop' then matrix.makeshop_option_code else matrix.ably_option_code end),''),'')
        into v_primary_product,v_primary_option
      from public.operations_hub_matrix_cached matrix where matrix.sellpia_sku_code=v_action_sku;
      if not found or v_primary_product is null then raise exception '수동 할인 action의 Matrix primary 판매처 연결을 찾을 수 없습니다.'; end if;
      v_action_product:=v_primary_product; v_action_option:=v_primary_option;
      if btrim(coalesce(v_action->>'seller_product_code','')) is distinct from v_action_product
         or coalesce(nullif(btrim(v_action->>'seller_option_code'),''),'') is distinct from v_action_option
         or not exists(select 1 from jsonb_array_elements(p_body->'groups') group_item
          cross join lateral jsonb_array_elements(group_item->'targets') target
          where group_item->>'seller_product_code'=v_action_product
            and target->>'seller_product_code'=v_action_product
            and coalesce(nullif(btrim(target->>'seller_option_code'),''),'')=v_action_option
            and (target->>'sku'=v_action_sku or coalesce(target->'member_skus','[]'::jsonb) ? v_action_sku)) then
        raise exception '수동 할인 action이 증명된 Matrix primary seller tuple과 일치하지 않습니다.';
      end if;
      select state.price into v_action_current_price
      from operations_private.hub_effective_price_states state
      where state.source_channel=v_source and state.seller_product_code=v_action_product
        and state.seller_option_code=v_action_option;
      if not found then
        select jsonb_build_object('base',coalesce(source_row.base_price,source_row.price),
          'discounted',coalesce(source_row.discounted_base_price,source_row.base_price,source_row.price),
          'option',coalesce(source_row.option_price,0),'final',coalesce(source_row.final_price,source_row.price),
          'terms',coalesce(source_row.discount_terms,'[]'::jsonb)) into v_action_current_price
        from public.seller_inventory_snapshots snapshot
        join public.seller_inventory_snapshot_rows source_row on source_row.snapshot_id=snapshot.snapshot_id
        where snapshot.source_channel=v_source and snapshot.upload_status='ready'
          and source_row.product_code=v_action_product and coalesce(nullif(btrim(source_row.option_code),''),'')=v_action_option
        order by snapshot.completed_at desc nulls last,snapshot.created_at desc,snapshot.snapshot_id desc limit 1;
      end if;
      if v_action_current_price is null then raise exception '수동 할인 action의 현재 seller tuple을 찾을 수 없습니다.'; end if;
      update public.operations_hub_change_queue queue set
        price_base_after=(v_action_current_price->>'base')::numeric,
        price_discounted_base_after=(v_action_current_price->>'discounted')::numeric,
        price_option_after=(v_action_current_price->>'option')::numeric,
        price_final_after=(v_action_current_price->>'final')::numeric,
        price_discount_terms_after=coalesce(v_action_current_price->'terms','[]'::jsonb)
      where lower(btrim(queue.source_channel))=v_source and btrim(queue.seller_product_code)=v_action_product
        and queue.seller_option_code_normalized=v_action_option and queue.field_key='sellpia_sale_price'
        and queue.status in ('pending','validated','failed');
      if not exists(select 1 from public.operations_hub_change_queue queue
        where lower(btrim(queue.source_channel))=v_source and btrim(queue.seller_product_code)=v_action_product
          and queue.seller_option_code_normalized=v_action_option and queue.field_key='sellpia_sale_price'
          and queue.status in ('pending','validated','failed')) then
        -- Seed the legacy discount saver with the currently accepted tuple so it does not validate
        -- a new discount against an older seller-source base when no queue row exists yet.
        select * into v_saved from public.save_operations_hub_seller_price_draft_v2(
          v_action_sku,v_source,(v_action_current_price->>'base')::numeric,'option',
          (v_action_current_price->>'option')::numeric,(v_action_current_price->>'final')::numeric,
          'manual','manual',null,p_request_id);
        if v_saved.change_id is not null then
          update public.operations_hub_change_queue queue set
            price_base_after=(v_action_current_price->>'base')::numeric,
            price_discounted_base_after=(v_action_current_price->>'discounted')::numeric,
            price_option_after=(v_action_current_price->>'option')::numeric,
            price_final_after=(v_action_current_price->>'final')::numeric,
            price_discount_terms_after=coalesce(v_action_current_price->'terms','[]'::jsonb),
            after_value=to_jsonb((v_action_current_price->>'final')::numeric)
          where queue.change_id=v_saved.change_id;
        end if;
      end if;
      select * into v_saved from public.save_operations_hub_seller_discount_draft(
        v_action_sku,v_source,coalesce(v_action->'discount_terms','[]'::jsonb),coalesce(v_action->>'input_mode','option'),
        nullif(v_action->>'option_price','')::numeric,nullif(v_action->>'target_final_price','')::numeric,p_request_id);
      v_items:=v_items||jsonb_build_array(jsonb_build_object('sku',v_action_sku,'result',to_jsonb(v_saved)));
      v_action_terms:=coalesce(v_action->'discount_terms','[]'::jsonb);
      v_action_base:=(v_action_current_price->>'base')::numeric;
      if coalesce(v_action->>'input_mode','option')='discount_anchor' then
        v_action_option_price:=coalesce(nullif(v_action->>'option_price','')::numeric,(v_action_current_price->>'option')::numeric,0);
        v_action_final:=coalesce(nullif(v_action->>'target_final_price','')::numeric,(v_action_current_price->>'final')::numeric);
        v_action_anchor:=v_action_final-v_action_option_price;
        v_action_base:=operations_private.gross_operations_hub_discount_base(v_source,v_action_anchor,v_action_terms);
        v_action_discounted:=operations_private.calculate_operations_hub_discounted_base(v_source,v_action_base,v_action_terms,null);
        v_action_final:=v_action_discounted+v_action_option_price;
      else
        v_action_discounted:=operations_private.calculate_operations_hub_discounted_base(v_source,v_action_base,v_action_terms,null);
        if coalesce(v_action->>'input_mode','option')='final' then
          v_action_final:=coalesce(nullif(v_action->>'target_final_price','')::numeric,(v_action_current_price->>'final')::numeric);
          v_action_option_price:=v_action_final-v_action_discounted;
        else
          v_action_option_price:=coalesce(nullif(v_action->>'option_price','')::numeric,(v_action_current_price->>'option')::numeric,0);
          v_action_final:=v_action_discounted+v_action_option_price;
        end if;
      end if;
      if v_saved.change_id is not null then
        update public.operations_hub_change_queue set price_base_after=v_action_base,
          price_discounted_base_after=v_action_discounted,price_option_after=v_action_option_price,
          price_final_after=v_action_final,price_discount_terms_after=v_action_terms,after_value=to_jsonb(v_action_final)
        where change_id=v_saved.change_id;
      end if;
      v_result_item:=jsonb_array_length(v_items)-1;
      v_items:=jsonb_set(v_items,array[v_result_item::text,'result','draft_base_price'],to_jsonb(v_action_base),true);
      v_items:=jsonb_set(v_items,array[v_result_item::text,'result','draft_discounted_base_price'],to_jsonb(v_action_discounted),true);
      v_items:=jsonb_set(v_items,array[v_result_item::text,'result','draft_option_price'],to_jsonb(v_action_option_price),true);
      v_items:=jsonb_set(v_items,array[v_result_item::text,'result','draft_final_price'],to_jsonb(v_action_final),true);
      v_items:=jsonb_set(v_items,array[v_result_item::text,'result','draft_discount_terms'],v_action_terms,true);
      v_action_decision:=jsonb_build_object('sku',v_action_sku,'seller_product_code',v_action_product,'seller_option_code',v_action_option,
        'base',v_action_base,'discounted',v_action_discounted,'option',v_action_option_price,'final',v_action_final,
        'terms',v_action_terms,
        'intent',jsonb_build_object('kind','discount','input_mode',v_saved.saved_input_mode,
          'terms_changed',v_action_terms is distinct from coalesce(v_action_current_price->'terms','[]'::jsonb)));
      v_action_decisions:=v_action_decisions||jsonb_build_array(v_action_decision);
    elsif v_action_kind='product_discount' then
      v_action_product:=btrim(v_action->>'product_code');
      if not exists(select 1 from jsonb_array_elements(p_body->'groups') group_item
        where group_item->>'seller_product_code'=v_action_product) then
        raise exception '수동 상품 할인 action 상품이 증명된 그룹에 없습니다.';
      end if;
      for v_saved in select * from public.save_operations_hub_seller_product_discount_mode_v1(
        v_source,v_action->>'product_code',nullif(v_action->>'anchor_sku',''),coalesce(v_action->'discount_terms','[]'::jsonb),
        nullif(v_action->>'rule_code',''),coalesce(v_action->>'calculation_mode','forward'),p_request_id) loop
        v_items:=v_items||jsonb_build_array(jsonb_build_object('sku',v_saved.sellpia_sku_code,'result',to_jsonb(v_saved)));
        select btrim(case v_source when 'smartstore' then matrix.smartstore_product_code
          when 'makeshop' then matrix.makeshop_product_code else matrix.ably_product_code end),
          coalesce(nullif(btrim(case v_source when 'smartstore' then matrix.smartstore_option_code
            when 'makeshop' then matrix.makeshop_option_code else matrix.ably_option_code end),''),'')
          into v_primary_product,v_primary_option
        from public.operations_hub_matrix_cached matrix where matrix.sellpia_sku_code=v_saved.sellpia_sku_code;
        if not found or v_primary_product is distinct from btrim(v_action->>'product_code') then
          raise exception '수동 상품 할인 action SKU의 Matrix primary 판매처 연결이 상품과 일치하지 않습니다.';
        end if;
        v_action_option:=v_primary_option;
        if not exists(select 1 from jsonb_array_elements(p_body->'groups') group_item
          cross join lateral jsonb_array_elements(group_item->'targets') target
          where group_item->>'seller_product_code'=v_primary_product
            and target->>'seller_product_code'=v_primary_product
            and coalesce(nullif(btrim(target->>'seller_option_code'),''),'')=v_primary_option
            and (target->>'sku'=v_saved.sellpia_sku_code
              or coalesce(target->'member_skus','[]'::jsonb) ? v_saved.sellpia_sku_code)) then
          raise exception '수동 상품 할인 action SKU가 증명된 그룹 option에 없습니다.';
        end if;
        select state.price into v_action_current_price
        from operations_private.hub_effective_price_states state
        where state.source_channel=v_source and state.seller_product_code=v_action_product
          and state.seller_option_code=v_action_option;
        if not found then
          select jsonb_build_object('base',coalesce(source_row.base_price,source_row.price),
            'discounted',coalesce(source_row.discounted_base_price,source_row.base_price,source_row.price),
            'option',coalesce(source_row.option_price,0),'final',coalesce(source_row.final_price,source_row.price),
            'terms',coalesce(source_row.discount_terms,'[]'::jsonb)) into v_action_current_price
          from public.seller_inventory_snapshots snapshot
          join public.seller_inventory_snapshot_rows source_row on source_row.snapshot_id=snapshot.snapshot_id
          where snapshot.source_channel=v_source and snapshot.upload_status='ready'
            and source_row.product_code=v_action_product and coalesce(nullif(btrim(source_row.option_code),''),'')=v_action_option
          order by snapshot.completed_at desc nulls last,snapshot.created_at desc,snapshot.snapshot_id desc limit 1;
        end if;
        if v_action_current_price is null then raise exception '수동 상품 할인 action의 현재 seller tuple을 찾을 수 없습니다.'; end if;
        v_action_terms:=coalesce(v_saved.draft_discount_terms,v_action->'discount_terms','[]'::jsonb);
        if coalesce(v_action->>'calculation_mode','forward')='reverse-base' then
          v_action_option_price:=(v_action_current_price->>'option')::numeric;
          v_action_final:=(v_action_current_price->>'final')::numeric;
          v_action_anchor:=v_action_final-v_action_option_price;
          v_action_base:=operations_private.gross_operations_hub_discount_base(v_source,v_action_anchor,v_action_terms);
          v_action_discounted:=operations_private.calculate_operations_hub_discounted_base(v_source,v_action_base,v_action_terms,null);
          v_action_final:=v_action_discounted+v_action_option_price;
        else
          v_action_base:=(v_action_current_price->>'base')::numeric;
          v_action_discounted:=operations_private.calculate_operations_hub_discounted_base(v_source,v_action_base,v_action_terms,
            (v_action_current_price->>'discounted')::numeric);
          v_action_option_price:=(v_action_current_price->>'option')::numeric;
          v_action_final:=v_action_discounted+v_action_option_price;
        end if;
        if v_saved.change_id is not null then
          update public.operations_hub_change_queue set price_base_after=v_action_base,
            price_discounted_base_after=v_action_discounted,price_option_after=v_action_option_price,
            price_final_after=v_action_final,price_discount_terms_after=v_action_terms,after_value=to_jsonb(v_action_final)
          where change_id=v_saved.change_id;
        end if;
        v_result_item:=jsonb_array_length(v_items)-1;
        v_items:=jsonb_set(v_items,array[v_result_item::text,'result','draft_base_price'],to_jsonb(v_action_base),true);
        v_items:=jsonb_set(v_items,array[v_result_item::text,'result','draft_discounted_base_price'],to_jsonb(v_action_discounted),true);
        v_items:=jsonb_set(v_items,array[v_result_item::text,'result','draft_option_price'],to_jsonb(v_action_option_price),true);
        v_items:=jsonb_set(v_items,array[v_result_item::text,'result','draft_final_price'],to_jsonb(v_action_final),true);
        v_items:=jsonb_set(v_items,array[v_result_item::text,'result','draft_discount_terms'],v_action_terms,true);
        v_action_decision:=jsonb_build_object('sku',v_saved.sellpia_sku_code,'seller_product_code',btrim(v_action->>'product_code'),'seller_option_code',v_action_option,
          'base',v_action_base,'discounted',v_action_discounted,
          'option',v_action_option_price,'final',v_action_final,
          'terms',v_action_terms,
          'intent',jsonb_build_object('kind','product_discount','input_mode',v_saved.saved_input_mode,
            'calculation_mode',v_action->>'calculation_mode'));
        v_action_decisions:=v_action_decisions||jsonb_build_array(v_action_decision);
      end loop;
    else raise exception '지원하지 않는 manual action입니다.';
    end if;
  end loop;

  if v_decision_source='matrix_manual' then
    if exists(
      select 1 from jsonb_array_elements(v_action_decisions) decision
      group by decision->>'seller_product_code',decision->>'seller_option_code'
      having count(distinct jsonb_build_array(decision->'base',decision->'discounted',decision->'option',
        decision->'final',decision->'terms')::text)>1
    ) then raise exception '같은 판매처 옵션의 수동 가격 저장 결과가 서로 다릅니다.'; end if;
    for v_product in select distinct group_item->>'seller_product_code'
      from jsonb_array_elements(p_body->'groups') group_item order by 1 loop
      select array_agg(distinct coalesce(nullif(btrim(member.option_code),''),'') order by coalesce(nullif(btrim(member.option_code),''),''))
        into v_expected_options
      from public.operations_hub_listing_component_projection member
      where member.source_channel=v_source and btrim(member.product_code)=v_product;
      if exists(select 1 from jsonb_array_elements(v_action_decisions) decision
        where decision->>'seller_product_code'=v_product
          and coalesce((decision->'intent'->>'base_changed')::boolean,false))
         and (select count(distinct decision->>'seller_option_code') from jsonb_array_elements(v_action_decisions) decision
           where decision->>'seller_product_code'=v_product)<cardinality(v_expected_options) then
        raise exception '상품 공통 등록가 변경에는 전체 옵션 대상 저장이 필요합니다.';
      end if;
      if exists(select 1 from jsonb_array_elements(v_action_decisions) decision
        where decision->>'seller_product_code'=v_product
          and coalesce((decision->'intent'->>'terms_changed')::boolean,false))
         and (select count(distinct decision->>'seller_option_code') from jsonb_array_elements(v_action_decisions) decision
           where decision->>'seller_product_code'=v_product)<cardinality(v_expected_options) then
        raise exception '상품 공통 할인조건 변경에는 전체 옵션 대상 저장이 필요합니다.';
      end if;
      if exists(select 1 from jsonb_array_elements(p_body->'manual_actions') action
        where action->>'kind'='product_discount' and btrim(action->>'product_code')=v_product)
         and (select count(distinct decision->>'seller_option_code') from jsonb_array_elements(v_action_decisions) decision
           where decision->>'seller_product_code'=v_product)<cardinality(v_expected_options) then
        raise exception '상품 할인 변경이 전체 판매처 옵션을 다루지 않았습니다.';
      end if;
      if v_product=any(v_mapping_drift_products) and (
        (select count(distinct decision->>'seller_option_code') from jsonb_array_elements(v_action_decisions) decision
          where decision->>'seller_product_code'=v_product)<cardinality(v_expected_options)
        or not exists(select 1 from jsonb_array_elements(v_action_decisions) decision
          where decision->>'seller_product_code'=v_product
            and (coalesce((decision->'intent'->>'base_changed')::boolean,false)
              or coalesce((decision->'intent'->>'terms_changed')::boolean,false)))
      ) then raise exception '연결이 변경된 상품은 전체 옵션에 대한 명시적 가격 또는 할인 기준 적용이 필요합니다.'; end if;
    end loop;
  end if;

  for v_group in select x from jsonb_array_elements(p_body->'groups') x order by x->>'seller_product_code' loop
    v_product:=btrim(v_group->>'seller_product_code');
    select revision into v_revision from operations_private.hub_price_decision_groups
    where source_channel=v_source and seller_product_code=v_product for update;
    v_new_revision:=v_revision+1;
    for v_target in select x from jsonb_array_elements(v_group->'targets') x order by x->>'seller_option_code' loop
      if v_decision_source in ('matrix_manual','rollback') then
        select decision into v_action_decision
        from jsonb_array_elements(v_action_decisions) decision
        where decision->>'seller_product_code'=v_product
          and coalesce(nullif(btrim(decision->>'seller_option_code'),''),'')=coalesce(nullif(btrim(v_target->>'seller_option_code'),''),'')
        order by decision->>'sku' limit 1;
        if not found then continue; end if;
        if v_decision_source='matrix_manual' then
          v_price:=jsonb_build_object('base',v_action_decision->'base','discounted',v_action_decision->'discounted',
            'option',v_action_decision->'option','final',v_action_decision->'final','terms',v_action_decision->'terms');
          v_intent:=coalesce(v_action_decision->'intent','{}'::jsonb);
        else
          v_price:=v_action_decision->'price'; v_intent:=coalesce(v_action_decision->'intent','{}'::jsonb);
        end if;
      else
        v_price:=v_target->'price'; v_intent:=coalesce(v_target->'intent','{}'::jsonb);
      end if;
      if coalesce(v_price->>'base','') !~ '^(0|[1-9][0-9]{0,14})$'
         or coalesce(v_price->>'discounted','') !~ '^(0|[1-9][0-9]{0,14})$'
         or coalesce(v_price->>'option','') !~ '^-?(0|[1-9][0-9]{0,14})$'
         or coalesce(v_price->>'final','') !~ '^(0|[1-9][0-9]{0,14})$'
         or (v_price->>'final')::numeric<>(v_price->>'discounted')::numeric+(v_price->>'option')::numeric
         or jsonb_typeof(v_price->'terms') is distinct from 'array'
         or (v_price->>'discounted')::numeric is distinct from operations_private.calculate_operations_hub_discounted_base(
           v_source,(v_price->>'base')::numeric,v_price->'terms',(v_price->>'discounted')::numeric) then
        raise exception '적용 결과 가격 tuple이 유효하지 않습니다.';
      end if;
      v_previous_event_id:=null;
      select state.event_id into v_previous_event_id from operations_private.hub_effective_price_states state
      where state.source_channel=v_source and state.seller_product_code=v_product
        and state.seller_option_code=coalesce(nullif(btrim(v_target->>'seller_option_code'),''),'');
      insert into operations_private.hub_price_decision_events(
        request_id,source_channel,seller_product_code,seller_option_code,sellpia_sku_code,group_revision,
        decision_source,reason,price,intent,proof,previous_event_id,actor,effective_at
      ) values (
        p_request_id,v_source,v_product,coalesce(nullif(btrim(v_target->>'seller_option_code'),''),''),v_target->>'sku',v_new_revision,
        v_decision_source,v_reason,v_price,v_intent,
        jsonb_build_object('mapping_fingerprint',v_group->>'mapping_fingerprint','input_fingerprints',v_group->'input_fingerprints',
          'snapshot_id',v_group->'snapshot_id','sellpia_snapshot_id',v_group->'sellpia_snapshot_id',
          'rollback_event_id',p_body->'rollback_event_id'),
        v_previous_event_id,v_actor_name,clock_timestamp()
      ) returning event_id into v_event_id;
      insert into operations_private.hub_effective_price_states(
        source_channel,seller_product_code,seller_option_code,sellpia_sku_code,price,intent,event_id,revision,decision_source,effective_at
      ) values (
        v_source,v_product,coalesce(nullif(btrim(v_target->>'seller_option_code'),''),''),v_target->>'sku',v_price,v_intent,
        v_event_id,v_new_revision,v_decision_source,clock_timestamp()
      ) on conflict(source_channel,seller_product_code,seller_option_code) do update set
        sellpia_sku_code=excluded.sellpia_sku_code,price=excluded.price,intent=excluded.intent,event_id=excluded.event_id,
        revision=excluded.revision,decision_source=excluded.decision_source,effective_at=excluded.effective_at;
      v_rows:=v_rows||jsonb_build_array(jsonb_build_object(
        'sku',v_target->>'sku','source_channel',v_source,'seller_product_code',v_product,
        'seller_option_code',coalesce(nullif(btrim(v_target->>'seller_option_code'),''),''),'price',v_price,
        'event_id',v_event_id,'revision',v_new_revision,'decision_source',v_decision_source
      ));
    end loop;
    update operations_private.hub_price_decision_groups set revision=v_new_revision,
      mapping_fingerprint=v_group->>'mapping_fingerprint',current_request_id=p_request_id,updated_at=clock_timestamp()
    where source_channel=v_source and seller_product_code=v_product;
    delete from operations_private.hub_effective_price_states state
    where state.source_channel=v_source
      and (state.seller_product_code=v_product or state.sellpia_sku_code in (
        select member.sellpia_sku_code from public.operations_hub_listing_component_projection member
        where member.source_channel=v_source and btrim(member.product_code)=v_product
      ))
      and not exists(select 1 from public.operations_hub_listing_component_projection active_member
        where active_member.source_channel=state.source_channel
          and btrim(active_member.product_code)=state.seller_product_code
          and coalesce(nullif(btrim(active_member.option_code),''),'')=state.seller_option_code);
    v_group_results:=v_group_results||jsonb_build_array(jsonb_build_object('seller_product_code',v_product,'revision',v_new_revision));
  end loop;
  select coalesce(jsonb_agg(row_item order by row_item->>'sku',row_item->>'source_channel',row_item->>'seller_product_code',row_item->>'seller_option_code'),'[]'::jsonb)
    into v_rows
  from jsonb_array_elements(coalesce(public.hub_price_decision_matrix_read_v1(
    p_session_token,array(select distinct refs.sku from (
      select event_row->>'sku' as sku from jsonb_array_elements(v_rows) event_row
      union all select action->>'sku' from jsonb_array_elements(coalesce(p_body->'manual_actions','[]'::jsonb)) action
      union all select item->>'sku' from jsonb_array_elements(v_items) item
    ) refs where refs.sku is not null and length(btrim(refs.sku)) between 1 and 128)),'{}'::jsonb)->'rows') row_item
  where row_item->>'source_channel'=v_source;
  v_existing.request_id:=p_request_id; v_existing.actor:=v_actor_name; v_existing.payload_fingerprint:=v_payload_fingerprint;
  v_existing.result:=jsonb_build_object('items',v_items,'rows',coalesce(v_rows,'[]'::jsonb),'groups',v_group_results,'request_id',p_request_id);
  insert into operations_private.hub_price_decision_requests(request_id,actor,payload_fingerprint,request_body,result)
  values(v_existing.request_id,v_existing.actor,v_existing.payload_fingerprint,p_body,v_existing.result);
  return v_existing.result;
end $$;

create function public.hub_price_decision_history_v1(p_session_token text,p_source text,p_product_code text,p_limit integer default 100)
returns jsonb language plpgsql security definer stable set search_path=pg_catalog set statement_timeout='15s' as $$
declare v_source text:=lower(btrim(coalesce(p_source,''))); v_product text:=btrim(coalesce(p_product_code,'')); v_result jsonb;
begin
  perform operations_private.require_operations_hub_operator_session(p_session_token);
  if v_source not in ('smartstore','makeshop','ably') or length(v_product) not between 1 and 256
     or p_limit not between 1 and 500 then raise exception '가격 결정 이력 조회 인자 오류'; end if;
  select jsonb_build_object('events',coalesce(jsonb_agg(to_jsonb(event) order by event.event_id desc),'[]'::jsonb))
  into v_result from (
    select * from operations_private.hub_price_decision_events event
    where event.source_channel=v_source and event.seller_product_code=v_product
    order by event.event_id desc limit p_limit
  ) event;
  return v_result;
end $$;

revoke all on function public.hub_price_decision_matrix_read_v1(text,text[]),
  public.hub_price_decision_read_v1(text,text,text[]),
  public.hub_price_decision_apply_v1(text,uuid,jsonb),
  public.hub_price_decision_history_v1(text,text,text,integer) from public;
grant execute on function public.hub_price_decision_matrix_read_v1(text,text[]),
  public.hub_price_decision_read_v1(text,text,text[]),
  public.hub_price_decision_apply_v1(text,uuid,jsonb),
  public.hub_price_decision_history_v1(text,text,text,integer) to anon,authenticated;
notify pgrst,'reload schema';
