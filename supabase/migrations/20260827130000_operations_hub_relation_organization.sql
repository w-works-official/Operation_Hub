-- Organize seller listing compositions without deciding inventory or price
-- formulas. Existing component_qty/component_role calculations remain intact;
-- folders and parent_component_id are management-only metadata in this phase.

create table public.operations_hub_relation_folders (
  folder_id bigint generated always as identity primary key,
  folder_name text not null check (length(btrim(folder_name)) between 1 and 60),
  folder_kind text not null default 'custom'
    check (folder_kind in ('collection', 'one_plus_one', 'set', 'custom')),
  sort_order integer not null default 100 check (sort_order between 0 and 10000),
  is_active boolean not null default true,
  updated_by text not null default 'operations_hub_frontend',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index operations_hub_relation_folders_active_name_idx
  on public.operations_hub_relation_folders (lower(btrim(folder_name)))
  where is_active;

alter table public.operations_hub_seller_listings
  add column folder_id bigint references public.operations_hub_relation_folders(folder_id) on delete set null,
  add column relation_kind text
    check (relation_kind is null or relation_kind in ('collection', 'one_plus_one', 'set', 'custom')),
  add column group_name text
    check (group_name is null or length(btrim(group_name)) between 1 and 100),
  add column organization_updated_at timestamptz;

create index operations_hub_seller_listings_folder_active_idx
  on public.operations_hub_seller_listings (folder_id, source_channel, product_code, option_code)
  where is_active;

alter table public.operations_hub_listing_components
  add column parent_component_id bigint;

alter table public.operations_hub_listing_components
  add constraint operations_hub_listing_components_parent_component_id_fkey
  foreign key (parent_component_id)
  references public.operations_hub_listing_components(component_id)
  on delete set null;

create index operations_hub_listing_components_parent_active_idx
  on public.operations_hub_listing_components (parent_component_id, component_id)
  where is_active and parent_component_id is not null;

create index operations_hub_listing_components_dependent_sku_active_idx
  on public.operations_hub_listing_components (sellpia_sku_code)
  where is_active and parent_component_id is not null;

create table public.operations_hub_relation_events (
  event_id bigint generated always as identity primary key,
  event_type text not null check (event_type in ('FOLDER_SAVE', 'FOLDER_ARCHIVE', 'ORGANIZE', 'REPARENT')),
  listing_id bigint references public.operations_hub_seller_listings(listing_id) on delete set null,
  folder_id bigint references public.operations_hub_relation_folders(folder_id) on delete set null,
  component_id bigint references public.operations_hub_listing_components(component_id) on delete set null,
  before_value jsonb,
  after_value jsonb,
  changed_by text not null default 'operations_hub_frontend',
  changed_at timestamptz not null default now()
);

create index operations_hub_relation_events_listing_time_idx
  on public.operations_hub_relation_events (listing_id, changed_at desc);
create index operations_hub_relation_events_folder_time_idx
  on public.operations_hub_relation_events (folder_id, changed_at desc);

alter table public.operations_hub_relation_folders enable row level security;
alter table public.operations_hub_relation_events enable row level security;

create policy "operations hub relation folders readable"
  on public.operations_hub_relation_folders for select
  to anon, authenticated using (true);
create policy "operations hub relation folders insertable"
  on public.operations_hub_relation_folders for insert
  to anon, authenticated with check (updated_by = 'operations_hub_frontend');
create policy "operations hub relation folders updatable"
  on public.operations_hub_relation_folders for update
  to anon, authenticated
  using (updated_by = 'operations_hub_frontend')
  with check (updated_by = 'operations_hub_frontend');
create policy "operations hub relation events readable"
  on public.operations_hub_relation_events for select
  to anon, authenticated using (true);
create policy "operations hub relation events insertable"
  on public.operations_hub_relation_events for insert
  to anon, authenticated with check (changed_by = 'operations_hub_frontend');

grant select, insert, update on table public.operations_hub_relation_folders to anon, authenticated;
grant select, insert on table public.operations_hub_relation_events to anon, authenticated;
grant usage, select on sequence public.operations_hub_relation_folders_folder_id_seq to anon, authenticated;
grant usage, select on sequence public.operations_hub_relation_events_event_id_seq to anon, authenticated;

insert into public.operations_hub_relation_folders (folder_name, folder_kind, sort_order)
select seed.folder_name, seed.folder_kind, seed.sort_order
from (values
  ('모음전 관리', 'collection'::text, 10),
  ('1+1 조합 관리', 'one_plus_one'::text, 20),
  ('세트 구성', 'set'::text, 30)
) seed(folder_name, folder_kind, sort_order)
where not exists (
  select 1
  from public.operations_hub_relation_folders folder
  where folder.is_active and lower(btrim(folder.folder_name)) = lower(btrim(seed.folder_name))
);

create or replace function public.list_operations_hub_relation_folders()
returns jsonb
language sql
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'folders', coalesce(jsonb_agg(
      jsonb_build_object(
        'folderId', folder.folder_id,
        'name', folder.folder_name,
        'kind', folder.folder_kind,
        'sortOrder', folder.sort_order,
        'listingCount', coalesce(counts.listing_count, 0),
        'updatedAt', folder.updated_at
      ) order by folder.sort_order, folder.folder_name
    ), '[]'::jsonb),
    'organizedCount', coalesce(sum(coalesce(counts.listing_count, 0)), 0),
    'unorganizedExplicitCount', (
      select count(*)
      from public.operations_hub_seller_listings listing
      where listing.is_active and listing.folder_id is null
    )
  )
  from public.operations_hub_relation_folders folder
  left join lateral (
    select count(*)::integer as listing_count
    from public.operations_hub_seller_listings listing
    where listing.is_active and listing.folder_id = folder.folder_id
  ) counts on true
  where folder.is_active;
$$;

create or replace function public.save_operations_hub_relation_folder(
  p_folder_id bigint,
  p_folder_name text,
  p_folder_kind text default 'custom',
  p_sort_order integer default 100
)
returns table (
  folder_id bigint,
  folder_name text,
  folder_kind text,
  sort_order integer,
  updated_at timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_before jsonb;
  v_folder_id bigint;
begin
  p_folder_name := btrim(coalesce(p_folder_name, ''));
  p_folder_kind := lower(btrim(coalesce(p_folder_kind, 'custom')));
  p_sort_order := greatest(0, least(coalesce(p_sort_order, 100), 10000));
  if length(p_folder_name) not between 1 and 60 then
    raise exception '폴더명은 1~60자로 입력해주세요.';
  end if;
  if p_folder_kind not in ('collection', 'one_plus_one', 'set', 'custom') then
    raise exception '폴더 유형을 확인해주세요.';
  end if;
  if exists (
    select 1 from public.operations_hub_relation_folders duplicate
    where duplicate.is_active
      and lower(btrim(duplicate.folder_name)) = lower(p_folder_name)
      and duplicate.folder_id <> coalesce(p_folder_id, -1)
  ) then
    raise exception '같은 이름의 활성 폴더가 이미 있습니다.';
  end if;

  if p_folder_id is null then
    insert into public.operations_hub_relation_folders (
      folder_name, folder_kind, sort_order, is_active, updated_by, updated_at
    ) values (
      p_folder_name, p_folder_kind, p_sort_order, true, 'operations_hub_frontend', now()
    ) returning operations_hub_relation_folders.folder_id into v_folder_id;
  else
    select to_jsonb(folder.*) into v_before
    from public.operations_hub_relation_folders folder
    where folder.folder_id = p_folder_id and folder.is_active
    for update;
    if not found then raise exception '수정할 폴더를 찾을 수 없습니다.'; end if;
    update public.operations_hub_relation_folders folder
    set folder_name = p_folder_name,
        folder_kind = p_folder_kind,
        sort_order = p_sort_order,
        updated_by = 'operations_hub_frontend',
        updated_at = now()
    where folder.folder_id = p_folder_id;
    v_folder_id := p_folder_id;
  end if;

  insert into public.operations_hub_relation_events (
    event_type, folder_id, before_value, after_value, changed_by
  )
  select 'FOLDER_SAVE', folder.folder_id, v_before, to_jsonb(folder.*), 'operations_hub_frontend'
  from public.operations_hub_relation_folders folder
  where folder.folder_id = v_folder_id;

  return query
  select folder.folder_id, folder.folder_name, folder.folder_kind, folder.sort_order, folder.updated_at
  from public.operations_hub_relation_folders folder
  where folder.folder_id = v_folder_id;
end;
$$;

create or replace function public.archive_operations_hub_relation_folder(p_folder_id bigint)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_before jsonb;
  v_unassigned integer := 0;
begin
  select to_jsonb(folder.*) into v_before
  from public.operations_hub_relation_folders folder
  where folder.folder_id = p_folder_id and folder.is_active
  for update;
  if not found then raise exception '보관할 폴더를 찾을 수 없습니다.'; end if;

  update public.operations_hub_seller_listings listing
  set folder_id = null,
      organization_updated_at = now(),
      updated_by = 'operations_hub_frontend',
      updated_at = now()
  where listing.folder_id = p_folder_id;
  get diagnostics v_unassigned = row_count;

  update public.operations_hub_relation_folders folder
  set is_active = false,
      updated_by = 'operations_hub_frontend',
      updated_at = now()
  where folder.folder_id = p_folder_id;

  insert into public.operations_hub_relation_events (
    event_type, folder_id, before_value, after_value, changed_by
  ) values (
    'FOLDER_ARCHIVE', p_folder_id, v_before,
    jsonb_build_object('archived', true, 'unassignedListings', v_unassigned),
    'operations_hub_frontend'
  );
  return v_unassigned;
end;
$$;

create or replace function public.save_operations_hub_listing_organization(
  p_source text,
  p_product_code text,
  p_option_code text default '',
  p_folder_id bigint default null,
  p_relation_kind text default null,
  p_group_name text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_listing_id bigint;
  v_seed_sku text;
  v_before jsonb;
  v_after jsonb;
begin
  p_source := lower(btrim(coalesce(p_source, '')));
  p_product_code := btrim(coalesce(p_product_code, ''));
  p_option_code := btrim(coalesce(p_option_code, ''));
  p_relation_kind := nullif(lower(btrim(coalesce(p_relation_kind, ''))), '');
  p_group_name := nullif(btrim(coalesce(p_group_name, '')), '');
  if p_source not in ('smartstore', 'makeshop', 'ably') or p_product_code = '' then
    raise exception '판매처와 상품코드를 확인해주세요.';
  end if;
  if p_relation_kind is not null and p_relation_kind not in ('collection', 'one_plus_one', 'set', 'custom') then
    raise exception '조합 유형을 확인해주세요.';
  end if;
  if p_group_name is not null and length(p_group_name) > 100 then
    raise exception '조합 이름은 100자 이하로 입력해주세요.';
  end if;
  if p_folder_id is not null and not exists (
    select 1 from public.operations_hub_relation_folders folder
    where folder.folder_id = p_folder_id and folder.is_active
  ) then
    raise exception '선택한 활성 폴더를 찾을 수 없습니다.';
  end if;

  select listing.listing_id into v_listing_id
  from public.operations_hub_seller_listings listing
  where listing.source_channel = p_source
    and listing.product_code = p_product_code
    and listing.option_code = p_option_code
    and listing.is_active
  limit 1;

  if v_listing_id is null then
    select cache.sellpia_sku_code into v_seed_sku
    from public.operations_hub_listing_legacy_cache cache
    where cache.source_channel = p_source
      and cache.product_code = p_product_code
      and cache.option_code = p_option_code
      and not exists (
        select 1 from public.operations_hub_link_suppressions suppression
        where suppression.source_channel = cache.source_channel
          and suppression.sellpia_sku_code = cache.sellpia_sku_code
          and suppression.product_code = cache.product_code
          and suppression.option_code = cache.option_code
      )
    order by cache.sellpia_sku_code
    limit 1;
    if v_seed_sku is null then
      raise exception '정리할 기존 연결을 찾을 수 없습니다. 먼저 SKU 구성을 추가해주세요.';
    end if;
    select promoted.listing_id into v_listing_id
    from public.upsert_operations_hub_listing_component(
      p_source, p_product_code, p_option_code, v_seed_sku, 1, 'primary'
    ) promoted;
  end if;

  select to_jsonb(listing.*) into v_before
  from public.operations_hub_seller_listings listing
  where listing.listing_id = v_listing_id
  for update;

  update public.operations_hub_seller_listings listing
  set folder_id = p_folder_id,
      relation_kind = p_relation_kind,
      group_name = p_group_name,
      organization_updated_at = now(),
      updated_by = 'operations_hub_frontend',
      updated_at = now()
  where listing.listing_id = v_listing_id;

  select to_jsonb(listing.*) into v_after
  from public.operations_hub_seller_listings listing
  where listing.listing_id = v_listing_id;

  insert into public.operations_hub_relation_events (
    event_type, listing_id, folder_id, before_value, after_value, changed_by
  ) values (
    'ORGANIZE', v_listing_id, p_folder_id, v_before, v_after, 'operations_hub_frontend'
  );
  return v_after;
end;
$$;

create or replace function public.save_operations_hub_listing_component_parent(
  p_component_id bigint,
  p_parent_component_id bigint default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_listing_id bigint;
  v_before jsonb;
  v_after jsonb;
begin
  select component.listing_id, to_jsonb(component.*)
    into v_listing_id, v_before
  from public.operations_hub_listing_components component
  where component.component_id = p_component_id and component.is_active
  for update;
  if not found then raise exception '종속관계를 수정할 구성 SKU를 찾을 수 없습니다.'; end if;
  if p_parent_component_id = p_component_id then
    raise exception '자기 자신을 상위 SKU로 지정할 수 없습니다.';
  end if;
  if p_parent_component_id is not null and not exists (
    select 1 from public.operations_hub_listing_components parent
    where parent.component_id = p_parent_component_id
      and parent.listing_id = v_listing_id
      and parent.is_active
  ) then
    raise exception '같은 조합 안의 활성 SKU만 상위 SKU로 지정할 수 있습니다.';
  end if;
  if p_parent_component_id is not null and exists (
    with recursive descendants as (
      select child.component_id
      from public.operations_hub_listing_components child
      where child.parent_component_id = p_component_id and child.is_active
      union all
      select child.component_id
      from public.operations_hub_listing_components child
      join descendants parent on parent.component_id = child.parent_component_id
      where child.is_active
    )
    select 1 from descendants where component_id = p_parent_component_id
  ) then
    raise exception '순환 종속관계는 만들 수 없습니다.';
  end if;

  update public.operations_hub_listing_components component
  set parent_component_id = p_parent_component_id,
      updated_by = 'operations_hub_frontend',
      updated_at = now()
  where component.component_id = p_component_id;

  select to_jsonb(component.*) into v_after
  from public.operations_hub_listing_components component
  where component.component_id = p_component_id;

  insert into public.operations_hub_relation_events (
    event_type, listing_id, component_id, before_value, after_value, changed_by
  ) values (
    'REPARENT', v_listing_id, p_component_id, v_before, v_after, 'operations_hub_frontend'
  );
  return v_after;
end;
$$;

create or replace function public.list_operations_hub_listing_graph_v2(
  p_source text default 'all',
  p_relation_type text default 'all',
  p_search text default '',
  p_page integer default 1,
  p_page_size integer default 50,
  p_folder_id bigint default null,
  p_organization_scope text default 'all'
)
returns jsonb
language sql
security invoker
set search_path = public
as $$
  with input as materialized (
    select
      p_source as source_filter,
      p_relation_type as relation_filter,
      btrim(coalesce(p_search, '')) as search_text,
      greatest(coalesce(p_page, 1), 1) as page_number,
      least(greatest(coalesce(p_page_size, 50), 1), 100) as page_size,
      p_folder_id as folder_filter,
      case when p_organization_scope in ('all', 'organized', 'unorganized') then p_organization_scope else 'all' end as organization_scope
  ), identity_edges as materialized (
    select
      'explicit'::text as mapping_source,
      listing.listing_id,
      component.component_id,
      component.parent_component_id,
      listing.source_channel,
      listing.product_code,
      coalesce(listing.option_code, '') as option_code,
      listing.product_name,
      listing.option_name,
      listing.folder_id,
      folder.folder_name,
      folder.folder_kind,
      folder.sort_order as folder_sort_order,
      listing.relation_kind,
      listing.group_name,
      component.sellpia_sku_code,
      component.component_qty,
      component.component_role,
      greatest(listing.updated_at, component.updated_at) as identity_updated_at
    from public.operations_hub_seller_listings listing
    join public.operations_hub_listing_components component
      on component.listing_id = listing.listing_id and component.is_active
    left join public.operations_hub_relation_folders folder
      on folder.folder_id = listing.folder_id and folder.is_active
    cross join input
    where listing.is_active
      and (input.source_filter = 'all' or listing.source_channel = input.source_filter)

    union all

    select
      'legacy'::text, null::bigint, null::bigint, null::bigint,
      cache.source_channel, cache.product_code, cache.option_code,
      cache.product_name, cache.option_name,
      null::bigint, null::text, null::text, null::integer, null::text, null::text,
      cache.sellpia_sku_code, 1::integer, 'primary'::text, cache.refreshed_at
    from public.operations_hub_listing_legacy_cache cache
    cross join input
    where (input.source_filter = 'all' or cache.source_channel = input.source_filter)
      and not exists (
        select 1 from public.operations_hub_seller_listings explicit_listing
        where explicit_listing.is_active
          and explicit_listing.source_channel = cache.source_channel
          and explicit_listing.product_code = cache.product_code
          and explicit_listing.option_code = cache.option_code
      )
  ), listing_rollup as materialized (
    select
      edge.source_channel, edge.product_code, edge.option_code,
      max(edge.listing_id) as listing_id,
      max(edge.product_name) as product_name,
      max(edge.option_name) as option_name,
      max(edge.folder_id) as folder_id,
      max(edge.folder_name) as folder_name,
      max(edge.folder_kind) as folder_kind,
      max(edge.folder_sort_order) as folder_sort_order,
      max(edge.relation_kind) as relation_kind,
      max(edge.group_name) as group_name,
      count(*)::integer as component_count,
      bool_or(edge.mapping_source = 'explicit') as is_explicit,
      max(edge.identity_updated_at) as identity_updated_at
    from identity_edges edge
    group by edge.source_channel, edge.product_code, edge.option_code
  ), sku_listing_counts as materialized (
    select edge.source_channel, edge.sellpia_sku_code,
      count(distinct (edge.product_code, edge.option_code))::integer as listing_count
    from identity_edges edge
    group by edge.source_channel, edge.sellpia_sku_code
  ), listing_spread as materialized (
    select edge.source_channel, edge.product_code, edge.option_code,
      max(counts.listing_count)::integer as max_listing_count
    from identity_edges edge
    join sku_listing_counts counts
      on counts.source_channel = edge.source_channel
     and counts.sellpia_sku_code = edge.sellpia_sku_code
    group by edge.source_channel, edge.product_code, edge.option_code
  ), classified as materialized (
    select rollup.*, spread.max_listing_count,
      case
        when rollup.component_count > 1 and spread.max_listing_count > 1 then 'multi_bundle'
        when rollup.component_count > 1 then 'bundle'
        when spread.max_listing_count > 1 then 'multi'
        else 'single'
      end as relation_type
    from listing_rollup rollup
    join listing_spread spread using (source_channel, product_code, option_code)
  ), component_metadata_matches as not materialized (
    select sellpia.sellpia_sku_code
    from public.operations_hub_sellpia_component_live sellpia
    cross join input
    where input.search_text <> '' and (
      coalesce(sellpia.sellpia_own_code, '') ilike '%' || input.search_text || '%'
      or coalesce(sellpia.sellpia_product_name, '') ilike '%' || input.search_text || '%'
      or coalesce(sellpia.sellpia_option_name, '') ilike '%' || input.search_text || '%'
    )
  ), component_search_matches as materialized (
    select distinct edge.source_channel, edge.product_code, edge.option_code
    from identity_edges edge cross join input
    where input.search_text <> '' and (
      edge.sellpia_sku_code ilike '%' || input.search_text || '%'
      or edge.sellpia_sku_code in (select sellpia_sku_code from component_metadata_matches)
    )
  ), filtered as materialized (
    select graph.*
    from classified graph cross join input
    where (
      input.relation_filter = 'all'
      or (input.relation_filter = 'complex' and graph.relation_type <> 'single')
      or graph.relation_type = input.relation_filter
    )
      and (input.folder_filter is null or graph.folder_id = input.folder_filter)
      and (
        input.organization_scope = 'all'
        or (input.organization_scope = 'organized' and graph.folder_id is not null)
        or (input.organization_scope = 'unorganized' and graph.folder_id is null)
      )
      and (
        input.search_text = ''
        or graph.product_code ilike '%' || input.search_text || '%'
        or graph.option_code ilike '%' || input.search_text || '%'
        or coalesce(graph.product_name, '') ilike '%' || input.search_text || '%'
        or coalesce(graph.option_name, '') ilike '%' || input.search_text || '%'
        or coalesce(graph.group_name, '') ilike '%' || input.search_text || '%'
        or coalesce(graph.folder_name, '') ilike '%' || input.search_text || '%'
        or exists (
          select 1 from component_search_matches matched
          where matched.source_channel = graph.source_channel
            and matched.product_code = graph.product_code
            and matched.option_code = graph.option_code
        )
      )
  ), paged_keys as materialized (
    select graph.* from filtered graph cross join input
    order by coalesce(graph.folder_sort_order, 2147483647), coalesce(graph.group_name, graph.product_name, ''),
      graph.source_channel, graph.product_code, graph.option_code
    offset (select (page_number - 1) * page_size from input)
    limit (select page_size from input)
  ), paged_components as materialized (
    select edge.*, sellpia.sellpia_product_name, sellpia.sellpia_option_name,
      sellpia.sellpia_own_code, sellpia.sellpia_available_stock,
      greatest(edge.identity_updated_at, sellpia.updated_at) as updated_at
    from identity_edges edge
    join paged_keys page using (source_channel, product_code, option_code)
    left join public.operations_hub_sellpia_component_live sellpia
      on sellpia.sellpia_sku_code = edge.sellpia_sku_code
  ), paged_rollup as materialized (
    select
      component.source_channel, component.product_code, component.option_code,
      max(component.listing_id) as listing_id,
      max(component.product_name) as product_name,
      max(component.option_name) as option_name,
      max(component.folder_id) as folder_id,
      max(component.folder_name) as folder_name,
      max(component.folder_kind) as folder_kind,
      max(component.relation_kind) as relation_kind,
      max(component.group_name) as group_name,
      count(*)::integer as component_count,
      case when count(component.sellpia_available_stock) = count(*) then
        min(floor(component.sellpia_available_stock::numeric / component.component_qty))::integer
      else null end as calculated_stock,
      bool_or(component.mapping_source = 'explicit') as is_explicit,
      max(component.updated_at) as updated_at,
      jsonb_agg(jsonb_build_object(
        'componentId', component.component_id,
        'parentComponentId', component.parent_component_id,
        'sku', component.sellpia_sku_code,
        'qty', component.component_qty,
        'role', component.component_role,
        'mappingSource', component.mapping_source,
        'productName', component.sellpia_product_name,
        'optionName', component.sellpia_option_name,
        'ownCode', component.sellpia_own_code,
        'availableStock', component.sellpia_available_stock
      ) order by component.sellpia_sku_code) as components
    from paged_components component
    group by component.source_channel, component.product_code, component.option_code
  ), paged_graph as materialized (
    select rollup.*, page.max_listing_count, page.relation_type
    from paged_rollup rollup
    join paged_keys page using (source_channel, product_code, option_code)
  ), enriched as materialized (
    select graph.*, seller.stock as seller_stock,
      seller.snapshot_completed_at as seller_inventory_at,
      draft.change_id as inventory_change_id,
      draft.status as inventory_draft_status,
      draft.after_value #>> '{}' as inventory_draft_stock
    from paged_graph graph
    left join lateral (
      select latest.stock, latest.snapshot_completed_at
      from public.seller_inventory_latest latest
      where latest.source_channel = graph.source_channel
        and latest.product_code = graph.product_code
        and latest.option_code = graph.option_code
      order by latest.snapshot_completed_at desc nulls last limit 1
    ) seller on true
    left join lateral (
      select queue.change_id, queue.status, queue.after_value
      from public.operations_hub_change_queue queue
      where queue.source_channel = graph.source_channel
        and queue.seller_product_code = graph.product_code
        and coalesce(queue.seller_option_code, '') = graph.option_code
        and queue.field_key = 'sellpia_current_stock'
        and queue.status in ('pending', 'validated', 'failed')
      order by queue.change_id desc limit 1
    ) draft on true
  )
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(to_jsonb(enriched)
      order by coalesce(enriched.folder_name, ''), coalesce(enriched.group_name, enriched.product_name, ''),
        enriched.source_channel, enriched.product_code, enriched.option_code) from enriched), '[]'::jsonb),
    'count', (select count(*) from filtered),
    'page', (select page_number from input),
    'pageSize', (select page_size from input)
  );
$$;

comment on function public.list_operations_hub_listing_graph_v2(text, text, text, integer, integer, bigint, text) is
  'Lists page-first listing graphs with folder organization and display-only parent component metadata.';

-- Keep the existing hot matrix view untouched. This wrapper adds only indexed
-- relationship metadata and deterministic natural-sort keys for the UI.
create or replace view public.operations_hub_matrix_managed_live
with (security_invoker = true)
as
select
  matrix.*,
  exists (
    select 1
    from public.operations_hub_listing_components component
    where component.is_active
      and component.parent_component_id is not null
      and component.sellpia_sku_code = matrix.sellpia_sku_code
  ) as is_dependent_combination_sku,
  case
    when matrix.sellpia_sku_code ~ '^[0-9]+'
      then substring(matrix.sellpia_sku_code from '^([0-9]+)')::numeric
    else null
  end as sellpia_sku_prefix_number,
  (matrix.sellpia_sku_code ~ '^[0-9]+-[0-9]+') as sellpia_sku_has_numeric_suffix,
  case
    when matrix.sellpia_sku_code ~ '^[0-9]+-[0-9]+'
      then substring(matrix.sellpia_sku_code from '^[0-9]+-([0-9]+)')::numeric
    else null
  end as sellpia_sku_suffix_number,
  lower(matrix.sellpia_sku_code) as sellpia_sku_natural_fallback
from public.operations_hub_matrix_system_live matrix;

comment on view public.operations_hub_matrix_managed_live is
  'Matrix overlay with explicit dependent-SKU flag and numeric SKU sort keys; source values remain system-owned.';

revoke all on public.operations_hub_matrix_managed_live from public, anon, authenticated;
grant select on public.operations_hub_matrix_managed_live to anon, authenticated;

create or replace function public.load_operations_hub_matrix_filtered_v2(
  p_page integer default 1,
  p_page_size integer default 50,
  p_search text default '',
  p_search_sources text[] default array['sellpia','smartstore','makeshop','ably']::text[],
  p_status text default 'all',
  p_sort text default 'sku_asc',
  p_filter jsonb default '{"logic":"and","conditions":[]}'::jsonb,
  p_skus text[] default '{}'::text[],
  p_exclude_dependent boolean default false
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := greatest(1, least(coalesce(p_page_size, 50), 100));
  v_search text := btrim(coalesce(p_search, ''));
  v_sources text[];
  v_status text := lower(coalesce(p_status, 'all'));
  v_sort text := lower(coalesce(p_sort, 'sku_asc'));
  v_filter jsonb := coalesce(p_filter, '{"logic":"and","conditions":[]}'::jsonb);
  v_conditions jsonb;
  v_logic text;
  v_condition jsonb;
  v_field text;
  v_operator text;
  v_value text;
  v_type text;
  v_product_term text;
  v_option_term text;
  v_result jsonb;
begin
  if jsonb_typeof(v_filter) <> 'object' then raise exception '상세 필터 형식이 올바르지 않습니다.'; end if;
  v_logic := lower(coalesce(v_filter ->> 'logic', 'and'));
  if v_logic not in ('and','or') then raise exception '상세 필터 결합 방식은 and 또는 or만 허용됩니다.'; end if;
  v_conditions := coalesce(v_filter -> 'conditions', '[]'::jsonb);
  if jsonb_typeof(v_conditions) <> 'array' then raise exception '상세 필터 conditions는 배열이어야 합니다.'; end if;
  if jsonb_array_length(v_conditions) > 12 then raise exception '상세 필터는 최대 12개까지 사용할 수 있습니다.'; end if;

  for v_condition in select value from jsonb_array_elements(v_conditions)
  loop
    if jsonb_typeof(v_condition) <> 'object' then raise exception '상세 필터 조건 형식이 올바르지 않습니다.'; end if;
    v_field := lower(coalesce(v_condition ->> 'field', ''));
    v_operator := lower(coalesce(v_condition ->> 'operator', ''));
    v_value := coalesce(v_condition ->> 'value', '');
    v_type := case
      when v_field = any(array[
        'sellpia_current_stock','sellpia_sale_price','smartstore_stock','smartstore_price',
        'makeshop_stock','makeshop_price','ably_stock','ably_price'
      ]) then 'number'
      when v_field = 'overall_status' then 'status'
      when v_field = any(array[
        'sellpia_sku_code','sellpia_own_code','sellpia_product_name','sellpia_option_name',
        'smartstore_product_code','smartstore_option_code','smartstore_name','smartstore_option_name','smartstore_sale_status',
        'makeshop_product_code','makeshop_option_code','makeshop_name','makeshop_option_name','makeshop_sale_status',
        'ably_product_code','ably_option_code','ably_name','ably_option_name','ably_sale_status',
        'material','product_group','shape','tag_summary'
      ]) then 'text'
      else null
    end;
    if v_type is null then raise exception '허용되지 않은 상세 필터 필드입니다: %', v_field; end if;
    if v_type = 'number' and v_operator not in ('eq','neq','gt','gte','lt','lte','empty','not_empty') then
      raise exception '숫자 필드에 허용되지 않은 연산자입니다: %', v_operator;
    elsif v_type = 'status' and v_operator not in ('eq','neq') then
      raise exception '연결상태 필드에 허용되지 않은 연산자입니다: %', v_operator;
    elsif v_type = 'text' and v_operator not in ('contains','not_contains','eq','neq','empty','not_empty') then
      raise exception '텍스트 필드에 허용되지 않은 연산자입니다: %', v_operator;
    end if;
    if v_operator not in ('empty','not_empty') and nullif(btrim(v_value), '') is null then
      raise exception '상세 필터 비교값을 입력해주세요.';
    end if;
    if v_type = 'number' and v_operator not in ('empty','not_empty') and btrim(v_value) !~ '^-?[0-9]+([.][0-9]+)?$' then
      raise exception '숫자 필터 값이 올바르지 않습니다: %', v_value;
    end if;
    if v_type = 'status' and lower(v_value) not in ('connected','review','unmatched') then
      raise exception '연결상태 값이 올바르지 않습니다: %', v_value;
    end if;
  end loop;

  select coalesce(array_agg(distinct lower(btrim(source))), '{}'::text[])
  into v_sources
  from unnest(coalesce(p_search_sources, '{}'::text[])) source
  where lower(btrim(source)) = any(array['sellpia','smartstore','makeshop','ably']);

  if v_status not in ('all','attention','connected','review','unmatched') then v_status := 'all'; end if;
  if v_sort not in ('sku_asc','stock_desc','price_desc','updated_desc') then v_sort := 'sku_asc'; end if;
  if position('/' in v_search) > 0 then
    v_product_term := nullif(btrim(split_part(v_search, '/', 1)), '');
    v_option_term := nullif(btrim(substr(v_search, position('/' in v_search) + 1)), '');
  end if;

  with filtered as materialized (
    select matrix.*
    from public.operations_hub_matrix_managed_live matrix
    left join public.operations_hub_product_profiles profile
      on profile.sellpia_sku_code = matrix.sellpia_sku_code
    where
      (not coalesce(p_exclude_dependent, false) or not matrix.is_dependent_combination_sku)
      and (coalesce(array_length(p_skus, 1), 0) = 0 or matrix.sellpia_sku_code = any(p_skus))
      and (
        v_status = 'all'
        or (v_status = 'attention' and matrix.overall_status = any(array['review','unmatched']))
        or matrix.overall_status = v_status
      )
      and (
        v_search = ''
        or (
          coalesce(array_length(v_sources, 1), 0) > 0
          and case when v_product_term is not null and v_option_term is not null then
            ('sellpia' = any(v_sources) and coalesce(matrix.sellpia_product_name, '') ilike '%' || v_product_term || '%' and coalesce(matrix.sellpia_option_name, '') ilike '%' || v_option_term || '%')
            or ('smartstore' = any(v_sources) and coalesce(matrix.smartstore_name, '') ilike '%' || v_product_term || '%' and coalesce(matrix.smartstore_option_name, '') ilike '%' || v_option_term || '%')
            or ('makeshop' = any(v_sources) and coalesce(matrix.makeshop_name, '') ilike '%' || v_product_term || '%' and coalesce(matrix.makeshop_option_name, '') ilike '%' || v_option_term || '%')
            or ('ably' = any(v_sources) and coalesce(matrix.ably_name, '') ilike '%' || v_product_term || '%' and coalesce(matrix.ably_option_name, '') ilike '%' || v_option_term || '%')
          else
            ('sellpia' = any(v_sources) and concat_ws(' ', matrix.sellpia_sku_code, matrix.own_code, matrix.sellpia_own_code, matrix.display_name, matrix.sellpia_product_name, matrix.sellpia_option_name) ilike '%' || v_search || '%')
            or ('smartstore' = any(v_sources) and concat_ws(' ', matrix.smartstore_product_code, matrix.smartstore_option_code, matrix.smartstore_name, matrix.smartstore_option_name) ilike '%' || v_search || '%')
            or ('makeshop' = any(v_sources) and concat_ws(' ', matrix.makeshop_product_code, matrix.makeshop_option_code, matrix.makeshop_name, matrix.makeshop_option_name) ilike '%' || v_search || '%')
            or ('ably' = any(v_sources) and concat_ws(' ', matrix.ably_product_code, matrix.ably_option_code, matrix.ably_name, matrix.ably_option_name) ilike '%' || v_search || '%')
          end
        )
      )
      and (
        jsonb_array_length(v_conditions) = 0
        or (v_logic = 'and' and not exists (
          select 1 from jsonb_array_elements(v_conditions) condition
          where not public.operations_hub_matrix_condition_matches(to_jsonb(matrix), to_jsonb(profile), condition)
        ))
        or (v_logic = 'or' and exists (
          select 1 from jsonb_array_elements(v_conditions) condition
          where public.operations_hub_matrix_condition_matches(to_jsonb(matrix), to_jsonb(profile), condition)
        ))
      )
  ), ranked as (
    select filtered.*,
      row_number() over (
        order by
          case when v_sort = 'stock_desc' then system_stock end desc nulls last,
          case when v_sort = 'price_desc' then system_base_price end desc nulls last,
          case when v_sort = 'updated_desc' then updated_at end desc nulls last,
          sellpia_sku_prefix_number asc nulls last,
          sellpia_sku_has_numeric_suffix asc,
          sellpia_sku_suffix_number asc nulls first,
          sellpia_sku_natural_fallback asc
      ) as __row_number
    from filtered
  ), paged as (
    select * from ranked
    where __row_number > (v_page - 1) * v_page_size
      and __row_number <= v_page * v_page_size
    order by __row_number
  )
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(
      to_jsonb(paged)
        - '__row_number'
        - 'sellpia_sku_prefix_number'
        - 'sellpia_sku_has_numeric_suffix'
        - 'sellpia_sku_suffix_number'
        - 'sellpia_sku_natural_fallback'
      order by __row_number
    ) from paged), '[]'::jsonb),
    'count', (select count(*) from filtered),
    'page', v_page,
    'pageSize', v_page_size
  ) into v_result;
  return v_result;
end;
$$;

comment on function public.load_operations_hub_matrix_filtered_v2(integer, integer, text, text[], text, text, jsonb, text[], boolean) is
  'Exact-paged advanced matrix filtering with dependent-SKU exclusion and natural numeric SKU ordering.';

revoke all on function public.list_operations_hub_relation_folders() from public;
revoke all on function public.save_operations_hub_relation_folder(bigint, text, text, integer) from public;
revoke all on function public.archive_operations_hub_relation_folder(bigint) from public;
revoke all on function public.save_operations_hub_listing_organization(text, text, text, bigint, text, text) from public;
revoke all on function public.save_operations_hub_listing_component_parent(bigint, bigint) from public;
revoke all on function public.list_operations_hub_listing_graph_v2(text, text, text, integer, integer, bigint, text) from public;
revoke all on function public.load_operations_hub_matrix_filtered_v2(integer, integer, text, text[], text, text, jsonb, text[], boolean) from public;

grant execute on function public.list_operations_hub_relation_folders() to anon, authenticated;
grant execute on function public.save_operations_hub_relation_folder(bigint, text, text, integer) to anon, authenticated;
grant execute on function public.archive_operations_hub_relation_folder(bigint) to anon, authenticated;
grant execute on function public.save_operations_hub_listing_organization(text, text, text, bigint, text, text) to anon, authenticated;
grant execute on function public.save_operations_hub_listing_component_parent(bigint, bigint) to anon, authenticated;
grant execute on function public.list_operations_hub_listing_graph_v2(text, text, text, integer, integer, bigint, text) to anon, authenticated;
grant execute on function public.load_operations_hub_matrix_filtered_v2(integer, integer, text, text[], text, text, jsonb, text[], boolean) to anon, authenticated;

notify pgrst, 'reload schema';
