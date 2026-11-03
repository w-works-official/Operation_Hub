CREATE OR REPLACE FUNCTION operations_private.hub_sync_product_price_rules_v1(p_skus text[], p_actor text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
declare product text; candidates uuid[]; candidate uuid; existing operations_private.hub_product_price_assignments%rowtype; names text;
begin
 perform pg_advisory_xact_lock(hashtextextended('hub-rule-registry',0));
 for product in select distinct sellpia_product_code from public.sellpia_stock_latest where sellpia_sku_code=any(p_skus) loop
  select array_agg(distinct r.id),string_agg(distinct t.tag_name,', ') into candidates,names
  from operations_private.hub_product_price_rules r join public.product_tags t on t.tag_id=r.tag_id and t.is_active
  join public.sellpia_tag_assignments a on a.tag_id=r.tag_id and a.is_active
  where r.is_active and (a.tag_scope='product' and a.sellpia_product_code=product or a.tag_scope='option' and exists(select 1 from public.sellpia_stock_latest p where p.sellpia_product_code=product and p.sellpia_sku_code=a.sellpia_sku_code));
  if cardinality(candidates)>1 then raise exception '%: 대표가 output 소유권 충돌 (%). 전체 적용을 취소했습니다.',product,names;end if;
  candidate:=candidates[1];select * into existing from operations_private.hub_product_price_assignments where product_code=product;
  if candidate is null then
   delete from operations_private.hub_product_price_assignments where product_code=product;
  elsif existing.rule_id is null then
   if (select selection from operations_private.hub_product_price_rules where id=candidate)='direct' then raise exception '%: 직접지정 대표 옵션을 먼저 명시하세요.',product;end if;
   insert into operations_private.hub_product_price_assignments(product_code,rule_id,updated_by) values(product,candidate,p_actor);
  elsif existing.rule_id<>candidate then
   raise exception '%: 기존 대표가 Rule %를 먼저 해제하세요.',product,existing.rule_id;
  end if;
 end loop;
end $function$;
