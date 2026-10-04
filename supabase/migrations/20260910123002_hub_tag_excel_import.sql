create function public.hub_tag_bulk_import_v1(
 p_session_token text,
 p_rows jsonb,
 p_tag_id uuid default null,
 p_preview boolean default true
)
returns jsonb language plpgsql security definer set search_path=pg_catalog set statement_timeout='60s' set lock_timeout='5s' as $$
declare
 actor jsonb;
 total_rows integer;
 error_count integer;
 duplicate_count integer;
 inserted_count integer:=0;
 linked_count integer:=0;
 first_error record;
 codes text[];
 preview_rows jsonb;
begin
 actor:=operations_private.require_operations_hub_operator_session(p_session_token);
 if jsonb_typeof(p_rows) is distinct from 'array' then raise exception '엑셀 행 배열이 필요합니다.';end if;
 total_rows:=jsonb_array_length(p_rows);
 if total_rows not between 1 and 50000 then raise exception '엑셀 일괄등록은 1~50,000행까지 가능합니다.';end if;
 perform pg_advisory_xact_lock(hashtextextended('hub-rule-registry',0));
 create temporary table if not exists hub_tag_import_rows(
  row_no integer not null,
  sku text not null,
  requested_tag_name text not null,
  tag_id uuid,
  tag_name text,
  error text,
  is_duplicate boolean not null default false
 ) on commit drop;
 truncate pg_temp.hub_tag_import_rows;
 insert into pg_temp.hub_tag_import_rows(row_no,sku,requested_tag_name)
 select ordinality::integer,btrim(coalesce(value->>'sku','')),btrim(coalesce(value->>'tag_name',''))
 from jsonb_array_elements(p_rows) with ordinality;

 update pg_temp.hub_tag_import_rows set error='셀피아 SKU가 비어 있습니다.' where sku='';
 if p_tag_id is not null then
  update pg_temp.hub_tag_import_rows i set tag_id=t.tag_id,tag_name=t.tag_name
  from public.product_tags t where t.tag_id=p_tag_id and t.is_active;
  if not exists(select 1 from public.product_tags where tag_id=p_tag_id and is_active) then
   update pg_temp.hub_tag_import_rows set error=concat_ws(' ',error,'선택한 태그를 찾지 못했습니다.');
  end if;
 else
  update pg_temp.hub_tag_import_rows i set tag_id=matched.tag_id,tag_name=matched.tag_name
  from (
   select lower(btrim(tag_name)) normalized_name,(array_agg(tag_id order by tag_id))[1] tag_id,(array_agg(tag_name order by tag_id))[1] tag_name
   from public.product_tags where is_active group by lower(btrim(tag_name)) having count(*)=1
  ) matched
  where lower(i.requested_tag_name)=matched.normalized_name;
  update pg_temp.hub_tag_import_rows i set error=concat_ws(' ',i.error,
   case when i.requested_tag_name='' then '태그명이 비어 있습니다.'
        when (select count(*) from public.product_tags t where t.is_active and lower(btrim(t.tag_name))=lower(i.requested_tag_name))>1 then '같은 이름의 활성 태그가 여러 개입니다.'
        else '태그명을 찾지 못했습니다.' end)
  where i.tag_id is null;
 end if;

 update pg_temp.hub_tag_import_rows i set error=concat_ws(' ',i.error,'셀피아 원본에 없는 SKU입니다.')
 where i.sku<>'' and not exists(select 1 from public.sellpia_stock_latest s where s.sellpia_sku_code=i.sku);
 update pg_temp.hub_tag_import_rows i set is_duplicate=true
 where i.error is null and exists(
  select 1 from pg_temp.hub_tag_import_rows earlier
  where earlier.row_no<i.row_no and earlier.error is null and earlier.sku=i.sku and earlier.tag_id=i.tag_id
 );
 select count(*) into error_count from pg_temp.hub_tag_import_rows where error is not null;
 select count(*) into duplicate_count from pg_temp.hub_tag_import_rows where is_duplicate;
 select coalesce(jsonb_agg(to_jsonb(sample) order by sample.row_no),'[]') into preview_rows
 from (select row_no,sku,coalesce(tag_name,requested_tag_name) tag_name,error,is_duplicate from pg_temp.hub_tag_import_rows order by row_no limit 200) sample;

 if p_preview then
  return jsonb_build_object(
   'mode',case when p_tag_id is null then 'per_row' else 'single_tag' end,
   'row_count',total_rows,'valid_count',total_rows-error_count-duplicate_count,
   'error_count',error_count,'duplicate_count',duplicate_count,
   'sku_count',(select count(distinct sku) from pg_temp.hub_tag_import_rows where error is null),
   'tag_count',(select count(distinct tag_id) from pg_temp.hub_tag_import_rows where error is null),
   'preview_rows',preview_rows
  );
 end if;
 if error_count>0 then
  select row_no,error into first_error from pg_temp.hub_tag_import_rows where error is not null order by row_no limit 1;
  raise exception '%행: % 전체 저장을 취소했습니다.',first_error.row_no,first_error.error;
 end if;

 insert into public.sellpia_tag_assignments(tag_id,tag_scope,sellpia_sku_code,reviewer,memo)
 select distinct i.tag_id,'option',i.sku,actor->>'username','operations hub excel tag import'
 from pg_temp.hub_tag_import_rows i
 where not i.is_duplicate and not exists(
  select 1 from public.sellpia_tag_assignments a
  where a.tag_id=i.tag_id and a.tag_scope='option' and a.sellpia_sku_code=i.sku and a.is_active
 );
 get diagnostics inserted_count=row_count;
 select array_agg(distinct sku) into codes from pg_temp.hub_tag_import_rows where error is null;
 linked_count:=operations_private.hub_sync_tag_rules(codes,actor->>'username');
 insert into operations_private.hub_rule_events(action,after_value,actor)
 values('tag_excel_import',jsonb_build_object('row_count',total_rows,'sku_count',cardinality(codes),'tag_count',(select count(distinct tag_id) from pg_temp.hub_tag_import_rows),'inserted_tag_count',inserted_count,'rule_assignment_count',linked_count),actor->>'username');
 return jsonb_build_object(
  'mode',case when p_tag_id is null then 'per_row' else 'single_tag' end,
  'row_count',total_rows,'valid_count',total_rows-duplicate_count,
  'error_count',0,'duplicate_count',duplicate_count,
  'sku_count',cardinality(codes),'tag_count',(select count(distinct tag_id) from pg_temp.hub_tag_import_rows),
  'inserted_tag_count',inserted_count,'rule_assignment_count',linked_count,'preview_rows',preview_rows
 );
end $$;

revoke all on function public.hub_tag_bulk_import_v1(text,jsonb,uuid,boolean) from public;
grant execute on function public.hub_tag_bulk_import_v1(text,jsonb,uuid,boolean) to anon,authenticated;
notify pgrst,'reload schema';