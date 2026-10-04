-- Lightweight, session-gated search for the tag manager's "apply to SKU" list.
-- Search reads the latest ready Sellpia snapshot's four display fields and
-- product identity only;
-- tag assignment is checked only for the bounded result page.
create or replace function public.hub_tag_member_search_v2(
  p_session_token text,
  p_tag_id uuid,
  p_search text,
  p_page integer default 1,
  p_page_size integer default 100
) returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog'
set statement_timeout to '15s'
set jit to 'off'
as $function$
declare
  v_query text := lower(btrim(coalesce(p_search, '')));
  v_page integer := greatest(1, coalesce(p_page, 1));
  v_page_size integer := least(100, greatest(1, coalesce(p_page_size, 100)));
  v_snapshot_id uuid;
  v_count integer;
  v_rows jsonb;
begin
  perform operations_private.require_operations_hub_operator_session(p_session_token);

  if not exists (
    select 1 from public.product_tags tag
    where tag.tag_id = p_tag_id and tag.is_active
  ) then
    raise exception '활성 태그를 찾지 못했습니다.';
  end if;
  if v_query = '' or length(v_query) > 100 then
    raise exception '검색어는 1~100자여야 합니다.';
  end if;
  if v_page > 1000 then
    raise exception '검색 페이지는 1~1,000이어야 합니다.';
  end if;

  select snapshot.snapshot_id into v_snapshot_id
  from public.sellpia_stock_snapshots snapshot
  where snapshot.upload_status = 'ready'
  order by snapshot.completed_at desc nulls last,
    snapshot.created_at desc, snapshot.snapshot_id desc
  limit 1;

  if v_snapshot_id is null then
    return jsonb_build_object(
      'tag_id', p_tag_id, 'page', v_page, 'page_size', v_page_size,
      'count', 0, 'rows', '[]'::jsonb
    );
  end if;

  with matched as materialized (
    select source.sellpia_sku_code,
      source.own_sku,
      source.sellpia_product_code,
      source.sellpia_product_name,
      source.sellpia_option_name
    from public.sellpia_stock_snapshot_rows source
    where source.snapshot_id = v_snapshot_id
      and (
        strpos(lower(source.sellpia_sku_code), v_query) > 0
        or strpos(lower(coalesce(source.own_sku, '')), v_query) > 0
        or strpos(lower(coalesce(source.sellpia_product_name, '')), v_query) > 0
        or strpos(lower(coalesce(source.sellpia_option_name, '')), v_query) > 0
      )
  ), page_rows as materialized (
    select matched.* from matched
    order by matched.sellpia_sku_code
    limit v_page_size offset (v_page - 1) * v_page_size
  )
  select
    (select count(*)::integer from matched),
    (select coalesce(jsonb_agg(jsonb_build_object(
      'sellpia_sku_code', page.sellpia_sku_code,
      'own_sku', page.own_sku,
      'sellpia_product_name', page.sellpia_product_name,
      'sellpia_option_name', page.sellpia_option_name,
      'tag_applied', exists (
        select 1 from public.sellpia_tag_assignments assignment
        where assignment.tag_id = p_tag_id
          and assignment.is_active
          and ((assignment.tag_scope = 'option' and assignment.sellpia_sku_code = page.sellpia_sku_code)
            or (assignment.tag_scope = 'product' and assignment.sellpia_product_code = page.sellpia_product_code))
      )
    ) order by page.sellpia_sku_code), '[]'::jsonb) from page_rows page)
  into v_count, v_rows;

  return jsonb_build_object(
    'tag_id', p_tag_id,
    'page', v_page,
    'page_size', v_page_size,
    'count', v_count,
    'rows', v_rows
  );
end;
$function$;

revoke all on function public.hub_tag_member_search_v2(text,uuid,text,integer,integer) from public;
revoke all on function public.hub_tag_member_search_v2(text,uuid,text,integer,integer) from anon, authenticated;
grant execute on function public.hub_tag_member_search_v2(text,uuid,text,integer,integer)
  to anon, authenticated, service_role;

comment on function public.hub_tag_member_search_v2(text,uuid,text,integer,integer) is
  'Session-gated latest Sellpia snapshot scalar search with bounded option and product tag-application state per page.';

notify pgrst, 'reload schema';
