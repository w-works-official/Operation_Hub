-- Bounded bulk import for seller-specific one-plus-one and set BOMs.
-- Targets remain exact seller listing options. Components remain exact, real
-- Sellpia SKUs; this migration never creates a synthetic Sellpia SKU.

create or replace function public.resolve_operations_hub_seller_bundle_import_rows_v1(
  p_rows jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
set statement_timeout = '10s'
as $$
declare
  v_item jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_errors jsonb := '[]'::jsonb;
  v_seen jsonb := '{}'::jsonb;
  v_target_types jsonb := '{}'::jsonb;
  v_target_seen jsonb := '{}'::jsonb;
  v_existing jsonb;
  v_source text;
  v_product_code text;
  v_option_code text;
  v_component_sku text;
  v_qty_text text;
  v_bundle_type text;
  v_target_key text;
  v_pair_key text;
  v_product_name text;
  v_option_name text;
  v_component_product_name text;
  v_component_option_name text;
  v_component_role text;
  v_count integer;
  v_qty integer;
  v_index integer := 0;
  v_normalized jsonb;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '판매처 세트 구성 행은 JSON 배열이어야 합니다.';
  end if;
  if jsonb_array_length(p_rows) > 1000 then
    raise exception '한 번에 확인할 수 있는 판매처 세트 구성은 최대 1000행입니다.';
  end if;

  for v_item in select value from jsonb_array_elements(p_rows)
  loop
    v_index := v_index + 1;
    if jsonb_typeof(v_item) <> 'object' then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object(
        'rowIndex', v_index, 'code', 'invalid_row', 'message', '행은 JSON 객체여야 합니다.'
      ));
      continue;
    end if;

    v_source := lower(btrim(coalesce(v_item ->> 'source_channel', '')));
    v_product_code := btrim(coalesce(v_item ->> 'product_code', ''));
    v_option_code := btrim(coalesce(v_item ->> 'option_code', ''));
    v_component_sku := btrim(coalesce(v_item ->> 'component_sku_code', ''));
    v_qty_text := btrim(coalesce(v_item ->> 'component_qty', ''));
    v_bundle_type := lower(btrim(coalesce(v_item ->> 'bundle_type', '')));

    if v_source not in ('smartstore', 'makeshop', 'ably') then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object(
        'rowIndex', v_index, 'code', 'invalid_source', 'message', '지원하지 않는 판매처입니다.'
      ));
      continue;
    end if;
    if v_product_code = '' or v_component_sku = '' then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object(
        'rowIndex', v_index, 'code', 'missing_code', 'message', '판매처 상품코드와 구성품 셀피아 SKU가 필요합니다.'
      ));
      continue;
    end if;
    if v_bundle_type not in ('one_plus_one', 'set') then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object(
        'rowIndex', v_index, 'code', 'invalid_bundle_type', 'message', '판매처 조합 유형은 one_plus_one 또는 set이어야 합니다.'
      ));
      continue;
    end if;
    if v_qty_text !~ '^[0-9]+$' or length(v_qty_text) > 10 then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object(
        'rowIndex', v_index, 'code', 'invalid_quantity', 'message', '구성수량은 1 이상의 정수여야 합니다.'
      ));
      continue;
    end if;
    if v_qty_text::numeric <= 0 or v_qty_text::numeric > 2147483647 then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object(
        'rowIndex', v_index, 'code', 'invalid_quantity', 'message', '구성수량 범위를 확인해주세요.'
      ));
      continue;
    end if;
    v_qty := v_qty_text::integer;

    select count(*)::integer,
      min(latest.product_name), min(latest.option_name)
    into v_count, v_product_name, v_option_name
    from public.seller_inventory_latest latest
    where latest.source_channel = v_source
      and latest.product_code = v_product_code
      and latest.option_code = v_option_code;
    if v_count <> 1 then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object(
        'rowIndex', v_index,
        'code', case when v_count = 0 then 'seller_option_not_found' else 'seller_option_ambiguous' end,
        'message', format('최신 %s 원본에서 상품코드/옵션코드 %s/%s를 정확히 하나 찾을 수 없습니다.', v_source, v_product_code, v_option_code),
        'candidateCount', v_count
      ));
      continue;
    end if;

    select count(*)::integer,
      min(latest.sellpia_product_name), min(latest.sellpia_option_name)
    into v_count, v_component_product_name, v_component_option_name
    from public.sellpia_stock_latest latest
    where latest.sellpia_sku_code = v_component_sku;
    if v_count <> 1 then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object(
        'rowIndex', v_index,
        'code', case when v_count = 0 then 'component_not_found' else 'component_ambiguous' end,
        'message', format('최신 셀피아 원본에서 구성품 SKU %s를 정확히 하나 찾을 수 없습니다.', v_component_sku),
        'candidateCount', v_count
      ));
      continue;
    end if;

    v_target_key := v_source || chr(31) || v_product_code || chr(31) || v_option_code;
    if v_target_types ? v_target_key
      and v_target_types ->> v_target_key is distinct from v_bundle_type then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object(
        'rowIndex', v_index, 'code', 'conflicting_bundle_type',
        'message', '같은 판매처 상품/옵션에 서로 다른 조합 유형이 입력되었습니다.'
      ));
      continue;
    end if;
    v_target_types := v_target_types || jsonb_build_object(v_target_key, v_bundle_type);

    v_pair_key := v_target_key || chr(31) || v_component_sku;
    v_existing := v_seen -> v_pair_key;
    if v_existing is not null then
      if (v_existing -> 'component_qty') is distinct from to_jsonb(v_qty)
        or (v_existing ->> 'bundle_type') is distinct from v_bundle_type then
        v_errors := v_errors || jsonb_build_array(jsonb_build_object(
          'rowIndex', v_index, 'code', 'conflicting_duplicate',
          'message', '같은 판매처 옵션/구성품 쌍에 서로 다른 유형 또는 수량이 입력되었습니다.'
        ));
      end if;
      continue;
    end if;

    v_component_role := case when v_target_seen ? v_target_key then 'additional' else 'primary' end;
    v_target_seen := v_target_seen || jsonb_build_object(v_target_key, true);
    v_normalized := jsonb_build_object(
      'row_index', v_index,
      'source_channel', v_source,
      'product_code', v_product_code,
      'option_code', v_option_code,
      'product_name', v_product_name,
      'option_name', v_option_name,
      'component_sku_code', v_component_sku,
      'component_product_name', v_component_product_name,
      'component_option_name', v_component_option_name,
      'component_qty', v_qty,
      'component_role', v_component_role,
      'bundle_type', v_bundle_type
    );
    v_seen := v_seen || jsonb_build_object(v_pair_key, v_normalized);
    v_rows := v_rows || jsonb_build_array(v_normalized);
  end loop;

  v_errors := v_errors || coalesce((
    select jsonb_agg(jsonb_build_object(
      'code', 'one_plus_one_quantity_too_small',
      'sourceChannel', grouped.source_channel,
      'productCode', grouped.product_code,
      'optionCode', grouped.option_code,
      'message', '1+1 구성의 총 구성수량은 2 이상이어야 합니다.'
    ))
    from (
      select
        row ->> 'source_channel' as source_channel,
        row ->> 'product_code' as product_code,
        row ->> 'option_code' as option_code,
        sum((row ->> 'component_qty')::integer) as total_qty
      from jsonb_array_elements(v_rows) row
      where row ->> 'bundle_type' = 'one_plus_one'
      group by row ->> 'source_channel', row ->> 'product_code', row ->> 'option_code'
      having sum((row ->> 'component_qty')::integer) < 2
    ) grouped
  ), '[]'::jsonb);

  return jsonb_build_object(
    'valid', jsonb_array_length(v_errors) = 0,
    'rowCount', jsonb_array_length(v_rows),
    'rows', v_rows,
    'errors', v_errors
  );
end;
$$;

create or replace function public.apply_operations_hub_seller_bundle_import_v1(
  p_rows jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
set statement_timeout = '15s'
as $$
declare
  v_preflight jsonb;
  v_row jsonb;
  v_results jsonb := '[]'::jsonb;
  v_listing public.operations_hub_seller_listings%rowtype;
  v_component public.operations_hub_listing_components%rowtype;
  v_listing_before jsonb;
  v_component_before jsonb;
  v_listing_changed boolean;
  v_component_changed boolean;
  v_changed_count integer := 0;
  v_unchanged_count integer := 0;
begin
  v_preflight := public.resolve_operations_hub_seller_bundle_import_rows_v1(p_rows);
  if not coalesce((v_preflight ->> 'valid')::boolean, false) then
    return jsonb_build_object(
      'applied', false,
      'changedCount', 0,
      'unchangedCount', 0,
      'rows', '[]'::jsonb,
      'errors', coalesce(v_preflight -> 'errors', '[]'::jsonb)
    );
  end if;

  -- Natural unique keys make repeated payloads idempotent. The graph lock also
  -- keeps two concurrent bulk requests from racing on the same listing/component.
  perform pg_advisory_xact_lock(hashtextextended('operations_hub_seller_bundle_import_v1', 0));

  for v_row in select value from jsonb_array_elements(v_preflight -> 'rows')
  loop
    v_listing_before := null;
    v_component_before := null;
    v_listing_changed := false;
    v_component_changed := false;

    select listing.* into v_listing
    from public.operations_hub_seller_listings listing
    where listing.source_channel = v_row ->> 'source_channel'
      and listing.product_code = v_row ->> 'product_code'
      and listing.option_code = v_row ->> 'option_code'
    for update;

    if v_listing.listing_id is null then
      insert into public.operations_hub_seller_listings (
        source_channel, product_code, option_code, product_name, option_name,
        relation_kind, organization_updated_at, is_active, updated_by, updated_at
      ) values (
        v_row ->> 'source_channel', v_row ->> 'product_code', v_row ->> 'option_code',
        v_row ->> 'product_name', v_row ->> 'option_name',
        v_row ->> 'bundle_type', now(), true, 'operations_hub_frontend', now()
      ) returning * into v_listing;
      v_listing_changed := true;
    else
      v_listing_before := to_jsonb(v_listing);
      if not v_listing.is_active
        or v_listing.product_name is distinct from (v_row ->> 'product_name')
        or v_listing.option_name is distinct from (v_row ->> 'option_name')
        or v_listing.relation_kind is distinct from (v_row ->> 'bundle_type') then
        update public.operations_hub_seller_listings listing
        set product_name = v_row ->> 'product_name',
            option_name = v_row ->> 'option_name',
            relation_kind = v_row ->> 'bundle_type',
            organization_updated_at = now(),
            is_active = true,
            updated_by = 'operations_hub_frontend',
            updated_at = now()
        where listing.listing_id = v_listing.listing_id
        returning * into v_listing;
        v_listing_changed := true;
      end if;
    end if;

    if v_listing_changed then
      insert into public.operations_hub_relation_events (
        event_type, listing_id, folder_id, before_value, after_value, changed_by
      ) values (
        'ORGANIZE', v_listing.listing_id, v_listing.folder_id,
        v_listing_before, to_jsonb(v_listing), 'operations_hub_frontend'
      );
    end if;

    select component.* into v_component
    from public.operations_hub_listing_components component
    where component.listing_id = v_listing.listing_id
      and component.sellpia_sku_code = v_row ->> 'component_sku_code'
    for update;

    if v_component.component_id is null then
      insert into public.operations_hub_listing_components (
        listing_id, sellpia_sku_code, component_qty, component_role,
        mapping_origin, mapping_note, is_active, updated_by, updated_at
      ) values (
        v_listing.listing_id, v_row ->> 'component_sku_code',
        (v_row ->> 'component_qty')::integer, v_row ->> 'component_role',
        'import', 'seller_bundle_import_v1', true, 'operations_hub_frontend', now()
      ) returning * into v_component;
      v_component_changed := true;
    else
      v_component_before := to_jsonb(v_component);
      if not v_component.is_active
        or v_component.component_qty is distinct from (v_row ->> 'component_qty')::integer
        or v_component.component_role is distinct from (v_row ->> 'component_role') then
        update public.operations_hub_listing_components component
        set component_qty = (v_row ->> 'component_qty')::integer,
            component_role = v_row ->> 'component_role',
            mapping_origin = 'import',
            mapping_note = 'seller_bundle_import_v1',
            is_active = true,
            updated_by = 'operations_hub_frontend',
            updated_at = now()
        where component.component_id = v_component.component_id
        returning * into v_component;
        v_component_changed := true;
      end if;
    end if;

    if v_component_changed then
      insert into public.operations_hub_listing_component_events (
        listing_id, component_id, event_type, before_value, after_value, changed_by
      ) values (
        v_listing.listing_id, v_component.component_id, 'UPSERT',
        v_component_before, to_jsonb(v_component), 'operations_hub_frontend'
      );
    end if;

    if v_listing_changed or v_component_changed then
      v_changed_count := v_changed_count + 1;
    else
      v_unchanged_count := v_unchanged_count + 1;
    end if;
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'listingId', v_listing.listing_id,
      'componentId', v_component.component_id,
      'sourceChannel', v_listing.source_channel,
      'productCode', v_listing.product_code,
      'optionCode', v_listing.option_code,
      'componentSkuCode', v_component.sellpia_sku_code,
      'componentQty', v_component.component_qty,
      'componentRole', v_component.component_role,
      'bundleType', v_listing.relation_kind,
      'changed', v_listing_changed or v_component_changed
    ));
  end loop;

  return jsonb_build_object(
    'applied', true,
    'changedCount', v_changed_count,
    'unchangedCount', v_unchanged_count,
    'rows', v_results,
    'errors', '[]'::jsonb
  );
end;
$$;

create or replace function public.list_operations_hub_seller_bundle_graph_v1(
  p_source text default '',
  p_query text default ''
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
set statement_timeout = '10s'
as $$
  with input as (
    select lower(btrim(coalesce(p_source, ''))) as source_filter,
      btrim(coalesce(p_query, '')) as query_text
  ), listings as materialized (
    select
      listing.listing_id, listing.source_channel, listing.product_code,
      listing.option_code, listing.product_name, listing.option_name,
      listing.relation_kind, listing.folder_id, listing.group_name,
      listing.updated_at,
      count(component.component_id) filter (where component.is_active)::integer as component_count
    from public.operations_hub_seller_listings listing
    left join public.operations_hub_listing_components component
      on component.listing_id = listing.listing_id and component.is_active
    cross join input
    where listing.is_active
      and listing.relation_kind in ('one_plus_one', 'set')
      and (input.source_filter = '' or listing.source_channel = input.source_filter)
      and (
        input.query_text = ''
        or listing.product_code ilike '%' || input.query_text || '%'
        or listing.option_code ilike '%' || input.query_text || '%'
        or coalesce(listing.product_name, '') ilike '%' || input.query_text || '%'
        or coalesce(listing.option_name, '') ilike '%' || input.query_text || '%'
        or exists (
          select 1 from public.operations_hub_listing_components matching
          where matching.listing_id = listing.listing_id and matching.is_active
            and matching.sellpia_sku_code ilike '%' || input.query_text || '%'
        )
      )
    group by listing.listing_id
  ), components as materialized (
    select
      component.component_id, component.listing_id, component.sellpia_sku_code,
      component.component_qty, component.component_role, component.mapping_origin,
      stock.sellpia_product_code, stock.sellpia_product_name, stock.sellpia_option_name,
      component.updated_at
    from public.operations_hub_listing_components component
    join listings listing on listing.listing_id = component.listing_id
    join public.sellpia_stock_latest stock
      on stock.sellpia_sku_code = component.sellpia_sku_code
    where component.is_active
  )
  select jsonb_build_object(
    'listings', coalesce((select jsonb_agg(jsonb_build_object(
      'listingId', listing.listing_id,
      'sourceChannel', listing.source_channel,
      'productCode', listing.product_code,
      'optionCode', listing.option_code,
      'productName', listing.product_name,
      'optionName', listing.option_name,
      'bundleType', listing.relation_kind,
      'folderId', listing.folder_id,
      'groupName', listing.group_name,
      'componentCount', listing.component_count,
      'updatedAt', listing.updated_at
    ) order by listing.source_channel, listing.product_code, listing.option_code) from listings listing), '[]'::jsonb),
    'components', coalesce((select jsonb_agg(jsonb_build_object(
      'componentId', component.component_id,
      'listingId', component.listing_id,
      'componentSkuCode', component.sellpia_sku_code,
      'componentQty', component.component_qty,
      'componentRole', component.component_role,
      'mappingOrigin', component.mapping_origin,
      'productCode', component.sellpia_product_code,
      'productName', component.sellpia_product_name,
      'optionName', component.sellpia_option_name,
      'updatedAt', component.updated_at
    ) order by component.listing_id, component.component_role desc, component.component_id) from components component), '[]'::jsonb),
    'counts', jsonb_build_object(
      'listings', (select count(*) from listings),
      'components', (select count(*) from components)
    )
  );
$$;

revoke all on function public.resolve_operations_hub_seller_bundle_import_rows_v1(jsonb) from public;
revoke all on function public.apply_operations_hub_seller_bundle_import_v1(jsonb) from public;
revoke all on function public.list_operations_hub_seller_bundle_graph_v1(text, text) from public;

grant execute on function public.resolve_operations_hub_seller_bundle_import_rows_v1(jsonb) to anon, authenticated;
grant execute on function public.apply_operations_hub_seller_bundle_import_v1(jsonb) to anon, authenticated;
grant execute on function public.list_operations_hub_seller_bundle_graph_v1(text, text) to anon, authenticated;

comment on function public.resolve_operations_hub_seller_bundle_import_rows_v1(jsonb) is
  'Validates up to 1000 seller-option BOM rows against one exact seller source row and one exact real Sellpia SKU. Conflicting or ambiguous rows are returned as errors.';
comment on function public.apply_operations_hub_seller_bundle_import_v1(jsonb) is
  'Atomically and additively applies validated seller one-plus-one/set components. Existing unique rows make repeated identical payloads no-op and audit events are written only for actual changes.';
comment on function public.list_operations_hub_seller_bundle_graph_v1(text, text) is
  'Lists active seller-specific one-plus-one/set targets and their exact Sellpia components.';

notify pgrst, 'reload schema';
