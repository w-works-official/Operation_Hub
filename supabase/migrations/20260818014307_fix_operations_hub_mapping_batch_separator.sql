create or replace function operations_private.save_operations_hub_mapping_batch(
  p_items jsonb,
  p_actor text default 'operations_hub_automation',
  p_origin text default 'automatic',
  p_note text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, operations_private, extensions, pg_temp
as $$
declare
  v_batch_id uuid := gen_random_uuid();
  v_origin text := lower(coalesce(nullif(btrim(p_origin), ''), 'automatic'));
  v_actor text := coalesce(nullif(btrim(p_actor), ''), 'operations_hub_automation');
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 500), '');
  v_requested integer := 0;
  v_saved integer := 0;
  v_failed integer := 0;
  v_failures jsonb := '[]'::jsonb;
  v_seen text[] := array[]::text[];
  v_entry jsonb;
  v_source text;
  v_sku text;
  v_product_code text;
  v_option_code text;
  v_entry_key text;
  v_score numeric;
  v_item public.seller_inventory_latest%rowtype;
  v_before jsonb;
  v_changed_at timestamptz;
begin
  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'p_items는 JSON 배열이어야 합니다.';
  end if;

  v_requested := jsonb_array_length(p_items);
  if v_requested < 1 or v_requested > 500 then
    raise exception '매핑 묶음은 1~500건이어야 합니다. 현재 %건', v_requested;
  end if;
  if v_origin not in ('manual', 'automatic', 'import') then
    raise exception '지원하지 않는 매핑 출처입니다: %', v_origin;
  end if;
  if v_actor !~ '^[0-9A-Za-z_.:@-]{3,120}$' then
    raise exception 'actor 형식이 올바르지 않습니다.';
  end if;

  insert into operations_private.operations_hub_mapping_batches (
    batch_id, mapping_origin, actor, status, requested_count, note
  ) values (
    v_batch_id, v_origin, v_actor, 'running', v_requested, v_note
  );

  for v_entry in select value from jsonb_array_elements(p_items)
  loop
    begin
      v_source := lower(btrim(coalesce(v_entry ->> 'source', v_entry ->> 'source_channel', '')));
      v_sku := btrim(coalesce(v_entry ->> 'sellpia_sku_code', v_entry ->> 'sellpia_sku', ''));
      v_product_code := btrim(coalesce(v_entry ->> 'product_code', ''));
      v_option_code := btrim(coalesce(v_entry ->> 'option_code', ''));
      v_entry_key := v_source || chr(31) || v_sku;

      if v_source not in ('smartstore', 'makeshop', 'ably') then
        raise exception '지원하지 않는 판매처: %', nullif(v_source, '');
      end if;
      if v_sku = '' then
        raise exception '셀피아 SKU가 비어 있습니다.';
      end if;
      if v_product_code = '' then
        raise exception '판매처 상품코드가 비어 있습니다.';
      end if;
      if array_position(v_seen, v_entry_key) is not null then
        raise exception '같은 판매처와 SKU가 묶음에 중복되었습니다.';
      end if;
      v_seen := array_append(v_seen, v_entry_key);

      if not exists (
        select 1
        from operations_private.operations_hub_matrix_core matrix
        where matrix.sellpia_sku_code = v_sku
      ) then
        raise exception '매트릭스 코어에 없는 셀피아 SKU입니다: %', v_sku;
      end if;

      select item.*
      into v_item
      from public.seller_inventory_latest item
      where item.source_channel = v_source
        and item.product_code = v_product_code
        and item.option_code = v_option_code
      limit 1;

      if not found then
        raise exception '최신 판매처 원본에서 상품·옵션 코드를 찾지 못했습니다.';
      end if;

      begin
        v_score := coalesce(nullif(v_entry ->> 'match_score', '')::numeric, 100);
      exception when invalid_text_representation then
        raise exception 'match_score가 숫자가 아닙니다.';
      end;
      if v_score < 0 or v_score > 100 then
        raise exception 'match_score는 0~100이어야 합니다.';
      end if;

      select to_jsonb(existing.*)
      into v_before
      from public.operations_hub_manual_links existing
      where existing.source_channel = v_source
        and existing.sellpia_sku_code = v_sku;

      v_changed_at := clock_timestamp();
      insert into public.operations_hub_manual_links (
        source_channel,
        sellpia_sku_code,
        product_code,
        option_code,
        product_name,
        option_name,
        updated_by,
        updated_at,
        mapping_origin,
        match_tier,
        match_score,
        mapping_batch_id,
        mapping_note
      ) values (
        v_source,
        v_sku,
        v_item.product_code,
        v_item.option_code,
        v_item.product_name,
        v_item.option_name,
        v_actor,
        v_changed_at,
        v_origin,
        case v_origin
          when 'manual' then 'MANUAL_LINKED'
          when 'import' then 'IMPORTED_LINKED'
          else 'AUTO_LINKED'
        end,
        v_score,
        v_batch_id,
        v_note
      )
      on conflict on constraint operations_hub_manual_links_pkey do update set
        product_code = excluded.product_code,
        option_code = excluded.option_code,
        product_name = excluded.product_name,
        option_name = excluded.option_name,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at,
        mapping_origin = excluded.mapping_origin,
        match_tier = excluded.match_tier,
        match_score = excluded.match_score,
        mapping_batch_id = excluded.mapping_batch_id,
        mapping_note = excluded.mapping_note;

      insert into public.operations_hub_link_history (
        sellpia_sku_code,
        source_channel,
        before_link,
        after_link,
        changed_by,
        changed_at
      ) values (
        v_sku,
        v_source,
        v_before,
        jsonb_build_object(
          'product_code', v_item.product_code,
          'option_code', v_item.option_code,
          'product_name', v_item.product_name,
          'option_name', v_item.option_name,
          'mapping_origin', v_origin,
          'match_tier', case v_origin
            when 'manual' then 'MANUAL_LINKED'
            when 'import' then 'IMPORTED_LINKED'
            else 'AUTO_LINKED'
          end,
          'match_score', v_score,
          'mapping_batch_id', v_batch_id,
          'mapping_note', v_note
        ),
        v_actor,
        v_changed_at
      );

      v_saved := v_saved + 1;
    exception when others then
      v_failed := v_failed + 1;
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'source_channel', nullif(v_source, ''),
        'sellpia_sku_code', nullif(v_sku, ''),
        'product_code', nullif(v_product_code, ''),
        'option_code', nullif(v_option_code, ''),
        'reason', sqlerrm
      ));
    end;
  end loop;

  update operations_private.operations_hub_mapping_batches
  set
    status = case
      when v_saved = 0 then 'failed'
      when v_failed > 0 then 'partial'
      else 'completed'
    end,
    saved_count = v_saved,
    failed_count = v_failed,
    failure_items = v_failures,
    completed_at = clock_timestamp()
  where batch_id = v_batch_id;

  return jsonb_build_object(
    'batch_id', v_batch_id,
    'status', case
      when v_saved = 0 then 'failed'
      when v_failed > 0 then 'partial'
      else 'completed'
    end,
    'requested_count', v_requested,
    'saved_count', v_saved,
    'failed_count', v_failed,
    'failure_items', v_failures
  );
end;
$$;

revoke all on function operations_private.save_operations_hub_mapping_batch(jsonb, text, text, text) from public;
revoke all on function operations_private.save_operations_hub_mapping_batch(jsonb, text, text, text) from anon, authenticated;
grant execute on function operations_private.save_operations_hub_mapping_batch(jsonb, text, text, text) to service_role;
