-- Tag definitions own shared rules; SKU rows retain links, never copied formulas.
alter table operations_private.hub_rule_assignments add column assigned_tag_id uuid references public.product_tags(tag_id);

create function operations_private.hub_sync_tag_rules(p_skus text[],p_actor text)
returns integer language plpgsql set search_path=pg_catalog as $$
declare collision text; changed integer;
begin
 perform pg_advisory_xact_lock(hashtextextended('hub-rule-registry',0));
 if exists(select 1 from pg_class where oid=to_regclass('pg_temp.hub_desired_tag_rules') and relowner<>current_user::regrole) then raise exception '임시 계산 테이블 소유권 오류';end if;
 create temporary table if not exists hub_desired_tag_rules(sku text,rule_id uuid,target_field text,scope text,tag_id uuid,input_origin text) on commit drop;
 create index if not exists hub_desired_tag_rules_lookup on pg_temp.hub_desired_tag_rules(sku,target_field,scope,rule_id);
 truncate pg_temp.hub_desired_tag_rules;
 insert into pg_temp.hub_desired_tag_rules
 select distinct p.sellpia_sku_code,r.id,r.target_field,r.scope,r.tag_id,r.input_origin
 from public.operations_hub_product_profiles p
 join public.sellpia_tag_assignments a on a.is_active and ((a.tag_scope='option' and a.sellpia_sku_code=p.sellpia_sku_code) or (a.tag_scope='product' and a.sellpia_product_code=p.sellpia_product_code))
 join operations_private.hub_rules r on r.tag_id=a.tag_id and r.is_active
 where p.sellpia_sku_code in(select unnest(p_skus));
 select sku into collision from pg_temp.hub_desired_tag_rules group by sku,target_field,scope having count(distinct rule_id)>1 limit 1;
 if collision is not null then raise exception '%: 같은 단계에 서로 다른 태그 수식이 겹칩니다. 기존 태그를 제거한 뒤 적용하세요.',collision;end if;
 select d.sku into collision from pg_temp.hub_desired_tag_rules d join operations_private.hub_rule_assignments a using(sku,target_field,scope)
 where a.rule_id<>d.rule_id and (a.assigned_tag_id is null or exists(select 1 from pg_temp.hub_desired_tag_rules keep where keep.sku=a.sku and keep.rule_id=a.rule_id)) limit 1;
 if collision is not null then raise exception '%: 같은 단계의 기존 Rule과 충돌합니다. 기존 Rule을 제거한 뒤 적용하세요.',collision;end if;
 select d.sku into collision from pg_temp.hub_desired_tag_rules d where d.input_origin='parent' and not exists(select 1 from operations_private.hub_field_references f where f.child_sku=d.sku and f.rule_id=d.rule_id) limit 1;
 if collision is not null then raise exception '%: 상위 SKU를 참조하는 수식은 종속관계를 먼저 연결하세요.',collision;end if;
 delete from operations_private.hub_rule_assignments a where a.sku in(select unnest(p_skus)) and a.assigned_tag_id is not null and not exists(select 1 from pg_temp.hub_desired_tag_rules d where d.sku=a.sku and d.rule_id=a.rule_id);
 insert into operations_private.hub_rule_assignments(sku,rule_id,target_field,scope,assigned_tag_id,updated_by)
 select sku,rule_id,target_field,scope,tag_id,p_actor from pg_temp.hub_desired_tag_rules
 on conflict(sku,target_field,scope) do nothing;
 get diagnostics changed=row_count;
 perform operations_private.hub_validate_rule_graph();
 -- The matrix's tag filter reads this compact profile cache.
 update operations_private.operations_hub_matrix_export_cache c set profile_json=to_jsonb(p)
 from public.operations_hub_product_profiles p where p.sellpia_sku_code=c.sellpia_sku_code and c.sellpia_sku_code in(select unnest(p_skus));
 return changed;
end $$;
revoke all on function operations_private.hub_sync_tag_rules(text[],text) from public,anon,authenticated;

create function public.hub_tag_assign_v1(p_session_token text,p_tag_id uuid,p_skus text[],p_action text default 'add')
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare actor jsonb; codes text[]; missing text; linked integer;
begin
 actor:=operations_private.require_operations_hub_operator_session(p_session_token);
 if p_action is null or p_action not in ('add','remove') then raise exception '태그 작업 오류';end if;
 select array_agg(distinct btrim(s)) into codes from unnest(p_skus)s where nullif(btrim(s),'') is not null;
 if coalesce(cardinality(codes),0) not between 1 and 50000 then raise exception '대상 SKU는 1~50,000개여야 합니다.';end if;
 perform pg_advisory_xact_lock(hashtextextended('hub-rule-registry',0));
 if not exists(select 1 from public.product_tags where tag_id=p_tag_id and is_active) then raise exception '태그를 찾지 못했습니다.';end if;
 select s into missing from unnest(codes)s where not exists(select 1 from public.operations_hub_product_profiles p where p.sellpia_sku_code=s) limit 1;
 if missing is not null then raise exception 'SKU % 원본 없음',missing;end if;
 if p_action='add' then
  insert into public.sellpia_tag_assignments(tag_id,tag_scope,sellpia_sku_code,reviewer,memo)
  select p_tag_id,'option',s,actor->>'username','operations hub filtered SKU tag' from unnest(codes)s
  where not exists(select 1 from public.sellpia_tag_assignments a where a.tag_id=p_tag_id and a.tag_scope='option' and a.sellpia_sku_code=s and a.is_active);
 else
  update public.sellpia_tag_assignments set is_active=false,updated_at=clock_timestamp(),reviewer=actor->>'username'
  where tag_id=p_tag_id and tag_scope='option' and sellpia_sku_code in(select unnest(codes)) and is_active;
 end if;
 linked:=operations_private.hub_sync_tag_rules(codes,actor->>'username');
 insert into operations_private.hub_rule_events(action,after_value,actor) values('tag_'||p_action,jsonb_build_object('tag_id',p_tag_id,'skus',codes),actor->>'username');
 return jsonb_build_object('sku_count',cardinality(codes),'rule_assignment_count',linked,'tag_id',p_tag_id);
end $$;
revoke all on function public.hub_tag_assign_v1(text,uuid,text[],text) from public;
grant execute on function public.hub_tag_assign_v1(text,uuid,text[],text) to anon,authenticated;

create function public.hub_tag_rule_save_v1(p_session_token text,p_tag jsonb,p_rule jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare actor jsonb; t public.product_tags%rowtype; rules jsonb; codes text[]; tagid uuid; oldtag uuid;
begin
 actor:=operations_private.require_operations_hub_operator_session(p_session_token);
 perform pg_advisory_xact_lock(hashtextextended('hub-rule-registry',0));
 if jsonb_typeof(p_tag) is distinct from 'object' or coalesce(length(btrim(p_tag->>'name')),0) not between 1 and 200 then raise exception '태그 이름을 입력하세요.';end if;
 tagid:=nullif(p_tag->>'id','')::uuid;
 if tagid is null then
  insert into public.product_tags(tag_name,tag_color,tag_group,created_by) values(btrim(p_tag->>'name'),coalesce(p_tag->>'color','#dbeafe'),coalesce(p_tag->>'group','운영'),actor->>'username') returning * into t;
 else
  update public.product_tags set tag_name=btrim(p_tag->>'name'),tag_color=coalesce(p_tag->>'color',tag_color),updated_at=clock_timestamp() where tag_id=tagid and is_active returning * into t;
  if not found then raise exception '태그를 찾지 못했습니다.';end if;
 end if;
 if nullif(p_rule->>'id','') is not null then
  select tag_id into oldtag from operations_private.hub_rules where id=(p_rule->>'id')::uuid;
  if oldtag is distinct from t.tag_id then raise exception '다른 태그의 수식을 변경할 수 없습니다.';end if;
 end if;
 p_rule:=p_rule||jsonb_build_object('tag_id',t.tag_id);
 if p_rule->>'target_field' like 'platform_%' and coalesce(p_rule->>'scope','')='' then
  rules:=public.hub_platform_rule_group_save_v1(p_session_token,p_rule);
 else
  rules:=jsonb_build_array(public.hub_rule_registry_v1(p_session_token,'save',p_rule));
 end if;
 select array_agg(distinct p.sellpia_sku_code) into codes from public.operations_hub_product_profiles p
 join public.sellpia_tag_assignments a on a.tag_id=t.tag_id and a.is_active and ((a.tag_scope='option' and a.sellpia_sku_code=p.sellpia_sku_code) or (a.tag_scope='product' and a.sellpia_product_code=p.sellpia_product_code));
 if cardinality(codes)>0 then perform operations_private.hub_sync_tag_rules(codes,actor->>'username');end if;
 return jsonb_build_object('tag',to_jsonb(t),'rules',rules);
end $$;
revoke all on function public.hub_tag_rule_save_v1(text,jsonb,jsonb) from public;
grant execute on function public.hub_tag_rule_save_v1(text,jsonb,jsonb) to anon,authenticated;

create function public.hub_profile_save_with_rules_v1(p_session_token text,p_sku text,p_material text,p_product_group text,p_shape text,p_product_tag_ids uuid[],p_sku_tag_ids uuid[])
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare actor jsonb; result jsonb; codes text[];
begin
 actor:=operations_private.require_operations_hub_operator_session(p_session_token);
 perform pg_advisory_xact_lock(hashtextextended('hub-rule-registry',0));
 result:=public.save_operations_hub_product_profile(p_sku,p_material,p_product_group,p_shape,p_product_tag_ids,p_sku_tag_ids,actor->>'username');
 select array_agg(p.sellpia_sku_code) into codes from public.operations_hub_product_profiles p where p.sellpia_product_code=result->>'sellpia_product_code';
 perform operations_private.hub_sync_tag_rules(coalesce(codes,array[p_sku]),actor->>'username');
 return result;
end $$;
revoke all on function public.hub_profile_save_with_rules_v1(text,text,text,text,text,uuid[],uuid[]) from public;
grant execute on function public.hub_profile_save_with_rules_v1(text,text,text,text,text,uuid[],uuid[]) to anon,authenticated;
notify pgrst,'reload schema';
