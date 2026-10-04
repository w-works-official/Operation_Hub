alter table operations_private.hub_rule_assignments
  drop constraint hub_rule_assignments_rule_id_target_field_scope_fkey;

alter table operations_private.hub_rule_assignments
  add constraint hub_rule_assignments_rule_id_target_field_scope_fkey
  foreign key(rule_id,target_field,scope)
  references operations_private.hub_rules(id,target_field,scope)
  on update cascade;

create or replace function public.hub_rule_registry_v1(p_session_token text,p_action text,p_rule jsonb default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare
 actor jsonb;
 r operations_private.hub_rules%rowtype;
 old jsonb;
 rid uuid;
 assigned_count integer:=0;
 conflict_sku text;
 new_target text;
 new_scope text;
 new_origin text;
 location_changed boolean:=false;
begin
 actor:=operations_private.require_operations_hub_operator_session(p_session_token);
 if p_action='list' then
  return jsonb_build_object(
   'rules',(select coalesce(jsonb_agg(to_jsonb(t) order by name),'[]') from operations_private.hub_rules t),
   'assignments',(select coalesce(jsonb_agg(to_jsonb(t)),'[]') from operations_private.hub_rule_assignments t),
   'dependencies',(select coalesce(jsonb_agg(to_jsonb(t)||jsonb_build_object('relation_valid',t.relation_edge_id is null or exists(
     select 1 from public.operations_hub_relation_edges e
     join public.operations_hub_relation_nodes p on p.node_id=e.parent_node_id
     join public.operations_hub_relation_nodes c on c.node_id=e.child_node_id
     where e.edge_id=t.relation_edge_id and e.is_active and p.is_active and c.is_active
       and p.sellpia_sku_code=t.parent_sku and c.sellpia_sku_code=t.child_sku))),'[]')
    from operations_private.hub_field_references t));
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
  new_target:=p_rule->>'target_field';
  new_scope:=coalesce(p_rule->>'scope','');
  new_origin:=p_rule->>'input_origin';
  location_changed:=(old->>'target_field' is distinct from new_target or old->>'scope' is distinct from new_scope);
  select count(*) into assigned_count from operations_private.hub_rule_assignments where rule_id=rid;
  if assigned_count>0 and old->>'input_origin'='self' and new_origin='parent' then
   raise exception '적용 중인 규칙을 상위 SKU 참조로 바꾸려면 먼저 Assignment를 제거하고 종속관계를 설정하세요.';
  end if;
  if assigned_count>0 and location_changed then
   select other_assignment.sku into conflict_sku
   from operations_private.hub_rule_assignments current_assignment
   join operations_private.hub_rule_assignments other_assignment
     on other_assignment.sku=current_assignment.sku
    and other_assignment.target_field=new_target
    and other_assignment.scope=new_scope
    and other_assignment.rule_id<>rid
   where current_assignment.rule_id=rid
   limit 1;
   if conflict_sku is not null then
    raise exception '적용점 변경 충돌: SKU %의 % 위치에 다른 Rule이 있습니다. 전체 저장을 취소했습니다.',conflict_sku,new_target;
   end if;
  end if;
  if assigned_count>0 and old->>'input_origin'='parent' and new_origin='self' then
   delete from operations_private.hub_field_references where rule_id=rid;
  end if;
  update operations_private.hub_rules set
   name=btrim(p_rule->>'name'),
   tag_id=nullif(p_rule->>'tag_id','')::uuid,
   target_field=new_target,
   scope=new_scope,
   input_origin=new_origin,
   source_field=p_rule->>'source_field',
   source_scope=coalesce(p_rule->>'source_scope',''),
   config=p_rule->'config',
   version=version+1,
   updated_at=clock_timestamp(),
   updated_by=actor->>'username'
  where id=rid returning * into r;
  if assigned_count>0 and location_changed then
   update operations_private.hub_field_references
   set target_field=new_target,scope=new_scope
   where rule_id=rid;
  end if;
  if assigned_count>0 and (location_changed or old->>'input_origin' is distinct from new_origin) then
   update operations_private.hub_rule_assignments
   set version=version+1,updated_at=clock_timestamp(),updated_by=actor->>'username'
   where rule_id=rid;
  end if;
 end if;
 perform operations_private.hub_validate_rule_graph();
 insert into operations_private.hub_rule_events(action,before_value,after_value,actor)
 values('rule_save',old,to_jsonb(r),actor->>'username');
 return to_jsonb(r);
end $$;

revoke all on function public.hub_rule_registry_v1(text,text,jsonb) from public;
grant execute on function public.hub_rule_registry_v1(text,text,jsonb) to anon,authenticated;
notify pgrst,'reload schema';