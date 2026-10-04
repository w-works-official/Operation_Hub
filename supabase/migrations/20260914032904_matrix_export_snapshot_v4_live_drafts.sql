-- Incremental v4: use live active seller drafts and expose per-field generations.
create index if not exists seller_inventory_snapshot_rows_export_lookup_idx
  on public.seller_inventory_snapshot_rows(snapshot_id,product_code,(coalesce(option_code,'')))
  include (source_row_no,stock,base_price,discounted_base_price,option_price,final_price,discount_terms,raw_payload);

create or replace function public.hub_matrix_export_snapshot_v1(
  p_session_token text,
  p_source_channel text,
  p_skus text[] default null,
  p_after_sku text default null,
  p_limit integer default 1000
) returns jsonb
language plpgsql
security definer
set search_path=pg_catalog
set statement_timeout='20s'
as $$
declare
  v_session jsonb;
  v_source text := lower(btrim(coalesce(p_source_channel,'')));
  v_snapshot_id uuid;
  v_limit integer := greatest(50,least(coalesce(p_limit,1000),2000));
  v_rows jsonb;
  v_next text;
  v_count integer;
begin
  v_session := operations_private.require_operations_hub_operator_session(p_session_token);
  if v_source not in ('smartstore','makeshop') then raise exception '지원하지 않는 판매처입니다.'; end if;

  select s.snapshot_id into v_snapshot_id
  from public.seller_inventory_snapshots s
  where s.source_channel=v_source and s.upload_status='ready'
  order by coalesce(s.completed_at,s.created_at) desc, s.created_at desc
  limit 1;
  if v_snapshot_id is null then raise exception '최신 판매처 원본 스냅샷이 없습니다.'; end if;

  with base as (
    select m.sellpia_sku_code,om.stock_quantity as system_stock,
      case v_source when 'smartstore' then m.smartstore_product_code else m.makeshop_product_code end as product_code,
      case v_source when 'smartstore' then coalesce(m.smartstore_option_code,'') else coalesce(m.makeshop_option_code,'') end as option_code,
      case v_source when 'smartstore' then m.smartstore_stock else m.makeshop_stock end as seller_stock,
      case v_source when 'smartstore' then m.smartstore_price else m.makeshop_price end as seller_price
    from operations_private.operations_hub_matrix_export_cache m
    left join public.operations_hub_sku_operational_master om on om.sellpia_sku_code=m.sellpia_sku_code
    where nullif(btrim(case v_source when 'smartstore' then m.smartstore_product_code else m.makeshop_product_code end),'') is not null
      and (p_after_sku is null or m.sellpia_sku_code > p_after_sku)
      and (p_skus is null or cardinality(p_skus)=0 or m.sellpia_sku_code=any(p_skus))
    order by m.sellpia_sku_code limit v_limit
  ), enriched as (
    select b.*,r.source_row_no,r.raw_payload->>'source_file_name' as source_file_name,
      r.stock as source_stock,r.base_price as source_base_price,r.discounted_base_price as source_discounted_base_price,
      r.option_price as source_option_price,r.final_price as source_final_price,coalesce(r.discount_terms,'[]'::jsonb) as source_discount_terms,
      to_jsonb(sd) as stock_draft,to_jsonb(pd) as price_draft,
      cr.value as registration_price,cr.status as registration_status,cr.error as registration_error,cr.result_details as registration_details,
      cd.value as discount_price,cd.status as discount_status,cd.error as discount_error,cd.result_details as discount_details,
      co.value as option_price,co.status as option_status,co.error as option_error,co.result_details as option_details,
      cf.value as final_price,cf.status as final_status,cf.error as final_error,cf.result_details as final_details,
      cr.generation_id as registration_generation_id,cd.generation_id as discount_generation_id,
      co.generation_id as option_generation_id,cf.generation_id as final_generation_id,
      coalesce(cf.rule_versions,'[]'::jsonb) as rule_versions,
      greatest(cr.generation_id,cd.generation_id,co.generation_id,cf.generation_id) as generation_id
    from base b
    left join public.seller_inventory_snapshot_rows r
      on r.snapshot_id=v_snapshot_id and r.product_code=b.product_code and coalesce(r.option_code,'')=b.option_code
    left join public.operations_hub_active_seller_drafts sd
      on sd.sellpia_sku_code=b.sellpia_sku_code and sd.source_channel=v_source and sd.field_key='sellpia_current_stock'
    left join public.operations_hub_active_seller_drafts pd
      on pd.sellpia_sku_code=b.sellpia_sku_code and pd.source_channel=v_source and pd.field_key='sellpia_sale_price'
    left join operations_private.hub_calculated_results cr
      on cr.sku=b.sellpia_sku_code and cr.scope=v_source and cr.field='platform_registration_price'
    left join operations_private.hub_calculated_results cd
      on cd.sku=b.sellpia_sku_code and cd.scope=v_source and cd.field='platform_discount_price'
    left join operations_private.hub_calculated_results co
      on co.sku=b.sellpia_sku_code and co.scope=v_source and co.field='platform_option_price'
    left join operations_private.hub_calculated_results cf
      on cf.sku=b.sellpia_sku_code and cf.scope=v_source and cf.field='platform_final_price'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'sku',sellpia_sku_code,'product_code',product_code,'option_code',option_code,'system_stock',system_stock,
      'seller_stock',seller_stock,'seller_price',seller_price,'source_row_no',source_row_no,'source_file_name',source_file_name,
      'source_stock',source_stock,'source_base_price',source_base_price,'source_discounted_base_price',source_discounted_base_price,
      'source_option_price',source_option_price,'source_final_price',source_final_price,'source_discount_terms',source_discount_terms,
      'stock_draft',stock_draft,'price_draft',price_draft,
      'registration_price',registration_price,'registration_status',registration_status,'registration_error',registration_error,'registration_details',registration_details,
      'discount_price',discount_price,'discount_status',discount_status,'discount_error',discount_error,'discount_details',discount_details,
      'option_price',option_price,'option_status',option_status,'option_error',option_error,'option_details',option_details,
      'final_price',final_price,'final_status',final_status,'final_error',final_error,'final_details',final_details,
      'registration_generation_id',registration_generation_id,'discount_generation_id',discount_generation_id,
      'option_generation_id',option_generation_id,'final_generation_id',final_generation_id,
      'rule_versions',rule_versions,'generation_id',generation_id
    ) order by sellpia_sku_code),'[]'::jsonb),max(sellpia_sku_code),count(*)
  into v_rows,v_next,v_count from enriched;

  return jsonb_build_object('source',v_source,'snapshot_id',v_snapshot_id,'rows',v_rows,
    'next_cursor',v_next,'has_more',v_count=v_limit,'count',v_count);
end
$$;

revoke all on function public.hub_matrix_export_snapshot_v1(text,text,text[],text,integer) from public;
grant execute on function public.hub_matrix_export_snapshot_v1(text,text,text[],text,integer) to anon,authenticated;
notify pgrst,'reload schema';
