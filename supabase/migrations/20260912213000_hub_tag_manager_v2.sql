create or replace function public.hub_tag_catalog_v1(
 p_session_token text,
 p_search text default ''
)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog
set statement_timeout='30s'
as $$
declare
 actor jsonb;
 result jsonb;
begin
 actor:=operations_private.require_operations_hub_operator_session(p_session_token);

 select coalesce(jsonb_agg(to_jsonb(row_data) order by lower(row_data.tag_name),row_data.tag_name),'[]'::jsonb)
 into result
 from (
  select
   t.tag_id,
   t.tag_name,
   t.tag_color,
   t.tag_group,
   count(a.assignment_id) filter(where a.is_active and a.tag_scope='option')::integer as option_count,
   count(a.assignment_id) filter(where a.is_active and a.tag_scope='product')::integer as product_count,
   (
    select count(*)::integer
    from operations_private.hub_rules r
    where r.is_active and r.tag_id=t.tag_id
   ) as rule_count
  from public.product_tags t
  left join public.sellpia_tag_assignments a on a.tag_id=t.tag_id
  where t.is_active
    and (btrim(coalesce(p_search,''))='' or t.tag_name ilike '%'||btrim(p_search)||'%')
  group by t.tag_id,t.tag_name,t.tag_color,t.tag_group
 ) row_data;

 return jsonb_build_object('rows',result);
end $$;

create or replace function public.hub_tag_members_v1(
 p_session_token text,
 p_tag_id uuid,
 p_search text default '',
 p_page integer default 1,
 p_page_size integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog
set statement_timeout='30s'
as $$
declare
 actor jsonb;
 safe_page integer:=greatest(1,coalesce(p_page,1));
 safe_page_size integer:=least(1000,greatest(1,coalesce(p_page_size,100)));
 total_count integer;
 result jsonb;
begin
 actor:=operations_private.require_operations_hub_operator_session(p_session_token);
 if not exists(select 1 from public.product_tags where tag_id=p_tag_id and is_active) then
  raise exception '활성 태그를 찾지 못했습니다.';
 end if;

 select count(*)::integer
 into total_count
 from public.sellpia_tag_assignments a
 join public.sellpia_stock_latest s on s.sellpia_sku_code=a.sellpia_sku_code
 where a.tag_id=p_tag_id
   and a.tag_scope='option'
   and a.is_active
   and (
    btrim(coalesce(p_search,''))=''
    or s.sellpia_sku_code ilike '%'||btrim(p_search)||'%'
    or coalesce(s.own_sku,'') ilike '%'||btrim(p_search)||'%'
    or coalesce(s.sellpia_product_name,'') ilike '%'||btrim(p_search)||'%'
    or coalesce(s.sellpia_option_name,'') ilike '%'||btrim(p_search)||'%'
   );

 select coalesce(jsonb_agg(to_jsonb(member) order by member.sellpia_sku_code),'[]'::jsonb)
 into result
 from (
  select
   a.assignment_id,
   a.sellpia_sku_code,
   s.sellpia_product_code,
   s.sellpia_product_name,
   s.sellpia_option_name,
   s.own_sku,
   a.memo,
   a.updated_at
  from public.sellpia_tag_assignments a
  join public.sellpia_stock_latest s on s.sellpia_sku_code=a.sellpia_sku_code
  where a.tag_id=p_tag_id
    and a.tag_scope='option'
    and a.is_active
    and (
     btrim(coalesce(p_search,''))=''
     or s.sellpia_sku_code ilike '%'||btrim(p_search)||'%'
     or coalesce(s.own_sku,'') ilike '%'||btrim(p_search)||'%'
     or coalesce(s.sellpia_product_name,'') ilike '%'||btrim(p_search)||'%'
     or coalesce(s.sellpia_option_name,'') ilike '%'||btrim(p_search)||'%'
    )
  order by s.sellpia_sku_code
  offset (safe_page-1)*safe_page_size
  limit safe_page_size
 ) member;

 return jsonb_build_object(
  'tag_id',p_tag_id,
  'page',safe_page,
  'page_size',safe_page_size,
  'count',total_count,
  'rows',result
 );
end $$;

create or replace function public.hub_tag_members_remove_v1(
 p_session_token text,
 p_tag_id uuid,
 p_skus text[]
)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog
set statement_timeout='60s'
set lock_timeout='5s'
as $$
declare
 actor jsonb;
 codes text[];
 removed_count integer:=0;
 linked_count integer:=0;
begin
 actor:=operations_private.require_operations_hub_operator_session(p_session_token);
 if not exists(select 1 from public.product_tags where tag_id=p_tag_id and is_active) then
  raise exception '활성 태그를 찾지 못했습니다.';
 end if;

 codes:=coalesce(array(
  select distinct btrim(code)
  from unnest(coalesce(p_skus,'{}'::text[])) code
  where btrim(code)<>''
  order by 1
 ),'{}'::text[]);

 if cardinality(codes)=0 then raise exception '해제할 SKU가 없습니다.'; end if;
 if cardinality(codes)>5000 then raise exception '선택 해제는 한 번에 최대 5,000 SKU까지 가능합니다.'; end if;

 perform pg_advisory_xact_lock(hashtextextended('hub-rule-registry',0));

 update public.sellpia_tag_assignments
 set is_active=false,
     reviewer=actor->>'username',
     memo='operations hub tag manager remove',
     updated_at=now()
 where tag_id=p_tag_id
   and tag_scope='option'
   and is_active
   and sellpia_sku_code=any(codes);
 get diagnostics removed_count=row_count;

 if removed_count>0 then
  linked_count:=operations_private.hub_sync_tag_rules(codes,actor->>'username');
 end if;

 insert into operations_private.hub_rule_events(action,after_value,actor)
 values(
  'tag_manager_remove',
  jsonb_build_object(
   'tag_id',p_tag_id,
   'requested_count',cardinality(codes),
   'removed_count',removed_count,
   'rule_assignment_count',linked_count
  ),
  actor->>'username'
 );

 return jsonb_build_object(
  'tag_id',p_tag_id,
  'requested_count',cardinality(codes),
  'removed_count',removed_count,
  'rule_assignment_count',linked_count
 );
end $$;

revoke all on function public.hub_tag_catalog_v1(text,text) from public;
revoke all on function public.hub_tag_members_v1(text,uuid,text,integer,integer) from public;
revoke all on function public.hub_tag_members_remove_v1(text,uuid,text[]) from public;

grant execute on function public.hub_tag_catalog_v1(text,text) to anon,authenticated;
grant execute on function public.hub_tag_members_v1(text,uuid,text,integer,integer) to anon,authenticated;
grant execute on function public.hub_tag_members_remove_v1(text,uuid,text[]) to anon,authenticated;

notify pgrst,'reload schema';
