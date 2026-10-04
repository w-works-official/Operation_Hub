-- Persist explicit seller-link disconnections so legacy/cache refreshes cannot
-- recreate a relationship that an operator intentionally removed.

create table if not exists public.operations_hub_link_suppressions (
  source_channel text not null,
  sellpia_sku_code text not null,
  product_code text not null,
  option_code text not null default '',
  reason text not null default 'operator_disconnect',
  suppressed_by text not null default 'operations_hub_frontend',
  suppressed_at timestamptz not null default now(),
  primary key (source_channel, sellpia_sku_code, product_code, option_code),
  constraint operations_hub_link_suppressions_source_check
    check (source_channel in ('smartstore', 'makeshop', 'ably'))
);

create index if not exists operations_hub_link_suppressions_sku_idx
  on public.operations_hub_link_suppressions (sellpia_sku_code, source_channel);

alter table public.operations_hub_link_suppressions enable row level security;

drop policy if exists "operations hub link suppressions readable"
  on public.operations_hub_link_suppressions;
create policy "operations hub link suppressions readable"
  on public.operations_hub_link_suppressions for select
  to anon, authenticated
  using (true);

revoke all on table public.operations_hub_link_suppressions from public;
revoke insert, update, delete on table public.operations_hub_link_suppressions from anon, authenticated;
grant select on table public.operations_hub_link_suppressions to anon, authenticated;

create or replace function public.disconnect_operations_hub_listing_component(
  p_component_id bigint,
  p_source text,
  p_product_code text,
  p_option_code text,
  p_sellpia_sku_code text
)
returns table (
  listing_id bigint,
  component_id bigint,
  remaining_component_count integer,
  promoted_component_count integer,
  suppression_saved boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_listing_id bigint;
  v_component_id bigint;
  v_remaining integer;
  v_promoted integer := 0;
  v_before jsonb;
begin
  p_source := lower(btrim(coalesce(p_source, '')));
  p_product_code := btrim(coalesce(p_product_code, ''));
  p_option_code := btrim(coalesce(p_option_code, ''));
  p_sellpia_sku_code := btrim(coalesce(p_sellpia_sku_code, ''));

  if p_source not in ('smartstore', 'makeshop', 'ably') then
    raise exception '지원하지 않는 판매처입니다.';
  end if;
  if p_product_code = '' or p_sellpia_sku_code = '' then
    raise exception '판매처 상품코드와 셀피아 SKU는 필수입니다.';
  end if;

  if p_component_id is not null then
    select listing.listing_id, component.component_id
      into v_listing_id, v_component_id
    from public.operations_hub_listing_components component
    join public.operations_hub_seller_listings listing
      on listing.listing_id = component.listing_id
    where component.component_id = p_component_id
      and component.is_active
      and listing.is_active
      and listing.source_channel = p_source
      and listing.product_code = p_product_code
      and listing.option_code = p_option_code
      and component.sellpia_sku_code = p_sellpia_sku_code;

    if not found then
      raise exception '현재 연결에서 선택한 구성품을 찾을 수 없습니다.';
    end if;
  else
    if not exists (
      select 1
      from public.operations_hub_listing_legacy_cache cache
      where cache.source_channel = p_source
        and cache.product_code = p_product_code
        and cache.option_code = p_option_code
        and cache.sellpia_sku_code = p_sellpia_sku_code
    ) then
      raise exception '현재 자동 연결에서 해당 셀피아 SKU를 찾을 수 없습니다.';
    end if;

    -- Promotion creates an explicit listing. Keeping that listing active with
    -- zero components is the durable tombstone that blocks legacy fallback.
    select promoted.listing_id, promoted.component_id, promoted.promoted_component_count
      into v_listing_id, v_component_id, v_promoted
    from public.upsert_operations_hub_listing_component(
      p_source,
      p_product_code,
      p_option_code,
      p_sellpia_sku_code,
      1,
      'primary'
    ) promoted;
  end if;

  select coalesce(
    (
      select to_jsonb(manual.*)
      from public.operations_hub_manual_links manual
      where manual.source_channel = p_source
        and manual.sellpia_sku_code = p_sellpia_sku_code
    ),
    jsonb_build_object(
      'source_channel', p_source,
      'sellpia_sku_code', p_sellpia_sku_code,
      'product_code', p_product_code,
      'option_code', p_option_code,
      'mapping_origin', 'listing_graph'
    )
  ) into v_before;

  select deactivated.remaining_component_count
    into v_remaining
  from public.deactivate_operations_hub_listing_component(v_component_id) deactivated;

  insert into public.operations_hub_link_suppressions (
    source_channel,
    sellpia_sku_code,
    product_code,
    option_code,
    reason,
    suppressed_by,
    suppressed_at
  ) values (
    p_source,
    p_sellpia_sku_code,
    p_product_code,
    p_option_code,
    'operator_disconnect',
    'operations_hub_frontend',
    now()
  )
  on conflict (source_channel, sellpia_sku_code, product_code, option_code)
  do update set
    reason = excluded.reason,
    suppressed_by = excluded.suppressed_by,
    suppressed_at = excluded.suppressed_at;

  insert into public.operations_hub_link_history (
    sellpia_sku_code,
    source_channel,
    before_link,
    after_link,
    changed_by,
    changed_at
  ) values (
    p_sellpia_sku_code,
    p_source,
    v_before,
    jsonb_build_object(
      'disconnected', true,
      'product_code', p_product_code,
      'option_code', p_option_code,
      'suppression_saved', true
    ),
    'operations_hub_frontend',
    now()
  );

  return query
  select v_listing_id, v_component_id, v_remaining, v_promoted, true;
end;
$$;

comment on function public.disconnect_operations_hub_listing_component(bigint, text, text, text, text) is
  'Soft-deactivates one explicit or inferred seller component and stores an exact suppression so source/cache refreshes cannot restore it.';

revoke all on function public.disconnect_operations_hub_listing_component(bigint, text, text, text, text) from public;
grant execute on function public.disconnect_operations_hub_listing_component(bigint, text, text, text, text) to anon, authenticated;

-- Compatibility wrapper for older clients. The last remaining edge is now a
-- valid disconnect because the explicit empty listing preserves the decision.
create or replace function public.disconnect_operations_hub_legacy_listing_component(
  p_source text,
  p_product_code text,
  p_option_code text,
  p_sellpia_sku_code text
)
returns table (
  listing_id bigint,
  component_id bigint,
  remaining_component_count integer,
  promoted_component_count integer
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    disconnected.listing_id,
    disconnected.component_id,
    disconnected.remaining_component_count,
    disconnected.promoted_component_count
  from public.disconnect_operations_hub_listing_component(
    null,
    p_source,
    p_product_code,
    p_option_code,
    p_sellpia_sku_code
  ) disconnected;
$$;

comment on function public.disconnect_operations_hub_legacy_listing_component(text, text, text, text) is
  'Compatibility wrapper for durable inferred-link disconnection, including the last remaining edge.';

revoke all on function public.disconnect_operations_hub_legacy_listing_component(text, text, text, text) from public;
grant execute on function public.disconnect_operations_hub_legacy_listing_component(text, text, text, text) to anon, authenticated;

create or replace function public.save_operations_hub_listing_component(
  p_source text,
  p_product_code text,
  p_option_code text,
  p_sellpia_sku_code text,
  p_component_qty integer default 1,
  p_component_role text default 'additional'
)
returns table (
  listing_id bigint,
  component_id bigint,
  promoted_component_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  select saved.listing_id, saved.component_id, saved.promoted_component_count
  from public.upsert_operations_hub_listing_component(
    p_source,
    p_product_code,
    p_option_code,
    p_sellpia_sku_code,
    p_component_qty,
    p_component_role
  ) saved;

  delete from public.operations_hub_link_suppressions suppression
  where suppression.source_channel = lower(btrim(coalesce(p_source, '')))
    and suppression.sellpia_sku_code = btrim(coalesce(p_sellpia_sku_code, ''))
    and suppression.product_code = btrim(coalesce(p_product_code, ''))
    and suppression.option_code = btrim(coalesce(p_option_code, ''));
end;
$$;

revoke all on function public.save_operations_hub_listing_component(text, text, text, text, integer, text) from public;
grant execute on function public.save_operations_hub_listing_component(text, text, text, text, integer, text) to anon, authenticated;

create or replace function public.link_operations_hub_seller_item_v2(
  p_sku text,
  p_source text,
  p_product_code text,
  p_option_code text default ''
)
returns table (
  source_channel text,
  sellpia_sku_code text,
  product_code text,
  option_code text,
  product_name text,
  option_name text,
  stock integer,
  price numeric,
  linked_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  select linked.*
  from public.link_operations_hub_seller_item(
    p_sku,
    p_source,
    p_product_code,
    p_option_code
  ) linked;

  delete from public.operations_hub_link_suppressions suppression
  where suppression.source_channel = lower(btrim(coalesce(p_source, '')))
    and suppression.sellpia_sku_code = btrim(coalesce(p_sku, ''));
end;
$$;

revoke all on function public.link_operations_hub_seller_item_v2(text, text, text, text) from public;
grant execute on function public.link_operations_hub_seller_item_v2(text, text, text, text) to anon, authenticated;

-- Overlay suppressions after the cached matrix so an operator disconnect is
-- visible immediately without waiting for a full 24k-row cache rebuild.
create or replace view public.operations_hub_matrix_system_live
with (security_invoker = true)
as
with suppression_state as (
  select
    matrix,
    (smart_suppression.sellpia_sku_code is not null) as smartstore_link_suppressed,
    (make_suppression.sellpia_sku_code is not null) as makeshop_link_suppressed,
    (ably_suppression.sellpia_sku_code is not null) as ably_link_suppressed
  from public.operations_hub_matrix_cached matrix
  left join public.operations_hub_link_suppressions smart_suppression
    on smart_suppression.source_channel = 'smartstore'
   and smart_suppression.sellpia_sku_code = matrix.sellpia_sku_code
   and smart_suppression.product_code = matrix.smartstore_product_code
   and smart_suppression.option_code = coalesce(matrix.smartstore_option_code, '')
  left join public.operations_hub_link_suppressions make_suppression
    on make_suppression.source_channel = 'makeshop'
   and make_suppression.sellpia_sku_code = matrix.sellpia_sku_code
   and make_suppression.product_code = matrix.makeshop_product_code
   and make_suppression.option_code = coalesce(matrix.makeshop_option_code, '')
  left join public.operations_hub_link_suppressions ably_suppression
    on ably_suppression.source_channel = 'ably'
   and ably_suppression.sellpia_sku_code = matrix.sellpia_sku_code
   and ably_suppression.product_code = matrix.ably_product_code
   and ably_suppression.option_code = coalesce(matrix.ably_option_code, '')
), effective as (
  select
    jsonb_populate_record(
      state.matrix,
      (case when state.smartstore_link_suppressed then jsonb_build_object(
        'smartstore_name', null, 'smartstore_option_name', null,
        'smartstore_product_code', null, 'smartstore_option_code', null,
        'smartstore_match_tier', null, 'smartstore_match_score', null,
        'smartstore_listing_count', 0, 'smartstore_name_is_draft', false,
        'smartstore_sale_status', null, 'smartstore_stock', null,
        'smartstore_price', null, 'smartstore_policy_price', null,
        'smartstore_policy_active', null, 'smartstore_policy_name', null,
        'smartstore_inventory_at', null
      ) else '{}'::jsonb end)
      || (case when state.makeshop_link_suppressed then jsonb_build_object(
        'makeshop_name', null, 'makeshop_option_name', null,
        'makeshop_product_code', null, 'makeshop_option_code', null,
        'makeshop_match_tier', null, 'makeshop_match_score', null,
        'makeshop_listing_count', 0, 'makeshop_name_is_draft', false,
        'makeshop_sale_status', null, 'makeshop_stock', null,
        'makeshop_price', null, 'makeshop_policy_price', null,
        'makeshop_policy_active', null, 'makeshop_policy_name', null,
        'makeshop_inventory_at', null
      ) else '{}'::jsonb end)
      || (case when state.ably_link_suppressed then jsonb_build_object(
        'ably_name', null, 'ably_option_name', null,
        'ably_product_code', null, 'ably_option_code', null,
        'ably_match_tier', null, 'ably_match_score', null,
        'ably_listing_count', 0, 'ably_name_is_draft', false,
        'ably_sale_status', null, 'ably_stock', null,
        'ably_price', null, 'ably_policy_price', null,
        'ably_policy_active', null, 'ably_policy_name', null,
        'ably_inventory_at', null
      ) else '{}'::jsonb end)
      || (case
        when state.smartstore_link_suppressed or state.makeshop_link_suppressed or state.ably_link_suppressed
        then jsonb_build_object(
          'overall_status', case
            when (state.smartstore_link_suppressed or (state.matrix).smartstore_product_code is null)
             and (state.makeshop_link_suppressed or (state.matrix).makeshop_product_code is null)
             and (state.ably_link_suppressed or (state.matrix).ably_product_code is null)
            then 'unmatched'
            else 'connected'
          end
        )
        else '{}'::jsonb
      end)
    ) as matrix_row,
    state.smartstore_link_suppressed,
    state.makeshop_link_suppressed,
    state.ably_link_suppressed
  from suppression_state state
)
select
  (effective.matrix_row).*,
  nullif(
    regexp_replace(coalesce(source_stock.raw_payload ->> 'sell_price', ''), '[^0-9.-]', '', 'g'),
    ''
  )::numeric as sellpia_source_sale_price,
  source_stock.stock as sellpia_source_stock,
  source_stock.snapshot_completed_at as sellpia_source_updated_at,
  master.base_price as system_base_price,
  master.stock_quantity as system_stock,
  master.price_version as system_price_version,
  master.stock_version as system_stock_version,
  master.price_updated_at as system_price_updated_at,
  master.stock_updated_at as system_stock_updated_at,
  master.updated_at as system_updated_at,
  effective.smartstore_link_suppressed,
  effective.makeshop_link_suppressed,
  effective.ably_link_suppressed
from effective
left join public.sellpia_stock_latest source_stock
  on source_stock.sellpia_sku_code = (effective.matrix_row).sellpia_sku_code
left join public.operations_hub_sku_operational_master master
  on master.sellpia_sku_code = (effective.matrix_row).sellpia_sku_code;

revoke all on public.operations_hub_matrix_system_live from public, anon, authenticated;
grant select on public.operations_hub_matrix_system_live to anon, authenticated;

create or replace function public.find_operations_hub_listing_skus_by_sources(
  p_query text,
  p_sources text[] default array['smartstore','makeshop','ably'],
  p_limit integer default 500
)
returns table (sellpia_sku_code text)
language sql
stable
set search_path = pg_catalog, public, operations_private
as $$
  with allowed_sources as materialized (
    select distinct lower(btrim(source)) as source_channel
    from unnest(coalesce(p_sources, '{}'::text[])) source
    where lower(btrim(source)) = any(array['smartstore','makeshop','ably'])
  ), matches as (
    select matrix.sellpia_sku_code
    from operations_private.operations_hub_matrix_export_cache matrix
    where exists (select 1 from allowed_sources where source_channel = 'smartstore')
      and matrix.smartstore_product_code is not null
      and case when coalesce(matrix.smartstore_option_code, '') = '' then matrix.smartstore_product_code
               else matrix.smartstore_product_code || '-' || matrix.smartstore_option_code end = btrim(coalesce(p_query, ''))
      and not exists (
        select 1 from public.operations_hub_link_suppressions suppression
        where suppression.source_channel = 'smartstore'
          and suppression.sellpia_sku_code = matrix.sellpia_sku_code
          and suppression.product_code = matrix.smartstore_product_code
          and suppression.option_code = coalesce(matrix.smartstore_option_code, '')
      )
    union all
    select matrix.sellpia_sku_code
    from operations_private.operations_hub_matrix_export_cache matrix
    where exists (select 1 from allowed_sources where source_channel = 'makeshop')
      and matrix.makeshop_product_code is not null
      and case when coalesce(matrix.makeshop_option_code, '') = '' then matrix.makeshop_product_code
               else matrix.makeshop_product_code || '-' || matrix.makeshop_option_code end = btrim(coalesce(p_query, ''))
      and not exists (
        select 1 from public.operations_hub_link_suppressions suppression
        where suppression.source_channel = 'makeshop'
          and suppression.sellpia_sku_code = matrix.sellpia_sku_code
          and suppression.product_code = matrix.makeshop_product_code
          and suppression.option_code = coalesce(matrix.makeshop_option_code, '')
      )
    union all
    select matrix.sellpia_sku_code
    from operations_private.operations_hub_matrix_export_cache matrix
    where exists (select 1 from allowed_sources where source_channel = 'ably')
      and matrix.ably_product_code is not null
      and case when coalesce(matrix.ably_option_code, '') = '' then matrix.ably_product_code
               else matrix.ably_product_code || '-' || matrix.ably_option_code end = btrim(coalesce(p_query, ''))
      and not exists (
        select 1 from public.operations_hub_link_suppressions suppression
        where suppression.source_channel = 'ably'
          and suppression.sellpia_sku_code = matrix.sellpia_sku_code
          and suppression.product_code = matrix.ably_product_code
          and suppression.option_code = coalesce(matrix.ably_option_code, '')
      )
  )
  select distinct matches.sellpia_sku_code
  from matches
  order by matches.sellpia_sku_code
  limit greatest(1, least(coalesce(p_limit, 500), 2000));
$$;

revoke all on function public.find_operations_hub_listing_skus_by_sources(text, text[], integer) from public;
grant execute on function public.find_operations_hub_listing_skus_by_sources(text, text[], integer) to anon, authenticated;

notify pgrst, 'reload schema';
