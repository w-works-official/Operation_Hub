-- Add carrier mapping evidence without changing canonical decisions or v1.
set local lock_timeout='2s';
set local statement_timeout='30s';

create function operations_private.hub_price_decision_export_payload_v2(p_source text,p_skus text[])
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare
  v_source text:=lower(btrim(coalesce(p_source,'')));
  v_result jsonb;v_members jsonb;v_seller_rows jsonb;v_sellpia_prices jsonb;
  v_snapshot uuid;v_sellpia_snapshot uuid;v_observed_at timestamptz;v_all_skus text[];
  v_max_siblings integer;v_total_members bigint;v_group record;v_targets jsonb;v_group_prices jsonb;
  v_proofs jsonb:='[]'::jsonb;
begin
  -- This call retains every existing session-independent canonical validation,
  -- full active-group proof, size guard and invalid orphan decision row.
  v_result:=operations_private.hub_price_decision_export_payload_v1(p_source,p_skus);
  v_snapshot:=(v_result->'snapshots'->>'seller_snapshot_id')::uuid;
  v_sellpia_snapshot:=(v_result->'snapshots'->>'sellpia_snapshot_id')::uuid;
  v_observed_at:=(v_result->'snapshots'->>'sellpia_observed_at')::timestamptz;

  -- Mirror loadCarrierSellerMappings: cached identities survive unless an
  -- active identity has a nonempty component-owner set excluding that SKU.
  -- An active listing with no components retains the established cache fallback.
  -- Explicit owners are added, and exact source/SKU/identity suppressions apply
  -- to both branches. No legacy/canonical ownership is promoted by this proof.
  with requested as materialized(select distinct unnest(p_skus) sku),
  products as materialized(
    select distinct product_code from(
      select c.smartstore_product_code product_code from requested r
      join operations_private.operations_hub_matrix_export_cache c on c.sellpia_sku_code=r.sku
      where nullif(btrim(c.smartstore_product_code),'') is not null
      union
      select l.product_code from requested r
      join public.operations_hub_listing_components c on c.sellpia_sku_code=r.sku and c.is_active
      join public.operations_hub_seller_listings l on l.listing_id=c.listing_id
      where l.is_active and l.source_channel=v_source and nullif(btrim(l.product_code),'') is not null
    ) p
  ), active_members as materialized(
    select btrim(c.sellpia_sku_code) sku,btrim(l.product_code) product_code,
      btrim(coalesce(l.option_code,'')) option_code,'explicit'::text mapping_source,
      l.listing_id,c.component_id,c.component_qty,c.component_role
    from products p cross join lateral(
      select l.* from public.operations_hub_seller_listings l
      where l.is_active and l.source_channel=v_source and l.product_code=p.product_code offset 0
    ) l join public.operations_hub_listing_components c on c.listing_id=l.listing_id and c.is_active
  ), cache_members as materialized(
    select btrim(c.sellpia_sku_code) sku,btrim(c.smartstore_product_code) product_code,
      btrim(coalesce(c.smartstore_option_code,'')) option_code,'carrier_cache'::text mapping_source,
      null::bigint listing_id,null::bigint component_id,1::numeric component_qty,'primary'::text component_role
    from products p cross join lateral(
      select c.sellpia_sku_code,c.smartstore_product_code,c.smartstore_option_code
      from operations_private.operations_hub_matrix_export_cache c where c.smartstore_product_code=p.product_code offset 0
    ) c
  ), suppressions as materialized(
    select btrim(s.sellpia_sku_code) sku,btrim(s.product_code) product_code,btrim(coalesce(s.option_code,'')) option_code
    from public.operations_hub_link_suppressions s where s.source_channel=v_source
      and s.product_code in(select product_code from products)
  ), candidates as materialized(
    select c.* from cache_members c where not exists(
      select 1 from active_members a where a.product_code=c.product_code and a.option_code=c.option_code
    ) or exists(
      select 1 from active_members a where a.product_code=c.product_code and a.option_code=c.option_code and a.sku=c.sku
    )
    union all select * from active_members
  ), members as materialized(
    select c.* from candidates c where not exists(
      select 1 from suppressions s where s.sku=c.sku and s.product_code=c.product_code and s.option_code=c.option_code
    )
  ), sizes as materialized(select product_code,count(distinct sku) n from members group by product_code)
  select coalesce(jsonb_agg(to_jsonb(m) order by m.product_code,m.option_code,m.sku,m.mapping_source,m.listing_id,m.component_id),'[]'::jsonb),
    coalesce((select max(n) from sizes),0),coalesce((select sum(n) from sizes),0)
  into v_members,v_max_siblings,v_total_members from members m;
  if v_max_siblings>200 or v_total_members>1000 then raise exception '가격 결정 그룹이 요청 크기 제한을 넘었습니다.';end if;

  select array_agg(distinct m->>'sku') into v_all_skus from jsonb_array_elements(v_members) m;
  select coalesce(jsonb_object_agg(r.sellpia_sku_code,
    nullif(regexp_replace(coalesce(r.raw_payload->>'sell_price',''),'[^0-9.-]','','g'),'')::numeric),'{}'::jsonb)
  into v_sellpia_prices from public.sellpia_stock_snapshot_rows r
  where r.snapshot_id=v_sellpia_snapshot and r.sellpia_sku_code=any(v_all_skus);
  with keys as materialized(
    select distinct m->>'product_code' product_code,m->>'option_code' option_code from jsonb_array_elements(v_members) m
  ) select coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) into v_seller_rows
  from keys k cross join lateral(
    select r.* from public.seller_inventory_snapshot_rows r where r.snapshot_id=v_snapshot
      and r.product_code=k.product_code and btrim(coalesce(r.option_code,''))=k.option_code offset 0
  ) r;

  for v_group in
    select m->>'product_code' product_code,
      md5(jsonb_agg(m order by m->>'option_code',m->>'sku',m->>'mapping_source',
        (m->>'listing_id')::bigint,(m->>'component_id')::bigint)::text) fingerprint,
      array_agg(distinct m->>'sku' order by m->>'sku') member_skus
    from jsonb_array_elements(v_members) m group by m->>'product_code' order by 1
  loop
    select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into v_group_prices
    from jsonb_each(v_sellpia_prices) where key=any(v_group.member_skus);
    select coalesce(jsonb_agg(target order by target->>'seller_option_code'),'[]'::jsonb) into v_targets
    from(
      select jsonb_build_object('sku',min(m.sku),'member_skus',jsonb_agg(distinct m.sku order by m.sku),
        'seller_product_code',v_group.product_code,'seller_option_code',m.option_code,
        'component_members',jsonb_agg(jsonb_build_object('sku',m.sku,'mapping_source',m.mapping_source,
          'listing_id',m.listing_id,'component_id',m.component_id,'component_qty',m.component_qty,'component_role',m.component_role)
          order by m.sku,m.mapping_source,m.listing_id,m.component_id),
        'price',case when r.snapshot_id is null then null else jsonb_build_object(
          'base',coalesce(r.base_price,nullif(r.raw_payload->>'base_price','')::numeric,r.price),
          'discounted',coalesce(r.discounted_base_price,r.base_price,r.price),
          'option',coalesce(r.option_price,nullif(r.raw_payload->>'option_price','')::numeric,0),
          'final',coalesce(r.final_price,r.price),'terms',coalesce(r.discount_terms,'[]'::jsonb)) end,
        'source_row_no',r.source_row_no,'source_valid',r.snapshot_id is not null) target
      from jsonb_to_recordset(v_members) m(sku text,product_code text,option_code text,mapping_source text,
        listing_id bigint,component_id bigint,component_qty numeric,component_role text)
      left join jsonb_to_recordset(v_seller_rows) r(snapshot_id uuid,product_code text,option_code text,
        raw_payload jsonb,price numeric,base_price numeric,discounted_base_price numeric,option_price numeric,
        final_price numeric,discount_terms jsonb,source_row_no integer)
        on r.product_code=v_group.product_code and btrim(coalesce(r.option_code,''))=m.option_code
      where m.product_code=v_group.product_code group by m.option_code,r.snapshot_id,r.raw_payload,r.price,
        r.base_price,r.discounted_base_price,r.option_price,r.final_price,r.discount_terms,r.source_row_no
    ) targets;
    v_proofs:=v_proofs||jsonb_build_array(jsonb_build_object('source_channel',v_source,
      'seller_product_code',v_group.product_code,'mapping_fingerprint',v_group.fingerprint,
      'snapshot_id',v_snapshot,'sellpia_snapshot_id',v_sellpia_snapshot,'source_observed_at',v_observed_at,
      'sellpia_prices',v_group_prices,'targets',v_targets));
  end loop;
  return v_result||jsonb_build_object('proof_version','sellpia-export-v2','carrier_proofs',v_proofs);
end $$;
revoke all on function operations_private.hub_price_decision_export_payload_v2(text,text[]) from public,anon,authenticated,service_role;

create function public.hub_price_decision_export_read_v2(p_session_token text,p_source text,p_skus text[])
returns jsonb language plpgsql stable security definer set search_path=pg_catalog set statement_timeout='20s' as $$
begin
  perform operations_private.require_operations_hub_operator_session(p_session_token);
  return operations_private.hub_price_decision_export_payload_v2(p_source,p_skus);
end $$;
revoke all on function public.hub_price_decision_export_read_v2(text,text,text[]) from public,anon,authenticated,service_role;
grant execute on function public.hub_price_decision_export_read_v2(text,text,text[]) to anon,authenticated;
notify pgrst,'reload schema';
