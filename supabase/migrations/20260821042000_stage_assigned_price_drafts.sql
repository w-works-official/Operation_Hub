-- Calculate assigned composite price rules from Sellpia SKU prices and create
-- reviewable seller price drafts. Existing option-price drafts are preserved;
-- seller base price is derived as target final price minus effective option price.

create or replace function public.stage_operations_hub_assigned_price_drafts_bulk(
  p_skus text[],
  p_sources text[],
  p_batch_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, operations_private, pg_temp
as $$
declare
  v_target record;
  v_preview record;
  v_saved record;
  v_effective_option numeric;
  v_option_source text;
  v_requested_skus integer := 0;
  v_assignment_rows integer := 0;
  v_pending integer := 0;
  v_unchanged integer := 0;
  v_failed integer := 0;
  v_errors jsonb := '[]'::jsonb;
  v_batch_id uuid := coalesce(p_batch_id, gen_random_uuid());
begin
  if coalesce(cardinality(p_skus), 0) = 0 then
    raise exception '가격 수정안을 만들 셀피아 SKU가 필요합니다.';
  end if;
  if coalesce(cardinality(p_sources), 0) = 0 then
    raise exception '가격 수정안을 만들 판매처가 필요합니다.';
  end if;
  if exists (
    select 1 from unnest(p_sources) source_name
    where lower(btrim(source_name)) not in ('smartstore', 'makeshop', 'ably')
  ) then
    raise exception '지원하지 않는 판매처가 포함되어 있습니다.';
  end if;

  select count(*) into v_requested_skus
  from (select distinct nullif(btrim(sku), '') sku from unnest(p_skus) sku) requested
  where requested.sku is not null;

  for v_target in
    with requested as (
      select distinct nullif(btrim(sku), '') sku
      from unnest(p_skus) sku
    ), sources as (
      select distinct lower(btrim(source_name)) source_name
      from unnest(p_sources) source_name
    )
    select assignment.sellpia_sku_code,
           assignment.source_channel,
           assignment.price_rule_set_id,
           matrix_row.sellpia_sale_price
    from public.operations_hub_price_rule_assignments assignment
    join requested on requested.sku = assignment.sellpia_sku_code
    join sources on sources.source_name = assignment.source_channel
    join public.operations_hub_matrix_live matrix_row
      on matrix_row.sellpia_sku_code = assignment.sellpia_sku_code
    where assignment.target_type = 'sellpia_sku'
      and assignment.is_active
    order by assignment.sellpia_sku_code, assignment.source_channel
  loop
    v_assignment_rows := v_assignment_rows + 1;
    begin
      if v_target.sellpia_sale_price is null then
        raise exception '셀피아 판매가가 없습니다.';
      end if;

      select * into v_preview
      from public.calculate_operations_hub_price_rule_set(
        v_target.sellpia_sale_price,
        v_target.price_rule_set_id
      );
      if v_preview.final_price is null then
        raise exception '가격 규칙 계산 결과가 없습니다.';
      end if;

      select draft.price_option_after,
             coalesce(nullif(draft.option_price_source, ''), 'original')
      into v_effective_option, v_option_source
      from public.operations_hub_active_seller_drafts draft
      where draft.sellpia_sku_code = v_target.sellpia_sku_code
        and draft.source_channel = v_target.source_channel
        and draft.field_key = 'sellpia_sale_price'
      limit 1;
      if not found then
        v_effective_option := null;
        v_option_source := 'original';
      end if;

      select * into v_saved
      from public.save_operations_hub_seller_price_draft(
        v_target.sellpia_sku_code,
        v_target.source_channel,
        v_preview.final_price,
        v_effective_option,
        v_option_source,
        v_target.price_rule_set_id,
        v_batch_id
      );

      if v_saved.draft_status = 'pending' then
        v_pending := v_pending + 1;
      else
        v_unchanged := v_unchanged + 1;
      end if;
    exception when others then
      v_failed := v_failed + 1;
      if jsonb_array_length(v_errors) < 20 then
        v_errors := v_errors || jsonb_build_array(jsonb_build_object(
          'sku', v_target.sellpia_sku_code,
          'source', v_target.source_channel,
          'message', sqlerrm
        ));
      end if;
    end;
  end loop;

  return jsonb_build_object(
    'batch_id', v_batch_id,
    'requested_skus', v_requested_skus,
    'assignment_rows', v_assignment_rows,
    'pending_drafts', v_pending,
    'unchanged_drafts', v_unchanged,
    'failed_rows', v_failed,
    'unassigned_rows', greatest(v_requested_skus * (
      select count(*) from (select distinct lower(btrim(source_name)) from unnest(p_sources) source_name) source_count
    ) - v_assignment_rows, 0),
    'errors', v_errors
  );
end;
$$;

comment on function public.stage_operations_hub_assigned_price_drafts_bulk(text[], text[], uuid) is
  'Creates reviewable seller price drafts from active SKU/channel rule assignments. Preserves effective option price and derives base price.';

revoke all on function public.stage_operations_hub_assigned_price_drafts_bulk(text[], text[], uuid) from public;
grant execute on function public.stage_operations_hub_assigned_price_drafts_bulk(text[], text[], uuid) to anon, authenticated;
