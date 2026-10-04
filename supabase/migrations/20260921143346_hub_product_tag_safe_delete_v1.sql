-- Only an unused tag can be retired. Applied tags and Rule-owned tags must be
-- explicitly detached through their existing review workflows first.
create or replace function public.hub_product_tag_safe_delete_v1(
  p_session_token text,
  p_tag_id uuid,
  p_expected_name text
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog
set statement_timeout='15s'
set lock_timeout='5s'
as $$
declare
  actor jsonb;
  tag public.product_tags%rowtype;
begin
  actor:=operations_private.require_operations_hub_operator_session(p_session_token);
  perform pg_advisory_xact_lock(hashtextextended('hub-rule-registry',0));
  select * into tag from public.product_tags
  where tag_id=p_tag_id and is_active for update;
  if not found then raise exception '활성 태그를 찾지 못했습니다.'; end if;
  if tag.tag_name is distinct from p_expected_name then
    raise exception '태그 이름이 변경됐습니다. 다시 조회하세요.';
  end if;
  if exists(select 1 from public.sellpia_tag_assignments a
    where a.tag_id=p_tag_id and a.is_active) then
    raise exception '적용 중인 SKU/상품 태그를 먼저 해제하세요.';
  end if;
  if exists(select 1 from operations_private.hub_rules r
    where r.tag_id=p_tag_id and r.is_active) or exists(
      select 1 from operations_private.hub_rule_assignments a
      where a.assigned_tag_id=p_tag_id) then
    raise exception '연결된 활성 수식/Rule 배정을 먼저 해제하세요.';
  end if;
  update public.product_tags set is_active=false,updated_at=clock_timestamp()
  where tag_id=p_tag_id and is_active;
  insert into operations_private.hub_rule_events(action,before_value,after_value,actor)
  values('product_tag_retire',jsonb_build_object('tag_id',p_tag_id,'tag_name',tag.tag_name),
    jsonb_build_object('is_active',false),actor->>'username');
  return jsonb_build_object('tag_id',p_tag_id,'tag_name',tag.tag_name,'status','retired');
end $$;

revoke all on function public.hub_product_tag_safe_delete_v1(text,uuid,text) from public;
grant execute on function public.hub_product_tag_safe_delete_v1(text,uuid,text) to anon,authenticated;
notify pgrst,'reload schema';
