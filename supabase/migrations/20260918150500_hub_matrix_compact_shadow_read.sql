-- Full current cell state; unused seller calculation history and dependency JSON are drawer-only.
CREATE OR REPLACE FUNCTION operations_private.hub_matrix_shadow_compact_payload_v1(p_source text, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog'
 SET statement_timeout TO '15s'
 SET jit TO 'off'
AS $function$
declare vid uuid; sid uuid; version_no integer; result jsonb; active_rows jsonb; full_payload jsonb;
begin
 if p_source is null or p_source not in ('smartstore','makeshop','ably') or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) not between 1 and 200 or pg_column_size(p_rows)>262144 then raise exception 'invalid bounded shadow scope';end if;
 if exists(select 1 from jsonb_array_elements(p_rows) x where length(coalesce(x->>'sku','')) not between 1 and 128 or length(coalesce(x->>'product_code',''))>128 or length(coalesce(x->>'option_code',''))>128 or length(coalesce(x->'carrier'->>'seller_product_code',''))>128 or length(coalesce(x->'carrier'->>'full_option_label',''))>2048) then raise exception 'invalid shadow identity';end if;
 if exists(select 1 from jsonb_array_elements(p_rows) x group by x->>'sku' having count(*)>1) then raise exception 'duplicate shadow SKU';end if;
 select h.current_version_id,v.source_snapshot_id,v.version into vid,sid,version_no from operations_private.hub_baseline_heads h join operations_private.hub_baseline_versions v on v.id=h.current_version_id where h.source=p_source and h.mode='shadow';
 if sid is null then
  with recursive ancestry as (select id,previous_version_id,source_snapshot_id from operations_private.hub_baseline_versions where id=vid union all select v.id,v.previous_version_id,v.source_snapshot_id from operations_private.hub_baseline_versions v join ancestry a on v.id=a.previous_version_id) select source_snapshot_id into sid from ancestry where source_snapshot_id is not null limit 1;
 end if;
 EXECUTE $matrix_query$
select jsonb_agg(jsonb_build_object('sku',x->>'sku','product_code',x->>'product_code','option_code',coalesce(x->>'option_code',''),
  'baseline',b.facts,'snapshot',case when r.product_code is null then null else jsonb_build_object('stock',r.stock,'price',jsonb_build_object('base',r.base_price,'discounted',r.discounted_base_price,'option',r.option_price,'final',r.final_price,'terms',coalesce(r.discount_terms,'[]'::jsonb))) end,
  'candidates',coalesce((select jsonb_agg(jsonb_build_object('product_code',br.product_code,'option_code',br.option_code,'option_name',sr.option_name,'facts',br.facts,'source_row_no',br.source_row_no)) from operations_private.hub_baseline_rows br join public.seller_inventory_snapshot_rows sr on sr.snapshot_id=$4 and sr.product_code=br.product_code and coalesce(sr.option_code,'')=br.option_code where br.version_id=$3 and br.product_code=x->'carrier'->>'seller_product_code' and sr.option_name=x->'carrier'->>'full_option_label'),'[]'::jsonb),
  'declared_links',coalesce((select jsonb_agg(z) from (select distinct c.sellpia_sku_code sku,l.product_code,coalesce(l.option_code,'') option_code from public.operations_hub_listing_components c join public.operations_hub_seller_listings l on l.listing_id=c.listing_id where c.is_active and l.is_active and l.source_channel=$2 and c.sellpia_sku_code=x->>'sku' union select m.sellpia_sku_code,m.product_code,coalesce(m.option_code,'') from public.operations_hub_manual_links m where m.source_channel=$2 and m.sellpia_sku_code=x->>'sku' union select ca.sellpia_sku_code,case $2 when 'smartstore' then ca.smartstore_product_code when 'makeshop' then ca.makeshop_product_code when 'ably' then ca.ably_product_code end,coalesce(case $2 when 'smartstore' then ca.smartstore_option_code when 'makeshop' then ca.makeshop_option_code when 'ably' then ca.ably_option_code end,'') from operations_private.operations_hub_matrix_export_cache ca where ca.sellpia_sku_code=x->>'sku' and coalesce(case $2 when 'smartstore' then ca.smartstore_product_code when 'makeshop' then ca.makeshop_product_code when 'ably' then ca.ably_product_code end,'')<>'') z),'[]'::jsonb),
  'current_rules','[]'::jsonb,
  'calculated',coalesce((select jsonb_agg(to_jsonb(cr)) from operations_private.hub_calculated_results cr where cr.sku=x->>'sku' and cr.scope=''),'[]'::jsonb),
  'draft_markers',coalesce((select jsonb_agg(jsonb_build_object('change_id',q.change_id,'base_price_source',q.base_price_source,'option_price_source',q.option_price_source,'pricing_input_mode',q.pricing_input_mode)) from public.operations_hub_change_queue q where q.sellpia_sku_code=x->>'sku' and q.source_channel=$2 and q.status in ('pending','validated','processing','failed')),'[]'::jsonb),
  'source_delta',(select jsonb_build_object('before',d.before_values,'after',d.after_values,'changedFields',d.changed_fields,'ruleImpact',d.rule_impact,'changed',true,'created_at',d.created_at) from operations_private.hub_source_deltas d where ((d.source in ('sellpia',$2) and d.identity=x->>'sku') or d.rule_impact->'affectedSkus' ? (x->>'sku')) order by d.created_at desc limit 1)
 ) order by x->>'sku')
 from jsonb_array_elements($1) x left join operations_private.hub_baseline_rows b on b.version_id=$3 and b.product_code=x->>'product_code' and b.option_code=coalesce(x->>'option_code','') left join public.seller_inventory_snapshot_rows r on r.snapshot_id=$4 and r.product_code=b.product_code and coalesce(r.option_code,'')=b.option_code
$matrix_query$ INTO result USING p_rows,p_source,vid,sid;
 -- Managed seller prices retain the complete original dependency/version proof.
 select jsonb_agg(x) into active_rows from jsonb_array_elements(p_rows) x where exists(
  select 1 from operations_private.hub_rule_assignments a join operations_private.hub_rules ru on ru.id=a.rule_id
  where a.sku=x->>'sku' and a.scope=p_source and ru.is_active and ru.scope=a.scope and ru.target_field=a.target_field and left(ru.target_field,9)='platform_'
 );
 if active_rows is not null then
  full_payload:=operations_private.hub_matrix_shadow_payload_v1(p_source,active_rows);
  select jsonb_agg(coalesce(f.value,c.value) order by c.value->>'sku') into result
  from jsonb_array_elements(result) c left join jsonb_array_elements(full_payload->'rows') f on f.value->>'sku'=c.value->>'sku';
 end if;
 return jsonb_build_object('source',p_source,'mode','shadow','compact',true,'version_id',vid,'version',version_no,'snapshot_id',sid,'rows',coalesce(result,'[]'::jsonb));
end $function$;
REVOKE ALL ON FUNCTION operations_private.hub_matrix_shadow_compact_payload_v1(text,jsonb) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION operations_private.hub_matrix_shadow_compact_batch_v1(p_session_token text,p_source text,p_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog' SET statement_timeout TO '15s' SET jit TO 'off'
AS $rpc$ BEGIN
 PERFORM operations_private.require_operations_hub_operator_session(p_session_token);
 RETURN operations_private.hub_matrix_shadow_compact_payload_v1(p_source,p_rows);
END $rpc$;
REVOKE ALL ON FUNCTION operations_private.hub_matrix_shadow_compact_batch_v1(text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operations_private.hub_matrix_shadow_compact_batch_v1(text,text,jsonb) TO anon,authenticated;
CREATE FUNCTION public.hub_matrix_shadow_compact_batch_v1(p_session_token text,p_source text,p_rows jsonb)
RETURNS jsonb LANGUAGE sql STABLE SET search_path TO 'pg_catalog'
AS $rpc$ SELECT operations_private.hub_matrix_shadow_compact_batch_v1(p_session_token,p_source,p_rows); $rpc$;
REVOKE ALL ON FUNCTION public.hub_matrix_shadow_compact_batch_v1(text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hub_matrix_shadow_compact_batch_v1(text,text,jsonb) TO anon,authenticated,service_role;
