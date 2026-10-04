-- Read-only carrier targets: scope before draft projection; no observed-source join.
create function operations_private.carrier_scoped_targets_payload(p_source text,p_skus text[])
returns jsonb language sql stable set search_path=pg_catalog as $$
with requested as materialized (select distinct unnest(p_skus) sku),
keys as materialized (
 select l.source_channel,l.product_code,coalesce(l.option_code,'') option_code,c.sellpia_sku_code
 from public.operations_hub_listing_components c
 join requested r on r.sku=c.sellpia_sku_code
 join public.operations_hub_seller_listings l on l.listing_id=c.listing_id
 where c.is_active and l.is_active and l.source_channel=p_source
 union all
 select c.source_channel,c.product_code,c.option_code,c.sellpia_sku_code
 from public.operations_hub_listing_legacy_cache c join requested r on r.sku=c.sellpia_sku_code
 where c.source_channel=p_source and not exists (
  select 1 from public.operations_hub_seller_listings l where l.is_active
  and l.source_channel=c.source_channel and l.product_code=c.product_code and l.option_code=c.option_code)
), candidates as materialized (
 select q.* from public.operations_hub_change_queue q
 where q.source_channel=p_source and q.field_key in ('sellpia_current_stock','sellpia_sale_price')
 and q.status in ('pending','validated','failed','processing')
 and (q.sellpia_sku_code in (select sku from requested) or exists (
  select 1 from keys k where btrim(k.product_code)=btrim(q.seller_product_code)
  and coalesce(nullif(btrim(k.option_code),''),'')=q.seller_option_code_normalized))
), projected as (
 select k.sellpia_sku_code sku,q.* from candidates q join keys k
 on btrim(k.product_code)=btrim(q.seller_product_code)
 and coalesce(nullif(btrim(k.option_code),''),'')=q.seller_option_code_normalized
 union all
 select q.sellpia_sku_code sku,q.* from candidates q
 where q.sellpia_sku_code in (select sku from requested)
 -- Preserve the existing view's fallback: only an identity with no components
 -- anywhere may fall back to its queue SKU (not merely no requested component).
 and not exists (
  select 1 from public.operations_hub_seller_listings l
  join public.operations_hub_listing_components c on c.listing_id=l.listing_id and c.is_active
  where l.is_active and l.source_channel=p_source and btrim(l.product_code)=btrim(q.seller_product_code)
  and coalesce(nullif(btrim(coalesce(l.option_code,'')),''),'')=q.seller_option_code_normalized)
 and not exists (
  select 1 from public.operations_hub_listing_legacy_cache c
  where c.source_channel=p_source and btrim(c.product_code)=btrim(q.seller_product_code)
  and coalesce(nullif(btrim(c.option_code),''),'')=q.seller_option_code_normalized
  and not exists (select 1 from public.operations_hub_seller_listings l where l.is_active
   and l.source_channel=c.source_channel and l.product_code=c.product_code and l.option_code=c.option_code))
), drafts as materialized (
 select distinct on (sku,field_key) sku sellpia_sku_code,source_channel,field_key,change_id,
 after_value,price_base_after,price_discounted_base_after,price_option_after,price_final_after,
 price_discount_terms_after,status,updated_at
 from projected order by sku,field_key,updated_at desc,change_id desc
)
select jsonb_build_object(
 'matrix_rows',coalesce((select jsonb_agg(jsonb_build_object('sku',m.sellpia_sku_code,'seller_stock',
  case p_source when 'smartstore' then m.smartstore_stock when 'makeshop' then m.makeshop_stock else m.ably_stock end))
  from operations_private.operations_hub_matrix_export_cache m join requested r on r.sku=m.sellpia_sku_code),'[]'::jsonb),
 'calculated_rows',coalesce((select jsonb_agg(to_jsonb(c)) from operations_private.hub_calculated_results c
  join requested r on r.sku=c.sku where c.scope=p_source and c.field in
  ('platform_registration_price','platform_discount_price','platform_option_price','platform_final_price')),'[]'::jsonb),
 'drafts',coalesce((select jsonb_agg(to_jsonb(d)) from drafts d),'[]'::jsonb),
 'active_price_skus',coalesce((select jsonb_agg(distinct a.sku) from operations_private.hub_rule_assignments a
  join requested s on s.sku=a.sku join operations_private.hub_rules r
  on r.id=a.rule_id and r.scope=a.scope and r.target_field=a.target_field
  where a.scope=p_source and r.is_active and left(r.target_field,9)='platform_'),'[]'::jsonb)
);
$$;
revoke all on function operations_private.carrier_scoped_targets_payload(text,text[]) from public,anon,authenticated;

create function public.hub_carrier_targets_read_v1(p_session_token text,p_source text,p_skus text[])
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
begin
 perform operations_private.require_operations_hub_operator_session(p_session_token);
 if p_source is null or p_source not in ('smartstore','makeshop','ably') then raise exception '판매처 범위 오류';end if;
 if coalesce(cardinality(p_skus),0) not between 1 and 200 then raise exception 'carrier 조회는 요청당 SKU 1~200개입니다.';end if;
 return operations_private.carrier_scoped_targets_payload(p_source,p_skus);
end $$;
revoke all on function public.hub_carrier_targets_read_v1(text,text,text[]) from public;
grant execute on function public.hub_carrier_targets_read_v1(text,text,text[]) to anon,authenticated;
notify pgrst,'reload schema';
