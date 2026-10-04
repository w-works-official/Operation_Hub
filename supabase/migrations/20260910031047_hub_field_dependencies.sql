-- Shared definitions, assignments and field references. No per-SKU formula copies.
create table operations_private.hub_rules (
 id uuid primary key default gen_random_uuid(), tag_id uuid references public.product_tags(tag_id),
 name text not null check(length(btrim(name)) between 1 and 200),
 target_field text not null check(target_field in ('actual_inbound_cost','basis_sku_price','calculated_base_price','calculated_stock','platform_registration_price','platform_option_price','platform_discount_price','platform_final_price','platform_price')),
 scope text not null default '' check(scope in ('','ably','smartstore','makeshop')),
 input_origin text not null check(input_origin in ('self','parent')),
 source_field text not null check(source_field in ('purchase_price','source_base_price','actual_inbound_cost','basis_sku_price','calculated_base_price','system_stock','calculated_stock','platform_registration_price','platform_option_price','platform_discount_price','platform_final_price','platform_price')),
 config jsonb not null check(jsonb_typeof(config)='object'), version integer not null default 1,
 is_active boolean not null default true, updated_at timestamptz not null default now(), updated_by text not null,
 unique(id,target_field,scope), unique(name,target_field,scope),
 check((target_field in ('platform_registration_price','platform_option_price','platform_discount_price','platform_final_price','platform_price'))=(scope<>'')),
 source_scope text not null default '' check(source_scope in ('','ably','smartstore','makeshop')),
 check(case when source_field like 'platform_%' then coalesce(nullif(source_scope,''),nullif(scope,'')) is not null else source_scope='' end)
);
create table operations_private.hub_rule_assignments (
 sku text not null check(length(btrim(sku)) between 1 and 128), rule_id uuid not null,
 target_field text not null, scope text not null default '', version integer not null default 1,
 updated_at timestamptz not null default now(), updated_by text not null,
 primary key(sku,target_field,scope), unique(sku,rule_id),
 foreign key(rule_id,target_field,scope) references operations_private.hub_rules(id,target_field,scope)
);
create table operations_private.hub_field_references (
 child_sku text not null, rule_id uuid not null, parent_sku text not null,
 source_field text not null, target_field text not null, scope text not null default '',
 relation_edge_id bigint references public.operations_hub_relation_edges(edge_id),
 source_scope text not null default '' check(source_scope in ('','ably','smartstore','makeshop')),
 primary key(child_sku,target_field,scope),
 foreign key(child_sku,rule_id) references operations_private.hub_rule_assignments(sku,rule_id) on delete cascade,
 check(child_sku<>parent_sku),
 check(source_field in ('purchase_price','source_base_price','actual_inbound_cost','basis_sku_price','calculated_base_price','system_stock','calculated_stock','platform_registration_price','platform_option_price','platform_discount_price','platform_final_price','platform_price'))
);
create index hub_field_references_parent_idx on operations_private.hub_field_references(parent_sku);
create table operations_private.hub_rule_requests (
 request_id uuid primary key, payload jsonb not null, result jsonb not null, created_at timestamptz not null default now()
);
create table operations_private.hub_rule_events (
 id bigint generated always as identity primary key, action text not null, before_value jsonb,
 after_value jsonb, actor text not null, created_at timestamptz not null default now()
);
alter table operations_private.hub_rules enable row level security;
alter table operations_private.hub_rule_assignments enable row level security;
alter table operations_private.hub_field_references enable row level security;
alter table operations_private.hub_rule_requests enable row level security;
alter table operations_private.hub_rule_events enable row level security;
revoke all on operations_private.hub_rules,operations_private.hub_rule_assignments,operations_private.hub_field_references,operations_private.hub_rule_requests,operations_private.hub_rule_events from public,anon,authenticated;

-- Private validators are used on both assignment and shared definition edits.
create function operations_private.hub_validate_rule_config(p_config jsonb)
returns void language plpgsql set search_path=pg_catalog as $$
declare s jsonb; n numeric; k text;
begin
 if jsonb_typeof(p_config) is distinct from 'object' then raise exception '규칙 설정 객체가 필요합니다.'; end if;
 if jsonb_typeof(p_config->'steps') is distinct from 'array' then raise exception '연산 배열이 필요합니다.'; end if;
 if jsonb_array_length(p_config->'steps')>20 then raise exception '연산은 최대 20개입니다.'; end if;
 for s in select value from jsonb_array_elements(p_config->'steps') loop
  if jsonb_typeof(s) is distinct from 'object' or s->>'op' is null then raise exception '수식 연산 오류'; end if;
  if s->>'op'='round' then
   if jsonb_typeof(s->'unit') is distinct from 'number' or coalesce(s->>'rounding','') not in ('up','down','nearest') then raise exception '끝자리 처리 오류'; end if;
   n:=(s->>'unit')::numeric;
   if n<1 or n<>trunc(n) or n>9007199254740991 then raise exception '끝자리 단위 오류'; end if;
  else
   if s->>'op' not in ('add','subtract','multiply','divide','set') or jsonb_typeof(s->'value') is distinct from 'number' then raise exception '수식 연산 오류'; end if;
   if s->>'op'='divide' and (s->>'value')::numeric=0 then raise exception '0으로 나눌 수 없습니다.'; end if;
  end if;
 end loop;
 if p_config->>'unit' is not null or p_config->>'rounding' is not null then
  n:=coalesce((p_config->>'unit')::numeric,1);
  if n<1 or n<>trunc(n) or n>9007199254740991 or coalesce(p_config->>'rounding','nearest') not in ('up','down','nearest') then raise exception '끝자리 처리 오류'; end if;
 end if;
 foreach k in array array['min','max'] loop
  if nullif(p_config->>k,'') is not null then
   if jsonb_typeof(p_config->k) not in ('string','number') or (p_config->>k)::numeric<0 then raise exception '가격 범위 오류'; end if;
  end if;
 end loop;
 if nullif(p_config->>'min','')::numeric > nullif(p_config->>'max','')::numeric then raise exception '최저값이 최고값보다 큽니다.'; end if;
end $$;

create function operations_private.hub_validate_rule_graph()
returns void language plpgsql set search_path=pg_catalog as $$
begin
 if exists(select 1 from operations_private.hub_rule_assignments a
   join operations_private.hub_rules r on r.id=a.rule_id
   left join operations_private.hub_field_references d on d.child_sku=a.sku and d.rule_id=a.rule_id
   where (r.input_origin='parent' and (d.child_sku is null or d.target_field<>a.target_field or d.scope<>a.scope))
      or (r.input_origin='self' and d.child_sku is not null)) then raise exception '규칙과 상위 참조 항목이 다르거나 참조가 없습니다.'; end if;
 if exists(with recursive assigned_edges as (
   select jsonb_build_array(a.sku,a.target_field,a.scope)::text as target,
     jsonb_build_array(case when r.input_origin='parent' then d.parent_sku else a.sku end,
       case when r.input_origin='parent' then d.source_field else r.source_field end,
       case when (case when r.input_origin='parent' then d.source_field else r.source_field end) like 'platform_%'
         then coalesce(nullif(case when r.input_origin='parent' then d.source_scope else r.source_scope end,''),r.scope) else '' end)::text as source
   from operations_private.hub_rule_assignments a join operations_private.hub_rules r on r.id=a.rule_id
   left join operations_private.hub_field_references d on d.child_sku=a.sku and d.rule_id=a.rule_id
  ), upstream_skus as (
   select distinct a.sku from operations_private.hub_rule_assignments a where a.target_field in ('actual_inbound_cost','basis_sku_price')
  ), edges as (
   select * from assigned_edges
   union all
   select jsonb_build_array(u.sku,'basis_sku_price','')::text,jsonb_build_array(u.sku,'actual_inbound_cost','')::text
   from upstream_skus u where exists(select 1 from operations_private.hub_rule_assignments a where a.sku=u.sku and a.target_field='actual_inbound_cost')
    and not exists(select 1 from operations_private.hub_rule_assignments a where a.sku=u.sku and a.target_field='basis_sku_price')
   union all
   select jsonb_build_array(u.sku,'calculated_base_price','')::text,jsonb_build_array(u.sku,'basis_sku_price','')::text
   from upstream_skus u where not exists(select 1 from operations_private.hub_rule_assignments a where a.sku=u.sku and a.target_field='calculated_base_price')
  ), walk as (
   select target,source,array[target] as path,source=target as cycle from edges
   union all select w.target,e.source,w.path||w.source,e.source=any(w.path||w.source)
   from walk w join edges e on e.target=w.source where not w.cycle and cardinality(w.path)<65
  ) select 1 from walk where cycle or cardinality(path)>=65) then raise exception '필드 참조에 순환 또는 64단계 초과 연결이 있습니다.'; end if;
end $$;
revoke all on function operations_private.hub_validate_rule_config(jsonb) from public,anon,authenticated;
revoke all on function operations_private.hub_validate_rule_graph() from public,anon,authenticated;

create function public.hub_rule_registry_v1(p_session_token text,p_action text,p_rule jsonb default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare actor jsonb; r operations_private.hub_rules%rowtype; old jsonb; step jsonb; rid uuid;
begin
 actor:=operations_private.require_operations_hub_operator_session(p_session_token);
 if p_action='list' then
  return jsonb_build_object(
   'rules',(select coalesce(jsonb_agg(to_jsonb(t) order by name),'[]') from operations_private.hub_rules t),
   'assignments',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from operations_private.hub_rule_assignments t),
   'dependencies',(select coalesce(jsonb_agg(to_jsonb(t)||jsonb_build_object('relation_valid',t.relation_edge_id is null or exists(
     select 1 from public.operations_hub_relation_edges e join public.operations_hub_relation_nodes p on p.node_id=e.parent_node_id join public.operations_hub_relation_nodes c on c.node_id=e.child_node_id
     where e.edge_id=t.relation_edge_id and e.is_active and p.is_active and c.is_active and p.sellpia_sku_code=t.parent_sku and c.sellpia_sku_code=t.child_sku))),'[]') from operations_private.hub_field_references t));
 end if;
 if p_action is distinct from 'save' then raise exception '지원하지 않는 규칙 작업'; end if;
 if jsonb_typeof(p_rule) is distinct from 'object' then raise exception '규칙 객체가 필요합니다.'; end if;
 perform operations_private.hub_validate_rule_config(p_rule->'config');
 perform pg_advisory_xact_lock(hashtextextended('hub-rule-registry',0));
 rid:=nullif(p_rule->>'id','')::uuid;
 if rid is null then
  insert into operations_private.hub_rules(tag_id,name,target_field,scope,input_origin,source_field,source_scope,config,updated_by)
  values(nullif(p_rule->>'tag_id','')::uuid,btrim(p_rule->>'name'),p_rule->>'target_field',coalesce(p_rule->>'scope',''),p_rule->>'input_origin',p_rule->>'source_field',coalesce(p_rule->>'source_scope',''),p_rule->'config',actor->>'username') returning * into r;
 else
  select to_jsonb(t) into old from operations_private.hub_rules t where id=rid for update;
  if old is null or (old->>'version')::int is distinct from (p_rule->>'version')::int then raise exception '다른 화면에서 규칙이 수정되었습니다. 최신 규칙을 불러오세요.'; end if;
  if exists(select 1 from operations_private.hub_rule_assignments where rule_id=rid) and (old->>'target_field' is distinct from p_rule->>'target_field' or old->>'scope' is distinct from coalesce(p_rule->>'scope','') or old->>'input_origin' is distinct from p_rule->>'input_origin') then raise exception '배정된 규칙의 단계·판매처·참조 위치는 새 규칙으로 등록하세요.'; end if;
  update operations_private.hub_rules set name=btrim(p_rule->>'name'),tag_id=nullif(p_rule->>'tag_id','')::uuid,target_field=p_rule->>'target_field',scope=coalesce(p_rule->>'scope',''),input_origin=p_rule->>'input_origin',source_field=p_rule->>'source_field',source_scope=coalesce(p_rule->>'source_scope',''),config=p_rule->'config',version=version+1,updated_at=clock_timestamp(),updated_by=actor->>'username' where id=rid returning * into r;
 end if;
 perform operations_private.hub_validate_rule_graph();
 insert into operations_private.hub_rule_events(action,before_value,after_value,actor) values('rule_save',old,to_jsonb(r),actor->>'username');
 return to_jsonb(r);
end $$;

create function public.hub_rule_assign_v1(p_session_token text,p_action text,p_assignments jsonb,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare actor jsonb; item jsonb; rule operations_private.hub_rules%rowtype; existing operations_private.hub_rule_assignments%rowtype;
 v_sku text; parent text; sourcefield text; sourcescope text; edgeid bigint; pn jsonb; cn jsonb; erec jsonb; saved jsonb; payload jsonb; previous operations_private.hub_rule_requests%rowtype; count_items int:=0; before_rows jsonb;
begin
 actor:=operations_private.require_operations_hub_operator_session(p_session_token);
 if p_request_id is null or p_action is null or p_action not in ('apply','remove') or jsonb_typeof(p_assignments) is distinct from 'array' or jsonb_array_length(p_assignments) not between 1 and 1000 then raise exception '배정은 1~1,000개와 요청 ID가 필요합니다.'; end if;
 payload:=jsonb_build_object('action',p_action,'assignments',p_assignments);
 perform pg_advisory_xact_lock(hashtextextended('hub-rule-registry',0));
 select * into previous from operations_private.hub_rule_requests where request_id=p_request_id;
 if found then if previous.payload<>payload then raise exception '요청 ID가 다른 내용에 재사용됐습니다.'; end if; return previous.result; end if;
 before_rows:='[]';
 for item in select value from jsonb_array_elements(p_assignments) loop
  v_sku:=btrim(item->>'sku');
  if coalesce(length(v_sku),0) not between 1 and 128 then raise exception '유효한 SKU가 필요합니다.'; end if;
  select * into rule from operations_private.hub_rules where id=(item->>'rule_id')::uuid and (is_active or p_action='remove');
  if not found then raise exception '규칙을 찾지 못했습니다.'; end if;
  if not exists(select 1 from public.operations_hub_product_profiles where sellpia_sku_code=v_sku) then raise exception 'SKU % 원본 없음',v_sku; end if;
  select * into existing from operations_private.hub_rule_assignments a where a.sku=v_sku and a.target_field=rule.target_field and a.scope=rule.scope;
  if found then before_rows:=before_rows||jsonb_build_array(to_jsonb(existing)); end if;
  if p_action='remove' then
   delete from operations_private.hub_rule_assignments a where a.sku=v_sku and a.rule_id=rule.id;
   if found then count_items:=count_items+1; end if;continue;
  end if;
  if existing.rule_id is not null and existing.rule_id<>rule.id then raise exception '%의 % 항목에 다른 규칙이 있습니다. 기존 태그를 제거한 뒤 적용하세요.',v_sku,rule.target_field; end if;
  insert into operations_private.hub_rule_assignments(sku,rule_id,target_field,scope,updated_by) values(v_sku,rule.id,rule.target_field,rule.scope,actor->>'username')
  on conflict(sku,target_field,scope) do update set version=operations_private.hub_rule_assignments.version+1,updated_at=clock_timestamp(),updated_by=excluded.updated_by;
  if rule.input_origin='parent' then
   parent:=btrim(item#>>'{reference,parent_sku}');sourcefield:=coalesce(item#>>'{reference,source_field}',rule.source_field);
   if parent is null or parent='' or parent=v_sku then raise exception '서로 다른 상위/하위 SKU가 필요합니다.'; end if;
   sourcescope:=case when sourcefield like 'platform_%' then coalesce(item#>>'{reference,source_scope}',rule.source_scope) else '' end;
   if sourcefield like 'platform_%' and coalesce(nullif(sourcescope,''),rule.scope) not in ('ably','smartstore','makeshop') then raise exception '참조 판매처를 확인하세요.'; end if;
   if exists(select 1 from operations_private.hub_field_references d where d.child_sku=v_sku and d.target_field=rule.target_field and d.scope=rule.scope and d.parent_sku<>parent) then raise exception '같은 단계에 상위 SKU가 여러 개입니다. 기존 배정을 제거한 뒤 적용하세요.'; end if;
   if coalesce(item#>>'{reference,target_field}',rule.target_field)<>rule.target_field then raise exception '규칙과 종속 대상 항목이 다릅니다.'; end if;
   if not exists(select 1 from public.operations_hub_product_profiles where sellpia_sku_code=parent) then raise exception '상위 SKU % 원본 없음',parent; end if;
   edgeid:=nullif(item#>>'{reference,relation_edge_id}','')::bigint;
   if coalesce((item#>>'{reference,create_relation}')::boolean,false) then
    pn:=public.ensure_operations_hub_sellpia_sku_relation_node(parent,null,'individual');
    cn:=public.ensure_operations_hub_sellpia_sku_relation_node(v_sku,null,'individual');
    erec:=public.save_operations_hub_relation_edge((pn->>'nodeId')::bigint,(cn->>'nodeId')::bigint,100);
    select e.edge_id into edgeid from public.operations_hub_relation_edges e where e.parent_node_id=(pn->>'nodeId')::bigint and e.child_node_id=(cn->>'nodeId')::bigint and e.is_active;
   end if;
   if edgeid is not null and not exists(select 1 from public.operations_hub_relation_edges e join public.operations_hub_relation_nodes p on p.node_id=e.parent_node_id join public.operations_hub_relation_nodes c on c.node_id=e.child_node_id where e.edge_id=edgeid and e.is_active and p.is_active and c.is_active and p.sellpia_sku_code=parent and c.sellpia_sku_code=v_sku) then raise exception '선택한 관계가 현재 상위/하위 SKU와 다릅니다.'; end if;
   insert into operations_private.hub_field_references(child_sku,rule_id,parent_sku,source_field,target_field,scope,relation_edge_id,source_scope) values(v_sku,rule.id,parent,sourcefield,rule.target_field,rule.scope,edgeid,sourcescope)
   on conflict(child_sku,target_field,scope) do update set parent_sku=excluded.parent_sku,source_field=excluded.source_field,source_scope=excluded.source_scope,relation_edge_id=excluded.relation_edge_id;
  end if;
  count_items:=count_items+1;
 end loop;
 perform operations_private.hub_validate_rule_graph();
 saved:=jsonb_build_object('count',count_items,'request_id',p_request_id);
 insert into operations_private.hub_rule_requests values(p_request_id,payload,saved,clock_timestamp());
 insert into operations_private.hub_rule_events(action,before_value,after_value,actor) values('assignment_'||p_action,before_rows,payload,actor->>'username');
 return saved;
end $$;

revoke all on function public.hub_rule_registry_v1(text,text,jsonb) from public;
revoke all on function public.hub_rule_assign_v1(text,text,jsonb,uuid) from public;
grant execute on function public.hub_rule_registry_v1(text,text,jsonb) to anon,authenticated;
grant execute on function public.hub_rule_assign_v1(text,text,jsonb,uuid) to anon,authenticated;
notify pgrst,'reload schema';
