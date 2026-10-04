-- Additive API: v1 remains atomic. v2 revalidates all rows under the same registry lock.
create function public.hub_tag_bulk_import_v2(p_session_token text,p_rows jsonb,p_tag_id uuid default null,p_preview boolean default true)
returns jsonb language plpgsql security definer set search_path=pg_catalog set statement_timeout='60s' set lock_timeout='5s' as $$
declare actor jsonb; codes text[]; inserted_count integer:=0; linked_count integer:=0; receipt jsonb;
begin
 actor:=operations_private.require_operations_hub_operator_session(p_session_token);
 if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) not between 1 and 50000 then raise exception '태그 행 배열은 1~50,000행이어야 합니다.';end if;
 if p_tag_id is not null and not exists(select 1 from public.product_tags where tag_id=p_tag_id and is_active) then raise exception '선택한 태그를 판별할 수 없습니다.';end if;
 perform pg_advisory_xact_lock(hashtextextended('hub-rule-registry',0));
 if exists(select 1 from pg_class where oid in(to_regclass('pg_temp.hub_partial_tag_rows'),to_regclass('pg_temp.hub_partial_tag_outputs'),to_regclass('pg_temp.hub_partial_tag_issues')) and relowner<>current_user::regrole) then raise exception '임시 검사 테이블 소유권 오류';end if;
 create temporary table if not exists hub_partial_tag_rows(row_no integer primary key,source_row_no integer,source_file text,sku text,requested_tag_name text,tag_id uuid,tag_name text,product_code text,state text default 'APPLY',reason text,duplicate boolean default false) on commit drop;
 create temporary table if not exists hub_partial_tag_outputs(row_no integer,sku text,rule_id uuid,tag_id uuid,target_field text,scope text,input_origin text) on commit drop;
 create temporary table if not exists hub_partial_tag_issues(row_no integer,existing_tag text,stage text,output_field text,exclusive_group text,reason text) on commit drop;
 truncate pg_temp.hub_partial_tag_rows,pg_temp.hub_partial_tag_outputs,pg_temp.hub_partial_tag_issues;
 create index if not exists hub_partial_tag_rows_identity on pg_temp.hub_partial_tag_rows(sku,tag_id,row_no);
 create index if not exists hub_partial_tag_issues_row on pg_temp.hub_partial_tag_issues(row_no);
 insert into pg_temp.hub_partial_tag_rows(row_no,source_row_no,source_file,sku,requested_tag_name)
 select n::integer,case when v->>'source_row_no'~'^[0-9]{1,6}$' then (v->>'source_row_no')::integer else n::integer end,left(coalesce(v->>'source_file',''),260),btrim(coalesce(v->>'sku','')),btrim(coalesce(v->>'tag_name','')) from jsonb_array_elements(p_rows) with ordinality as x(v,n);
 update pg_temp.hub_partial_tag_rows i set tag_id=t.tag_id,tag_name=t.tag_name from public.product_tags t where t.is_active and p_tag_id=t.tag_id;
 if p_tag_id is null then
  update pg_temp.hub_partial_tag_rows i set tag_id=t.tag_id,tag_name=t.tag_name from (select lower(btrim(tag_name)) key,(array_agg(tag_id))[1] tag_id,(array_agg(tag_name))[1] tag_name from public.product_tags where is_active group by lower(btrim(tag_name)) having count(*)=1)t where lower(i.requested_tag_name)=t.key;
 end if;
 update pg_temp.hub_partial_tag_rows i set product_code=s.sellpia_product_code from public.sellpia_stock_latest s where s.sellpia_sku_code=i.sku;
 update pg_temp.hub_partial_tag_rows set state='INVALID',reason=case when sku='' then '셀피아 SKU가 비어 있습니다.' when tag_id is null then '활성 태그를 정확히 판별할 수 없습니다.' else '셀피아 원본에 없는 SKU 또는 유효하지 않은 SKU입니다.' end where sku='' or tag_id is null or product_code is null;
 -- A repeated input and an already-effective exact tag are NOOP; no first-owner selection.
 update pg_temp.hub_partial_tag_rows i set state='NOOP',duplicate=true,reason='중복 행 · 한 번만 적용' where i.state='APPLY' and exists(select 1 from pg_temp.hub_partial_tag_rows earlier where earlier.row_no<i.row_no and earlier.sku=i.sku and earlier.tag_id=i.tag_id);
 update pg_temp.hub_partial_tag_rows i set state='NOOP',reason='이미 동일 태그가 적용되어 있습니다.' where i.state='APPLY' and exists(select 1 from public.sellpia_tag_assignments a where a.is_active and a.tag_id=i.tag_id and (a.tag_scope='option' and a.sellpia_sku_code=i.sku or a.tag_scope='product' and a.sellpia_product_code=i.product_code));
 insert into pg_temp.hub_partial_tag_outputs select i.row_no,i.sku,r.id,r.tag_id,r.target_field,r.scope,r.input_origin from pg_temp.hub_partial_tag_rows i join operations_private.hub_rules r on r.tag_id=i.tag_id and r.is_active where i.state in ('APPLY','NOOP');
 create index if not exists hub_partial_tag_outputs_lookup on pg_temp.hub_partial_tag_outputs(sku,target_field,scope,rule_id);
 analyze pg_temp.hub_partial_tag_rows;analyze pg_temp.hub_partial_tag_outputs;
 -- Current assignment ownership is authoritative, even when its original tag has been renamed.
 insert into pg_temp.hub_partial_tag_issues
 select distinct d.row_no,coalesce(t.tag_name,r.name),m->>'stage',d.target_field,m->>'exclusive_group','같은 출력에 기존 수식 owner가 있습니다.' from pg_temp.hub_partial_tag_outputs d join operations_private.hub_rule_assignments a on a.sku=d.sku and a.target_field=d.target_field and a.scope=d.scope and a.rule_id<>d.rule_id join operations_private.hub_rules r on r.id=a.rule_id left join public.product_tags t on t.tag_id=coalesce(a.assigned_tag_id,r.tag_id) cross join lateral operations_private.hub_output_ownership_v1(d.target_field,d.scope)m;
 -- Also check existing tag ownership whose derived assignment is not materialized yet.
 insert into pg_temp.hub_partial_tag_issues
 select distinct d.row_no,t.tag_name,m->>'stage',d.target_field,m->>'exclusive_group','기존 활성 태그가 같은 출력을 소유합니다.' from pg_temp.hub_partial_tag_outputs d join pg_temp.hub_partial_tag_rows i on i.row_no=d.row_no join public.sellpia_tag_assignments a on a.is_active and (a.tag_scope='option' and a.sellpia_sku_code=i.sku or a.tag_scope='product' and a.sellpia_product_code=i.product_code) join operations_private.hub_rules r on r.tag_id=a.tag_id and r.is_active and r.target_field=d.target_field and r.scope=d.scope and r.id<>d.rule_id join public.product_tags t on t.tag_id=a.tag_id cross join lateral operations_private.hub_output_ownership_v1(d.target_field,d.scope)m;
 insert into pg_temp.hub_partial_tag_issues
 select distinct d.row_no,t.tag_name,m->>'stage',d.target_field,m->>'exclusive_group','같은 요청 안에서 동일 출력의 수식이 경쟁합니다.' from pg_temp.hub_partial_tag_outputs d join pg_temp.hub_partial_tag_outputs other on other.sku=d.sku and other.target_field=d.target_field and other.scope=d.scope and other.rule_id<>d.rule_id join public.product_tags t on t.tag_id=other.tag_id cross join lateral operations_private.hub_output_ownership_v1(d.target_field,d.scope)m;
 insert into pg_temp.hub_partial_tag_issues
 select d.row_no,null,m->>'stage',d.target_field,m->>'exclusive_group','상위 참조 또는 수식 입력 계약이 일치하지 않습니다.' from pg_temp.hub_partial_tag_outputs d left join operations_private.hub_field_references f on f.child_sku=d.sku and f.rule_id=d.rule_id cross join lateral operations_private.hub_output_ownership_v1(d.target_field,d.scope)m where d.input_origin='parent' and (f.child_sku is null or f.target_field<>d.target_field or f.scope<>d.scope) or d.input_origin='self' and f.child_sku is not null;
 -- Representative tags own a product-wide output, not a single option's output.
 insert into pg_temp.hub_partial_tag_issues
 select distinct i.row_no,coalesce(t.tag_name,old.id::text),'representative_price','representative_base_price','representative_price_rule','상품 대표가의 기존 owner와 충돌합니다.' from pg_temp.hub_partial_tag_rows i join operations_private.hub_product_price_rules requested on requested.tag_id=i.tag_id and requested.is_active join operations_private.hub_product_price_assignments a on a.product_code=i.product_code and a.rule_id<>requested.id join operations_private.hub_product_price_rules old on old.id=a.rule_id left join public.product_tags t on t.tag_id=old.tag_id where i.state in ('APPLY','NOOP');
 insert into pg_temp.hub_partial_tag_issues
 select distinct i.row_no,t.tag_name,'representative_price','representative_base_price','representative_price_rule','상품의 활성 대표가 태그와 충돌합니다.' from pg_temp.hub_partial_tag_rows i join operations_private.hub_product_price_rules requested on requested.tag_id=i.tag_id and requested.is_active join public.sellpia_tag_assignments a on a.is_active and (a.tag_scope='product' and a.sellpia_product_code=i.product_code or a.tag_scope='option' and exists(select 1 from public.sellpia_stock_latest s where s.sellpia_product_code=i.product_code and s.sellpia_sku_code=a.sellpia_sku_code)) join operations_private.hub_product_price_rules old on old.tag_id=a.tag_id and old.is_active and old.id<>requested.id join public.product_tags t on t.tag_id=old.tag_id where i.state in ('APPLY','NOOP');
 insert into pg_temp.hub_partial_tag_issues
 select distinct i.row_no,t.tag_name,'representative_price','representative_base_price','representative_price_rule','같은 상품의 요청 대표가 태그가 경쟁합니다.' from pg_temp.hub_partial_tag_rows i join operations_private.hub_product_price_rules requested on requested.tag_id=i.tag_id and requested.is_active join pg_temp.hub_partial_tag_rows other on other.product_code=i.product_code and other.state in ('APPLY','NOOP') join operations_private.hub_product_price_rules old on old.tag_id=other.tag_id and old.is_active and old.id<>requested.id join public.product_tags t on t.tag_id=old.tag_id where i.state in ('APPLY','NOOP');
 insert into pg_temp.hub_partial_tag_issues
 select i.row_no,null,'representative_price','representative_base_price','representative_price_rule','직접지정 대표 옵션은 상품 대표가 화면에서 먼저 명시하세요.' from pg_temp.hub_partial_tag_rows i join operations_private.hub_product_price_rules r on r.tag_id=i.tag_id and r.is_active and r.selection='direct' where i.state in ('APPLY','NOOP') and not exists(select 1 from operations_private.hub_product_price_assignments a where a.product_code=i.product_code and a.rule_id=r.id);
 update pg_temp.hub_partial_tag_rows i set state='BLOCK',reason='수식 output ownership / 입력 계약 차단' where i.state in ('APPLY','NOOP') and exists(select 1 from pg_temp.hub_partial_tag_issues x where x.row_no=i.row_no);
 if not p_preview then
  insert into public.sellpia_tag_assignments(tag_id,tag_scope,sellpia_sku_code,reviewer,memo,source_file_name,source_row_no)
  select i.tag_id,'option',i.sku,actor->>'username','operations hub partial tag import',nullif(i.source_file,''),i.source_row_no from pg_temp.hub_partial_tag_rows i where i.state='APPLY';
  get diagnostics inserted_count=row_count;
  select array_agg(distinct sku) into codes from pg_temp.hub_partial_tag_rows where state='APPLY';
  if cardinality(codes)>0 then linked_count:=operations_private.hub_sync_tag_rules(codes,actor->>'username');end if;
 end if;
 select jsonb_build_object('mode','partial','row_count',count(*),'apply_count',count(*) filter(where i.state='APPLY'),'noop_count',count(*) filter(where i.state='NOOP'),'blocked_count',count(*) filter(where i.state='BLOCK'),'invalid_count',count(*) filter(where i.state='INVALID'),'valid_count',count(*) filter(where i.state in ('APPLY','NOOP')),'error_count',count(*) filter(where i.state='INVALID'),'duplicate_count',count(*) filter(where i.duplicate),'applied_count',case when p_preview then 0 else inserted_count end,'inserted_tag_count',inserted_count,'rule_assignment_count',linked_count,'sku_count',count(distinct i.sku) filter(where i.state='APPLY'),'tag_count',count(distinct i.tag_id) filter(where i.state='APPLY'),'applied_skus',case when p_preview then '[]'::jsonb else to_jsonb(coalesce(codes,'{}'::text[])) end,'row_results',jsonb_agg(jsonb_build_object('row_no',i.row_no,'source_row_no',i.source_row_no,'source_file',i.source_file,'sku',i.sku,'tag_name',coalesce(i.tag_name,i.requested_tag_name),'state',i.state,'reason',i.reason,'is_duplicate',i.duplicate,'issues',coalesce((select jsonb_agg(distinct to_jsonb(x)-'row_no') from pg_temp.hub_partial_tag_issues x where x.row_no=i.row_no),'[]')) order by i.row_no)) into receipt from pg_temp.hub_partial_tag_rows i;
 if not p_preview then
  insert into operations_private.hub_rule_events(action,after_value,actor) values('tag_excel_partial_import',(receipt-'row_results')||jsonb_build_object('rejected_rows',(select coalesce(jsonb_agg(r),'[]') from jsonb_array_elements(receipt->'row_results')r where r->>'state' in ('BLOCK','INVALID'))),actor->>'username');
 end if;
 return receipt;
end $$;
revoke all on function public.hub_tag_bulk_import_v2(text,jsonb,uuid,boolean) from public;
grant execute on function public.hub_tag_bulk_import_v2(text,jsonb,uuid,boolean) to anon,authenticated;
notify pgrst,'reload schema';

