-- Resolve tag predicates from current assignments without rewriting the matrix MV.
do $patch$
declare signature text; definition text;
begin
 foreach signature in array array[
 'public.load_operations_hub_matrix_filtered_v4(integer,integer,text,text[],text,text,jsonb,text[],boolean)',
 'public.hub_filtered_skus_v1(text,integer,integer,text,text[],text,text,jsonb,text[],boolean)'
 ] loop
 definition:=pg_get_functiondef(signature::regprocedure);
 if position('with filtered_keys as materialized' in definition)=0 or position('v_product_term, v_option_term, v_sort, v_page, v_page_size' in definition)=0 then raise exception '필터 함수 구조가 변경되어 안전하게 갱신할 수 없습니다: %',signature;end if;
 definition:=replace(definition,
 $from$when v_field = any(array['material','product_group','shape','tag_summary'])$from$,
 $to$when v_field = 'tag_summary' then 'concat_ws('' · '',nullif(current_product_tags.summary,''''),nullif(current_sku_tags.summary,''''))'
      when v_field = any(array['material','product_group','shape'])$to$);
 definition:=replace(definition,'with filtered_keys as materialized',
 $cte$with current_tag_rows as materialized (
   select a.tag_scope,a.sellpia_sku_code,a.sellpia_product_code,t.tag_name,t.display_order
   from public.sellpia_tag_assignments a join public.product_tags t on t.tag_id=a.tag_id and t.is_active
   where $11 and a.is_active
 ), current_sku_tag_groups as (
   select sellpia_sku_code,string_agg(tag_name,' · ' order by display_order,tag_name) summary from current_tag_rows where tag_scope='option' group by sellpia_sku_code
 ), current_product_tag_groups as (
   select sellpia_product_code,string_agg(tag_name,' · ' order by display_order,tag_name) summary from current_tag_rows where tag_scope='product' group by sellpia_product_code
 ), filtered_keys as materialized$cte$);
 definition:=replace(definition,'left join public.operations_hub_sku_operational_master master',
 $joins$left join current_sku_tag_groups current_sku_tags on current_sku_tags.sellpia_sku_code=cache.sellpia_sku_code
      left join current_product_tag_groups current_product_tags on current_product_tags.sellpia_product_code=cache.profile_json->>'sellpia_product_code'
      left join public.operations_hub_sku_operational_master master$joins$);
 definition:=replace(definition,'v_product_term, v_option_term, v_sort, v_page, v_page_size;',
 $using$v_product_term, v_option_term, v_sort, v_page, v_page_size, exists(select 1 from jsonb_array_elements(v_conditions) c where lower(coalesce(c->>'field',''))='tag_summary');$using$);
 execute definition;
 end loop;
end $patch$;
notify pgrst,'reload schema';
