-- Tune the optimized v5 feed to sequential 3,000-row pages. Read-only
-- production EXPLAIN under two concurrent calls stayed near three seconds.

create or replace function public.hub_matrix_grid_manifest_v5(
  p_session_token text,
  p_chunk_size integer default 2000
) returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog'
set statement_timeout to '8s'
set jit to 'off'
as $function$
declare
  v_started_at timestamptz := clock_timestamp();
  v_total integer;
  v_dataset_version timestamptz;
  v_tag_catalog jsonb;
  v_link_badges jsonb;
begin
  perform operations_private.require_operations_hub_operator_session(p_session_token);

  if p_chunk_size is null or p_chunk_size not between 250 and 4000 then
    raise exception 'Matrix Grid manifest chunk size는 250~4,000이어야 합니다.';
  end if;

  select count(*)::integer, max(cache_refreshed_at)
    into v_total, v_dataset_version
  from operations_private.operations_hub_matrix_export_cache;

  select coalesce(jsonb_object_agg(tag.tag_id::text, jsonb_strip_nulls(jsonb_build_object(
    'name', tag.tag_name,
    'color', tag.tag_color,
    'group', tag.tag_group
  ))), '{}'::jsonb)
    into v_tag_catalog
  from public.product_tags tag
  where tag.is_active;

  select coalesce(jsonb_agg(jsonb_build_array(
    badge.sellpia_sku_code,
    badge.source_channel,
    badge.max_component_count,
    badge.relation_type
  ) order by badge.sellpia_sku_code, badge.source_channel), '[]'::jsonb)
    into v_link_badges
  from public.get_operations_hub_sku_link_badges_v2(
    (select array_agg(cache.sellpia_sku_code order by cache.sellpia_sku_code)
     from operations_private.operations_hub_matrix_export_cache cache)
  ) badge;

  return jsonb_build_object(
    'contract_version', 5,
    'total', v_total,
    'dataset_version', v_dataset_version,
    'recommended_chunk_size', 3000,
    'max_chunk_size', 4000,
    'page_cursors', (
      select jsonb_agg(cursor.after_sku order by cursor.page_number)
      from (
        select ((rn - 1) / p_chunk_size + 1)::integer page_number,
          lag(sellpia_sku_code) over (order by rn) after_sku,
          rn
        from (
          select sellpia_sku_code,
            row_number() over (order by sellpia_sku_code) rn
          from operations_private.operations_hub_matrix_export_cache
        ) numbered
      ) cursor
      where (cursor.rn - 1) % p_chunk_size = 0
    ),
    'tag_catalog', v_tag_catalog,
    'link_badges', v_link_badges,
    'server_ms', round(extract(epoch from (clock_timestamp() - v_started_at)) * 1000, 2)
  );
end;
$function$;

