-- Narrow read-only path: no Matrix pagination, seller projection, or baseline commit.
create function operations_private.hub_sellpia_patch_read_v1(
 p_session_token text,p_skus text[] default null,p_search text default '',p_search_type text default 'sku',
 p_offset integer default 0,p_limit integer default 100,p_with_results boolean default true
) returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare snapshot uuid; codes text[]; result jsonb; term text:=btrim(coalesce(p_search,'')); pattern text; exact_match boolean;
begin
 perform operations_private.require_operations_hub_operator_session(p_session_token);
 if p_search_type is null or p_search_type not in ('sku','own_code','name') or p_offset is null or p_offset<0 or p_limit is null or p_limit not between 1 and 500 or cardinality(p_skus)>5000 then raise exception '유효하지 않은 조회 범위';end if;
 select snapshot_id into snapshot from public.sellpia_stock_snapshots where upload_status='ready' order by coalesce(completed_at,created_at) desc,created_at desc,snapshot_id desc limit 1;
 pattern:=replace(replace(replace(term,E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_')||'%';
 if p_skus is not null then codes:=p_skus;
 elsif term='' then raise exception 'SKU 또는 검색어를 입력하세요.';
 else
  select exists(select 1 from operations_private.operations_hub_matrix_export_cache c where case p_search_type when 'sku' then c.sellpia_sku_code=term when 'own_code' then coalesce(c.sellpia_own_code,c.own_code)=term else false end) into exact_match;
  select array_agg(c.sellpia_sku_code order by c.sellpia_sku_code) into codes from operations_private.operations_hub_matrix_export_cache c where
   case p_search_type when 'sku' then case when exact_match then c.sellpia_sku_code=term else c.sellpia_sku_code like pattern escape E'\\' end
   when 'own_code' then case when exact_match then coalesce(c.sellpia_own_code,c.own_code)=term else coalesce(c.sellpia_own_code,c.own_code) like pattern escape E'\\' end
   else position(lower(term) in lower(concat_ws(' ',c.sellpia_product_name,c.sellpia_option_name)))>0 end;
 end if;
 with wanted as (select distinct s from unnest(codes) s), selected as (
  select s from wanted order by s offset p_offset limit p_limit
 ), proofs as materialized (select s,operations_private.hub_sku_input_fingerprint_v1(s,'') fp from selected where p_with_results and exists(select 1 from operations_private.hub_rule_assignments a join operations_private.hub_rules ru on ru.id=a.rule_id and ru.is_active where a.sku=s and a.scope='')), rows as (
 select jsonb_build_object('sellpia_sku_code',s,'sellpia_product_code',raw.sellpia_product_code,
 'sellpia_product_name',raw.sellpia_product_name,'sellpia_option_name',raw.sellpia_option_name,'own_code',c.own_code,
 'sellpia_source_purchase_price',raw.purchase_price,'sellpia_purchase_price',coalesce(m.purchase_price,raw.purchase_price),
 'sellpia_source_sale_price',c.sellpia_sale_price,'sellpia_source_stock',raw.stock,'system_base_price',m.base_price,'system_stock',m.stock_quantity,
 '__missing',raw.sellpia_sku_code is null,
 '__hubInternalPrices',case when p_with_results then coalesce((select jsonb_object_agg(r.field,jsonb_build_object(
 'value',r.value,'error',r.error,'generationId',r.generation_id,'versions',r.rule_versions,
 'activeOutputRules',(select coalesce(jsonb_agg(jsonb_build_object('id',ru.id,'name',ru.name,'version',ru.version,'assignmentVersion',a.version)),'[]') from operations_private.hub_rule_assignments a join operations_private.hub_rules ru on ru.id=a.rule_id and ru.is_active where a.sku=s and a.scope='' and a.target_field=r.field),
 'stale',r.status<>'calculated' or r.result_details->>'input_fingerprint' is distinct from proof.fp))
 from operations_private.hub_calculated_results r where r.sku=s and r.scope='' and r.field in ('actual_inbound_cost','calculated_base_price')),'{}') else '{}'::jsonb end,
 '__activeBaseOwner',exists(select 1 from operations_private.hub_rule_assignments a join operations_private.hub_rules ru on ru.id=a.rule_id and ru.is_active where a.sku=s and a.scope='' and a.target_field='calculated_base_price')
 ) as row from selected
 left join public.sellpia_stock_snapshot_rows raw on raw.snapshot_id=snapshot and raw.sellpia_sku_code=s
 left join public.operations_hub_sku_operational_master m on m.sellpia_sku_code=s
 left join operations_private.operations_hub_matrix_export_cache c on c.sellpia_sku_code=s
 left join proofs proof using(s)
 ) select jsonb_build_object('rows',coalesce(jsonb_agg(row),'[]'),'count',(select count(*) from wanted)) into result from rows;
 return result;
end $$;
revoke all on function operations_private.hub_sellpia_patch_read_v1(text,text[],text,text,integer,integer,boolean) from public;
grant execute on function operations_private.hub_sellpia_patch_read_v1(text,text[],text,text,integer,integer,boolean) to anon,authenticated;
create function public.hub_sellpia_patch_read_v1(p_session_token text,p_skus text[] default null,p_search text default '',p_search_type text default 'sku',p_offset integer default 0,p_limit integer default 100,p_with_results boolean default true)
returns jsonb language sql stable security invoker set search_path=pg_catalog as $$
 select operations_private.hub_sellpia_patch_read_v1(p_session_token,p_skus,p_search,p_search_type,p_offset,p_limit,p_with_results)
$$;
revoke all on function public.hub_sellpia_patch_read_v1(text,text[],text,text,integer,integer,boolean) from public;
grant execute on function public.hub_sellpia_patch_read_v1(text,text[],text,text,integer,integer,boolean) to anon,authenticated;
notify pgrst,'reload schema';
