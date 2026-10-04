-- Assign one reusable price-rule set to many Sellpia SKUs and seller channels.
-- This function only stores durable calculation assignments. It never creates
-- seller change drafts or modifies the latest uploaded seller originals.

create or replace function public.save_operations_hub_price_rule_assignments_bulk(
  p_skus text[],
  p_sources text[],
  p_rule_set_id bigint,
  p_updated_by text default 'operations-hub'
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_requested_skus integer := 0;
  v_matched_skus integer := 0;
  v_source_count integer := 0;
  v_assigned_rows integer := 0;
  v_cleared_rows integer := 0;
begin
  if coalesce(cardinality(p_skus), 0) = 0 then
    raise exception '가격 규칙을 배정할 셀피아 SKU가 필요합니다.';
  end if;
  if coalesce(cardinality(p_sources), 0) = 0 then
    raise exception '가격 규칙을 배정할 판매처가 필요합니다.';
  end if;
  if exists (
    select 1 from unnest(p_sources) source_name
    where lower(btrim(source_name)) not in ('smartstore', 'makeshop', 'ably')
  ) then
    raise exception '지원하지 않는 판매처가 포함되어 있습니다.';
  end if;
  if p_rule_set_id is not null and not exists (
    select 1 from public.operations_hub_price_rule_sets rule_set
    where rule_set.price_rule_set_id = p_rule_set_id and rule_set.is_active
  ) then
    raise exception '활성 가격 조합 태그를 찾을 수 없습니다: %', p_rule_set_id;
  end if;

  select count(*) into v_requested_skus
  from (select distinct nullif(btrim(sku), '') sku from unnest(p_skus) sku) requested
  where requested.sku is not null;

  select count(*) into v_source_count
  from (select distinct lower(btrim(source_name)) source_name from unnest(p_sources) source_name) sources;

  select count(*) into v_matched_skus
  from (
    select distinct nullif(btrim(sku), '') sku
    from unnest(p_skus) sku
  ) requested
  where requested.sku is not null
    and exists (
      select 1 from public.operations_hub_matrix_live matrix_row
      where matrix_row.sellpia_sku_code = requested.sku
    );

  update public.operations_hub_price_rule_assignments assignment
  set is_active = false,
      updated_by = coalesce(nullif(btrim(p_updated_by), ''), 'operations-hub'),
      updated_at = now()
  where assignment.target_type = 'sellpia_sku'
    and assignment.is_active
    and assignment.source_channel in (
      select distinct lower(btrim(source_name)) from unnest(p_sources) source_name
    )
    and assignment.sellpia_sku_code in (
      select distinct nullif(btrim(sku), '') from unnest(p_skus) sku
    );
  get diagnostics v_cleared_rows = row_count;

  if p_rule_set_id is not null then
    insert into public.operations_hub_price_rule_assignments (
      source_channel, target_type, sellpia_sku_code, price_rule_set_id,
      is_active, updated_by
    )
    select sources.source_name,
           'sellpia_sku',
           requested.sku,
           p_rule_set_id,
           true,
           coalesce(nullif(btrim(p_updated_by), ''), 'operations-hub')
    from (
      select distinct nullif(btrim(sku), '') sku
      from unnest(p_skus) sku
    ) requested
    cross join (
      select distinct lower(btrim(source_name)) source_name
      from unnest(p_sources) source_name
    ) sources
    where requested.sku is not null
      and exists (
        select 1 from public.operations_hub_matrix_live matrix_row
        where matrix_row.sellpia_sku_code = requested.sku
      )
    on conflict (source_channel, sellpia_sku_code)
      where target_type = 'sellpia_sku' and is_active
    do update set
      price_rule_set_id = excluded.price_rule_set_id,
      updated_by = excluded.updated_by,
      updated_at = now();
    get diagnostics v_assigned_rows = row_count;
  end if;

  return jsonb_build_object(
    'requested_skus', v_requested_skus,
    'matched_skus', v_matched_skus,
    'skipped_skus', greatest(v_requested_skus - v_matched_skus, 0),
    'source_count', v_source_count,
    'assigned_rows', v_assigned_rows,
    'cleared_rows', v_cleared_rows,
    'rule_set_id', p_rule_set_id
  );
end;
$$;

comment on function public.save_operations_hub_price_rule_assignments_bulk(text[], text[], bigint, text) is
  'Batched durable composite price-rule assignment by Sellpia SKU and seller channel. No seller change draft is created.';

revoke all on function public.save_operations_hub_price_rule_assignments_bulk(text[], text[], bigint, text) from public;
grant execute on function public.save_operations_hub_price_rule_assignments_bulk(text[], text[], bigint, text) to anon, authenticated;
