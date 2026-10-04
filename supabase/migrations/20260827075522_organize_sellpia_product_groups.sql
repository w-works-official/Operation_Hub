
create table public.operations_hub_relation_groups (
  relation_group_id bigint generated always as identity primary key,
  sellpia_product_code text not null check (length(btrim(sellpia_product_code)) between 1 and 80),
  representative_product_name text not null check (length(btrim(representative_product_name)) between 1 and 300),
  folder_id bigint references public.operations_hub_relation_folders(folder_id) on delete set null,
  relation_kind text not null default 'custom'
    check (relation_kind in ('collection', 'one_plus_one', 'set', 'custom')),
  is_active boolean not null default true,
  updated_by text not null default 'operations_hub_frontend',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index operations_hub_relation_groups_active_product_idx
  on public.operations_hub_relation_groups (lower(btrim(sellpia_product_code)))
  where is_active;

create index operations_hub_relation_groups_folder_active_idx
  on public.operations_hub_relation_groups (folder_id, representative_product_name)
  where is_active;

alter table public.operations_hub_seller_listings
  add column relation_group_id bigint
  references public.operations_hub_relation_groups(relation_group_id)
  on delete set null;

create index operations_hub_seller_listings_relation_group_active_idx
  on public.operations_hub_seller_listings (relation_group_id, source_channel, product_code, option_code)
  where is_active and relation_group_id is not null;

alter table public.operations_hub_relation_events
  drop constraint operations_hub_relation_events_event_type_check;

alter table public.operations_hub_relation_events
  add constraint operations_hub_relation_events_event_type_check
  check (event_type in ('FOLDER_SAVE', 'FOLDER_ARCHIVE', 'ORGANIZE', 'REPARENT', 'GROUP_SAVE', 'GROUP_ASSIGN'));

alter table public.operations_hub_relation_groups enable row level security;

create policy "operations hub relation groups readable"
  on public.operations_hub_relation_groups for select
  to anon, authenticated using (true);

create policy "operations hub relation groups insertable"
  on public.operations_hub_relation_groups for insert
  to anon, authenticated
  with check (updated_by = 'operations_hub_frontend');

create policy "operations hub relation groups updatable"
  on public.operations_hub_relation_groups for update
  to anon, authenticated
  using (updated_by = 'operations_hub_frontend')
  with check (updated_by = 'operations_hub_frontend');

grant select, insert, update on table public.operations_hub_relation_groups to anon, authenticated;
grant usage, select on sequence public.operations_hub_relation_groups_relation_group_id_seq to anon, authenticated;

create or replace function public.search_operations_hub_sellpia_product_groups(
  p_search text default '',
  p_limit integer default 20
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
set statement_timeout = '2s'
as $$
  with input as (
    select btrim(coalesce(p_search, '')) as search_text,
      greatest(1, least(coalesce(p_limit, 20), 50)) as row_limit
  ), grouped as materialized (
    select
      latest.sellpia_product_code,
      max(latest.sellpia_product_name) as representative_product_name,
      count(*)::integer as option_count,
      min(latest.sellpia_sku_code) as first_sku
    from public.sellpia_stock_latest latest
    where nullif(btrim(latest.sellpia_product_code), '') is not null
      and nullif(btrim(latest.sellpia_sku_code), '') is not null
    group by latest.sellpia_product_code
  ), filtered as (
    select grouped.*
    from grouped cross join input
    where input.search_text = ''
      or grouped.sellpia_product_code ilike '%' || input.search_text || '%'
      or grouped.representative_product_name ilike '%' || input.search_text || '%'
  ), paged as (
    select filtered.*
    from filtered cross join input
    order by
      case when filtered.sellpia_product_code ~ '^[0-9]+$' then filtered.sellpia_product_code::numeric end nulls last,
      lower(filtered.sellpia_product_code)
    limit (select row_limit from input)
  )
  select jsonb_build_object(
    'groups', coalesce(jsonb_agg(jsonb_build_object(
      'productCode', paged.sellpia_product_code,
      'productName', paged.representative_product_name,
      'optionCount', paged.option_count,
      'firstSku', paged.first_sku
    ) order by
      case when paged.sellpia_product_code ~ '^[0-9]+$' then paged.sellpia_product_code::numeric end nulls last,
      lower(paged.sellpia_product_code)
    ), '[]'::jsonb),
    'matchedCount', (select count(*) from filtered)
  )
  from paged;
$$;

create or replace function public.get_operations_hub_sellpia_product_group(
  p_product_code text
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
set statement_timeout = '2s'
as $$
  with input as (
    select btrim(coalesce(p_product_code, '')) as product_code
  ), rows as materialized (
    select
      latest.sellpia_product_code,
      latest.sellpia_product_name,
      latest.sellpia_sku_code,
      latest.sellpia_option_name,
      latest.own_sku,
      latest.available_stock
    from public.sellpia_stock_latest latest cross join input
    where latest.sellpia_product_code = input.product_code
  )
  select case when exists (select 1 from rows) then jsonb_build_object(
    'productCode', (select max(sellpia_product_code) from rows),
    'productName', (select max(sellpia_product_name) from rows),
    'optionCount', (select count(*) from rows),
    'options', (select coalesce(jsonb_agg(jsonb_build_object(
      'sku', rows.sellpia_sku_code,
      'optionName', rows.sellpia_option_name,
      'ownCode', rows.own_sku,
      'availableStock', rows.available_stock
    ) order by
      case when rows.sellpia_sku_code ~ '^[0-9]+-[0-9]+$'
        then substring(rows.sellpia_sku_code from '-([0-9]+)$')::numeric end nulls last,
      lower(rows.sellpia_sku_code)
    ), '[]'::jsonb) from rows)
  ) else null end;
$$;

create or replace function public.get_operations_hub_listing_relation_group(
  p_source text,
  p_product_code text,
  p_option_code text default ''
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
set statement_timeout = '2s'
as $$
  select case when grp.relation_group_id is null then null else
    jsonb_build_object(
      'relationGroupId', grp.relation_group_id,
      'productCode', grp.sellpia_product_code,
      'productName', grp.representative_product_name,
      'folderId', grp.folder_id,
      'relationKind', grp.relation_kind,
      'updatedAt', grp.updated_at
    )
  end
  from public.operations_hub_seller_listings listing
  left join public.operations_hub_relation_groups grp
    on grp.relation_group_id = listing.relation_group_id and grp.is_active
  where listing.source_channel = lower(btrim(coalesce(p_source, '')))
    and listing.product_code = btrim(coalesce(p_product_code, ''))
    and listing.option_code = btrim(coalesce(p_option_code, ''))
    and listing.is_active
  limit 1;
$$;

create or replace function public.save_operations_hub_listing_sellpia_group(
  p_source text,
  p_product_code text,
  p_option_code text default '',
  p_sellpia_product_code text default null,
  p_folder_id bigint default null,
  p_relation_kind text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
set statement_timeout = '4s'
as $$
declare
  v_listing public.operations_hub_seller_listings%rowtype;
  v_group public.operations_hub_relation_groups%rowtype;
  v_product_name text;
  v_before jsonb;
  v_after jsonb;
begin
  p_source := lower(btrim(coalesce(p_source, '')));
  p_product_code := btrim(coalesce(p_product_code, ''));
  p_option_code := btrim(coalesce(p_option_code, ''));
  p_sellpia_product_code := btrim(coalesce(p_sellpia_product_code, ''));
  p_relation_kind := coalesce(nullif(lower(btrim(coalesce(p_relation_kind, ''))), ''), 'custom');

  if p_source not in ('smartstore', 'makeshop', 'ably') or p_product_code = '' then
    raise exception '판매처와 상품코드를 확인해주세요.';
  end if;
  if p_sellpia_product_code = '' then
    raise exception '셀피아 대표상품을 선택해주세요.';
  end if;
  if p_relation_kind not in ('collection', 'one_plus_one', 'set', 'custom') then
    raise exception '조합 유형을 확인해주세요.';
  end if;
  if p_folder_id is not null and not exists (
    select 1 from public.operations_hub_relation_folders folder
    where folder.folder_id = p_folder_id and folder.is_active
  ) then
    raise exception '선택한 활성 폴더를 찾을 수 없습니다.';
  end if;

  select latest.sellpia_product_name
    into v_product_name
  from public.sellpia_stock_latest latest
  where latest.sellpia_product_code = p_sellpia_product_code
  order by latest.sellpia_sku_code
  limit 1;
  if nullif(btrim(coalesce(v_product_name, '')), '') is null then
    raise exception '최신 셀피아 원본에서 상품코드 %를 찾을 수 없습니다.', p_sellpia_product_code;
  end if;

  select listing.* into v_listing
  from public.operations_hub_seller_listings listing
  where listing.source_channel = p_source
    and listing.product_code = p_product_code
    and listing.option_code = p_option_code
    and listing.is_active
  for update;
  if not found then
    raise exception '먼저 판매처 옵션의 실제 SKU 연결을 저장해주세요.';
  end if;
  v_before := to_jsonb(v_listing);

  select grp.* into v_group
  from public.operations_hub_relation_groups grp
  where grp.is_active
    and lower(btrim(grp.sellpia_product_code)) = lower(p_sellpia_product_code)
  for update;

  if v_group.relation_group_id is null then
    insert into public.operations_hub_relation_groups (
      sellpia_product_code, representative_product_name, folder_id, relation_kind,
      is_active, updated_by, updated_at
    ) values (
      p_sellpia_product_code, v_product_name, p_folder_id, p_relation_kind,
      true, 'operations_hub_frontend', now()
    )
    returning * into v_group;
  else
    update public.operations_hub_relation_groups grp
    set representative_product_name = v_product_name,
        folder_id = p_folder_id,
        relation_kind = p_relation_kind,
        updated_by = 'operations_hub_frontend',
        updated_at = now()
    where grp.relation_group_id = v_group.relation_group_id
    returning * into v_group;

    update public.operations_hub_seller_listings listing
    set folder_id = p_folder_id,
        relation_kind = p_relation_kind,
        group_name = v_product_name,
        organization_updated_at = now(),
        updated_by = 'operations_hub_frontend',
        updated_at = now()
    where listing.relation_group_id = v_group.relation_group_id
      and listing.is_active;
  end if;

  update public.operations_hub_seller_listings listing
  set relation_group_id = v_group.relation_group_id,
      folder_id = p_folder_id,
      relation_kind = p_relation_kind,
      group_name = v_product_name,
      organization_updated_at = now(),
      updated_by = 'operations_hub_frontend',
      updated_at = now()
  where listing.listing_id = v_listing.listing_id
  returning to_jsonb(listing.*) into v_after;

  insert into public.operations_hub_relation_events (
    event_type, listing_id, folder_id, before_value, after_value, changed_by
  ) values (
    'GROUP_ASSIGN', v_listing.listing_id, p_folder_id, v_before,
    v_after || jsonb_build_object(
      'relationGroupId', v_group.relation_group_id,
      'sellpiaProductCode', v_group.sellpia_product_code,
      'representativeProductName', v_group.representative_product_name
    ),
    'operations_hub_frontend'
  );

  return jsonb_build_object(
    'relationGroupId', v_group.relation_group_id,
    'productCode', v_group.sellpia_product_code,
    'productName', v_group.representative_product_name,
    'folderId', v_group.folder_id,
    'relationKind', v_group.relation_kind,
    'listingId', v_listing.listing_id
  );
end;
$$;

revoke all on function public.search_operations_hub_sellpia_product_groups(text, integer) from public;
revoke all on function public.get_operations_hub_sellpia_product_group(text) from public;
revoke all on function public.get_operations_hub_listing_relation_group(text, text, text) from public;
revoke all on function public.save_operations_hub_listing_sellpia_group(text, text, text, text, bigint, text) from public;

grant execute on function public.search_operations_hub_sellpia_product_groups(text, integer) to anon, authenticated;
grant execute on function public.get_operations_hub_sellpia_product_group(text) to anon, authenticated;
grant execute on function public.get_operations_hub_listing_relation_group(text, text, text) to anon, authenticated;
grant execute on function public.save_operations_hub_listing_sellpia_group(text, text, text, text, bigint, text) to anon, authenticated;

comment on table public.operations_hub_relation_groups is
  'Sellpia product-code groups used for folder hierarchy and display only; no inventory or price calculation semantics.';
comment on function public.save_operations_hub_listing_sellpia_group(text, text, text, text, bigint, text) is
  'Assigns a seller listing to a Sellpia product group and derives the display name from the latest Sellpia source without changing component mappings.';

notify pgrst, 'reload schema';
