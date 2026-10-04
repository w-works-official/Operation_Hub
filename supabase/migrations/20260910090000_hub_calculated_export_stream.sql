create index if not exists hub_calculated_results_scope_sku_field_idx
 on operations_private.hub_calculated_results(scope,sku,field);

create or replace function public.hub_calculation_results_export_read_v1(
 p_session_token text,
 p_scope text,
 p_after_sku text default null,
 p_limit integer default 200
)
returns jsonb language plpgsql security definer stable set search_path=pg_catalog as $$
declare result jsonb;
begin
 perform operations_private.require_operations_hub_operator_session(p_session_token);
 if p_scope not in ('smartstore','makeshop','ably') then raise exception '판매처 범위 오류';end if;
 if p_limit is null or p_limit not between 1 and 500 then raise exception '내보내기 가격 조회는 요청당 SKU 1~500개입니다.';end if;
 with page_skus as materialized(
  select distinct r.sku
  from operations_private.hub_calculated_results r
  join operations_private.operations_hub_matrix_export_cache m on m.sellpia_sku_code=r.sku
  where r.scope=p_scope
   and r.field=any(array['platform_registration_price','platform_discount_price','platform_option_price','platform_final_price'])
   and (p_after_sku is null or r.sku>p_after_sku)
   and nullif(btrim(case p_scope when 'smartstore' then m.smartstore_product_code when 'makeshop' then m.makeshop_product_code when 'ably' then m.ably_product_code end),'') is not null
  order by r.sku limit p_limit+1
 ), visible_skus as materialized(select sku from page_skus order by sku limit p_limit), resolved as(
  select r.*,case p_scope when 'smartstore' then m.smartstore_product_code when 'makeshop' then m.makeshop_product_code when 'ably' then m.ably_product_code end seller_product_code,
   case p_scope when 'smartstore' then m.smartstore_option_code when 'makeshop' then m.makeshop_option_code when 'ably' then m.ably_option_code end seller_option_code
  from visible_skus v
  join operations_private.hub_calculated_results r on r.sku=v.sku and r.scope=p_scope
  join operations_private.operations_hub_matrix_export_cache m on m.sellpia_sku_code=r.sku
  where r.field=any(array['platform_registration_price','platform_discount_price','platform_option_price','platform_final_price'])
 )
 select jsonb_build_object(
  'rows',coalesce((select jsonb_agg(to_jsonb(r) order by sku,field) from resolved r),'[]'),
  'sku_count',(select count(*) from visible_skus),
  'next_sku',case when (select count(*) from page_skus)>p_limit then (select sku from visible_skus order by sku desc limit 1) else null end
 ) into result;
 return result;
end $$;

revoke all on function public.hub_calculation_results_export_read_v1(text,text,text,integer) from public;
grant execute on function public.hub_calculation_results_export_read_v1(text,text,text,integer) to anon,authenticated;
notify pgrst,'reload schema';
