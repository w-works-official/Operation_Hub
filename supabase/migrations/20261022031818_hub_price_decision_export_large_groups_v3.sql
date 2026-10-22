-- Additive three-channel export read for complete large product groups.
-- Copied verbatim from the applied v1 canonical and v2 carrier proof bodies;
-- Only channel/cache projection, private references and expansion guards differ.
-- Keep the editor
-- and deployed v1/v2 contracts unchanged, including sellpia-export-v2 JSON proofs.
-- Input requests remain 1..200 SKUs. Per-product expansion is at most 5,000
-- distinct SKUs and total expansion is at most 20,000 memberships per proof pass.
set local lock_timeout='2s';
set local statement_timeout='30s';

create function operations_private.hub_price_decision_export_base_v3(p_source text,p_skus text[])
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare
  v_source text:=lower(btrim(coalesce(p_source,'')));
  v_members jsonb; v_seller_rows jsonb; v_all_sellpia_prices jsonb;
  v_all_skus text[]; v_max_siblings integer; v_total_members bigint;
  v_snapshot uuid; v_sellpia_snapshot uuid; v_sellpia_observed_at timestamptz;
  v_group record; v_targets jsonb; v_absence_targets jsonb; v_sellpia_prices jsonb; v_fp jsonb;
  v_groups jsonb:='[]'::jsonb; v_absence jsonb:='[]'::jsonb;
  v_mapping_fps jsonb:='{}'::jsonb; v_rows jsonb;
begin
  if v_source not in ('smartstore','makeshop','ably') then raise exception '지원하지 않는 판매처입니다.';end if;
  if coalesce(cardinality(p_skus),0) not between 1 and 200 or exists(
    select 1 from unnest(p_skus) s where length(btrim(coalesce(s,''))) not between 1 and 128
  ) then raise exception '가격 결정 그룹 조회는 SKU 1~200개가 필요합니다.';end if;

  -- Keep both projection passes parameterized. OFFSET 0 prevents a planner
  -- pull-up into a full projection scan before applying the requested keys.
  with requested as materialized(select distinct unnest(p_skus) sku),
  products as materialized(
    select distinct btrim(p.product_code) product_code from requested r
    cross join lateral(
      select p.product_code from public.operations_hub_listing_component_projection p
      where p.source_channel=v_source and p.sellpia_sku_code=r.sku offset 0
    ) p where nullif(btrim(p.product_code),'') is not null
  ), members as materialized(
    select p.mapping_source,p.listing_id,p.component_id,p.source_channel,p.product_code,p.option_code,
      p.sellpia_sku_code,p.component_qty,p.component_role
    from products k cross join lateral(
      select p.mapping_source,p.listing_id,p.component_id,p.source_channel,p.product_code,p.option_code,
        p.sellpia_sku_code,p.component_qty,p.component_role
      from public.operations_hub_listing_component_projection p
      where p.source_channel=v_source and btrim(p.product_code)=k.product_code offset 0
    ) p
  ), sizes as materialized(
    select btrim(product_code) product_code,count(distinct sellpia_sku_code) n from members group by 1
  )
  select coalesce(jsonb_agg(to_jsonb(m) order by btrim(m.product_code),m.option_code,m.sellpia_sku_code,m.mapping_source,m.listing_id,m.component_id),'[]'::jsonb),
    coalesce((select max(n) from sizes),0),coalesce((select sum(n) from sizes),0)
  into v_members,v_max_siblings,v_total_members from members m;
  if v_max_siblings>5000 or v_total_members>20000 then raise exception '가격 결정 그룹이 요청 크기 제한을 넘었습니다.';end if;

  select snapshot.snapshot_id into v_snapshot from public.seller_inventory_snapshots snapshot
  where snapshot.source_channel=v_source and snapshot.upload_status='ready'
  order by snapshot.completed_at desc nulls last,snapshot.created_at desc,snapshot.snapshot_id desc limit 1;
  select snapshot.snapshot_id,snapshot.completed_at into v_sellpia_snapshot,v_sellpia_observed_at
  from public.sellpia_stock_snapshots snapshot where snapshot.upload_status='ready'
  order by coalesce(snapshot.completed_at,snapshot.created_at) desc,snapshot.created_at desc,snapshot.snapshot_id desc limit 1;
  select array_agg(distinct m->>'sellpia_sku_code') into v_all_skus from jsonb_array_elements(v_members) m;
  select coalesce(jsonb_object_agg(r.sellpia_sku_code,
    nullif(regexp_replace(coalesce(r.raw_payload->>'sell_price',''),'[^0-9.-]','','g'),'')::numeric),'{}'::jsonb)
  into v_all_sellpia_prices from public.sellpia_stock_snapshot_rows r
  where r.snapshot_id=v_sellpia_snapshot and r.sellpia_sku_code=any(v_all_skus);

  -- Fetch only mapped raw identities, once. A product may have many unmapped
  -- options; those are not permission to read the entire seller snapshot.
  with keys as materialized(
    select distinct btrim(m->>'product_code') product_code,
      coalesce(nullif(btrim(m->>'option_code'),''),'') option_code from jsonb_array_elements(v_members) m
  )
  select coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) into v_seller_rows
  from keys k cross join lateral(
    select r.* from public.seller_inventory_snapshot_rows r where r.snapshot_id=v_snapshot
      and r.product_code=k.product_code and coalesce(nullif(btrim(r.option_code),''),'')=k.option_code offset 0
  ) r;

  for v_group in
    with members as(
      select * from jsonb_to_recordset(v_members) m(mapping_source text,listing_id bigint,component_id bigint,
        source_channel text,product_code text,option_code text,sellpia_sku_code text,component_qty numeric,component_role text)
    ), products as(
      select btrim(m.product_code) product_code,array_agg(distinct m.sellpia_sku_code order by m.sellpia_sku_code) member_skus,
        md5(coalesce(jsonb_agg(jsonb_build_object('mapping_source',m.mapping_source,'listing_id',m.listing_id,
          'component_id',m.component_id,'option_code',coalesce(nullif(btrim(m.option_code),''),''),
          'sku',m.sellpia_sku_code,'component_qty',m.component_qty,'component_role',m.component_role)
          order by coalesce(nullif(btrim(m.option_code),''),''),m.sellpia_sku_code,m.mapping_source,m.listing_id,m.component_id)::text,'[]')) fingerprint
      from members m group by 1
    )
    select p.*,coalesce(g.revision,0) revision,g.mapping_fingerprint stored_fingerprint,
      (g.source_channel is not null or exists(select 1 from operations_private.hub_effective_price_states s
        where s.source_channel=v_source and s.seller_product_code=p.product_code)) has_decision
    from products p left join operations_private.hub_price_decision_groups g
      on g.source_channel=v_source and g.seller_product_code=p.product_code order by p.product_code
  loop
    v_mapping_fps:=v_mapping_fps||jsonb_build_object(v_group.product_code,v_group.fingerprint);
    select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into v_sellpia_prices
    from jsonb_each(v_all_sellpia_prices) where key=any(v_group.member_skus);
    select coalesce(jsonb_agg(option_target order by option_target->>'seller_option_code'),'[]'::jsonb) into v_targets
    from(
      select jsonb_build_object('sku',min(m.sellpia_sku_code),
        'member_skus',jsonb_agg(distinct m.sellpia_sku_code order by m.sellpia_sku_code),
        'seller_product_code',v_group.product_code,'seller_option_code',coalesce(nullif(btrim(m.option_code),''),''),
        'price',case when r.snapshot_id is null then null else jsonb_build_object(
          'base',coalesce(r.base_price,nullif(r.raw_payload->>'base_price','')::numeric,r.price),
          'discounted',coalesce(r.discounted_base_price,r.base_price,r.price),
          'option',coalesce(r.option_price,nullif(r.raw_payload->>'option_price','')::numeric,0),
          'final',coalesce(r.final_price,r.price),'terms',coalesce(r.discount_terms,'[]'::jsonb)) end,
        'raw_payload',r.raw_payload,'source_row_no',r.source_row_no,'source_valid',r.snapshot_id is not null,
        'current_state',to_jsonb(state)) option_target
      from jsonb_to_recordset(v_members) m(product_code text,option_code text,sellpia_sku_code text)
      left join jsonb_to_recordset(v_seller_rows) r(snapshot_id uuid,product_code text,option_code text,
        raw_payload jsonb,price numeric,base_price numeric,discounted_base_price numeric,option_price numeric,
        final_price numeric,discount_terms jsonb,source_row_no integer)
        on r.product_code=v_group.product_code and coalesce(nullif(btrim(r.option_code),''),'')=coalesce(nullif(btrim(m.option_code),''),'')
      left join operations_private.hub_effective_price_states state on state.source_channel=v_source
        and state.seller_product_code=v_group.product_code and state.seller_option_code=coalesce(nullif(btrim(m.option_code),''),'')
      where btrim(m.product_code)=v_group.product_code
      group by coalesce(nullif(btrim(m.option_code),''),''),r.snapshot_id,r.raw_payload,r.price,r.base_price,
        r.discounted_base_price,r.option_price,r.final_price,r.discount_terms,r.source_row_no,state
    ) grouped_options;
    if v_group.has_decision then
      -- Same current input map as the editor, without calling an authenticated
      -- wrapper inside this private pure-read helper. Only actual stored groups
      -- reach the expensive rule/representative dependency proof.
      select coalesce(jsonb_object_agg(s,operations_private.hub_input_fingerprint_v1(s,v_source)),'{}'::jsonb)
      into v_fp from unnest(v_group.member_skus) s;
      v_groups:=v_groups||jsonb_build_array(jsonb_build_object('source_channel',v_source,
        'seller_product_code',v_group.product_code,'revision',v_group.revision,'mapping_fingerprint',v_group.fingerprint,
        'mapping_valid',v_group.revision=0 or v_group.stored_fingerprint=v_group.fingerprint,
        'input_fingerprints',v_fp,'snapshot_id',v_snapshot,'sellpia_snapshot_id',v_sellpia_snapshot,
        'source_observed_at',v_sellpia_observed_at,'sellpia_prices',v_sellpia_prices,'targets',v_targets));
    else
      select coalesce(jsonb_agg((t-'raw_payload'-'current_state')||jsonb_build_object('component_members',(
        select jsonb_agg(jsonb_build_object('sku',m->>'sellpia_sku_code','component_qty',m->'component_qty',
          'component_role',m->>'component_role','mapping_source',m->>'mapping_source',
          'listing_id',m->'listing_id','component_id',m->'component_id')
          order by m->>'sellpia_sku_code',m->>'mapping_source',(m->>'listing_id')::bigint,(m->>'component_id')::bigint)
        from jsonb_array_elements(v_members) m where btrim(m->>'product_code')=v_group.product_code
          and coalesce(nullif(btrim(m->>'option_code'),''),'')=t->>'seller_option_code'
      )) order by t->>'seller_option_code'),'[]'::jsonb) into v_absence_targets from jsonb_array_elements(v_targets) t;
      v_absence:=v_absence||jsonb_build_array(jsonb_build_object('source_channel',v_source,
        'seller_product_code',v_group.product_code,'revision',0,'mapping_valid',true,
        'mapping_fingerprint',v_group.fingerprint,'snapshot_id',v_snapshot,'sellpia_snapshot_id',v_sellpia_snapshot,
        'source_observed_at',v_sellpia_observed_at,'sellpia_prices',v_sellpia_prices,'targets',v_absence_targets));
    end if;
  end loop;

  -- Preserve the existing current-state projection and its invalid orphan rows.
  with members as(
    select * from jsonb_to_recordset(v_members) m(product_code text,option_code text,sellpia_sku_code text)
  ), rows as(
    select distinct m.sellpia_sku_code sku,s.source_channel,s.seller_product_code,s.seller_option_code,
      s.price,s.event_id,s.revision,s.decision_source,s.effective_at,
      (g.revision is not null and g.mapping_fingerprint=v_mapping_fps->>s.seller_product_code) mapping_valid
    from members m join operations_private.hub_effective_price_states s on s.source_channel=v_source
      and s.seller_product_code=btrim(m.product_code) and s.seller_option_code=coalesce(nullif(btrim(m.option_code),''),'')
    left join operations_private.hub_price_decision_groups g on g.source_channel=s.source_channel and g.seller_product_code=s.seller_product_code
    where m.sellpia_sku_code=any(p_skus)
    union all
    select s.sellpia_sku_code,s.source_channel,s.seller_product_code,s.seller_option_code,s.price,s.event_id,
      s.revision,s.decision_source,s.effective_at,false from operations_private.hub_effective_price_states s
    where s.source_channel=v_source and s.sellpia_sku_code=any(p_skus) and not exists(
      select 1 from members m where m.sellpia_sku_code=s.sellpia_sku_code and btrim(m.product_code)=s.seller_product_code
        and coalesce(nullif(btrim(m.option_code),''),'')=s.seller_option_code)
  ) select coalesce(jsonb_agg(to_jsonb(rows) order by sku,source_channel,seller_product_code,seller_option_code),'[]'::jsonb)
  into v_rows from rows;
  return jsonb_build_object('rows',v_rows,'groups',v_groups,'proof_version','sellpia-export-v1',
    'absence_proofs',v_absence,'snapshots',jsonb_build_object('seller_snapshot_id',v_snapshot,
      'sellpia_snapshot_id',v_sellpia_snapshot,'sellpia_observed_at',v_sellpia_observed_at));
end $$;

create function operations_private.hub_price_decision_export_payload_v3(p_source text,p_skus text[])
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
  v_result:=operations_private.hub_price_decision_export_base_v3(p_source,p_skus);
  v_snapshot:=(v_result->'snapshots'->>'seller_snapshot_id')::uuid;
  v_sellpia_snapshot:=(v_result->'snapshots'->>'sellpia_snapshot_id')::uuid;
  v_observed_at:=(v_result->'snapshots'->>'sellpia_observed_at')::timestamptz;

  -- Mirror loadCarrierSellerMappings: cached identities survive unless an
  -- active identity has a nonempty component-owner set excluding that SKU.
  -- An active listing with no components retains the established cache fallback.
  -- Explicit owners are added, and exact source/SKU/identity suppressions apply
  -- to both branches. No legacy/canonical ownership is promoted by this proof.
  -- Project only the whitelisted channel identity fields once. A materialized
  -- narrow cache avoids repeating a full CASE-expression scan per product and
  -- never mixes an identity from a different marketplace into this proof.
  with requested as materialized(select distinct unnest(p_skus) sku),
  cache_rows as materialized(
    select c.sellpia_sku_code,
      case v_source when 'smartstore' then c.smartstore_product_code when 'makeshop' then c.makeshop_product_code when 'ably' then c.ably_product_code end product_code,
      case v_source when 'smartstore' then c.smartstore_option_code when 'makeshop' then c.makeshop_option_code when 'ably' then c.ably_option_code end option_code
    from operations_private.operations_hub_matrix_export_cache c
  ), products as materialized(
    select distinct product_code from(
      select c.product_code from requested r
      join cache_rows c on c.sellpia_sku_code=r.sku
      where nullif(btrim(c.product_code),'') is not null
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
    select btrim(c.sellpia_sku_code) sku,btrim(c.product_code) product_code,
      btrim(coalesce(c.option_code,'')) option_code,'carrier_cache'::text mapping_source,
      null::bigint listing_id,null::bigint component_id,1::numeric component_qty,'primary'::text component_role
    from products p join cache_rows c on c.product_code=p.product_code
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
  if v_max_siblings>5000 or v_total_members>20000 then raise exception '가격 결정 그룹이 요청 크기 제한을 넘었습니다.';end if;

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

create function public.hub_price_decision_export_read_v3(p_session_token text,p_source text,p_skus text[])
returns jsonb language plpgsql stable security definer set search_path=pg_catalog set statement_timeout='20s' as $$
begin
  perform operations_private.require_operations_hub_operator_session(p_session_token);
  return operations_private.hub_price_decision_export_payload_v3(p_source,p_skus);
end $$;

revoke all on function operations_private.hub_price_decision_export_base_v3(text,text[]) from public,anon,authenticated,service_role;
revoke all on function operations_private.hub_price_decision_export_payload_v3(text,text[]) from public,anon,authenticated,service_role;
revoke all on function public.hub_price_decision_export_read_v3(text,text,text[]) from public,anon,authenticated,service_role;
grant execute on function public.hub_price_decision_export_read_v3(text,text,text[]) to anon,authenticated;
notify pgrst,'reload schema';
