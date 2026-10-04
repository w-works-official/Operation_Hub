-- Read-only performance fix: page identities first; unchanged managed-live values and ACL.
create or replace function public.load_operations_hub_matrix_search_mvp(
 p_page integer default 1,p_page_size integer default 50,p_search text default '',
 p_search_type text default 'name',p_search_sources text[] default array['sellpia','smartstore','makeshop','ably'],
 p_status text default 'all',p_sort text default 'sku_asc',
 p_filter jsonb default '{"logic":"and","conditions":[]}',p_exclude_dependent boolean default false
) returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $function$
declare
 v_term text:=btrim(coalesce(p_search,''));
 v_pattern text;
 v_keys text[];
 v_exact boolean;
 v_product text;
 v_option text;
 v_result jsonb;
 v_count bigint; v_page_keys text[];
 v_page integer:=greatest(coalesce(p_page,1),1);
 v_size integer:=greatest(1,least(coalesce(p_page_size,50),200));
 v_status text:=lower(coalesce(p_status,'all'));
 v_sort text:=lower(coalesce(p_sort,'sku_asc'));
begin
 if p_search_type not in ('sku','own_code','name') then raise exception '지원하지 않는 검색 유형입니다.'; end if;
 if v_term='' then
  return public.load_operations_hub_matrix_filtered_v4(p_page,p_page_size,'',p_search_sources,p_status,p_sort,p_filter,'{}',p_exclude_dependent);
 end if;
 v_pattern:=replace(replace(replace(v_term,E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_')||'%';
 if p_search_type='sku' then
  select exists(select 1 from operations_private.operations_hub_matrix_export_cache where sellpia_sku_code=v_term) into v_exact;
  if v_exact then
   select array_agg(sellpia_sku_code) into v_keys from operations_private.operations_hub_matrix_export_cache where sellpia_sku_code=v_term;
  else
   select array_agg(sellpia_sku_code) into v_keys from operations_private.operations_hub_matrix_export_cache where sellpia_sku_code like v_pattern escape E'\\';
  end if;
 elsif p_search_type='own_code' then
  select exists(select 1 from operations_private.operations_hub_matrix_export_cache where coalesce(sellpia_own_code,own_code)=v_term) into v_exact;
  if v_exact then
   select array_agg(sellpia_sku_code) into v_keys from operations_private.operations_hub_matrix_export_cache where coalesce(sellpia_own_code,own_code)=v_term;
  else
   select array_agg(sellpia_sku_code) into v_keys from operations_private.operations_hub_matrix_export_cache where coalesce(sellpia_own_code,own_code) like v_pattern escape E'\\';
  end if;
 else
  if position('/' in v_term)>0 then
   v_product:=nullif(btrim(split_part(v_term,'/',1)),'');
   v_option:=nullif(btrim(substr(v_term,position('/' in v_term)+1)),'');
  end if;
  select array_agg(c.sellpia_sku_code) into v_keys from operations_private.operations_hub_matrix_export_cache c
   where ('sellpia'=any(coalesce(p_search_sources,'{}')) and case when v_product is not null and v_option is not null then position(lower(v_product) in lower(coalesce(c.sellpia_product_name,'')))>0 and position(lower(v_option) in lower(coalesce(c.sellpia_option_name,'')))>0 else position(lower(v_term) in lower(concat_ws(' ',c.sellpia_product_name,c.sellpia_option_name)))>0 end)
   or ('smartstore'=any(coalesce(p_search_sources,'{}')) and case when v_product is not null and v_option is not null then position(lower(v_product) in lower(coalesce(c.smartstore_name,'')))>0 and position(lower(v_option) in lower(coalesce(c.smartstore_option_name,'')))>0 else position(lower(v_term) in lower(concat_ws(' ',c.smartstore_name,c.smartstore_option_name)))>0 end)
   or ('makeshop'=any(coalesce(p_search_sources,'{}')) and case when v_product is not null and v_option is not null then position(lower(v_product) in lower(coalesce(c.makeshop_name,'')))>0 and position(lower(v_option) in lower(coalesce(c.makeshop_option_name,'')))>0 else position(lower(v_term) in lower(concat_ws(' ',c.makeshop_name,c.makeshop_option_name)))>0 end)
   or ('ably'=any(coalesce(p_search_sources,'{}')) and case when v_product is not null and v_option is not null then position(lower(v_product) in lower(coalesce(c.ably_name,'')))>0 and position(lower(v_option) in lower(coalesce(c.ably_option_name,'')))>0 else position(lower(v_term) in lower(concat_ws(' ',c.ably_name,c.ably_option_name)))>0 end);
 end if;
 -- Empty key arrays mean no restriction in the legacy RPC, so stop explicitly.
 if coalesce(cardinality(v_keys),0)=0 then
  return jsonb_build_object('rows','[]'::jsonb,'count',0,'page',greatest(p_page,1),'pageSize',greatest(1,least(p_page_size,200)));
 end if;
 -- Preserve advanced-filter validation and behavior in the existing RPC.
 if jsonb_typeof(coalesce(p_filter,'{}'))='object'
    and coalesce(p_filter->'conditions','[]')='[]'::jsonb
    and lower(coalesce(p_filter->>'logic','and')) in ('and','or') then
  if v_status not in ('all','connected','review','unmatched','attention') then v_status:='all';end if;
  if v_sort not in ('sku_asc','stock_desc','price_desc','updated_desc') then v_sort:='sku_asc';end if;
  with candidates as materialized (
   select c.sellpia_sku_code,
    case when v_sort='stock_desc' then coalesce(m.stock_quantity,c.sellpia_current_stock) end sort_stock,
    case when v_sort='price_desc' then coalesce(m.base_price,c.sellpia_sale_price) end sort_price,
    c.updated_at,
    case when c.sellpia_sku_code ~ '^[0-9]+' then substring(c.sellpia_sku_code from '^([0-9]+)')::numeric end prefix,
    (c.sellpia_sku_code ~ '^[0-9]+-[0-9]+') numeric_suffix,
    case when c.sellpia_sku_code ~ '^[0-9]+-[0-9]+' then substring(c.sellpia_sku_code from '^[0-9]+-([0-9]+)')::numeric end suffix
   from operations_private.operations_hub_matrix_export_cache c
   left join public.operations_hub_sku_operational_master m on m.sellpia_sku_code=c.sellpia_sku_code and v_sort in ('stock_desc','price_desc')
   where c.sellpia_sku_code=any(v_keys)
    and (v_status='all' or (v_status in ('connected','review') and c.overall_status<>'unmatched') or (v_status in ('unmatched','attention') and c.overall_status='unmatched'))
    and (not coalesce(p_exclude_dependent,false) or not exists(select 1 from public.operations_hub_listing_components component where component.is_active and component.parent_component_id is not null and component.sellpia_sku_code=c.sellpia_sku_code))
  ) select (select count(*) from candidates),array(select sellpia_sku_code from candidates order by
    case when v_sort='stock_desc' then sort_stock end desc nulls last,
    case when v_sort='price_desc' then sort_price end desc nulls last,
    case when v_sort='updated_desc' then updated_at end desc nulls last,
    prefix asc nulls last,numeric_suffix asc nulls first,suffix asc nulls first,lower(sellpia_sku_code) asc
    offset (v_page-1)*v_size limit v_size) into v_count,v_page_keys;
  if cardinality(v_page_keys)=0 then
   v_result:=jsonb_build_object('rows','[]'::jsonb,'count',v_count,'page',v_page,'pageSize',v_size);
  else
   -- The existing managed-live projection remains the value source.
   v_result:=public.load_operations_hub_matrix_filtered_v4(1,v_size,'',p_search_sources,'all',v_sort,'{"logic":"and","conditions":[]}',v_page_keys,false)
    ||jsonb_build_object('count',v_count,'page',v_page);
  end if;
 else
  v_result:=public.load_operations_hub_matrix_filtered_v4(p_page,p_page_size,'',p_search_sources,p_status,p_sort,p_filter,v_keys,p_exclude_dependent);
 end if;
 return v_result||jsonb_build_object('searchType',p_search_type,'matchMode',case when p_search_type='name' then 'contains' when v_exact then 'exact' else 'prefix' end);
end;
$function$;
revoke all on function public.load_operations_hub_matrix_search_mvp(integer,integer,text,text,text[],text,text,jsonb,boolean) from public;
grant execute on function public.load_operations_hub_matrix_search_mvp(integer,integer,text,text,text[],text,text,jsonb,boolean) to anon,authenticated;
