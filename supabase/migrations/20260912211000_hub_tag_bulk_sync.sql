create or replace function public.hub_tag_bulk_sync_v1(
 p_session_token text,
 p_tag_id uuid,
 p_skus text[] default '{}'::text[],
 p_preview boolean default true
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
 current_codes text[];
 add_codes text[];
 remove_codes text[];
 invalid_codes text[];
 linked_count integer:=0;
 inserted_count integer:=0;
 removed_count integer:=0;
begin
 actor:=operations_private.require_operations_hub_operator_session(p_session_token);
 if p_tag_id is null then raise exception '동기화할 태그가 필요합니다.'; end if;
 if not exists(select 1 from public.product_tags where tag_id=p_tag_id and is_active) then
  raise exception '활성 태그를 찾지 못했습니다.';
 end if;

 codes:=coalesce(array(
  select distinct btrim(code)
  from unnest(coalesce(p_skus,'{}'::text[])) as code
  where btrim(code)<>''
  order by 1
 ),'{}'::text[]);
 if cardinality(codes)>50000 then raise exception '태그 동기화는 최대 50,000 SKU까지 가능합니다.'; end if;

 invalid_codes:=coalesce(array(
  select code from unnest(codes) code
  where not exists(select 1 from public.sellpia_stock_latest s where s.sellpia_sku_code=code)
  order by 1
 ),'{}'::text[]);
 if cardinality(invalid_codes)>0 then
  raise exception '셀피아 원본에 없는 SKU가 있습니다: %',array_to_string(invalid_codes[1:least(10,cardinality(invalid_codes))],', ');
 end if;

 perform pg_advisory_xact_lock(hashtextextended('hub-rule-registry',0));

 current_codes:=coalesce(array(
  select distinct a.sellpia_sku_code
  from public.sellpia_tag_assignments a
  where a.tag_id=p_tag_id and a.tag_scope='option' and a.is_active and a.sellpia_sku_code is not null
  order by 1
 ),'{}'::text[]);

 add_codes:=coalesce(array(
  select code from unnest(codes) code
  except
  select code from unnest(current_codes) code
  order by 1
 ),'{}'::text[]);

 remove_codes:=coalesce(array(
  select code from unnest(current_codes) code
  except
  select code from unnest(codes) code
  order by 1
 ),'{}'::text[]);

 if p_preview then
  return jsonb_build_object(
   'tag_id',p_tag_id,
   'current_count',cardinality(current_codes),
   'target_count',cardinality(codes),
   'add_count',cardinality(add_codes),
   'remove_count',cardinality(remove_codes),
   'unchanged_count',greatest(0,cardinality(codes)-cardinality(add_codes)),
   'preview_add',to_jsonb(add_codes[1:least(50,cardinality(add_codes))]),
   'preview_remove',to_jsonb(remove_codes[1:least(50,cardinality(remove_codes))])
  );
 end if;

 if cardinality(remove_codes)>0 then
  update public.sellpia_tag_assignments
  set is_active=false,
      reviewer=actor->>'username',
      memo='operations hub filename tag sync remove',
      updated_at=now()
  where tag_id=p_tag_id
    and tag_scope='option'
    and is_active
    and sellpia_sku_code=any(remove_codes);
  get diagnostics removed_count=row_count;
 end if;

 if cardinality(add_codes)>0 then
  insert into public.sellpia_tag_assignments(tag_id,tag_scope,sellpia_sku_code,reviewer,memo)
  select p_tag_id,'option',code,actor->>'username','operations hub filename tag sync add'
  from unnest(add_codes) code;
  get diagnostics inserted_count=row_count;
 end if;

 if cardinality(current_codes)>0 or cardinality(codes)>0 then
  linked_count:=operations_private.hub_sync_tag_rules(
   array(select distinct code from unnest(current_codes||codes) code where code<>'' order by 1),
   actor->>'username'
  );
 end if;

 insert into operations_private.hub_rule_events(action,after_value,actor)
 values(
  'tag_filename_sync',
  jsonb_build_object(
   'tag_id',p_tag_id,
   'current_count',cardinality(current_codes),
   'target_count',cardinality(codes),
   'add_count',inserted_count,
   'remove_count',removed_count,
   'rule_assignment_count',linked_count
  ),
  actor->>'username'
 );

 return jsonb_build_object(
  'tag_id',p_tag_id,
  'current_count',cardinality(current_codes),
  'target_count',cardinality(codes),
  'add_count',inserted_count,
  'remove_count',removed_count,
  'unchanged_count',greatest(0,cardinality(codes)-inserted_count),
  'rule_assignment_count',linked_count
 );
end $$;

revoke all on function public.hub_tag_bulk_sync_v1(text,uuid,text[],boolean) from public;
grant execute on function public.hub_tag_bulk_sync_v1(text,uuid,text[],boolean) to anon,authenticated;
notify pgrst,'reload schema';
