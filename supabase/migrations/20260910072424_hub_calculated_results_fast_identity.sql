create or replace function public.hub_calculation_results_read_v1(p_session_token text,p_skus text[],p_scope text default null,p_fields text[] default null,p_after_key jsonb default null,p_limit integer default 1000)
returns jsonb language plpgsql security definer stable set search_path=pg_catalog as $$
declare result jsonb;
begin
 perform operations_private.require_operations_hub_operator_session(p_session_token);
 if coalesce(cardinality(p_skus),0) not between 1 and 1000 or p_limit is null or p_limit not between 1 and 1000 then raise exception '계산 결과 조회는 요청당 SKU 1~1,000개, 결과 최대 1,000개입니다.';end if;
 if p_scope is not null and p_scope not in ('','smartstore','makeshop','ably') then raise exception '판매처 범위 오류';end if;
 if p_fields is not null and cardinality(p_fields)>16 then raise exception '조회 필드가 너무 많습니다.';end if;
 if p_after_key is not null and (jsonb_typeof(p_after_key) is distinct from 'object' or p_after_key->>'sku' is null or p_after_key->>'scope' is null or p_after_key->>'field' is null) then raise exception '계산 결과 페이지 키 오류';end if;
 with matching_keys as materialized(
  select r.sku,r.scope,r.field from operations_private.hub_calculated_results r
  where r.sku in(select distinct unnest(p_skus)) and (p_scope is null or r.scope=p_scope) and (p_fields is null or r.field=any(p_fields))
 ), page as materialized(
  select r.* from operations_private.hub_calculated_results r join matching_keys k using(sku,scope,field)
  where p_after_key is null or (r.sku,r.scope,r.field)>(p_after_key->>'sku',p_after_key->>'scope',p_after_key->>'field')
  order by r.sku,r.scope,r.field limit p_limit+1
 ), visible as materialized(select * from page order by sku,scope,field limit p_limit), identities as materialized(
  select m.sellpia_sku_code,m.smartstore_product_code,m.smartstore_option_code,m.makeshop_product_code,m.makeshop_option_code,m.ably_product_code,m.ably_option_code
  from operations_private.operations_hub_matrix_export_cache m where m.sellpia_sku_code in(select sku from visible where scope<>'' union select unnest(p_skus) where p_scope in ('smartstore','makeshop','ably'))
 ), resolved as (
  select v.*,case v.scope when 'smartstore' then m.smartstore_product_code when 'makeshop' then m.makeshop_product_code when 'ably' then m.ably_product_code end seller_product_code,
   case v.scope when 'smartstore' then m.smartstore_option_code when 'makeshop' then m.makeshop_option_code when 'ably' then m.ably_option_code end seller_option_code
  from visible v left join identities m on m.sellpia_sku_code=v.sku
 ), missing as (
  select m.sellpia_sku_code,p_scope source_channel,
   case p_scope when 'smartstore' then m.smartstore_product_code when 'makeshop' then m.makeshop_product_code when 'ably' then m.ably_product_code end seller_product_code,
   case p_scope when 'smartstore' then m.smartstore_option_code when 'makeshop' then m.makeshop_option_code when 'ably' then m.ably_option_code end seller_option_code,
   '계산 결과 오류 또는 누락: '||string_agg(f.field,', ' order by f.field) reason
  from identities m cross join unnest(coalesce(p_fields,array['platform_registration_price','platform_discount_price','platform_option_price','platform_final_price'])) f(field)
  where p_scope in ('smartstore','makeshop','ably') and m.sellpia_sku_code in(select unnest(p_skus))
   and nullif(btrim(case p_scope when 'smartstore' then m.smartstore_product_code when 'makeshop' then m.makeshop_product_code when 'ably' then m.ably_product_code end),'') is not null
   and not exists(select 1 from operations_private.hub_calculated_results r where r.sku=m.sellpia_sku_code and r.scope=p_scope and r.field=f.field and r.status='calculated')
  group by m.sellpia_sku_code,m.smartstore_product_code,m.smartstore_option_code,m.makeshop_product_code,m.makeshop_option_code,m.ably_product_code,m.ably_option_code
 )
 select jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(v)||jsonb_build_object('mapping_missing',v.scope<>'' and nullif(btrim(v.seller_product_code),'') is null) order by sku,scope,field) from resolved v),'[]'),
  'total',(select count(*) from matching_keys),
  'missing_skus',coalesce((select jsonb_agg(s order by s) from (select distinct unnest(p_skus) s) requested where not exists(select 1 from matching_keys k where k.sku=requested.s)),'[]'),
  'missing',coalesce((select jsonb_agg(to_jsonb(m) order by sellpia_sku_code) from missing m),'[]'),
  'next_key',case when (select count(*) from page)>p_limit then (select jsonb_build_object('sku',sku,'scope',scope,'field',field) from visible order by sku desc,scope desc,field desc limit 1) else null end)
 into result;
 return result;
end $$;

notify pgrst,'reload schema';
