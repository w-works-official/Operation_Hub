create or replace function operations_private.hub_sync_tag_rules(p_skus text[],p_actor text)
returns integer language plpgsql set search_path=pg_catalog as $$
declare collision text; changed integer; removed integer;
begin
 perform pg_advisory_xact_lock(hashtextextended('hub-rule-registry',0));
 if exists(select 1 from pg_class where oid=to_regclass('pg_temp.hub_desired_tag_rules') and relowner<>current_user::regrole) then raise exception '임시 계산 테이블 소유권 오류';end if;
 create temporary table if not exists hub_desired_tag_rules(sku text,rule_id uuid,target_field text,scope text,tag_id uuid,input_origin text) on commit drop;
 create index if not exists hub_desired_tag_rules_lookup on pg_temp.hub_desired_tag_rules(sku,target_field,scope,rule_id);
 truncate pg_temp.hub_desired_tag_rules;
 insert into pg_temp.hub_desired_tag_rules
 select distinct a.sellpia_sku_code,r.id,r.target_field,r.scope,r.tag_id,r.input_origin
 from public.sellpia_tag_assignments a join operations_private.hub_rules r on r.tag_id=a.tag_id and r.is_active
 where a.is_active and a.tag_scope='option' and a.sellpia_sku_code in(select unnest(p_skus))
 union
 select distinct p.sellpia_sku_code,r.id,r.target_field,r.scope,r.tag_id,r.input_origin
 from public.sellpia_stock_latest p
 join public.sellpia_tag_assignments a on a.is_active and a.tag_scope='product' and a.sellpia_product_code=p.sellpia_product_code
 join operations_private.hub_rules r on r.tag_id=a.tag_id and r.is_active
 where p.sellpia_sku_code in(select unnest(p_skus));
 analyze pg_temp.hub_desired_tag_rules;
 select sku into collision from pg_temp.hub_desired_tag_rules group by sku,target_field,scope having count(distinct rule_id)>1 limit 1;
 if collision is not null then raise exception '%: 같은 단계에 서로 다른 태그 수식이 겹칩니다. 기존 태그를 제거한 뒤 적용하세요.',collision;end if;
 select d.sku into collision from pg_temp.hub_desired_tag_rules d join operations_private.hub_rule_assignments a using(sku,target_field,scope)
 where a.rule_id<>d.rule_id and (a.assigned_tag_id is null or exists(select 1 from pg_temp.hub_desired_tag_rules keep where keep.sku=a.sku and keep.rule_id=a.rule_id)) limit 1;
 if collision is not null then raise exception '%: 같은 단계의 기존 Rule과 충돌합니다. 기존 Rule을 제거한 뒤 적용하세요.',collision;end if;
 select d.sku into collision from pg_temp.hub_desired_tag_rules d where d.input_origin='parent' and not exists(select 1 from operations_private.hub_field_references f where f.child_sku=d.sku and f.rule_id=d.rule_id) limit 1;
 if collision is not null then raise exception '%: 상위 SKU를 참조하는 수식은 종속관계를 먼저 연결하세요.',collision;end if;
 delete from operations_private.hub_rule_assignments a where a.sku in(select unnest(p_skus)) and a.assigned_tag_id is not null and not exists(select 1 from pg_temp.hub_desired_tag_rules d where d.sku=a.sku and d.rule_id=a.rule_id);
 get diagnostics removed=row_count;
 insert into operations_private.hub_rule_assignments(sku,rule_id,target_field,scope,assigned_tag_id,updated_by)
 select d.sku,d.rule_id,d.target_field,d.scope,d.tag_id,p_actor from pg_temp.hub_desired_tag_rules d
 where not exists(select 1 from operations_private.hub_rule_assignments a where a.sku=d.sku and a.target_field=d.target_field and a.scope=d.scope)
 on conflict(sku,target_field,scope) do nothing;
 get diagnostics changed=row_count;
 if changed+removed>0 then perform operations_private.hub_validate_rule_graph();end if;
 return changed;
end $$;
revoke all on function operations_private.hub_sync_tag_rules(text[],text) from public,anon,authenticated;


create or replace function public.hub_tag_assign_v1(p_session_token text,p_tag_id uuid,p_skus text[],p_action text default 'add')
returns jsonb language plpgsql security definer set search_path=pg_catalog set statement_timeout='30s' set lock_timeout='5s' as $$
declare actor jsonb; codes text[]; missing text; linked integer;
begin
 actor:=operations_private.require_operations_hub_operator_session(p_session_token);
 if p_action is null or p_action not in ('add','remove') then raise exception '태그 작업 오류';end if;
 select array_agg(distinct btrim(s)) into codes from unnest(p_skus)s where nullif(btrim(s),'') is not null;
 if coalesce(cardinality(codes),0) not between 1 and 50000 then raise exception '대상 SKU는 1~50,000개여야 합니다.';end if;
 perform pg_advisory_xact_lock(hashtextextended('hub-rule-registry',0));
 if not exists(select 1 from public.product_tags where tag_id=p_tag_id and is_active) then raise exception '태그를 찾지 못했습니다.';end if;
 with catalog_skus as materialized(select sellpia_sku_code from public.sellpia_stock_latest)
 select s into missing from unnest(codes)s where not exists(select 1 from catalog_skus p where p.sellpia_sku_code=s) limit 1;
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


notify pgrst,'reload schema';
