-- Additive seller-listing graph for one-to-many links and bundle/BOM inventory.
-- Existing matrix/manual links remain authoritative until a listing is explicitly promoted.

create table public.operations_hub_seller_listings (
  listing_id bigint generated always as identity primary key,
  source_channel text not null check (source_channel in ('smartstore', 'makeshop', 'ably')),
  product_code text not null check (length(btrim(product_code)) > 0),
  option_code text not null default '',
  product_name text,
  option_name text,
  is_active boolean not null default true,
  updated_by text not null default 'operations_hub_frontend',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_channel, product_code, option_code)
);

comment on table public.operations_hub_seller_listings is
  'Explicit seller listing nodes. A row promotes one legacy matrix listing into the multi-link/BOM graph.';

create table public.operations_hub_listing_components (
  component_id bigint generated always as identity primary key,
  listing_id bigint not null references public.operations_hub_seller_listings(listing_id) on delete restrict,
  sellpia_sku_code text not null check (length(btrim(sellpia_sku_code)) > 0),
  component_qty integer not null default 1 check (component_qty > 0),
  component_role text not null default 'primary' check (component_role in ('primary', 'additional')),
  mapping_origin text not null default 'manual' check (mapping_origin in ('manual', 'legacy_promoted', 'import')),
  mapping_note text,
  is_active boolean not null default true,
  updated_by text not null default 'operations_hub_frontend',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (listing_id, sellpia_sku_code)
);

comment on table public.operations_hub_listing_components is
  'Sellpia SKU components and required quantities for each seller listing option.';

create table public.operations_hub_listing_component_events (
  event_id bigint generated always as identity primary key,
  listing_id bigint not null references public.operations_hub_seller_listings(listing_id) on delete restrict,
  component_id bigint references public.operations_hub_listing_components(component_id) on delete set null,
  event_type text not null check (event_type in ('UPSERT', 'DEACTIVATE')),
  before_value jsonb,
  after_value jsonb,
  changed_by text not null default 'operations_hub_frontend',
  changed_at timestamptz not null default now()
);

create index operations_hub_listing_components_listing_active_idx
  on public.operations_hub_listing_components (listing_id, sellpia_sku_code)
  where is_active;

create index operations_hub_listing_components_sku_active_idx
  on public.operations_hub_listing_components (sellpia_sku_code, listing_id)
  where is_active;

create index operations_hub_listing_component_events_listing_time_idx
  on public.operations_hub_listing_component_events (listing_id, changed_at desc);

alter table public.operations_hub_seller_listings enable row level security;
alter table public.operations_hub_listing_components enable row level security;
alter table public.operations_hub_listing_component_events enable row level security;

create policy "operations hub seller listings readable"
  on public.operations_hub_seller_listings for select
  to anon, authenticated using (true);
create policy "operations hub seller listings insertable"
  on public.operations_hub_seller_listings for insert
  to anon, authenticated with check (updated_by = 'operations_hub_frontend');
create policy "operations hub seller listings updatable"
  on public.operations_hub_seller_listings for update
  to anon, authenticated
  using (updated_by = 'operations_hub_frontend')
  with check (updated_by = 'operations_hub_frontend');

create policy "operations hub listing components readable"
  on public.operations_hub_listing_components for select
  to anon, authenticated using (true);
create policy "operations hub listing components insertable"
  on public.operations_hub_listing_components for insert
  to anon, authenticated with check (updated_by = 'operations_hub_frontend');
create policy "operations hub listing components updatable"
  on public.operations_hub_listing_components for update
  to anon, authenticated
  using (updated_by = 'operations_hub_frontend')
  with check (updated_by = 'operations_hub_frontend');

create policy "operations hub listing component events readable"
  on public.operations_hub_listing_component_events for select
  to anon, authenticated using (true);
create policy "operations hub listing component events insertable"
  on public.operations_hub_listing_component_events for insert
  to anon, authenticated with check (changed_by = 'operations_hub_frontend');

grant select, insert, update on table public.operations_hub_seller_listings to anon, authenticated;
grant select, insert, update on table public.operations_hub_listing_components to anon, authenticated;
grant select, insert on table public.operations_hub_listing_component_events to anon, authenticated;
grant usage, select on sequence public.operations_hub_seller_listings_listing_id_seq to anon, authenticated;
grant usage, select on sequence public.operations_hub_listing_components_component_id_seq to anon, authenticated;
grant usage, select on sequence public.operations_hub_listing_component_events_event_id_seq to anon, authenticated;

create or replace view public.operations_hub_listing_component_projection
with (security_invoker = true)
as
with explicit_components as (
  select
    'explicit'::text as mapping_source,
    listing.listing_id,
    component.component_id,
    listing.source_channel,
    listing.product_code,
    coalesce(listing.option_code, '') as option_code,
    listing.product_name,
    listing.option_name,
    component.sellpia_sku_code,
    component.component_qty,
    component.component_role,
    matrix.sellpia_product_name,
    matrix.sellpia_option_name,
    matrix.sellpia_own_code,
    matrix.sellpia_available_stock,
    greatest(listing.updated_at, component.updated_at) as updated_at
  from public.operations_hub_seller_listings listing
  join public.operations_hub_listing_components component
    on component.listing_id = listing.listing_id
   and component.is_active
  left join public.operations_hub_matrix_live matrix
    on matrix.sellpia_sku_code = component.sellpia_sku_code
  where listing.is_active
), legacy_components as (
  select
    'legacy'::text as mapping_source,
    null::bigint as listing_id,
    null::bigint as component_id,
    seller.source_channel,
    seller.product_code,
    coalesce(seller.option_code, '') as option_code,
    seller.product_name,
    seller.option_name,
    matrix.sellpia_sku_code,
    1::integer as component_qty,
    'primary'::text as component_role,
    matrix.sellpia_product_name,
    matrix.sellpia_option_name,
    matrix.sellpia_own_code,
    matrix.sellpia_available_stock,
    matrix.updated_at
  from public.operations_hub_matrix_live matrix
  cross join lateral (
    values
      ('smartstore'::text, matrix.smartstore_product_code, coalesce(matrix.smartstore_option_code, ''), matrix.smartstore_name, matrix.smartstore_option_name),
      ('makeshop'::text, matrix.makeshop_product_code, coalesce(matrix.makeshop_option_code, ''), matrix.makeshop_name, matrix.makeshop_option_name),
      ('ably'::text, matrix.ably_product_code, coalesce(matrix.ably_option_code, ''), matrix.ably_name, matrix.ably_option_name)
  ) as seller(source_channel, product_code, option_code, product_name, option_name)
  where nullif(btrim(seller.product_code), '') is not null
    and not exists (
      select 1
      from public.operations_hub_seller_listings explicit_listing
      where explicit_listing.is_active
        and explicit_listing.source_channel = seller.source_channel
        and explicit_listing.product_code = seller.product_code
        and explicit_listing.option_code = coalesce(seller.option_code, '')
    )
)
select * from explicit_components
union all
select * from legacy_components;

comment on view public.operations_hub_listing_component_projection is
  'Compatibility projection: explicit graph rows replace only the promoted listing; every other current matrix link remains a virtual qty-1 component.';

create or replace view public.operations_hub_listing_graph_live
with (security_invoker = true)
as
with listing_rollup as (
  select
    projection.source_channel,
    projection.product_code,
    projection.option_code,
    max(projection.listing_id) as listing_id,
    max(projection.product_name) as product_name,
    max(projection.option_name) as option_name,
    count(*)::integer as component_count,
    case
      when count(projection.sellpia_available_stock) = count(*) then
        min(floor(projection.sellpia_available_stock::numeric / projection.component_qty))::integer
      else null
    end as calculated_stock,
    bool_or(projection.mapping_source = 'explicit') as is_explicit,
    max(projection.updated_at) as updated_at,
    jsonb_agg(
      jsonb_build_object(
        'componentId', projection.component_id,
        'sku', projection.sellpia_sku_code,
        'qty', projection.component_qty,
        'role', projection.component_role,
        'mappingSource', projection.mapping_source,
        'productName', projection.sellpia_product_name,
        'optionName', projection.sellpia_option_name,
        'ownCode', projection.sellpia_own_code,
        'availableStock', projection.sellpia_available_stock
      ) order by projection.sellpia_sku_code
    ) as components
  from public.operations_hub_listing_component_projection projection
  group by projection.source_channel, projection.product_code, projection.option_code
), sku_listing_counts as (
  select
    projection.source_channel,
    projection.sellpia_sku_code,
    count(distinct (projection.product_code, projection.option_code))::integer as listing_count
  from public.operations_hub_listing_component_projection projection
  group by projection.source_channel, projection.sellpia_sku_code
), classified as (
  select
    rollup.*,
    coalesce((
      select max(counts.listing_count)
      from jsonb_array_elements(rollup.components) component
      left join sku_listing_counts counts
        on counts.source_channel = rollup.source_channel
       and counts.sellpia_sku_code = component ->> 'sku'
    ), 1)::integer as max_listing_count
  from listing_rollup rollup
)
select
  classified.*,
  case
    when component_count > 1 and max_listing_count > 1 then 'multi_bundle'
    when component_count > 1 then 'bundle'
    when max_listing_count > 1 then 'multi'
    else 'single'
  end as relation_type
from classified;

grant select on public.operations_hub_listing_component_projection to anon, authenticated;
grant select on public.operations_hub_listing_graph_live to anon, authenticated;

create or replace function public.list_operations_hub_listing_graph(
  p_source text default 'all',
  p_relation_type text default 'all',
  p_search text default '',
  p_page integer default 1,
  p_page_size integer default 50
)
returns jsonb
language sql
security invoker
set search_path = public
as $$
  with filtered as (
    select graph.*
    from public.operations_hub_listing_graph_live graph
    where (p_source = 'all' or graph.source_channel = p_source)
      and (
        p_relation_type = 'all'
        or (p_relation_type = 'complex' and graph.relation_type <> 'single')
        or graph.relation_type = p_relation_type
      )
      and (
        btrim(coalesce(p_search, '')) = ''
        or graph.product_code ilike '%' || btrim(p_search) || '%'
        or graph.option_code ilike '%' || btrim(p_search) || '%'
        or coalesce(graph.product_name, '') ilike '%' || btrim(p_search) || '%'
        or coalesce(graph.option_name, '') ilike '%' || btrim(p_search) || '%'
        or exists (
          select 1
          from jsonb_array_elements(graph.components) component
          where component ->> 'sku' ilike '%' || btrim(p_search) || '%'
             or component ->> 'ownCode' ilike '%' || btrim(p_search) || '%'
             or component ->> 'productName' ilike '%' || btrim(p_search) || '%'
             or component ->> 'optionName' ilike '%' || btrim(p_search) || '%'
        )
      )
  ), paged as (
    select *
    from filtered
    order by source_channel, product_code, option_code
    offset (greatest(coalesce(p_page, 1), 1) - 1) * least(greatest(coalesce(p_page_size, 50), 1), 100)
    limit least(greatest(coalesce(p_page_size, 50), 1), 100)
  )
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(to_jsonb(paged)) from paged), '[]'::jsonb),
    'count', (select count(*) from filtered),
    'page', greatest(coalesce(p_page, 1), 1),
    'pageSize', least(greatest(coalesce(p_page_size, 50), 1), 100)
  );
$$;

create or replace function public.get_operations_hub_sku_link_badges(p_skus text[])
returns table (
  sellpia_sku_code text,
  source_channel text,
  listing_count integer,
  max_component_count integer,
  relation_type text
)
language sql
security invoker
set search_path = public
as $$
  with selected as (
    select projection.*
    from public.operations_hub_listing_component_projection projection
    where projection.sellpia_sku_code = any(coalesce(p_skus, array[]::text[]))
  ), listing_sizes as (
    select
      projection.source_channel,
      projection.product_code,
      projection.option_code,
      count(*)::integer as component_count
    from public.operations_hub_listing_component_projection projection
    where exists (
      select 1 from selected
      where selected.source_channel = projection.source_channel
        and selected.product_code = projection.product_code
        and selected.option_code = projection.option_code
    )
    group by projection.source_channel, projection.product_code, projection.option_code
  )
  select
    selected.sellpia_sku_code,
    selected.source_channel,
    count(distinct (selected.product_code, selected.option_code))::integer as listing_count,
    max(listing_sizes.component_count)::integer as max_component_count,
    case
      when count(distinct (selected.product_code, selected.option_code)) > 1 and max(listing_sizes.component_count) > 1 then 'multi_bundle'
      when max(listing_sizes.component_count) > 1 then 'bundle'
      when count(distinct (selected.product_code, selected.option_code)) > 1 then 'multi'
      else 'single'
    end as relation_type
  from selected
  join listing_sizes
    on listing_sizes.source_channel = selected.source_channel
   and listing_sizes.product_code = selected.product_code
   and listing_sizes.option_code = selected.option_code
  group by selected.sellpia_sku_code, selected.source_channel;
$$;

create or replace function public.upsert_operations_hub_listing_component(
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
security invoker
set search_path = public
as $$
declare
  v_listing_id bigint;
  v_component_id bigint;
  v_product_name text;
  v_option_name text;
  v_before jsonb;
  v_promoted_count integer := 0;
begin
  p_source := lower(btrim(coalesce(p_source, '')));
  p_product_code := btrim(coalesce(p_product_code, ''));
  p_option_code := btrim(coalesce(p_option_code, ''));
  p_sellpia_sku_code := btrim(coalesce(p_sellpia_sku_code, ''));
  p_component_role := lower(btrim(coalesce(p_component_role, 'additional')));

  if p_source not in ('smartstore', 'makeshop', 'ably') then
    raise exception '지원하지 않는 판매처입니다.';
  end if;
  if p_product_code = '' or p_sellpia_sku_code = '' then
    raise exception '판매처 상품코드와 셀피아 SKU는 필수입니다.';
  end if;
  if coalesce(p_component_qty, 0) <= 0 then
    raise exception '구성수량은 1 이상이어야 합니다.';
  end if;
  if p_component_role not in ('primary', 'additional') then
    raise exception '구성 역할을 확인해주세요.';
  end if;
  if not exists (
    select 1 from public.operations_hub_matrix_live
    where sellpia_sku_code = p_sellpia_sku_code
  ) then
    raise exception '셀피아 SKU %를 찾을 수 없습니다.', p_sellpia_sku_code;
  end if;

  select latest.product_name, latest.option_name
    into v_product_name, v_option_name
  from public.seller_inventory_latest latest
  where latest.source_channel = p_source
    and latest.product_code = p_product_code
    and latest.option_code = p_option_code
  limit 1;

  if not found then
    raise exception '최신 % 원본에서 상품코드/옵션코드를 찾을 수 없습니다.', p_source;
  end if;

  insert into public.operations_hub_seller_listings (
    source_channel, product_code, option_code, product_name, option_name, is_active, updated_by, updated_at
  ) values (
    p_source, p_product_code, p_option_code, v_product_name, v_option_name, true, 'operations_hub_frontend', now()
  )
  on conflict (source_channel, product_code, option_code)
  do update set
    product_name = excluded.product_name,
    option_name = excluded.option_name,
    is_active = true,
    updated_by = 'operations_hub_frontend',
    updated_at = now()
  returning operations_hub_seller_listings.listing_id into v_listing_id;

  -- Preserve the current 1:1 mapping(s) when this listing is promoted to an explicit graph.
  insert into public.operations_hub_listing_components (
    listing_id, sellpia_sku_code, component_qty, component_role, mapping_origin, is_active, updated_by
  )
  select
    v_listing_id,
    matrix.sellpia_sku_code,
    1,
    'primary',
    'legacy_promoted',
    true,
    'operations_hub_frontend'
  from public.operations_hub_matrix_live matrix
  where case p_source
    when 'smartstore' then matrix.smartstore_product_code = p_product_code and coalesce(matrix.smartstore_option_code, '') = p_option_code
    when 'makeshop' then matrix.makeshop_product_code = p_product_code and coalesce(matrix.makeshop_option_code, '') = p_option_code
    when 'ably' then matrix.ably_product_code = p_product_code and coalesce(matrix.ably_option_code, '') = p_option_code
    else false
  end
  on conflict (listing_id, sellpia_sku_code) do nothing;
  get diagnostics v_promoted_count = row_count;

  select to_jsonb(component.*) into v_before
  from public.operations_hub_listing_components component
  where component.listing_id = v_listing_id
    and component.sellpia_sku_code = p_sellpia_sku_code;

  insert into public.operations_hub_listing_components (
    listing_id, sellpia_sku_code, component_qty, component_role, mapping_origin, is_active, updated_by, updated_at
  ) values (
    v_listing_id, p_sellpia_sku_code, p_component_qty, p_component_role, 'manual', true, 'operations_hub_frontend', now()
  )
  on conflict (listing_id, sellpia_sku_code)
  do update set
    component_qty = excluded.component_qty,
    component_role = excluded.component_role,
    mapping_origin = case
      when operations_hub_listing_components.mapping_origin = 'legacy_promoted' and excluded.component_qty = 1 and excluded.component_role = 'primary'
        then operations_hub_listing_components.mapping_origin
      else 'manual'
    end,
    is_active = true,
    updated_by = 'operations_hub_frontend',
    updated_at = now()
  returning operations_hub_listing_components.component_id into v_component_id;

  insert into public.operations_hub_listing_component_events (
    listing_id, component_id, event_type, before_value, after_value, changed_by
  )
  select
    v_listing_id,
    v_component_id,
    'UPSERT',
    v_before,
    to_jsonb(component.*),
    'operations_hub_frontend'
  from public.operations_hub_listing_components component
  where component.component_id = v_component_id;

  return query select v_listing_id, v_component_id, v_promoted_count;
end;
$$;

create or replace function public.deactivate_operations_hub_listing_component(p_component_id bigint)
returns table (
  listing_id bigint,
  component_id bigint,
  remaining_component_count integer
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_listing_id bigint;
  v_before jsonb;
  v_remaining integer;
begin
  select component.listing_id, to_jsonb(component.*)
    into v_listing_id, v_before
  from public.operations_hub_listing_components component
  where component.component_id = p_component_id
    and component.is_active;

  if not found then
    raise exception '활성 구성품을 찾을 수 없습니다.';
  end if;

  update public.operations_hub_listing_components
  set is_active = false,
      updated_by = 'operations_hub_frontend',
      updated_at = now()
  where operations_hub_listing_components.component_id = p_component_id;

  select count(*)::integer into v_remaining
  from public.operations_hub_listing_components
  where operations_hub_listing_components.listing_id = v_listing_id
    and is_active;

  insert into public.operations_hub_listing_component_events (
    listing_id, component_id, event_type, before_value, after_value, changed_by
  ) values (
    v_listing_id,
    p_component_id,
    'DEACTIVATE',
    v_before,
    jsonb_build_object('is_active', false),
    'operations_hub_frontend'
  );

  return query select v_listing_id, p_component_id, v_remaining;
end;
$$;

revoke all on function public.list_operations_hub_listing_graph(text, text, text, integer, integer) from public;
revoke all on function public.get_operations_hub_sku_link_badges(text[]) from public;
revoke all on function public.upsert_operations_hub_listing_component(text, text, text, text, integer, text) from public;
revoke all on function public.deactivate_operations_hub_listing_component(bigint) from public;

grant execute on function public.list_operations_hub_listing_graph(text, text, text, integer, integer) to anon, authenticated;
grant execute on function public.get_operations_hub_sku_link_badges(text[]) to anon, authenticated;
grant execute on function public.upsert_operations_hub_listing_component(text, text, text, text, integer, text) to anon, authenticated;
grant execute on function public.deactivate_operations_hub_listing_component(bigint) to anon, authenticated;
