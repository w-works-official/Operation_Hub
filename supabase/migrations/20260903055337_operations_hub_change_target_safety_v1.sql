-- Seller-change safety is keyed by the cell that is actually written in a
-- marketplace source file, not by the Sellpia SKU that happened to propose it.
--
-- Exact target identity:
--   source_channel + seller_product_code + normalized seller_option_code + field_key

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.operations_hub_change_queue
  add column if not exists seller_option_code_normalized text,
  add column if not exists target_component_skus text[] not null default '{}'::text[],
  add column if not exists target_safety_state text not null default 'ready',
  add column if not exists target_safety_details jsonb not null default '{}'::jsonb;

update public.operations_hub_change_queue
set seller_option_code_normalized = coalesce(nullif(btrim(seller_option_code), ''), '')
where seller_option_code_normalized is distinct from
  coalesce(nullif(btrim(seller_option_code), ''), '');

alter table public.operations_hub_change_queue
  alter column seller_option_code_normalized set default '',
  alter column seller_option_code_normalized set not null;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'operations_hub_change_queue_target_safety_state_check'
      and conrelid = 'public.operations_hub_change_queue'::regclass
  ) then
    alter table public.operations_hub_change_queue
      add constraint operations_hub_change_queue_target_safety_state_check
      check (target_safety_state in ('ready', 'conflict', 'incomplete'));
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'operations_hub_change_queue_target_safety_details_check'
      and conrelid = 'public.operations_hub_change_queue'::regclass
  ) then
    alter table public.operations_hub_change_queue
      add constraint operations_hub_change_queue_target_safety_details_check
      check (jsonb_typeof(target_safety_details) = 'object');
  end if;
end;
$$;

create or replace function public.normalize_operations_hub_change_target_v1()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if new.source_channel is not null then
    new.source_channel := nullif(lower(btrim(new.source_channel)), '');
  end if;
  if new.seller_product_code is not null then
    new.seller_product_code := nullif(btrim(new.seller_product_code), '');
  end if;
  new.seller_option_code := coalesce(nullif(btrim(new.seller_option_code), ''), '');
  new.seller_option_code_normalized := new.seller_option_code;
  new.target_component_skus := coalesce(new.target_component_skus, '{}'::text[]);
  new.target_safety_state := coalesce(nullif(new.target_safety_state, ''), 'ready');
  new.target_safety_details := coalesce(new.target_safety_details, '{}'::jsonb);
  return new;
end;
$$;

drop trigger if exists operations_hub_change_queue_target_normalizer_v1
  on public.operations_hub_change_queue;
create trigger operations_hub_change_queue_target_normalizer_v1
before insert or update of source_channel, seller_product_code, seller_option_code,
  target_component_skus, target_safety_state, target_safety_details
on public.operations_hub_change_queue
for each row execute function public.normalize_operations_hub_change_target_v1();

revoke all on function public.normalize_operations_hub_change_target_v1()
  from public, anon, authenticated;

-- Preserve all existing rows. For duplicate active exact targets, the newest
-- row becomes the visible representative and every other row is superseded.
-- Conflicting values remain visible as a failed representative and cannot be
-- exported until a later, unambiguous proposal replaces it.
do $$
begin
  if exists (
    select 1 from public.operations_hub_change_queue
    where status = 'processing'
  ) then
    raise exception using
      errcode = '55006',
      message = '처리 중인 판매처 수정안이 있어 대상 안전 마이그레이션을 시작할 수 없습니다.';
  end if;
end;
$$;

with duplicate_groups as materialized (
  select
    lower(btrim(queue.source_channel)) as source_channel,
    btrim(queue.seller_product_code) as seller_product_code,
    coalesce(nullif(btrim(queue.seller_option_code), ''), '') as seller_option_code,
    queue.field_key,
    (array_agg(queue.change_id order by
      case queue.status
        when 'processing' then 0
        when 'validated' then 1
        when 'pending' then 2
        when 'failed' then 3
        else 4
      end,
      queue.updated_at desc, queue.change_id desc
    ))[1] as keeper_id,
    array_agg(queue.change_id order by
      case queue.status
        when 'processing' then 0
        when 'validated' then 1
        when 'pending' then 2
        when 'failed' then 3
        else 4
      end,
      queue.updated_at desc, queue.change_id desc
    ) as change_ids,
    array_agg(distinct queue.sellpia_sku_code order by queue.sellpia_sku_code) as component_skus,
    jsonb_agg(distinct queue.after_value) as proposed_values,
    count(distinct queue.after_value) as proposed_value_count
  from public.operations_hub_change_queue queue
  where queue.status in ('pending', 'validated', 'failed', 'processing')
    and nullif(btrim(queue.source_channel), '') is not null
    and nullif(btrim(queue.seller_product_code), '') is not null
  group by lower(btrim(queue.source_channel)), btrim(queue.seller_product_code),
    coalesce(nullif(btrim(queue.seller_option_code), ''), ''), queue.field_key
  having count(*) > 1
), superseded as (
  update public.operations_hub_change_queue queue
  set status = 'cancelled',
      cancelled_at = clock_timestamp(),
      cancelled_by = 'operations_hub_target_safety_v1',
      status_message = format(
        '동일 판매처 대상 수정안 #%s에 통합되어 대체됨',
        duplicate_groups.keeper_id
      ),
      updated_at = clock_timestamp()
  from duplicate_groups
  where queue.change_id = any(duplicate_groups.change_ids)
    and queue.change_id <> duplicate_groups.keeper_id
  returning queue.change_id
)
update public.operations_hub_change_queue queue
set target_component_skus = duplicate_groups.component_skus,
    target_safety_state = case
      when duplicate_groups.proposed_value_count > 1 then 'conflict'
      else 'ready'
    end,
    target_safety_details = jsonb_build_object(
      'reason', case
        when duplicate_groups.proposed_value_count > 1 then 'conflicting_proposed_values'
        else 'duplicate_same_value_consolidated'
      end,
      'originalChangeIds', to_jsonb(duplicate_groups.change_ids),
      'componentSkus', to_jsonb(duplicate_groups.component_skus),
      'proposedValues', duplicate_groups.proposed_values
    ),
    status = case
      when duplicate_groups.proposed_value_count > 1 then 'failed'
      else queue.status
    end,
    error_message = case
      when duplicate_groups.proposed_value_count > 1
        then '동일 판매처 대상에 서로 다른 수정값이 있어 자동 선택하지 않았습니다.'
      else queue.error_message
    end,
    status_message = case
      when duplicate_groups.proposed_value_count > 1
        then '판매처 대상 충돌 · 구성과 값을 확인해주세요.'
      else '동일 판매처 대상의 같은 값 수정안을 한 건으로 통합함'
    end,
    validation_errors = case
      when duplicate_groups.proposed_value_count > 1
        then coalesce(queue.validation_errors, '[]'::jsonb)
          || jsonb_build_array('동일 판매처 대상에 서로 다른 수정값이 있습니다.')
      else queue.validation_errors
    end,
    updated_at = clock_timestamp()
from duplicate_groups
where queue.change_id = duplicate_groups.keeper_id;

create or replace function public.guard_operations_hub_change_target_v1()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_existing public.operations_hub_change_queue%rowtype;
  v_component_skus text[];
begin
  -- PostgreSQL fires same-kind triggers in name order.  Normalize here as well
  -- so this guard stays correct even when it precedes the dedicated normalizer.
  if new.source_channel is not null then
    new.source_channel := nullif(lower(btrim(new.source_channel)), '');
  end if;
  if new.seller_product_code is not null then
    new.seller_product_code := nullif(btrim(new.seller_product_code), '');
  end if;
  new.seller_option_code := coalesce(nullif(btrim(new.seller_option_code), ''), '');
  new.seller_option_code_normalized := new.seller_option_code;

  if new.status not in ('pending', 'validated', 'failed', 'processing')
     or new.source_channel is null
     or nullif(btrim(new.seller_product_code), '') is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    lower(btrim(new.source_channel)) || chr(31)
      || btrim(new.seller_product_code) || chr(31)
      || coalesce(nullif(btrim(new.seller_option_code), ''), '') || chr(31)
      || new.field_key,
    0
  ));

  select queue.*
  into v_existing
  from public.operations_hub_change_queue queue
  where queue.change_id <> coalesce(new.change_id, -1)
    and queue.status in ('pending', 'validated', 'failed', 'processing')
    and lower(btrim(queue.source_channel)) = lower(btrim(new.source_channel))
    and btrim(queue.seller_product_code) = btrim(new.seller_product_code)
    and queue.seller_option_code_normalized = coalesce(nullif(btrim(new.seller_option_code), ''), '')
    and queue.field_key = new.field_key
  order by queue.updated_at desc, queue.change_id desc
  limit 1
  for update;

  if not found then return new; end if;

  if v_existing.status = 'processing' then
    raise exception using
      errcode = '55006',
      message = format(
        '동일 판매처 대상의 처리 중 수정안 #%s은(는) 자동 대체할 수 없습니다.',
        v_existing.change_id
      ),
      hint = '진행 중인 판매처 반영이 끝난 뒤 다시 시도해주세요.';
  end if;

  select array_agg(distinct component_sku order by component_sku)
  into v_component_skus
  from unnest(
    coalesce(nullif(v_existing.target_component_skus, '{}'::text[]), array[v_existing.sellpia_sku_code])
      || coalesce(nullif(new.target_component_skus, '{}'::text[]), array[new.sellpia_sku_code])
  ) component_sku;

  update public.operations_hub_change_queue queue
  set status = 'cancelled',
      cancelled_at = clock_timestamp(),
      cancelled_by = coalesce(new.requested_by, 'operations_hub_frontend'),
      status_message = format('동일 판매처 대상의 최신 수정안 #%s로 대체됨', coalesce(new.change_id, 0)),
      updated_at = clock_timestamp()
  where queue.change_id = v_existing.change_id;

  new.target_component_skus := coalesce(v_component_skus, array[new.sellpia_sku_code]);
  if v_existing.after_value is distinct from new.after_value then
    new.status := 'failed';
    new.target_safety_state := 'conflict';
    new.error_message := '동일 판매처 대상에 서로 다른 수정값이 있어 자동 선택하지 않았습니다.';
    new.status_message := '판매처 대상 충돌 · 구성과 값을 확인해주세요.';
    new.validation_errors := coalesce(new.validation_errors, '[]'::jsonb)
      || jsonb_build_array('동일 판매처 대상에 서로 다른 수정값이 있습니다.');
    new.target_safety_details := jsonb_build_object(
      'reason', 'conflicting_proposed_values',
      'replacedChangeId', v_existing.change_id,
      'previousValue', v_existing.after_value,
      'incomingValue', new.after_value,
      'componentSkus', to_jsonb(new.target_component_skus)
    );
  else
    new.target_safety_state := 'ready';
    new.target_safety_details := jsonb_build_object(
      'reason', 'duplicate_same_value_consolidated',
      'replacedChangeId', v_existing.change_id,
      'componentSkus', to_jsonb(new.target_component_skus)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists operations_hub_change_queue_target_guard_v1
  on public.operations_hub_change_queue;
create trigger operations_hub_change_queue_target_guard_v1
before insert or update of source_channel, seller_product_code, seller_option_code,
  field_key, after_value, status
on public.operations_hub_change_queue
for each row execute function public.guard_operations_hub_change_target_v1();

revoke all on function public.guard_operations_hub_change_target_v1()
  from public, anon, authenticated;


create unique index if not exists operations_hub_change_queue_active_exact_target_uidx
  on public.operations_hub_change_queue (
    lower(btrim(source_channel)),
    btrim(seller_product_code),
    seller_option_code_normalized,
    field_key
  )
  where status in ('pending', 'validated', 'failed', 'processing')
    and source_channel is not null
    and nullif(btrim(seller_product_code), '') is not null;

create index if not exists operations_hub_change_queue_batch_summary_v1_idx
  on public.operations_hub_change_queue (change_batch_id, updated_at desc, change_id desc);

create index if not exists operations_hub_change_queue_target_history_v1_idx
  on public.operations_hub_change_queue (
    lower(btrim(source_channel)),
    btrim(seller_product_code),
    seller_option_code_normalized,
    field_key,
    updated_at desc,
    change_id desc
  )
  where source_channel is not null
    and nullif(btrim(seller_product_code), '') is not null;

-- A target page is selected first, then every component of those targets is
-- expanded. Explicit seller-listing BOMs use qty-aware minimum availability.
-- Legacy many-SKU links are only consolidated when all proposed values agree;
-- otherwise one failed conflict row is staged instead of choosing a value.
create or replace function public.stage_operations_hub_seller_inventory_match_batch(
  p_session_token text,
  p_sources text[],
  p_skus text[] default null,
  p_batch_id uuid default null,
  p_after_sku text default null,
  p_batch_size integer default 500
)
returns table(
  processed_count integer,
  total_count integer,
  staged_count integer,
  cancelled_count integer,
  next_cursor text,
  has_more boolean,
  change_batch_id uuid
)
language plpgsql
security definer
set search_path = pg_catalog
set statement_timeout = '45s'
as $$
declare
  v_sources text[];
  v_skus text[];
  v_batch_id uuid := coalesce(p_batch_id, gen_random_uuid());
  v_batch_size integer := greatest(25, least(coalesce(p_batch_size, 500), 500));
  v_target record;
  v_processed integer := 0;
  v_total integer := 0;
  v_staged integer := 0;
  v_cancelled integer := 0;
  v_affected integer := 0;
  v_next_cursor text := null;
  v_last_cursor text := null;
  v_session jsonb;
  v_actor text;
begin
  v_session := operations_private.require_operations_hub_operator_session(p_session_token);
  v_actor := v_session ->> 'username';
  select coalesce(array_agg(distinct lower(btrim(source))), '{}'::text[])
  into v_sources
  from unnest(coalesce(p_sources, '{}'::text[])) source
  where lower(btrim(source)) in ('smartstore', 'makeshop', 'ably');

  select coalesce(array_agg(distinct btrim(sku)), '{}'::text[])
  into v_skus
  from unnest(coalesce(p_skus, '{}'::text[])) sku
  where nullif(btrim(sku), '') is not null;

  if cardinality(v_sources) = 0 then
    raise exception '판매처를 하나 이상 선택해주세요.';
  end if;

  for v_target in
    with scoped_components as materialized (
      select
        projection.source_channel,
        btrim(projection.product_code) as product_code,
        coalesce(nullif(btrim(projection.option_code), ''), '') as option_code,
        projection.sellpia_sku_code
      from public.operations_hub_listing_component_projection projection
      where projection.source_channel = any(v_sources)
        and (
          cardinality(v_skus) = 0
          or projection.sellpia_sku_code = any(v_skus)
        )
    ), target_keys as materialized (
      select distinct
        component.source_channel,
        component.product_code,
        component.option_code,
        component.source_channel || chr(31) || component.product_code || chr(31) || component.option_code as target_cursor
      from scoped_components component
    ), target_candidates as materialized (
      select target.*,
        count(*) over ()::integer as total_count,
        max(target.target_cursor) over () as last_cursor
      from target_keys target
    ), target_page as materialized (
      select candidate.*
      from target_candidates candidate
      where p_after_sku is null or candidate.target_cursor > p_after_sku
      order by candidate.target_cursor
      limit v_batch_size
    ), expanded_components as materialized (
      select
        page.target_cursor,
        page.total_count,
        page.last_cursor,
        projection.source_channel,
        btrim(projection.product_code) as product_code,
        coalesce(nullif(btrim(projection.option_code), ''), '') as option_code,
        projection.mapping_source,
        projection.sellpia_sku_code,
        projection.component_qty,
        projection.component_role,
        projection.sellpia_available_stock
      from target_page page
      join public.operations_hub_listing_component_projection projection
        on projection.source_channel = page.source_channel
       and btrim(projection.product_code) = page.product_code
       and coalesce(nullif(btrim(projection.option_code), ''), '') = page.option_code
    ), component_rollup as materialized (
      select
        component.target_cursor,
        max(component.total_count)::integer as total_count,
        max(component.last_cursor) as last_cursor,
        component.source_channel,
        component.product_code,
        component.option_code,
        bool_or(component.mapping_source = 'explicit') as is_explicit,
        count(*)::integer as component_count,
        count(component.sellpia_available_stock)::integer as known_stock_count,
        count(distinct component.sellpia_available_stock)::integer as distinct_stock_count,
        (array_agg(
          component.sellpia_sku_code
          order by case component.component_role when 'primary' then 0 else 1 end,
            component.sellpia_sku_code
        ))[1] as representative_sku,
        array_agg(distinct component.sellpia_sku_code order by component.sellpia_sku_code) as component_skus,
        jsonb_agg(jsonb_build_object(
          'sku', component.sellpia_sku_code,
          'qty', component.component_qty,
          'availableStock', component.sellpia_available_stock,
          'mappingSource', component.mapping_source
        ) order by component.sellpia_sku_code) as component_details,
        case
          when count(component.sellpia_available_stock) <> count(*) then null
          when bool_or(component.mapping_source = 'explicit') then
            min(floor(component.sellpia_available_stock::numeric / component.component_qty))::integer
          when count(*) = 1 then max(component.sellpia_available_stock)::integer
          when count(distinct component.sellpia_available_stock) = 1 then max(component.sellpia_available_stock)::integer
          else null
        end as calculated_stock
      from expanded_components component
      group by component.target_cursor, component.source_channel,
        component.product_code, component.option_code
    )
    select
      rollup.*,
      seller.stock as seller_stock,
      case
        when rollup.known_stock_count <> rollup.component_count then 'incomplete'
        when not rollup.is_explicit
          and rollup.component_count > 1
          and rollup.distinct_stock_count > 1 then 'conflict'
        when seller.stock is null then 'incomplete'
        else 'ready'
      end as safety_state
    from component_rollup rollup
    left join lateral (
      select latest.stock
      from public.seller_inventory_latest latest
      where latest.source_channel = rollup.source_channel
        and btrim(latest.product_code) = rollup.product_code
        and coalesce(nullif(btrim(latest.option_code), ''), '') = rollup.option_code
      order by latest.snapshot_completed_at desc nulls last
      limit 1
    ) seller on true
    order by rollup.target_cursor
  loop
    v_processed := v_processed + 1;
    v_total := v_target.total_count;
    v_next_cursor := v_target.target_cursor;
    v_last_cursor := v_target.last_cursor;

    -- These statements are deliberately sequential. A data-modifying CTE that
    -- updated and inserted the same target could run in an unspecified order
    -- under one snapshot and hit the active-target unique index.
    -- Take the same canonical target lock as every direct writer before any
    -- queue row lock; this keeps the global order target-lock -> row-lock.
    perform pg_advisory_xact_lock(hashtextextended(
      v_target.source_channel || chr(31)
        || btrim(v_target.product_code) || chr(31)
        || coalesce(nullif(btrim(v_target.option_code), ''), '') || chr(31)
        || 'sellpia_current_stock',
      0
    ));

    if exists (
      select 1
      from public.operations_hub_change_queue queue
      where queue.status = 'processing'
        and queue.source_channel = v_target.source_channel
        and btrim(queue.seller_product_code) = v_target.product_code
        and queue.seller_option_code_normalized = v_target.option_code
        and queue.field_key = 'sellpia_current_stock'
    ) or exists (
      select 1
      from public.operations_hub_change_queue queue
      where queue.status = 'processing'
        and queue.source_channel is null
        and queue.field_key = 'sellpia_current_stock'
        and v_target.source_channel = any(queue.target_channels)
        and exists (
          select 1
          from public.operations_hub_matrix_live matrix
          where matrix.sellpia_sku_code = queue.sellpia_sku_code
            and v_target.product_code = btrim(case v_target.source_channel
              when 'smartstore' then matrix.smartstore_product_code
              when 'makeshop' then matrix.makeshop_product_code
              when 'ably' then matrix.ably_product_code
            end)
            and v_target.option_code = coalesce(nullif(btrim(case v_target.source_channel
              when 'smartstore' then matrix.smartstore_option_code
              when 'makeshop' then matrix.makeshop_option_code
              when 'ably' then matrix.ably_option_code
            end), ''), '')
        )
    ) then
      raise exception using
        errcode = '55006',
        message = format(
          '동일 판매처 대상의 처리 중 수정안은 자동 대체할 수 없습니다: %s / %s / %s',
          v_target.source_channel, v_target.product_code, v_target.option_code
        );
    end if;

    update public.operations_hub_change_queue queue
    set status = 'cancelled',
        cancelled_at = clock_timestamp(),
        cancelled_by = v_actor,
        status_message = '최신 판매처 대상 계산 수정안으로 대체됨',
        updated_at = clock_timestamp()
    where queue.status in ('pending', 'validated', 'failed')
      and queue.source_channel = v_target.source_channel
      and btrim(queue.seller_product_code) = v_target.product_code
      and queue.seller_option_code_normalized = v_target.option_code
      and queue.field_key = 'sellpia_current_stock'
      and queue.change_batch_id <> v_batch_id;
    get diagnostics v_affected = row_count;
    v_cancelled := v_cancelled + v_affected;

    update public.operations_hub_change_queue queue
    set status = 'cancelled',
        cancelled_at = clock_timestamp(),
        cancelled_by = v_actor,
        status_message = '정확한 판매처 대상 수정안으로 구형 전체채널 수정안을 대체함',
        updated_at = clock_timestamp()
    where queue.status in ('pending', 'validated', 'failed')
      and queue.source_channel is null
      and queue.field_key = 'sellpia_current_stock'
      and queue.change_batch_id <> v_batch_id
      and exists (
        select 1
        from public.operations_hub_matrix_live matrix
        where matrix.sellpia_sku_code = queue.sellpia_sku_code
          and v_target.source_channel = any(queue.target_channels)
          and v_target.product_code = btrim(case v_target.source_channel
            when 'smartstore' then matrix.smartstore_product_code
            when 'makeshop' then matrix.makeshop_product_code
            when 'ably' then matrix.ably_product_code
          end)
          and v_target.option_code = coalesce(nullif(btrim(case v_target.source_channel
            when 'smartstore' then matrix.smartstore_option_code
            when 'makeshop' then matrix.makeshop_option_code
            when 'ably' then matrix.ably_option_code
          end), ''), '')
      );
    get diagnostics v_affected = row_count;
    v_cancelled := v_cancelled + v_affected;

    insert into public.operations_hub_change_queue (
      change_batch_id, sellpia_sku_code, field_key, before_value, after_value,
      target_channels, status, requested_by, requested_at, updated_at,
      source_channel, seller_product_code, seller_option_code, status_message,
      error_message, validation_errors, target_component_skus,
      target_safety_state, target_safety_details
    )
    select
      v_batch_id,
      v_target.representative_sku,
      'sellpia_current_stock',
      to_jsonb(v_target.seller_stock),
      to_jsonb(v_target.calculated_stock),
      array[v_target.source_channel],
      case when v_target.safety_state = 'ready' then 'pending' else 'failed' end,
      'operations_hub_frontend',
      clock_timestamp(),
      clock_timestamp(),
      v_target.source_channel,
      v_target.product_code,
      v_target.option_code,
      case
        when v_target.safety_state = 'conflict'
          then '판매처 대상 충돌 · 구성 SKU의 재고값이 서로 다릅니다.'
        when v_target.safety_state = 'incomplete'
          then '판매처 대상 계산 불가 · 구성 또는 판매처 원본 재고가 없습니다.'
        when v_target.is_explicit
          then format('세트·번들 계산재고 · 구성 %s SKU · 검토 대기', v_target.component_count)
        when v_target.component_count > 1
          then format('동일 판매처 대상의 같은 재고값 · %s SKU 통합', v_target.component_count)
        else '셀피아 기준 재고 · 매트릭스 검토 대기'
      end,
      case
        when v_target.safety_state = 'conflict'
          then '명시적인 세트·번들 구성이 아닌 여러 SKU가 서로 다른 값을 제안했습니다.'
        when v_target.safety_state = 'incomplete'
          then '구성 SKU 또는 최신 판매처 원본의 재고를 모두 확인할 수 없습니다.'
      end,
      case
        when v_target.safety_state = 'conflict'
          then jsonb_build_array('동일 판매처 대상에 서로 다른 수정값이 있습니다.')
        when v_target.safety_state = 'incomplete'
          then jsonb_build_array('판매처 대상의 재고 계산 입력이 완전하지 않습니다.')
        else '[]'::jsonb
      end,
      v_target.component_skus,
      v_target.safety_state,
      jsonb_build_object(
        'actor', v_actor,
        'calculation', case
          when v_target.is_explicit then 'explicit_bom_min_available'
          when v_target.component_count > 1 then 'legacy_same_value_consolidated'
          else 'single_component'
        end,
        'componentCount', v_target.component_count,
        'knownStockCount', v_target.known_stock_count,
        'sellerStock', v_target.seller_stock,
        'calculatedStock', v_target.calculated_stock,
        'components', v_target.component_details
      )
    where v_target.safety_state <> 'ready'
       or v_target.seller_stock is distinct from v_target.calculated_stock
    on conflict do nothing;
    get diagnostics v_affected = row_count;
    v_staged := v_staged + v_affected;
  end loop;

  return query select
    v_processed,
    v_total,
    v_staged,
    v_cancelled,
    v_next_cursor,
    v_next_cursor is not null and v_next_cursor < v_last_cursor,
    v_batch_id;
end;
$$;

create or replace function public.stage_operations_hub_seller_inventory_match(
  p_session_token text,
  p_sources text[],
  p_skus text[] default null,
  p_batch_id uuid default null
)
returns table(staged_count integer, cancelled_count integer, change_batch_id uuid)
language plpgsql
security definer
set search_path = pg_catalog
set statement_timeout = '45s'
as $$
declare
  v_batch_id uuid := coalesce(p_batch_id, gen_random_uuid());
  v_cursor text := null;
  v_staged integer := 0;
  v_cancelled integer := 0;
  v_page record;
begin
  loop
    select *
    into v_page
    from public.stage_operations_hub_seller_inventory_match_batch(
      p_session_token, p_sources, p_skus, v_batch_id, v_cursor, 500
    );

    v_staged := v_staged + coalesce(v_page.staged_count, 0);
    v_cancelled := v_cancelled + coalesce(v_page.cancelled_count, 0);
    exit when not coalesce(v_page.has_more, false)
      or nullif(v_page.next_cursor, '') is null
      or v_page.processed_count = 0;
    v_cursor := v_page.next_cursor;
  end loop;

  return query select v_staged, v_cancelled, v_batch_id;
end;
$$;

revoke all on function public.stage_operations_hub_seller_inventory_match_batch(text, text[], text[], uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.stage_operations_hub_seller_inventory_match(text, text[], text[], uuid)
  from public, anon, authenticated;
grant execute on function public.stage_operations_hub_seller_inventory_match_batch(text, text[], text[], uuid, text, integer)
  to anon, authenticated;
grant execute on function public.stage_operations_hub_seller_inventory_match(text, text[], text[], uuid)
  to anon, authenticated;

create or replace function public.stage_operations_hub_seller_inventory_match_batch(
  p_sources text[], p_skus text[] default null, p_batch_id uuid default null,
  p_after_sku text default null, p_batch_size integer default 500
)
returns table(processed_count integer, total_count integer, staged_count integer,
  cancelled_count integer, next_cursor text, has_more boolean, change_batch_id uuid)
language plpgsql security invoker set search_path = pg_catalog
as $$ begin
  raise exception using errcode = '42501', message = '운영 세션 토큰이 필요합니다.';
end; $$;

create or replace function public.stage_operations_hub_seller_inventory_match(
  p_sources text[], p_skus text[] default null, p_batch_id uuid default null
)
returns table(staged_count integer, cancelled_count integer, change_batch_id uuid)
language plpgsql security invoker set search_path = pg_catalog
as $$ begin
  raise exception using errcode = '42501', message = '운영 세션 토큰이 필요합니다.';
end; $$;

revoke all on function public.stage_operations_hub_seller_inventory_match_batch(text[], text[], uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.stage_operations_hub_seller_inventory_match(text[], text[], uuid)
  from public, anon, authenticated;
grant execute on function public.stage_operations_hub_seller_inventory_match_batch(text[], text[], uuid, text, integer)
  to anon, authenticated;
grant execute on function public.stage_operations_hub_seller_inventory_match(text[], text[], uuid)
  to anon, authenticated;

-- Project one exact-target proposal back onto all of its component SKUs so the
-- matrix continues to show the same draft on every duplicate/bundle member.
-- Re-close legacy seller draft writers over the physical marketplace target.
-- CREATE OR REPLACE keeps the existing signatures/OIDs and therefore their grants
-- and callers, while ensuring an unchanged edit also retires another component
-- SKU's representative proposal.  A processing proposal is never retired here.
create or replace function public.save_operations_hub_seller_value_draft(
  p_sku text,
  p_source text,
  p_field_key text,
  p_after numeric,
  p_batch_id uuid default null
)
returns table(change_id bigint, draft_status text, cancelled_count integer, change_batch_id uuid)
language plpgsql
security invoker
set search_path = public, operations_private, pg_temp
as $$
declare
  v_matrix public.operations_hub_matrix_live%rowtype;
  v_before numeric;
  v_product_code text;
  v_option_code text;
  v_cancelled integer := 0;
  v_change_id bigint;
  v_batch_id uuid := coalesce(p_batch_id, gen_random_uuid());
begin
  p_sku := btrim(p_sku);
  p_source := lower(btrim(p_source));
  p_field_key := btrim(p_field_key);

  if p_source not in ('smartstore', 'makeshop', 'ably') then
    raise exception '지원하지 않는 판매처입니다: %', p_source;
  end if;
  if p_field_key not in ('sellpia_current_stock', 'sellpia_sale_price') then
    raise exception '재고와 판매가만 판매처 수정안으로 저장할 수 있습니다.';
  end if;
  if p_after is null or p_after < 0 then
    raise exception '재고와 판매가는 0 이상의 숫자여야 합니다.';
  end if;
  if p_field_key = 'sellpia_current_stock' and p_after <> trunc(p_after) then
    raise exception '재고는 정수로 입력해주세요.';
  end if;

  select * into v_matrix
  from public.operations_hub_matrix_live matrix
  where matrix.sellpia_sku_code = p_sku;
  if not found then raise exception '매트릭스에 없는 셀피아 SKU입니다: %', p_sku; end if;

  v_before := case p_source
    when 'smartstore' then case p_field_key when 'sellpia_current_stock' then v_matrix.smartstore_stock else v_matrix.smartstore_price end
    when 'makeshop' then case p_field_key when 'sellpia_current_stock' then v_matrix.makeshop_stock else v_matrix.makeshop_price end
    when 'ably' then case p_field_key when 'sellpia_current_stock' then v_matrix.ably_stock else v_matrix.ably_price end
  end;
  v_product_code := case p_source
    when 'smartstore' then v_matrix.smartstore_product_code
    when 'makeshop' then v_matrix.makeshop_product_code
    when 'ably' then v_matrix.ably_product_code
  end;
  v_option_code := case p_source
    when 'smartstore' then coalesce(v_matrix.smartstore_option_code, '')
    when 'makeshop' then coalesce(v_matrix.makeshop_option_code, '')
    when 'ably' then coalesce(v_matrix.ably_option_code, '')
  end;

  if nullif(btrim(v_product_code), '') is null then
    raise exception '판매처에 연결된 상품코드가 없습니다.';
  end if;
  if v_before is null then
    raise exception '최신 판매처 원본에 현재 값이 없습니다.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    p_source || chr(31)
      || btrim(v_product_code) || chr(31)
      || coalesce(nullif(btrim(v_option_code), ''), '') || chr(31)
      || p_field_key,
    0
  ));

  if exists (
    select 1
    from public.operations_hub_change_queue queue
    where queue.status = 'processing'
      and lower(btrim(queue.source_channel)) = p_source
      and btrim(queue.seller_product_code) = btrim(v_product_code)
      and queue.seller_option_code_normalized = coalesce(nullif(btrim(v_option_code), ''), '')
      and queue.field_key = p_field_key
  ) then
    raise exception using
      errcode = '55006',
      message = format(
        '동일 판매처 대상의 처리 중 수정안은 자동 대체할 수 없습니다: %s / %s / %s',
        p_source, v_product_code, coalesce(v_option_code, '')
      ),
      hint = '진행 중인 판매처 반영이 끝난 뒤 다시 시도해주세요.';
  end if;

  update public.operations_hub_change_queue queue
  set status = 'cancelled',
      cancelled_at = now(),
      cancelled_by = 'operations_hub_frontend',
      status_message = '더 최신 판매처 수정안으로 대체됨',
      updated_at = now()
  where lower(btrim(queue.source_channel)) = p_source
    and btrim(queue.seller_product_code) = btrim(v_product_code)
    and queue.seller_option_code_normalized = coalesce(nullif(btrim(v_option_code), ''), '')
    and queue.field_key = p_field_key
    and queue.status in ('pending', 'validated', 'failed');
  get diagnostics v_cancelled = row_count;

  if v_before is not distinct from p_after then
    return query select null::bigint, 'unchanged'::text, v_cancelled, v_batch_id;
    return;
  end if;

  insert into public.operations_hub_change_queue (
    change_batch_id, sellpia_sku_code, field_key, before_value, after_value,
    target_channels, status, requested_by, requested_at, updated_at,
    source_channel, seller_product_code, seller_option_code, status_message
  ) values (
    v_batch_id, p_sku, p_field_key, to_jsonb(v_before), to_jsonb(p_after),
    array[p_source], 'pending', 'operations_hub_frontend', now(), now(),
    p_source, v_product_code, coalesce(v_option_code, ''), '매트릭스 검토 대기'
  ) returning operations_hub_change_queue.change_id into v_change_id;

  return query select v_change_id, 'pending'::text, v_cancelled, v_batch_id;
end;
$$;

create or replace function public.save_operations_hub_seller_price_draft_v2(
  p_sku text,
  p_source text,
  p_target_base_price numeric,
  p_input_mode text,
  p_option_price numeric default null,
  p_target_final_price numeric default null,
  p_option_price_source text default 'original',
  p_base_price_source text default 'tag',
  p_price_rule_set_id bigint default null,
  p_batch_id uuid default null
)
returns table(
  change_id bigint,
  draft_status text,
  cancelled_count integer,
  change_batch_id uuid,
  source_base_price numeric,
  source_discounted_base_price numeric,
  source_option_price numeric,
  source_final_price numeric,
  draft_base_price numeric,
  draft_discounted_base_price numeric,
  draft_option_price numeric,
  draft_final_price numeric,
  saved_input_mode text,
  saved_at timestamptz
)
language plpgsql
security invoker
set search_path = public, operations_private, pg_temp
as $$
declare
  v_matrix public.operations_hub_matrix_cached%rowtype;
  v_snapshot_id uuid;
  v_source_row public.seller_inventory_snapshot_rows%rowtype;
  v_product_code text;
  v_option_code text;
  v_source_base numeric;
  v_source_discounted numeric;
  v_source_option numeric;
  v_source_final numeric;
  v_target_discounted numeric;
  v_target_option numeric;
  v_target_final numeric;
  v_cancelled integer := 0;
  v_change_id bigint;
  v_batch_id uuid := coalesce(p_batch_id, gen_random_uuid());
  v_saved_at timestamptz := now();
begin
  p_sku := btrim(p_sku);
  p_source := lower(btrim(p_source));
  p_input_mode := lower(btrim(p_input_mode));
  p_option_price_source := lower(coalesce(nullif(btrim(p_option_price_source), ''), 'original'));
  p_base_price_source := lower(coalesce(nullif(btrim(p_base_price_source), ''), 'tag'));

  if p_source not in ('smartstore','makeshop','ably') then raise exception '지원하지 않는 판매처입니다: %', p_source; end if;
  if p_input_mode not in ('option','final') then raise exception '입력 방식은 option 또는 final이어야 합니다.'; end if;
  if p_target_base_price is null or p_target_base_price < 0 then raise exception '태그 계산 판매가는 0 이상의 숫자여야 합니다.'; end if;
  if p_option_price_source not in ('original','manual','tag') then raise exception '옵션가 출처가 올바르지 않습니다.'; end if;
  if p_base_price_source not in ('source','tag','manual') then raise exception '판매가 출처가 올바르지 않습니다.'; end if;

  select * into v_matrix
  from public.operations_hub_matrix_cached matrix
  where matrix.sellpia_sku_code = p_sku;
  if not found then raise exception '매트릭스에 없는 셀피아 SKU입니다: %', p_sku; end if;

  v_product_code := case p_source
    when 'smartstore' then v_matrix.smartstore_product_code
    when 'makeshop' then v_matrix.makeshop_product_code
    when 'ably' then v_matrix.ably_product_code end;
  v_option_code := case p_source
    when 'smartstore' then coalesce(v_matrix.smartstore_option_code, '')
    when 'makeshop' then coalesce(v_matrix.makeshop_option_code, '')
    when 'ably' then coalesce(v_matrix.ably_option_code, '') end;
  if nullif(btrim(v_product_code), '') is null then raise exception '판매처 연결 상품코드가 없습니다.'; end if;

  select snapshot.snapshot_id into v_snapshot_id
  from public.seller_inventory_snapshots snapshot
  where snapshot.source_channel = p_source and snapshot.upload_status = 'ready'
  order by snapshot.completed_at desc nulls last, snapshot.created_at desc limit 1;

  select * into v_source_row
  from public.seller_inventory_snapshot_rows row_item
  where row_item.snapshot_id = v_snapshot_id
    and row_item.product_code = v_product_code
    and row_item.option_code = coalesce(v_option_code, '');
  if not found then raise exception '최신 판매처 원본에서 상품·옵션코드를 찾지 못했습니다.'; end if;

  v_source_base := coalesce(v_source_row.base_price, nullif(v_source_row.raw_payload ->> 'base_price', '')::numeric, v_source_row.price);
  v_source_discounted := coalesce(v_source_row.discounted_base_price, v_source_base);
  v_source_option := coalesce(v_source_row.option_price, nullif(v_source_row.raw_payload ->> 'option_price', '')::numeric, 0);
  v_source_final := coalesce(v_source_row.final_price, v_source_row.price, v_source_discounted + v_source_option);
  v_target_discounted := operations_private.calculate_operations_hub_discounted_base(
    p_source, p_target_base_price, v_source_row.discount_terms, v_source_row.discounted_base_price
  );

  if p_input_mode = 'option' then
    v_target_option := coalesce(p_option_price, v_source_option, 0);
    v_target_final := v_target_discounted + v_target_option;
  else
    if p_target_final_price is null or p_target_final_price < 0 then raise exception '목표 최종구매가는 0 이상의 숫자여야 합니다.'; end if;
    v_target_final := p_target_final_price;
    v_target_option := v_target_final - v_target_discounted;
  end if;

  if p_price_rule_set_id is not null and not exists (
    select 1 from public.operations_hub_price_rule_sets rule_set
    where rule_set.price_rule_set_id = p_price_rule_set_id and rule_set.is_active
  ) then raise exception '활성 가격 조합 태그를 찾을 수 없습니다: %', p_price_rule_set_id; end if;

  perform pg_advisory_xact_lock(hashtextextended(
    p_source || chr(31)
      || btrim(v_product_code) || chr(31)
      || coalesce(nullif(btrim(v_option_code), ''), '') || chr(31)
      || 'sellpia_sale_price',
    0
  ));

  if exists (
    select 1
    from public.operations_hub_change_queue queue
    where queue.status = 'processing'
      and lower(btrim(queue.source_channel)) = p_source
      and btrim(queue.seller_product_code) = btrim(v_product_code)
      and queue.seller_option_code_normalized = coalesce(nullif(btrim(v_option_code), ''), '')
      and queue.field_key = 'sellpia_sale_price'
  ) then
    raise exception using
      errcode = '55006',
      message = format(
        '동일 판매처 대상의 처리 중 수정안은 자동 대체할 수 없습니다: %s / %s / %s',
        p_source, v_product_code, coalesce(v_option_code, '')
      ),
      hint = '진행 중인 판매처 반영이 끝난 뒤 다시 시도해주세요.';
  end if;

  update public.operations_hub_change_queue queue
  set status = 'cancelled',
      cancelled_at = v_saved_at,
      cancelled_by = 'operations_hub_frontend',
      status_message = '더 최신인 판매처 가격 수정으로 대체됨',
      updated_at = v_saved_at
  where lower(btrim(queue.source_channel)) = p_source
    and btrim(queue.seller_product_code) = btrim(v_product_code)
    and queue.seller_option_code_normalized = coalesce(nullif(btrim(v_option_code), ''), '')
    and queue.field_key = 'sellpia_sale_price'
    and queue.status in ('pending', 'validated', 'failed');
  get diagnostics v_cancelled = row_count;

  if v_source_base is not distinct from p_target_base_price
     and v_source_option is not distinct from v_target_option
     and v_source_final is not distinct from v_target_final then
    return query select null::bigint, 'unchanged'::text, v_cancelled, v_batch_id,
      v_source_base, v_source_discounted, v_source_option, v_source_final,
      p_target_base_price, v_target_discounted, v_target_option, v_target_final,
      p_input_mode, v_saved_at;
    return;
  end if;

  insert into public.operations_hub_change_queue (
    change_batch_id, sellpia_sku_code, field_key, before_value, after_value,
    target_channels, status, requested_by, requested_at, updated_at,
    source_channel, seller_product_code, seller_option_code, status_message,
    price_base_before, price_base_after,
    price_discounted_base_before, price_discounted_base_after,
    price_option_before, price_option_after,
    price_final_before, price_final_after,
    option_price_source, base_price_source, price_rule_set_id,
    price_calculation_version, pricing_input_mode,
    source_snapshot_id, source_discount_fingerprint
  ) values (
    v_batch_id, p_sku, 'sellpia_sale_price', to_jsonb(v_source_final), to_jsonb(v_target_final),
    array[p_source], 'pending', 'operations_hub_frontend', v_saved_at, v_saved_at,
    p_source, v_product_code, coalesce(v_option_code, ''), 'DB 저장됨 · 판매처 원본 반영 대기',
    v_source_base, p_target_base_price,
    v_source_discounted, v_target_discounted,
    v_source_option, v_target_option,
    v_source_final, v_target_final,
    p_option_price_source, p_base_price_source, p_price_rule_set_id,
    2, p_input_mode, v_snapshot_id, v_source_row.source_discount_fingerprint
  ) returning operations_hub_change_queue.change_id into v_change_id;

  return query select v_change_id, 'pending'::text, v_cancelled, v_batch_id,
    v_source_base, v_source_discounted, v_source_option, v_source_final,
    p_target_base_price, v_target_discounted, v_target_option, v_target_final,
    p_input_mode, v_saved_at;
end;
$$;

create or replace function public.save_operations_hub_seller_discount_draft(
  p_sku text,
  p_source text,
  p_discount_terms jsonb,
  p_input_mode text default 'option',
  p_option_price numeric default null,
  p_target_final_price numeric default null,
  p_batch_id uuid default null
)
returns table(
  change_id bigint, draft_status text, cancelled_count integer, change_batch_id uuid,
  source_base_price numeric, source_discounted_base_price numeric,
  source_option_price numeric, source_final_price numeric,
  draft_base_price numeric, draft_discounted_base_price numeric,
  draft_option_price numeric, draft_final_price numeric,
  saved_input_mode text, saved_at timestamptz,
  draft_discount_terms jsonb
)
language plpgsql
security invoker
set search_path = public, operations_private, pg_temp
as $$
declare
  v_matrix public.operations_hub_matrix_cached%rowtype;
  v_snapshot_id uuid;
  v_source_row public.seller_inventory_snapshot_rows%rowtype;
  v_existing public.operations_hub_change_queue%rowtype;
  v_product_code text;
  v_option_code text;
  v_source_base numeric;
  v_source_discounted numeric;
  v_source_option numeric;
  v_source_final numeric;
  v_target_base numeric;
  v_target_discounted numeric;
  v_target_option numeric;
  v_target_final numeric;
  v_anchor_discounted numeric;
  v_cancelled integer := 0;
  v_change_id bigint;
  v_batch_id uuid := coalesce(p_batch_id, gen_random_uuid());
  v_saved_at timestamptz := now();
begin
  p_sku := btrim(coalesce(p_sku, ''));
  p_source := lower(btrim(coalesce(p_source, '')));
  p_input_mode := lower(btrim(coalesce(p_input_mode, 'option')));
  p_discount_terms := coalesce(p_discount_terms, '[]'::jsonb);
  if p_source not in ('smartstore','makeshop','ably') then raise exception '지원하지 않는 판매처입니다.'; end if;
  if p_input_mode not in ('option','final','discount_anchor') then raise exception '입력 방식은 option, final 또는 discount_anchor여야 합니다.'; end if;
  if jsonb_typeof(p_discount_terms) <> 'array' then raise exception '할인조건은 JSON 배열이어야 합니다.'; end if;
  if exists (
    select 1 from jsonb_array_elements(p_discount_terms) term
    where nullif(term ->> 'value', '') is not null
      and ((term ->> 'value')::numeric < 0 or term ->> 'unit' not in ('percent','amount'))
  ) then raise exception '할인값과 단위를 확인해주세요.'; end if;

  select * into v_matrix from public.operations_hub_matrix_cached matrix where matrix.sellpia_sku_code = p_sku;
  if not found then raise exception '매트릭스에 없는 셀피아 SKU입니다: %', p_sku; end if;
  v_product_code := case p_source when 'smartstore' then v_matrix.smartstore_product_code when 'makeshop' then v_matrix.makeshop_product_code when 'ably' then v_matrix.ably_product_code end;
  v_option_code := case p_source when 'smartstore' then coalesce(v_matrix.smartstore_option_code, '') when 'makeshop' then coalesce(v_matrix.makeshop_option_code, '') when 'ably' then coalesce(v_matrix.ably_option_code, '') end;
  if nullif(btrim(v_product_code), '') is null then raise exception '판매처 연결 상품코드가 없습니다.'; end if;

  select snapshot.snapshot_id into v_snapshot_id
  from public.seller_inventory_snapshots snapshot
  where snapshot.source_channel = p_source and snapshot.upload_status = 'ready'
  order by snapshot.completed_at desc nulls last, snapshot.created_at desc limit 1;
  select * into v_source_row from public.seller_inventory_snapshot_rows row_item
  where row_item.snapshot_id = v_snapshot_id and row_item.product_code = v_product_code
    and row_item.option_code = coalesce(v_option_code, '');
  if not found then
    raise exception '최신 % 원본에서 상품·옵션코드를 찾지 못했습니다: % / %', p_source, v_product_code, coalesce(v_option_code, '')
      using hint = '판매처 원본을 다시 업로드하거나 상품·옵션 연결을 먼저 확인해주세요.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    p_source || chr(31)
      || btrim(v_product_code) || chr(31)
      || coalesce(nullif(btrim(v_option_code), ''), '') || chr(31)
      || 'sellpia_sale_price',
    0
  ));

  if exists (
    select 1
    from public.operations_hub_change_queue queue
    where queue.status = 'processing'
      and lower(btrim(queue.source_channel)) = p_source
      and btrim(queue.seller_product_code) = btrim(v_product_code)
      and queue.seller_option_code_normalized = coalesce(nullif(btrim(v_option_code), ''), '')
      and queue.field_key = 'sellpia_sale_price'
  ) then
    raise exception using
      errcode = '55006',
      message = format(
        '동일 판매처 대상의 처리 중 수정안은 자동 대체할 수 없습니다: %s / %s / %s',
        p_source, v_product_code, coalesce(v_option_code, '')
      ),
      hint = '진행 중인 판매처 반영이 끝난 뒤 다시 시도해주세요.';
  end if;

  select *
  into v_existing
  from public.operations_hub_change_queue queue
  where lower(btrim(queue.source_channel)) = p_source
    and btrim(queue.seller_product_code) = btrim(v_product_code)
    and queue.seller_option_code_normalized = coalesce(nullif(btrim(v_option_code), ''), '')
    and queue.field_key = 'sellpia_sale_price'
    and queue.status in ('pending', 'validated', 'failed')
  order by queue.updated_at desc, queue.change_id desc
  limit 1;

  v_source_base := coalesce(v_source_row.base_price, nullif(v_source_row.raw_payload ->> 'base_price', '')::numeric, v_source_row.price);
  v_source_discounted := coalesce(v_source_row.discounted_base_price, v_source_base);
  v_source_option := coalesce(v_source_row.option_price, nullif(v_source_row.raw_payload ->> 'option_price', '')::numeric, 0);
  v_source_final := coalesce(v_source_row.final_price, v_source_row.price, v_source_discounted + v_source_option);

  if p_input_mode = 'discount_anchor' then
    v_target_option := coalesce(p_option_price, v_existing.price_option_after, v_source_option, 0);
    v_target_final := coalesce(p_target_final_price, v_existing.price_final_after, v_source_final);
    v_anchor_discounted := v_target_final - v_target_option;
    if v_anchor_discounted < 0 then raise exception '목표 최종구매가보다 옵션가가 커서 할인 적용 판매가가 음수가 됩니다.'; end if;
    v_target_base := operations_private.gross_operations_hub_discount_base(p_source, v_anchor_discounted, p_discount_terms);
    v_target_discounted := operations_private.calculate_operations_hub_discounted_base(p_source, v_target_base, p_discount_terms, null);
  else
    v_target_base := coalesce(v_existing.price_base_after, v_source_base);
    v_target_discounted := operations_private.calculate_operations_hub_discounted_base(p_source, v_target_base, p_discount_terms, null);
    if p_input_mode = 'final' then
      v_target_final := coalesce(p_target_final_price, v_existing.price_final_after, v_source_final);
      v_target_option := v_target_final - v_target_discounted;
    else
      v_target_option := coalesce(p_option_price, v_existing.price_option_after, v_source_option, 0);
      v_target_final := v_target_discounted + v_target_option;
    end if;
  end if;
  if v_target_final < 0 then raise exception '최종구매가는 0 이상이어야 합니다.'; end if;

  update public.operations_hub_change_queue queue
  set status = 'cancelled',
      cancelled_at = v_saved_at,
      cancelled_by = 'operations_hub_frontend',
      status_message = '더 최신인 할인조건 수정으로 대체됨',
      updated_at = v_saved_at
  where lower(btrim(queue.source_channel)) = p_source
    and btrim(queue.seller_product_code) = btrim(v_product_code)
    and queue.seller_option_code_normalized = coalesce(nullif(btrim(v_option_code), ''), '')
    and queue.field_key = 'sellpia_sale_price'
    and queue.status in ('pending', 'validated', 'failed');
  get diagnostics v_cancelled = row_count;

  if v_source_base is not distinct from v_target_base
     and v_source_option is not distinct from v_target_option
     and v_source_final is not distinct from v_target_final
     and coalesce(v_source_row.discount_terms, '[]'::jsonb) = p_discount_terms then
    return query select null::bigint, 'unchanged'::text, v_cancelled, v_batch_id,
      v_source_base, v_source_discounted, v_source_option, v_source_final,
      v_target_base, v_target_discounted, v_target_option, v_target_final,
      p_input_mode, v_saved_at, p_discount_terms;
    return;
  end if;

  insert into public.operations_hub_change_queue(
    change_batch_id,sellpia_sku_code,field_key,before_value,after_value,target_channels,status,
    requested_by,requested_at,updated_at,source_channel,seller_product_code,seller_option_code,status_message,
    price_base_before,price_base_after,price_discounted_base_before,price_discounted_base_after,
    price_option_before,price_option_after,price_final_before,price_final_after,
    option_price_source,base_price_source,price_rule_set_id,price_calculation_version,pricing_input_mode,
    source_snapshot_id,source_discount_fingerprint,price_discount_terms_before,price_discount_terms_after
  ) values (
    v_batch_id,p_sku,'sellpia_sale_price',to_jsonb(v_source_final),to_jsonb(v_target_final),array[p_source],'pending',
    'operations_hub_frontend',v_saved_at,v_saved_at,p_source,v_product_code,coalesce(v_option_code,''),'DB 저장됨 · 할인 적용 후 목표가 유지',
    v_source_base,v_target_base,v_source_discounted,v_target_discounted,
    v_source_option,v_target_option,v_source_final,v_target_final,
    case
      when p_input_mode='discount_anchor'
       and p_option_price is not null
       and p_option_price is distinct from coalesce(v_existing.price_option_after,v_source_option,0)
        then 'discount'
      else coalesce(v_existing.option_price_source,'original')
    end,
    case when p_input_mode='discount_anchor' then 'discount' else coalesce(v_existing.base_price_source,'source') end,
    v_existing.price_rule_set_id,2,p_input_mode,
    v_snapshot_id,v_source_row.source_discount_fingerprint,coalesce(v_source_row.discount_terms,'[]'::jsonb),p_discount_terms
  ) returning operations_hub_change_queue.change_id into v_change_id;

  return query select v_change_id,'pending'::text,v_cancelled,v_batch_id,
    v_source_base,v_source_discounted,v_source_option,v_source_final,
    v_target_base,v_target_discounted,v_target_option,v_target_final,
    p_input_mode,v_saved_at,p_discount_terms;
end;
$$;

create or replace function public.save_operations_hub_seller_rule_draft(
  p_sku text,
  p_source text,
  p_target_base_price numeric,
  p_target_discount_terms jsonb,
  p_target_option_price numeric,
  p_price_rule_set_id bigint,
  p_batch_id uuid default null
)
returns table(
  change_id bigint,
  draft_status text,
  cancelled_count integer,
  change_batch_id uuid,
  draft_base_price numeric,
  draft_discounted_base_price numeric,
  draft_option_price numeric,
  draft_final_price numeric,
  saved_at timestamptz
)
language plpgsql
security invoker
set search_path = public, operations_private, pg_temp
as $$
declare
  v_sku text := btrim(coalesce(p_sku, ''));
  v_source text := lower(btrim(coalesce(p_source, '')));
  v_terms jsonb := coalesce(p_target_discount_terms, '[]'::jsonb);
  v_matrix public.operations_hub_matrix_cached%rowtype;
  v_snapshot_id uuid;
  v_source_row public.seller_inventory_snapshot_rows%rowtype;
  v_product_code text;
  v_option_code text;
  v_source_base numeric;
  v_source_discounted numeric;
  v_source_option numeric;
  v_source_final numeric;
  v_target_discounted numeric;
  v_target_final numeric;
  v_batch_id uuid := coalesce(p_batch_id, gen_random_uuid());
  v_saved_at timestamptz := now();
  v_cancelled integer := 0;
  v_change_id bigint;
begin
  if v_sku = '' then raise exception '셀피아 SKU가 필요합니다.'; end if;
  if v_source not in ('smartstore','makeshop','ably') then raise exception '지원하지 않는 판매처입니다: %', v_source; end if;
  if p_target_base_price is null or p_target_base_price < 0 then raise exception '태그 계산 판매가는 0원 이상이어야 합니다.'; end if;
  if p_target_option_price is null then raise exception '태그 계산 옵션가가 필요합니다.'; end if;
  if jsonb_typeof(v_terms) <> 'array' then raise exception '할인조건은 JSON 배열이어야 합니다.'; end if;

  select * into v_matrix
  from public.operations_hub_matrix_cached matrix
  where matrix.sellpia_sku_code = v_sku;
  if not found then raise exception '매트릭스에 없는 셀피아 SKU입니다: %', v_sku; end if;

  v_product_code := case v_source
    when 'smartstore' then v_matrix.smartstore_product_code
    when 'makeshop' then v_matrix.makeshop_product_code
    when 'ably' then v_matrix.ably_product_code
  end;
  v_option_code := case v_source
    when 'smartstore' then coalesce(v_matrix.smartstore_option_code, '')
    when 'makeshop' then coalesce(v_matrix.makeshop_option_code, '')
    when 'ably' then coalesce(v_matrix.ably_option_code, '')
  end;
  if nullif(btrim(v_product_code), '') is null then raise exception '판매처 연결 상품코드가 없습니다.'; end if;

  select snapshot.snapshot_id into v_snapshot_id
  from public.seller_inventory_snapshots snapshot
  where snapshot.source_channel = v_source and snapshot.upload_status = 'ready'
  order by snapshot.completed_at desc nulls last, snapshot.created_at desc
  limit 1;
  if v_snapshot_id is null then raise exception '최신 % 원본이 없습니다.', v_source; end if;

  select * into v_source_row
  from public.seller_inventory_snapshot_rows source_row
  where source_row.snapshot_id = v_snapshot_id
    and source_row.product_code = v_product_code
    and source_row.option_code = coalesce(v_option_code, '');
  if not found then
    raise exception '최신 % 원본에서 상품·옵션코드를 찾지 못했습니다: % / %', v_source, v_product_code, coalesce(v_option_code, '');
  end if;

  v_source_base := coalesce(v_source_row.base_price, nullif(v_source_row.raw_payload ->> 'base_price', '')::numeric, v_source_row.price);
  v_source_discounted := coalesce(
    v_source_row.discounted_base_price,
    operations_private.calculate_operations_hub_discounted_base(v_source, v_source_base, coalesce(v_source_row.discount_terms, '[]'::jsonb), null)
  );
  v_source_option := coalesce(v_source_row.option_price, nullif(v_source_row.raw_payload ->> 'option_price', '')::numeric, 0);
  v_source_final := coalesce(v_source_row.final_price, v_source_row.price, v_source_discounted + v_source_option);
  v_target_discounted := operations_private.calculate_operations_hub_discounted_base(v_source, p_target_base_price, v_terms, null);
  v_target_final := v_target_discounted + p_target_option_price;
  if v_target_final < 0 then raise exception '태그 계산 최종구매가는 0원 이상이어야 합니다.'; end if;

  perform pg_advisory_xact_lock(hashtextextended(
    v_source || chr(31)
      || btrim(v_product_code) || chr(31)
      || coalesce(nullif(btrim(v_option_code), ''), '') || chr(31)
      || 'sellpia_sale_price',
    0
  ));

  if exists (
    select 1
    from public.operations_hub_change_queue queue
    where queue.status = 'processing'
      and lower(btrim(queue.source_channel)) = v_source
      and btrim(queue.seller_product_code) = btrim(v_product_code)
      and queue.seller_option_code_normalized = coalesce(nullif(btrim(v_option_code), ''), '')
      and queue.field_key = 'sellpia_sale_price'
  ) then
    raise exception using
      errcode = '55006',
      message = format(
        '동일 판매처 대상의 처리 중 수정안은 자동 대체할 수 없습니다: %s / %s / %s',
        v_source, v_product_code, coalesce(v_option_code, '')
      ),
      hint = '진행 중인 판매처 반영이 끝난 뒤 다시 시도해주세요.';
  end if;

  update public.operations_hub_change_queue queue
  set status = 'cancelled',
      cancelled_at = v_saved_at,
      cancelled_by = 'operations_hub_frontend',
      status_message = '더 최신 가격·할인 태그 수정안으로 대체됨',
      updated_at = v_saved_at
  where lower(btrim(queue.source_channel)) = v_source
    and btrim(queue.seller_product_code) = btrim(v_product_code)
    and queue.seller_option_code_normalized = coalesce(nullif(btrim(v_option_code), ''), '')
    and queue.field_key = 'sellpia_sale_price'
    and queue.status in ('pending', 'validated', 'failed');
  get diagnostics v_cancelled = row_count;

  if v_source_base is not distinct from p_target_base_price
     and v_source_discounted is not distinct from v_target_discounted
     and v_source_option is not distinct from p_target_option_price
     and v_source_final is not distinct from v_target_final
     and coalesce(v_source_row.discount_terms, '[]'::jsonb) = v_terms then
    return query select null::bigint, 'unchanged'::text, v_cancelled, v_batch_id,
      p_target_base_price, v_target_discounted, p_target_option_price, v_target_final, v_saved_at;
    return;
  end if;

  insert into public.operations_hub_change_queue(
    change_batch_id, sellpia_sku_code, field_key, before_value, after_value,
    target_channels, status, requested_by, requested_at, updated_at,
    source_channel, seller_product_code, seller_option_code, status_message,
    price_base_before, price_base_after,
    price_discounted_base_before, price_discounted_base_after,
    price_option_before, price_option_after,
    price_final_before, price_final_after,
    option_price_source, base_price_source, price_rule_set_id,
    price_calculation_version, pricing_input_mode,
    source_snapshot_id, source_discount_fingerprint,
    price_discount_terms_before, price_discount_terms_after
  ) values (
    v_batch_id, v_sku, 'sellpia_sale_price', to_jsonb(v_source_final), to_jsonb(v_target_final),
    array[v_source], 'pending', 'operations_hub_frontend', v_saved_at, v_saved_at,
    v_source, v_product_code, coalesce(v_option_code, ''),
    'DB 저장됨 · 판매가 태그 + 할인 태그 독립 계산',
    v_source_base, p_target_base_price,
    v_source_discounted, v_target_discounted,
    v_source_option, p_target_option_price,
    v_source_final, v_target_final,
    'tag', 'tag', p_price_rule_set_id,
    3, 'rule_tags',
    v_snapshot_id, v_source_row.source_discount_fingerprint,
    coalesce(v_source_row.discount_terms, '[]'::jsonb), v_terms
  ) returning operations_hub_change_queue.change_id into v_change_id;

  return query select v_change_id, 'pending'::text, v_cancelled, v_batch_id,
    p_target_base_price, v_target_discounted, p_target_option_price, v_target_final, v_saved_at;
end;
$$;


create or replace view public.operations_hub_active_seller_drafts
with (security_invoker = true)
as
with active_queue as materialized (
  select queue.*
  from public.operations_hub_change_queue queue
  where queue.source_channel in ('smartstore', 'makeshop', 'ably')
    and queue.field_key in ('sellpia_current_stock', 'sellpia_sale_price')
    and queue.status in ('pending', 'validated', 'failed', 'processing')
), projected as (
  select queue.*, component.sellpia_sku_code as projected_sku
  from active_queue queue
  join public.operations_hub_listing_component_projection component
    on component.source_channel = queue.source_channel
   and btrim(component.product_code) = btrim(queue.seller_product_code)
   and coalesce(nullif(btrim(component.option_code), ''), '') = queue.seller_option_code_normalized
  union all
  select queue.*, queue.sellpia_sku_code as projected_sku
  from active_queue queue
  where not exists (
    select 1
    from public.operations_hub_listing_component_projection component
    where component.source_channel = queue.source_channel
      and btrim(component.product_code) = btrim(queue.seller_product_code)
      and coalesce(nullif(btrim(component.option_code), ''), '') = queue.seller_option_code_normalized
  )
)
select distinct on (draft.projected_sku, draft.source_channel, draft.field_key)
  draft.change_id,
  draft.projected_sku as sellpia_sku_code,
  draft.source_channel,
  draft.field_key,
  draft.before_value,
  draft.after_value,
  draft.status,
  draft.updated_at,
  draft.price_base_before,
  draft.price_base_after,
  draft.price_option_before,
  draft.price_option_after,
  draft.price_final_before,
  draft.price_final_after,
  draft.option_price_source,
  draft.price_rule_set_id,
  draft.price_discounted_base_before,
  draft.price_discounted_base_after,
  draft.base_price_source,
  draft.price_calculation_version,
  draft.pricing_input_mode,
  draft.source_snapshot_id,
  draft.source_discount_fingerprint,
  draft.price_discount_terms_before,
  draft.price_discount_terms_after
from projected draft
order by draft.projected_sku, draft.source_channel, draft.field_key,
  draft.updated_at desc, draft.change_id desc;

revoke all on public.operations_hub_active_seller_drafts from public, anon, authenticated;
grant select on public.operations_hub_active_seller_drafts to anon, authenticated;

-- Export preparation is redefined with an exact-target preflight. Even legacy
-- global rows are expanded to their real marketplace target before checking.
create or replace function public.prepare_operations_hub_change_export(
  p_session_token text,
  p_export_batch_id uuid,
  p_change_ids bigint[],
  p_sources text[] default array['smartstore','makeshop','ably']::text[]
)
returns table(item_count integer, blocked_count integer, batch_status text)
language plpgsql
security definer
set search_path = pg_catalog
set statement_timeout = '45s'
as $$
declare
  v_count integer := 0;
  v_blocked integer := 0;
  v_sources text[];
  v_status text;
  v_duplicate_groups integer := 0;
  v_conflict_groups integer := 0;
  v_session jsonb;
  v_requested_count integer := 0;
  v_eligible_count integer := 0;
  v_ineligible_ids bigint[] := '{}'::bigint[];
begin
  v_session := operations_private.require_operations_hub_operator_session(p_session_token);
  if p_export_batch_id is null then raise exception '내보내기 배치 ID가 필요합니다.'; end if;
  if p_change_ids is null or cardinality(p_change_ids) = 0 then raise exception '내보낼 변경사항을 선택해주세요.'; end if;

  select coalesce(array_agg(distinct lower(btrim(source))), '{}'::text[])
  into v_sources
  from unnest(coalesce(p_sources, '{}'::text[])) source
  where lower(btrim(source)) in ('smartstore','makeshop','ably');
  if cardinality(v_sources) = 0 then raise exception '판매처를 하나 이상 선택해주세요.'; end if;

  select batch.item_count,
         count(item.export_item_id) filter (where item.blocking_reason is not null)::integer,
         batch.status
  into v_count, v_blocked, v_status
  from public.operations_hub_export_batches batch
  left join public.operations_hub_export_items item using (export_batch_id)
  where batch.export_batch_id = p_export_batch_id
  group by batch.item_count, batch.status;
  if found then
    return query select v_count, coalesce(v_blocked, 0), v_status;
    return;
  end if;

  with requested as materialized (
    select distinct requested_id
    from unnest(p_change_ids) requested_id
    where requested_id is not null
  ), eligibility as materialized (
    select requested.requested_id,
      queue.change_id is not null
      and queue.status = 'validated'
      and queue.target_safety_state = 'ready'
      and (
        (
          queue.source_channel = any(v_sources)
          and nullif(btrim(queue.seller_product_code), '') is not null
        )
        or (
          queue.source_channel is null
          and exists (
            select 1
            from unnest(queue.target_channels) source(source_channel)
            join public.operations_hub_matrix_live matrix
              on matrix.sellpia_sku_code = queue.sellpia_sku_code
            where source.source_channel = any(v_sources)
              and nullif(btrim(case source.source_channel
                when 'smartstore' then matrix.smartstore_product_code
                when 'makeshop' then matrix.makeshop_product_code
                when 'ably' then matrix.ably_product_code
              end), '') is not null
          )
        )
      ) as is_eligible
    from requested
    left join public.operations_hub_change_queue queue
      on queue.change_id = requested.requested_id
  )
  select
    count(*)::integer,
    count(*) filter (where eligibility.is_eligible)::integer,
    coalesce(array_agg(eligibility.requested_id order by eligibility.requested_id)
      filter (where not eligibility.is_eligible), '{}'::bigint[])
  into v_requested_count, v_eligible_count, v_ineligible_ids
  from eligibility;

  if v_requested_count = 0 or v_eligible_count <> v_requested_count then
    v_blocked := greatest(1, v_requested_count - v_eligible_count);
    insert into public.operations_hub_export_batches (
      export_batch_id, export_mode, source_channels, item_count,
      status, error_message, updated_at
    ) values (
      p_export_batch_id,
      'change_queue',
      v_sources,
      0,
      'failed',
      format(
        '요청 수정안 %s건 중 내보내기 가능한 수정안은 %s건입니다. 누락·범위외·미검토·차단 ID: %s',
        v_requested_count,
        v_eligible_count,
        coalesce(array_to_string(v_ineligible_ids[1:20], ','), '-')
      ),
      clock_timestamp()
    );
    return query select 0, v_blocked, 'failed'::text;
    return;
  end if;

  with resolved as materialized (
    select
      queue.change_id,
      queue.source_channel,
      nullif(btrim(queue.seller_product_code), '') as product_code,
      queue.seller_option_code_normalized as option_code,
      queue.field_key,
      queue.after_value,
      queue.target_safety_state
    from public.operations_hub_change_queue queue
    where queue.change_id = any(p_change_ids)
      and queue.status = 'validated'
      and queue.source_channel = any(v_sources)
    union all
    select
      queue.change_id,
      source.source_channel,
      nullif(btrim(case source.source_channel
        when 'smartstore' then matrix.smartstore_product_code
        when 'makeshop' then matrix.makeshop_product_code
        when 'ably' then matrix.ably_product_code
      end), '') as product_code,
      coalesce(nullif(btrim(case source.source_channel
        when 'smartstore' then matrix.smartstore_option_code
        when 'makeshop' then matrix.makeshop_option_code
        when 'ably' then matrix.ably_option_code
      end), ''), '') as option_code,
      queue.field_key,
      queue.after_value,
      queue.target_safety_state
    from public.operations_hub_change_queue queue
    cross join lateral unnest(queue.target_channels) source(source_channel)
    left join public.operations_hub_matrix_live matrix using (sellpia_sku_code)
    where queue.change_id = any(p_change_ids)
      and queue.status = 'validated'
      and queue.source_channel is null
      and source.source_channel = any(v_sources)
  ), target_groups as materialized (
    select
      resolved.source_channel,
      resolved.product_code,
      resolved.option_code,
      resolved.field_key,
      count(*)::integer as proposal_count,
      count(distinct resolved.after_value)::integer as value_count,
      bool_or(resolved.target_safety_state <> 'ready') as has_blocked_proposal
    from resolved
    where resolved.product_code is not null
    group by resolved.source_channel, resolved.product_code,
      resolved.option_code, resolved.field_key
  )
  select
    count(*) filter (where target.proposal_count > 1)::integer,
    count(*) filter (
      where target.value_count > 1 or target.has_blocked_proposal
    )::integer
  into v_duplicate_groups, v_conflict_groups
  from target_groups target;

  if v_duplicate_groups > 0 or v_conflict_groups > 0 then
    v_blocked := greatest(v_duplicate_groups, v_conflict_groups);
    insert into public.operations_hub_export_batches (
      export_batch_id, export_mode, source_channels, item_count,
      status, error_message, updated_at
    ) values (
      p_export_batch_id,
      'change_queue',
      v_sources,
      0,
      'failed',
      format(
        '판매처 실제 대상 중복 %s그룹 · 값 충돌/차단 %s그룹. 수정안을 다시 생성하거나 충돌을 해결해주세요.',
        v_duplicate_groups,
        v_conflict_groups
      ),
      clock_timestamp()
    );
    return query select 0, v_blocked, 'failed'::text;
    return;
  end if;

  update public.operations_hub_export_batches
  set status = 'failed', error_message = '30분 이상 완료되지 않아 자동 종료', updated_at = now()
  where status = 'prepared' and created_at < now() - interval '30 minutes';

  insert into public.operations_hub_export_batches (export_batch_id, export_mode, source_channels)
  values (p_export_batch_id, 'change_queue', v_sources);

  with source_specific as materialized (
    select queue.change_id, queue.sellpia_sku_code,
      queue.source_channel as export_source_channel, queue.field_key,
      queue.before_value, queue.after_value,
      nullif(btrim(queue.seller_product_code), '') as product_code,
      queue.seller_option_code_normalized as option_code,
      queue.price_base_after, queue.price_option_after, queue.price_final_after,
      queue.option_price_source, queue.price_rule_set_id
    from public.operations_hub_change_queue queue
    where queue.change_id = any(p_change_ids)
      and queue.status = 'validated'
      and queue.source_channel = any(v_sources)
      and queue.target_safety_state = 'ready'
  ), global_changes as materialized (
    select queue.change_id, queue.sellpia_sku_code,
      source.source_channel as export_source_channel, queue.field_key,
      queue.before_value, queue.after_value,
      case source.source_channel
        when 'smartstore' then matrix.smartstore_product_code
        when 'makeshop' then matrix.makeshop_product_code
        when 'ably' then matrix.ably_product_code
      end as product_code,
      case source.source_channel
        when 'smartstore' then coalesce(matrix.smartstore_option_code, '')
        when 'makeshop' then coalesce(matrix.makeshop_option_code, '')
        when 'ably' then coalesce(matrix.ably_option_code, '')
      end as option_code,
      null::numeric as price_base_after, null::numeric as price_option_after,
      null::numeric as price_final_after, null::text as option_price_source,
      null::bigint as price_rule_set_id
    from public.operations_hub_change_queue queue
    cross join lateral unnest(queue.target_channels) source(source_channel)
    left join public.operations_hub_matrix_live matrix using (sellpia_sku_code)
    where queue.change_id = any(p_change_ids)
      and queue.status = 'validated'
      and queue.source_channel is null
      and source.source_channel = any(v_sources)
      and queue.target_safety_state = 'ready'
  ), selected_changes as materialized (
    select * from source_specific
    union all
    select * from global_changes
  ), latest_snapshot as materialized (
    select distinct on (snapshot.source_channel) snapshot.snapshot_id, snapshot.source_channel
    from public.seller_inventory_snapshots snapshot
    where snapshot.upload_status = 'ready' and snapshot.source_channel = any(v_sources)
    order by snapshot.source_channel, snapshot.completed_at desc nulls last, snapshot.created_at desc
  )
  insert into public.operations_hub_export_items (
    export_batch_id, change_id, sellpia_sku_code, source_channel, field_key,
    before_value, after_value, seller_product_code, seller_option_code,
    source_file_name, source_row_no, expected_source_value,
    base_price, option_price, target_base_price, target_option_price,
    target_final_price, option_price_source, price_rule_set_id, blocking_reason
  )
  select p_export_batch_id, change.change_id, change.sellpia_sku_code,
    change.export_source_channel, change.field_key, change.before_value, change.after_value,
    change.product_code, coalesce(change.option_code, ''),
    source_row.raw_payload ->> 'source_file_name', source_row.source_row_no,
    case change.field_key
      when 'sellpia_current_stock' then to_jsonb(source_row.stock)
      when 'sellpia_sale_price' then to_jsonb(coalesce(source_row.final_price, source_row.price))
      when 'seller_product_name' then to_jsonb(source_row.product_name)
      when 'seller_option_name' then to_jsonb(source_row.option_name)
    end,
    coalesce(source_row.base_price, nullif(source_row.raw_payload ->> 'base_price', '')::numeric, source_row.price),
    coalesce(source_row.option_price, nullif(source_row.raw_payload ->> 'option_price', '')::numeric, 0),
    case when change.field_key = 'sellpia_sale_price' then change.price_base_after end,
    case when change.field_key = 'sellpia_sale_price' then change.price_option_after end,
    case when change.field_key = 'sellpia_sale_price' then coalesce(change.price_final_after, (change.after_value #>> '{}')::numeric) end,
    change.option_price_source, change.price_rule_set_id,
    case
      when change.product_code is null then '판매처 연결 코드가 없습니다.'
      when source_row.product_code is null then '최신 판매처 원본에서 상품·옵션 코드를 찾지 못했습니다.'
      when source_row.raw_payload ->> 'source_file_name' is null then '원본 파일명이 기록되지 않았습니다.'
      when source_row.source_row_no is null then '원본 행번호가 기록되지 않았습니다.'
      when change.field_key = 'sellpia_sale_price' and change.price_base_after is null then '목표 판매가 계산값이 없습니다.'
      when change.field_key = 'sellpia_sale_price' and change.price_option_after is null then '목표 옵션가 계산값이 없습니다.'
    end
  from selected_changes change
  left join latest_snapshot snapshot on snapshot.source_channel = change.export_source_channel
  left join public.seller_inventory_snapshot_rows source_row
    on source_row.snapshot_id = snapshot.snapshot_id
   and source_row.product_code = change.product_code
   and source_row.option_code = coalesce(change.option_code, '')
  on conflict do nothing;

  with latest_snapshot as materialized (
    select distinct on (snapshot.source_channel) snapshot.snapshot_id, snapshot.source_channel
    from public.seller_inventory_snapshots snapshot
    where snapshot.upload_status = 'ready' and snapshot.source_channel = any(v_sources)
    order by snapshot.source_channel, snapshot.completed_at desc nulls last, snapshot.created_at desc
  ), product_source_count as materialized (
    select snapshot.source_channel, row_item.product_code,
      count(distinct coalesce(row_item.option_code, ''))::integer as source_option_count
    from public.seller_inventory_snapshot_rows row_item
    join latest_snapshot snapshot on snapshot.snapshot_id = row_item.snapshot_id
    group by snapshot.source_channel, row_item.product_code
  ), price_group as materialized (
    select item.source_channel, item.seller_product_code,
      count(distinct coalesce(item.seller_option_code, ''))::integer as selected_option_count,
      count(distinct item.target_base_price)::integer as target_base_count,
      bool_or(item.target_base_price is distinct from item.base_price) as changes_shared_base
    from public.operations_hub_export_items item
    where item.export_batch_id = p_export_batch_id
      and item.field_key = 'sellpia_sale_price'
      and item.source_channel in ('smartstore','makeshop')
    group by item.source_channel, item.seller_product_code
  )
  update public.operations_hub_export_items item
  set blocking_reason = coalesce(item.blocking_reason,
    case
      when price_group.target_base_count > 1 then '같은 상품의 옵션별 목표 판매가가 서로 다릅니다.'
      when price_group.changes_shared_base and price_group.selected_option_count < source_count.source_option_count
        then '공유 판매가를 변경하려면 같은 상품의 모든 옵션 가격을 함께 검토해야 합니다.'
    end)
  from price_group
  join product_source_count source_count
    on source_count.source_channel = price_group.source_channel
   and source_count.product_code = price_group.seller_product_code
  where item.export_batch_id = p_export_batch_id
    and item.source_channel = price_group.source_channel
    and item.seller_product_code = price_group.seller_product_code
    and item.field_key = 'sellpia_sale_price';

  select count(*)::integer, count(*) filter (where blocking_reason is not null)::integer
  into v_count, v_blocked
  from public.operations_hub_export_items where export_batch_id = p_export_batch_id;
  if v_count = 0 then raise exception '내보낼 변경사항이 없습니다.'; end if;

  v_status := case when v_blocked > 0 then 'failed' else 'prepared' end;
  update public.operations_hub_export_batches
  set item_count = v_count, status = v_status,
      error_message = case when v_blocked > 0 then v_blocked || '건의 원본 위치·가격 구성을 확인할 수 없습니다.' end,
      updated_at = now()
  where export_batch_id = p_export_batch_id;

  return query select v_count, v_blocked, v_status;
end;
$$;

revoke all on function public.prepare_operations_hub_change_export(text,uuid,bigint[],text[])
  from public, anon, authenticated;
grant execute on function public.prepare_operations_hub_change_export(text,uuid,bigint[],text[])
  to anon, authenticated;

create or replace function public.prepare_operations_hub_change_export(
  p_export_batch_id uuid,
  p_change_ids bigint[],
  p_sources text[] default array['smartstore','makeshop','ably']::text[]
)
returns table(item_count integer, blocked_count integer, batch_status text)
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  raise exception using errcode = '42501', message = '운영 세션 토큰이 필요합니다.';
end;
$$;

revoke all on function public.prepare_operations_hub_change_export(uuid,bigint[],text[])
  from public, anon, authenticated;
grant execute on function public.prepare_operations_hub_change_export(uuid,bigint[],text[])
  to anon, authenticated;

-- Bounded read-only diagnostics for the operator UI. These functions obey the
-- queue and matrix RLS of the caller because both are SECURITY INVOKER.
create or replace function public.list_operations_hub_change_batch_summaries_v1(
  p_sources text[] default null,
  p_limit integer default 30
)
returns table(
  change_batch_id uuid,
  oldest_at timestamptz,
  newest_at timestamptz,
  source_channels text[],
  total_count integer,
  active_count integer,
  status_counts jsonb,
  duplicate_target_groups integer,
  conflicting_target_groups integer,
  superseded_count integer,
  is_stale boolean
)
language sql
stable
security invoker
set search_path = pg_catalog, public
set statement_timeout = '10s'
as $$
  with input as (
    select
      coalesce((
        select array_agg(distinct lower(btrim(source)))
        from unnest(coalesce(p_sources, '{}'::text[])) source
        where lower(btrim(source)) in ('smartstore','makeshop','ably')
      ), '{}'::text[]) as sources,
      greatest(1, least(coalesce(p_limit, 30), 30)) as row_limit
  ), latest_batches as materialized (
    select queue.change_batch_id, max(queue.updated_at) as newest_at
    from public.operations_hub_change_queue queue
    cross join input
    where cardinality(input.sources) = 0
       or queue.source_channel = any(input.sources)
       or queue.target_channels && input.sources
    group by queue.change_batch_id
    order by max(queue.updated_at) desc, queue.change_batch_id
    limit (select row_limit from input)
  ), batch_rows as materialized (
    select queue.*
    from public.operations_hub_change_queue queue
    join latest_batches batch using (change_batch_id)
  ), expanded_targets as materialized (
    select queue.change_batch_id, queue.change_id, queue.source_channel,
      nullif(btrim(queue.seller_product_code), '') as product_code,
      queue.seller_option_code_normalized as option_code,
      queue.field_key, queue.after_value, queue.target_safety_state
    from batch_rows queue
    where queue.source_channel is not null
    union all
    select queue.change_batch_id, queue.change_id, source.source_channel,
      nullif(btrim(case source.source_channel
        when 'smartstore' then matrix.smartstore_product_code
        when 'makeshop' then matrix.makeshop_product_code
        when 'ably' then matrix.ably_product_code
      end), '') as product_code,
      coalesce(nullif(btrim(case source.source_channel
        when 'smartstore' then matrix.smartstore_option_code
        when 'makeshop' then matrix.makeshop_option_code
        when 'ably' then matrix.ably_option_code
      end), ''), '') as option_code,
      queue.field_key, queue.after_value, queue.target_safety_state
    from batch_rows queue
    cross join lateral unnest(queue.target_channels) source(source_channel)
    left join public.operations_hub_matrix_live matrix using (sellpia_sku_code)
    where queue.source_channel is null
  ), target_group_stats as materialized (
    select target.change_batch_id, target.source_channel, target.product_code,
      target.option_code, target.field_key,
      count(*)::integer as proposal_count,
      count(distinct target.after_value)::integer as value_count,
      bool_or(target.target_safety_state <> 'ready') as has_blocked_proposal
    from expanded_targets target
    where target.product_code is not null
    group by target.change_batch_id, target.source_channel, target.product_code,
      target.option_code, target.field_key
  ), batch_target_stats as materialized (
    select target.change_batch_id,
      count(*) filter (where target.proposal_count > 1)::integer as duplicate_groups,
      count(*) filter (
        where target.value_count > 1 or target.has_blocked_proposal
      )::integer as conflict_groups
    from target_group_stats target
    group by target.change_batch_id
  ), batch_basic_stats as materialized (
    select
      queue.change_batch_id,
      min(queue.requested_at) as oldest_at,
      max(queue.updated_at) as newest_at,
      count(*)::integer as total_count,
      count(*) filter (
        where queue.status in ('pending','validated','failed','processing')
      )::integer as active_count,
      count(*) filter (
        where queue.status = 'cancelled' and queue.status_message like '%대체%'
      )::integer as superseded_count
    from batch_rows queue
    group by queue.change_batch_id
  ), batch_status_counts as materialized (
    select status_row.change_batch_id,
      jsonb_object_agg(status_row.status, status_row.row_count) as status_counts
    from (
      select queue.change_batch_id, queue.status, count(*)::integer as row_count
      from batch_rows queue
      group by queue.change_batch_id, queue.status
    ) status_row
    group by status_row.change_batch_id
  ), batch_sources as materialized (
    select queue.change_batch_id,
      array_agg(distinct source.source_channel order by source.source_channel) as source_channels
    from batch_rows queue
    cross join lateral unnest(
      case
        when queue.source_channel is not null then array[queue.source_channel]
        else queue.target_channels
      end
    ) source(source_channel)
    group by queue.change_batch_id
  )
  select
    stats.change_batch_id,
    stats.oldest_at,
    stats.newest_at,
    coalesce(sources.source_channels, '{}'::text[]),
    stats.total_count,
    stats.active_count,
    coalesce(statuses.status_counts, '{}'::jsonb),
    coalesce(targets.duplicate_groups, 0),
    coalesce(targets.conflict_groups, 0),
    stats.superseded_count,
    stats.active_count = 0 and stats.superseded_count > 0
  from batch_basic_stats stats
  left join batch_sources sources using (change_batch_id)
  left join batch_status_counts statuses using (change_batch_id)
  left join batch_target_stats targets using (change_batch_id)
  order by stats.newest_at desc, stats.change_batch_id;
$$;

create or replace function public.preview_operations_hub_change_target_safety_v1(
  p_sources text[] default null,
  p_limit integer default 200
)
returns table(
  source_channel text,
  seller_product_code text,
  seller_option_code text,
  field_key text,
  issue_type text,
  active_change_ids bigint[],
  proposed_values jsonb,
  component_skus text[],
  newest_at timestamptz
)
language sql
stable
security invoker
set search_path = pg_catalog, public
set statement_timeout = '10s'
as $$
  with input as (
    select coalesce((
      select array_agg(distinct lower(btrim(source)))
      from unnest(coalesce(p_sources, '{}'::text[])) source
      where lower(btrim(source)) in ('smartstore','makeshop','ably')
    ), '{}'::text[]) as sources
  ), active_targets as materialized (
    select queue.change_id, queue.source_channel,
      btrim(queue.seller_product_code) as product_code,
      queue.seller_option_code_normalized as option_code,
      queue.field_key, queue.after_value, queue.sellpia_sku_code,
      queue.target_component_skus, queue.target_safety_state, queue.updated_at
    from public.operations_hub_change_queue queue
    cross join input
    where queue.status in ('pending','validated','failed','processing')
      and queue.source_channel is not null
      and queue.seller_product_code is not null
      and (cardinality(input.sources) = 0 or queue.source_channel = any(input.sources))
  ), grouped as (
    select target.source_channel, target.product_code, target.option_code,
      target.field_key,
      count(*)::integer as proposal_count,
      count(distinct target.after_value)::integer as value_count,
      bool_or(target.target_safety_state <> 'ready') as has_blocked_proposal,
      array_agg(target.change_id order by target.updated_at desc, target.change_id desc) as change_ids,
      jsonb_agg(distinct target.after_value) as proposed_values,
      array_agg(distinct component.sku order by component.sku) as component_skus,
      max(target.updated_at) as newest_at
    from active_targets target
    cross join lateral unnest(
      case
        when cardinality(target.target_component_skus) > 0 then target.target_component_skus
        else array[target.sellpia_sku_code]
      end
    ) component(sku)
    group by target.source_channel, target.product_code, target.option_code, target.field_key
  )
  select grouped.source_channel, grouped.product_code, grouped.option_code,
    grouped.field_key,
    case
      when grouped.value_count > 1 then 'conflicting_values'
      when grouped.has_blocked_proposal then 'blocked_calculation'
      else 'duplicate_target'
    end,
    grouped.change_ids,
    grouped.proposed_values,
    grouped.component_skus,
    grouped.newest_at
  from grouped
  where grouped.proposal_count > 1 or grouped.has_blocked_proposal
  order by grouped.newest_at desc, grouped.source_channel,
    grouped.product_code, grouped.option_code, grouped.field_key
  limit greatest(1, least(coalesce(p_limit, 200), 500));
$$;

revoke all on function public.list_operations_hub_change_batch_summaries_v1(text[], integer)
  from public, anon, authenticated;
revoke all on function public.preview_operations_hub_change_target_safety_v1(text[], integer)
  from public, anon, authenticated;
grant execute on function public.list_operations_hub_change_batch_summaries_v1(text[], integer)
  to anon, authenticated;
grant execute on function public.preview_operations_hub_change_target_safety_v1(text[], integer)
  to anon, authenticated;

comment on function public.stage_operations_hub_seller_inventory_match_batch(text, text[], text[], uuid, text, integer) is
  'Stages at most one inventory proposal per exact marketplace upload target; explicit BOMs are qty-aware and ambiguous legacy multi-links are failed visibly.';
comment on function public.prepare_operations_hub_change_export(text,uuid,bigint[],text[]) is
  'Prepares an export only after exact marketplace targets are unique, unambiguous, and target-safety ready.';
comment on function public.list_operations_hub_change_batch_summaries_v1(text[], integer) is
  'Returns at most 30 recent change batches with lifecycle, duplicate/conflict, and stale signals under caller RLS.';
comment on function public.preview_operations_hub_change_target_safety_v1(text[], integer) is
  'Read-only exact-target issue preview for active seller changes under caller RLS.';

notify pgrst, 'reload schema';
