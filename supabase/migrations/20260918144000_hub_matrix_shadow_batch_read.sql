CREATE OR REPLACE FUNCTION operations_private.hub_matrix_shadow_payload_batch_v1(p_source text, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog'
 SET statement_timeout TO '15s'
AS $function$
declare vid uuid; sid uuid; version_no integer; result jsonb;
begin
 if p_source is null or p_source not in ('smartstore','makeshop','ably') or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) not between 1 and 200 or pg_column_size(p_rows)>262144 then raise exception 'invalid bounded shadow scope';end if;
 if exists(select 1 from jsonb_array_elements(p_rows) x where length(coalesce(x->>'sku','')) not between 1 and 128 or length(coalesce(x->>'product_code',''))>128 or length(coalesce(x->>'option_code',''))>128 or length(coalesce(x->'carrier'->>'seller_product_code',''))>128 or length(coalesce(x->'carrier'->>'full_option_label',''))>2048) then raise exception 'invalid shadow identity';end if;
 if exists(select 1 from jsonb_array_elements(p_rows) x group by x->>'sku' having count(*)>1) then raise exception 'duplicate shadow SKU';end if;
 select h.current_version_id,v.source_snapshot_id,v.version into vid,sid,version_no from operations_private.hub_baseline_heads h join operations_private.hub_baseline_versions v on v.id=h.current_version_id where h.source=p_source and h.mode='shadow';
 if sid is null then
  with recursive ancestry as (select id,previous_version_id,source_snapshot_id from operations_private.hub_baseline_versions where id=vid union all select v.id,v.previous_version_id,v.source_snapshot_id from operations_private.hub_baseline_versions v join ancestry a on v.id=a.previous_version_id) select source_snapshot_id into sid from ancestry where source_snapshot_id is not null limit 1;
 end if;
 with batch as materialized (
 select x,case when nullif(case p_source when 'smartstore' then c.smartstore_product_code when 'makeshop' then c.makeshop_product_code when 'ably' then c.ably_product_code end,'') is null then jsonb_build_array('sku',x->>'sku')::text else jsonb_build_array('product',case p_source when 'smartstore' then c.smartstore_product_code when 'makeshop' then c.makeshop_product_code when 'ably' then c.ably_product_code end)::text end scope_key
 from jsonb_array_elements(p_rows) x left join operations_private.operations_hub_matrix_export_cache c on c.sellpia_sku_code=x->>'sku'
 ), grouped as materialized (select scope_key,min(x->>'sku') seed from batch group by scope_key),
 scopes as materialized (select scope_key,operations_private.hub_input_scope_v1(seed,p_source) skus from grouped)
 select jsonb_agg(jsonb_build_object('sku',x->>'sku','product_code',x->>'product_code','option_code',coalesce(x->>'option_code',''),
  'baseline',b.facts,'snapshot',case when r.product_code is null then null else jsonb_build_object('stock',r.stock,'price',jsonb_build_object('base',r.base_price,'discounted',r.discounted_base_price,'option',r.option_price,'final',r.final_price,'terms',coalesce(r.discount_terms,'[]'::jsonb))) end,
  'candidates',coalesce((select jsonb_agg(jsonb_build_object('product_code',br.product_code,'option_code',br.option_code,'option_name',sr.option_name,'facts',br.facts,'source_row_no',br.source_row_no)) from operations_private.hub_baseline_rows br join public.seller_inventory_snapshot_rows sr on sr.snapshot_id=sid and sr.product_code=br.product_code and coalesce(sr.option_code,'')=br.option_code where br.version_id=vid and br.product_code=x->'carrier'->>'seller_product_code' and sr.option_name=x->'carrier'->>'full_option_label'),'[]'::jsonb),
  'declared_links',coalesce((select jsonb_agg(z) from (select distinct c.sellpia_sku_code sku,l.product_code,coalesce(l.option_code,'') option_code from public.operations_hub_listing_components c join public.operations_hub_seller_listings l on l.listing_id=c.listing_id where c.is_active and l.is_active and l.source_channel=p_source and c.sellpia_sku_code=x->>'sku' union select m.sellpia_sku_code,m.product_code,coalesce(m.option_code,'') from public.operations_hub_manual_links m where m.source_channel=p_source and m.sellpia_sku_code=x->>'sku' union select ca.sellpia_sku_code,case p_source when 'smartstore' then ca.smartstore_product_code when 'makeshop' then ca.makeshop_product_code when 'ably' then ca.ably_product_code end,coalesce(case p_source when 'smartstore' then ca.smartstore_option_code when 'makeshop' then ca.makeshop_option_code when 'ably' then ca.ably_option_code end,'') from operations_private.operations_hub_matrix_export_cache ca where ca.sellpia_sku_code=x->>'sku' and coalesce(case p_source when 'smartstore' then ca.smartstore_product_code when 'makeshop' then ca.makeshop_product_code when 'ably' then ca.ably_product_code end,'')<>'') z),'[]'::jsonb),
  'current_rules',coalesce((select jsonb_agg(jsonb_build_object('id',ru.id,'version',ru.version,'assignmentVersion',a.version,'name',ru.name,'sku',a.sku,'scope',a.scope,'field',a.target_field) order by a.sku,a.scope,a.target_field) from operations_private.hub_rule_assignments a join operations_private.hub_rules ru on ru.id=a.rule_id where a.sku=any(sc.skus) and ru.is_active),'[]'::jsonb),
  'calculated',coalesce((select jsonb_agg(to_jsonb(cr)) from operations_private.hub_calculated_results cr where cr.sku=x->>'sku' and cr.scope in ('',p_source)),'[]'::jsonb),
  'draft_markers',coalesce((select jsonb_agg(jsonb_build_object('change_id',q.change_id,'base_price_source',q.base_price_source,'option_price_source',q.option_price_source,'pricing_input_mode',q.pricing_input_mode)) from public.operations_hub_change_queue q where q.sellpia_sku_code=x->>'sku' and q.source_channel=p_source and q.status in ('pending','validated','processing','failed')),'[]'::jsonb),
  'source_delta',(select jsonb_build_object('before',d.before_values,'after',d.after_values,'changedFields',d.changed_fields,'ruleImpact',d.rule_impact,'changed',true,'created_at',d.created_at) from operations_private.hub_source_deltas d where ((d.source in ('sellpia',p_source) and d.identity=x->>'sku') or d.rule_impact->'affectedSkus' ? (x->>'sku')) order by d.created_at desc limit 1)
 ) order by x->>'sku') into result
 from batch join scopes sc on sc.scope_key=batch.scope_key left join operations_private.hub_baseline_rows b on b.version_id=vid and b.product_code=x->>'product_code' and b.option_code=coalesce(x->>'option_code','') left join public.seller_inventory_snapshot_rows r on r.snapshot_id=sid and r.product_code=b.product_code and coalesce(r.option_code,'')=b.option_code;
 return jsonb_build_object('source',p_source,'mode','shadow','version_id',vid,'version',version_no,'snapshot_id',sid,'rows',coalesce(result,'[]'::jsonb));
end $function$;

revoke all on function operations_private.hub_matrix_shadow_payload_batch_v1(text,jsonb) from public,anon,authenticated;
create function operations_private.hub_matrix_shadow_metadata_batch_v1(p_session_token text,p_source text,p_rows jsonb) returns jsonb
language plpgsql stable security definer set search_path to 'pg_catalog' set statement_timeout to '15s'
as $rpc$ begin
 perform operations_private.require_operations_hub_operator_session(p_session_token);
 return operations_private.hub_matrix_shadow_payload_batch_v1(p_source,p_rows);
end $rpc$;
revoke all on function operations_private.hub_matrix_shadow_metadata_batch_v1(text,text,jsonb) from public;
grant execute on function operations_private.hub_matrix_shadow_metadata_batch_v1(text,text,jsonb) to anon,authenticated;
create function public.hub_matrix_shadow_metadata_batch_v1(p_session_token text,p_source text,p_rows jsonb) returns jsonb
language sql stable set search_path to 'pg_catalog'
as $rpc$ select operations_private.hub_matrix_shadow_metadata_batch_v1(p_session_token,p_source,p_rows); $rpc$;
revoke all on function public.hub_matrix_shadow_metadata_batch_v1(text,text,jsonb) from public;
grant execute on function public.hub_matrix_shadow_metadata_batch_v1(text,text,jsonb) to anon,authenticated,service_role;
