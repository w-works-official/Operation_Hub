-- Read-only typed search. Existing Matrix value projection stays unchanged.
create index if not exists operations_hub_matrix_export_cache_sku_prefix_mvp_idx
 on operations_private.operations_hub_matrix_export_cache (sellpia_sku_code text_pattern_ops);
create index if not exists operations_hub_matrix_export_cache_own_prefix_mvp_idx
 on operations_private.operations_hub_matrix_export_cache ((coalesce(sellpia_own_code,own_code)) text_pattern_ops);

create function public.load_operations_hub_matrix_search_mvp(
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
   where exists (
    select 1 from (values
     ('sellpia',c.sellpia_product_name,c.sellpia_option_name),
     ('smartstore',c.smartstore_name,c.smartstore_option_name),
     ('makeshop',c.makeshop_name,c.makeshop_option_name),
     ('ably',c.ably_name,c.ably_option_name)
    ) names(source,product_name,option_name)
    where names.source=any(coalesce(p_search_sources,'{}')) and
     case when v_product is not null and v_option is not null then
      position(lower(v_product) in lower(coalesce(product_name,'')))>0 and position(lower(v_option) in lower(coalesce(option_name,'')))>0
     else position(lower(v_term) in lower(concat_ws(' ',product_name,option_name)))>0 end
   );
 end if;
 -- Empty key arrays mean no restriction in the legacy RPC, so stop explicitly.
 if coalesce(cardinality(v_keys),0)=0 then
  return jsonb_build_object('rows','[]'::jsonb,'count',0,'page',greatest(p_page,1),'pageSize',greatest(1,least(p_page_size,200)));
 end if;
 v_result:=public.load_operations_hub_matrix_filtered_v4(p_page,p_page_size,'',p_search_sources,p_status,p_sort,p_filter,v_keys,p_exclude_dependent);
 return v_result||jsonb_build_object('searchType',p_search_type,'matchMode',case when p_search_type='name' then 'contains' when v_exact then 'exact' else 'prefix' end);
end;
$function$;
revoke all on function public.load_operations_hub_matrix_search_mvp(integer,integer,text,text,text[],text,text,jsonb,boolean) from public;
grant execute on function public.load_operations_hub_matrix_search_mvp(integer,integer,text,text,text[],text,text,jsonb,boolean) to anon,authenticated;
