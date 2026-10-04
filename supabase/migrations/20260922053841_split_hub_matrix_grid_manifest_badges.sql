-- Keep Matrix bootstrap metadata independent of the full-dataset relationship
-- scan. Badge values still come from the existing canonical v2 projection, but
-- only for the SKU keys in one bounded feed page.

create or replace function public.hub_matrix_grid_manifest_v6(
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

  return jsonb_build_object(
    'contract_version', 6,
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
    'server_ms', round(extract(epoch from (clock_timestamp() - v_started_at)) * 1000, 2)
  );
end;
$function$;

revoke all on function public.hub_matrix_grid_manifest_v6(text,integer) from public;
revoke all on function public.hub_matrix_grid_manifest_v6(text,integer) from anon, authenticated;
grant execute on function public.hub_matrix_grid_manifest_v6(text,integer) to anon, authenticated, service_role;

comment on function public.hub_matrix_grid_manifest_v6(text,integer) is
  'Session-gated Matrix Grid manifest with tag catalog and keyset cursors, excluding full-dataset link badges.';

create or replace function public.hub_matrix_grid_link_badges_v1(
  p_session_token text,
  p_dataset_version timestamptz,
  p_skus text[]
) returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog'
set statement_timeout to '8s'
set jit to 'off'
set plan_cache_mode to 'force_custom_plan'
as $function$
declare
  v_started_at timestamptz := clock_timestamp();
  v_current_version timestamptz;
  v_skus text[];
  v_link_badges jsonb;
begin
  perform operations_private.require_operations_hub_operator_session(p_session_token);

  if p_dataset_version is null then
    raise exception 'Matrix Grid badge dataset version is required.';
  end if;
  if p_skus is null or cardinality(p_skus) not between 1 and 4000 then
    raise exception 'Matrix Grid badge SKU count must be 1~4,000.';
  end if;
  if exists (
    select 1 from unnest(p_skus) requested(sku)
    where requested.sku is null
       or btrim(requested.sku) = ''
       or length(requested.sku) > 128
  ) then
    raise exception 'Matrix Grid badge request contains invalid SKU.';
  end if;

  select array_agg(distinct btrim(requested.sku) order by btrim(requested.sku))
    into v_skus
  from unnest(p_skus) requested(sku);

  select max(cache_refreshed_at)
    into v_current_version
  from operations_private.operations_hub_matrix_export_cache;
  if v_current_version is distinct from p_dataset_version then
    raise exception 'Matrix Grid cache changed while loading link badges. Reload the dataset.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_array(
    badge.sellpia_sku_code,
    badge.source_channel,
    badge.max_component_count,
    badge.relation_type
  ) order by badge.sellpia_sku_code, badge.source_channel), '[]'::jsonb)
    into v_link_badges
  from public.get_operations_hub_sku_link_badges_v2(v_skus) badge;

  return jsonb_build_object(
    'contract_version', 1,
    'dataset_version', v_current_version,
    'requested', cardinality(v_skus),
    'link_badges', v_link_badges,
    'server_ms', round(extract(epoch from (clock_timestamp() - v_started_at)) * 1000, 2)
  );
end;
$function$;

revoke all on function public.hub_matrix_grid_link_badges_v1(text,timestamptz,text[]) from public;
revoke all on function public.hub_matrix_grid_link_badges_v1(text,timestamptz,text[]) from anon, authenticated;
grant execute on function public.hub_matrix_grid_link_badges_v1(text,timestamptz,text[]) to anon, authenticated, service_role;

comment on function public.hub_matrix_grid_link_badges_v1(text,timestamptz,text[]) is
  'Session-gated canonical seller-link badges for at most one 4,000-SKU Matrix Grid page at a fixed cache version.';
