create or replace view operations_private.operations_hub_matrix_export_source
with (security_invoker = true)
as
with product_tag_rollup as (
  select
    assignments.sellpia_product_code,
    jsonb_agg(
      jsonb_build_object(
        'tag_id', tags.tag_id,
        'tag_name', tags.tag_name,
        'tag_color', tags.tag_color,
        'tag_group', tags.tag_group
      ) order by tags.display_order, tags.tag_name
    ) as items,
    string_agg(tags.tag_name, ' · ' order by tags.display_order, tags.tag_name) as summary
  from public.sellpia_tag_assignments assignments
  join public.product_tags tags on tags.tag_id = assignments.tag_id and tags.is_active
  where assignments.is_active and assignments.tag_scope = 'product'
  group by assignments.sellpia_product_code
),
sku_tag_rollup as (
  select
    assignments.sellpia_sku_code,
    jsonb_agg(
      jsonb_build_object(
        'tag_id', tags.tag_id,
        'tag_name', tags.tag_name,
        'tag_color', tags.tag_color,
        'tag_group', tags.tag_group
      ) order by tags.display_order, tags.tag_name
    ) as items,
    string_agg(tags.tag_name, ' · ' order by tags.display_order, tags.tag_name) as summary
  from public.sellpia_tag_assignments assignments
  join public.product_tags tags on tags.tag_id = assignments.tag_id and tags.is_active
  where assignments.is_active and assignments.tag_scope = 'option'
  group by assignments.sellpia_sku_code
),
draft_rollup as (
  select
    draft.sellpia_sku_code,
    jsonb_object_agg(draft.source_channel || ':' || draft.field_key, to_jsonb(draft)) as payload
  from public.operations_hub_active_seller_drafts draft
  group by draft.sellpia_sku_code
)
select
  matrix.*,
  clock_timestamp() as cache_refreshed_at,
  jsonb_strip_nulls(jsonb_build_object(
    'sellpia_sku_code', matrix.sellpia_sku_code,
    'sellpia_product_code', stock.sellpia_product_code,
    'material', attr.material,
    'product_group', attr.product_group,
    'shape', attr.shape,
    'material_source', attr.material_source,
    'product_group_source', attr.product_group_source,
    'shape_source', attr.shape_source,
    'classifier_version', attr.classifier_version,
    'classified_at', attr.classified_at,
    'updated_by', attr.updated_by,
    'updated_at', attr.updated_at,
    'product_tags', coalesce(product_tags.items, '[]'::jsonb),
    'sku_tags', coalesce(sku_tags.items, '[]'::jsonb),
    'tag_summary', concat_ws(' · ', nullif(product_tags.summary, ''), nullif(sku_tags.summary, ''))
  )) as profile_json,
  coalesce(drafts.payload, '{}'::jsonb) as seller_drafts_json
from public.operations_hub_matrix_live matrix
left join public.sellpia_stock_latest stock on stock.sellpia_sku_code = matrix.sellpia_sku_code
left join catalog.sellpia_product_attributes attr on attr.sellpia_product_code = stock.sellpia_product_code
left join product_tag_rollup product_tags on product_tags.sellpia_product_code = stock.sellpia_product_code
left join sku_tag_rollup sku_tags on sku_tags.sellpia_sku_code = matrix.sellpia_sku_code
left join draft_rollup drafts on drafts.sellpia_sku_code = matrix.sellpia_sku_code;

do $$
begin
  if to_regclass('operations_private.operations_hub_matrix_export_cache') is null then
    execute $create$
      create materialized view operations_private.operations_hub_matrix_export_cache
      as select * from operations_private.operations_hub_matrix_export_source
    $create$;
  end if;
end;
$$;

create unique index if not exists operations_hub_matrix_export_cache_sku_idx
  on operations_private.operations_hub_matrix_export_cache (sellpia_sku_code);

create index if not exists operations_hub_matrix_export_cache_stock_idx
  on operations_private.operations_hub_matrix_export_cache (sellpia_current_stock desc nulls last, sellpia_sku_code);

create index if not exists operations_hub_matrix_export_cache_price_idx
  on operations_private.operations_hub_matrix_export_cache (sellpia_sale_price desc nulls last, sellpia_sku_code);

create index if not exists operations_hub_matrix_export_cache_updated_idx
  on operations_private.operations_hub_matrix_export_cache (updated_at desc nulls last, sellpia_sku_code);

grant usage on schema operations_private to anon, authenticated;
grant select on operations_private.operations_hub_matrix_export_cache to anon, authenticated;

create or replace function operations_private.refresh_operations_hub_matrix_export_cache(
  p_actor text default 'operations_hub_export_cache'
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, operations_private
as $$
declare
  v_actor text := coalesce(nullif(btrim(p_actor), ''), 'operations_hub_export_cache');
  v_started_at timestamptz := clock_timestamp();
  v_row_count integer := 0;
  v_refreshed_at timestamptz;
begin
  if v_actor !~ '^[0-9A-Za-z_.:@-]{3,120}$' then
    raise exception 'actor 형식이 올바르지 않습니다.';
  end if;

  if not pg_try_advisory_xact_lock(hashtextextended('operations_hub_matrix_export_cache_refresh', 0)) then
    return jsonb_build_object('status', 'locked', 'refreshed_by', v_actor);
  end if;

  refresh materialized view concurrently operations_private.operations_hub_matrix_export_cache;

  select count(*), max(cache_refreshed_at)
  into v_row_count, v_refreshed_at
  from operations_private.operations_hub_matrix_export_cache;

  return jsonb_build_object(
    'status', 'refreshed',
    'row_count', v_row_count,
    'refreshed_at', v_refreshed_at,
    'refreshed_by', v_actor,
    'duration_ms', greatest(0, round(extract(epoch from (clock_timestamp() - v_started_at)) * 1000))
  );
end;
$$;

revoke all on function operations_private.refresh_operations_hub_matrix_export_cache(text) from public, anon, authenticated;

do $$
declare
  v_definition text;
  v_rewritten text;
begin
  v_definition := pg_get_functiondef(
    'public.export_operations_hub_matrix_chunk(integer,integer,text,text[],text,text,jsonb,text[])'::regprocedure
  );
  v_rewritten := replace(
    v_definition,
    'from public.operations_hub_matrix_export_cache matrix',
    'from operations_private.operations_hub_matrix_export_cache matrix'
  );

  if v_rewritten = v_definition then
    raise exception 'CSV 내보내기 함수에서 공개 캐시 조회 구문을 찾지 못했습니다.';
  end if;

  execute v_rewritten;
end;
$$;

alter function public.export_operations_hub_matrix_chunk(integer, integer, text, text[], text, text, jsonb, text[])
  set statement_timeout = '20s';

drop table if exists public.operations_hub_matrix_export_cache;

notify pgrst, 'reload schema';
