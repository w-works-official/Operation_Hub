-- Retire a tag and detach every active connection in one transaction.
-- Historical tag rows and rule definitions remain for audit; current rule
-- assignments are removed so the retired rules cannot continue to own prices.
create function public.hub_product_tag_retire_cascade_v2(
  p_session_token text,
  p_tag_id uuid,
  p_expected_name text,
  p_preview boolean default true,
  p_expected_option_count integer default null,
  p_expected_product_count integer default null,
  p_expected_rule_count integer default null
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog
set statement_timeout='30s'
set lock_timeout='5s'
as $$
declare
  actor jsonb;
  tag public.product_tags%rowtype;
  option_count integer;
  product_count integer;
  legacy_count integer;
  rule_count integer;
  product_rule_count integer;
  rule_assignment_count integer;
  product_assignment_count integer;
  affected text[];
  removed_rule_assignments integer := 0;
  removed_product_assignments integer := 0;
begin
  actor:=operations_private.require_operations_hub_operator_session(p_session_token);
  perform pg_advisory_xact_lock(hashtextextended('hub-rule-registry',0));
  select * into tag from public.product_tags
  where tag_id=p_tag_id and is_active for update;
  if not found then raise exception '활성 태그를 찾지 못했습니다.'; end if;
  if tag.tag_name is distinct from p_expected_name then
    raise exception '태그 이름이 변경됐습니다. 다시 조회하세요.';
  end if;

  select count(*) filter(where tag_scope='option')::integer,
         count(*) filter(where tag_scope='product')::integer
  into option_count,product_count
  from public.sellpia_tag_assignments
  where tag_id=p_tag_id and is_active;
  select count(*)::integer into legacy_count from public.product_tag_assignments
  where tag_id=p_tag_id and is_active;
  select count(*)::integer into rule_count from operations_private.hub_rules
  where tag_id=p_tag_id and is_active;
  select count(*)::integer into product_rule_count
  from operations_private.hub_product_price_rules
  where tag_id=p_tag_id and is_active;
  select count(*)::integer into rule_assignment_count
  from operations_private.hub_rule_assignments a
  where a.assigned_tag_id=p_tag_id
     or exists(select 1 from operations_private.hub_rules r
               where r.id=a.rule_id and r.tag_id=p_tag_id);
  select count(*)::integer into product_assignment_count
  from operations_private.hub_product_price_assignments a
  where exists(select 1 from operations_private.hub_product_price_rules r
               where r.id=a.rule_id and r.tag_id=p_tag_id);

  -- Include product-scoped members and manually assigned tag rules, not just
  -- option-scoped rows shown by the tag manager.
  select coalesce(array_agg(distinct sku order by sku),'{}'::text[]) into affected
  from (
    select a.sellpia_sku_code as sku
    from public.sellpia_tag_assignments a
    where a.tag_id=p_tag_id and a.is_active and a.tag_scope='option'
    union
    select s.sellpia_sku_code
    from public.sellpia_tag_assignments a
    join public.sellpia_stock_latest s on s.sellpia_product_code=a.sellpia_product_code
    where a.tag_id=p_tag_id and a.is_active and a.tag_scope='product'
    union
    select a.sellpia_sku_code from public.product_tag_assignments a
    where a.tag_id=p_tag_id and a.is_active and a.sellpia_sku_code is not null
    union
    select a.sku from operations_private.hub_rule_assignments a
    where a.assigned_tag_id=p_tag_id or exists(
      select 1 from operations_private.hub_rules r where r.id=a.rule_id and r.tag_id=p_tag_id)
    union
    select s.sellpia_sku_code
    from operations_private.hub_product_price_assignments a
    join operations_private.hub_product_price_rules r on r.id=a.rule_id
    join public.sellpia_stock_latest s on s.sellpia_product_code=a.product_code
    where r.tag_id=p_tag_id
  ) members where sku is not null and sku<>'';

  if p_preview then
    return jsonb_build_object('tag_id',p_tag_id,'tag_name',tag.tag_name,
      'option_count',option_count,'product_count',product_count,
      'legacy_count',legacy_count,'rule_count',rule_count,
      'product_rule_count',product_rule_count,
      'rule_assignment_count',rule_assignment_count,
      'product_assignment_count',product_assignment_count,
      'affected_sku_count',cardinality(affected),'preview',true);
  end if;
  if p_expected_option_count is distinct from option_count
     or p_expected_product_count is distinct from product_count
     or p_expected_rule_count is distinct from rule_count+product_rule_count then
    raise exception '태그 연결 상태가 미리보기 이후 변경됐습니다. 다시 확인하세요.';
  end if;

  update public.sellpia_tag_assignments
  set is_active=false,reviewer=actor->>'username',updated_at=clock_timestamp()
  where tag_id=p_tag_id and is_active;
  update public.product_tag_assignments
  set is_active=false,reviewer=actor->>'username',updated_at=clock_timestamp()
  where tag_id=p_tag_id and is_active;
  delete from operations_private.hub_rule_assignments a
  where a.assigned_tag_id=p_tag_id or exists(
    select 1 from operations_private.hub_rules r where r.id=a.rule_id and r.tag_id=p_tag_id);
  get diagnostics removed_rule_assignments=row_count;
  delete from operations_private.hub_product_price_assignments a
  where exists(select 1 from operations_private.hub_product_price_rules r
               where r.id=a.rule_id and r.tag_id=p_tag_id);
  get diagnostics removed_product_assignments=row_count;
  update operations_private.hub_rules
  set is_active=false,version=version+1,updated_at=clock_timestamp(),updated_by=actor->>'username'
  where tag_id=p_tag_id and is_active;
  update operations_private.hub_product_price_rules
  set is_active=false,version=version+1,updated_at=clock_timestamp(),updated_by=actor->>'username'
  where tag_id=p_tag_id and is_active;
  update public.product_tags set is_active=false,updated_at=clock_timestamp()
  where tag_id=p_tag_id and is_active;
  insert into operations_private.hub_rule_events(action,before_value,after_value,actor)
  values('product_tag_retire_cascade',
    jsonb_build_object('tag_id',p_tag_id,'tag_name',tag.tag_name,
      'option_count',option_count,'product_count',product_count,
      'legacy_count',legacy_count,'rule_count',rule_count,
      'product_rule_count',product_rule_count),
    jsonb_build_object('is_active',false,'rule_assignments_removed',removed_rule_assignments,
      'product_assignments_removed',removed_product_assignments,
      'affected_sku_count',cardinality(affected)),actor->>'username');
  return jsonb_build_object('tag_id',p_tag_id,'tag_name',tag.tag_name,
    'status','retired','preview',false,'affected_skus',to_jsonb(affected),
    'affected_sku_count',cardinality(affected),'option_count',option_count,
    'product_count',product_count,'legacy_count',legacy_count,
    'rule_count',rule_count,'product_rule_count',product_rule_count,
    'rule_assignments_removed',removed_rule_assignments,
    'product_assignments_removed',removed_product_assignments);
end $$;

revoke all on function public.hub_product_tag_retire_cascade_v2(text,uuid,text,boolean,integer,integer,integer) from public;
grant execute on function public.hub_product_tag_retire_cascade_v2(text,uuid,text,boolean,integer,integer,integer) to anon,authenticated;
notify pgrst,'reload schema';
