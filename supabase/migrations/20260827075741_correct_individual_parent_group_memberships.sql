
drop function if exists public.get_operations_hub_listing_relation_group(text, text, text);
drop function if exists public.save_operations_hub_listing_sellpia_group(text, text, text, text, bigint, text);

drop index if exists public.operations_hub_seller_listings_relation_group_active_idx;
alter table public.operations_hub_seller_listings
  drop column if exists relation_group_id;

create table public.operations_hub_listing_group_memberships (
  membership_id bigint generated always as identity primary key,
  listing_id bigint not null
    references public.operations_hub_seller_listings(listing_id)
    on delete restrict,
  relation_group_id bigint not null
    references public.operations_hub_relation_groups(relation_group_id)
    on delete restrict,
  is_active boolean not null default true,
  updated_by text not null default 'operations_hub_frontend',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (listing_id, relation_group_id)
);

create index operations_hub_listing_group_memberships_group_active_idx
  on public.operations_hub_listing_group_memberships (relation_group_id, listing_id)
  where is_active;

create index operations_hub_listing_group_memberships_listing_active_idx
  on public.operations_hub_listing_group_memberships (listing_id, relation_group_id)
  where is_active;

alter table public.operations_hub_listing_group_memberships enable row level security;

create policy "operations hub listing group memberships readable"
  on public.operations_hub_listing_group_memberships for select
  to anon, authenticated using (true);

create policy "operations hub listing group memberships insertable"
  on public.operations_hub_listing_group_memberships for insert
  to anon, authenticated
  with check (updated_by = 'operations_hub_frontend');

create policy "operations hub listing group memberships updatable"
  on public.operations_hub_listing_group_memberships for update
  to anon, authenticated
  using (updated_by = 'operations_hub_frontend')
  with check (updated_by = 'operations_hub_frontend');

grant select, insert, update on table public.operations_hub_listing_group_memberships to anon, authenticated;
grant usage, select on sequence public.operations_hub_listing_group_memberships_membership_id_seq to anon, authenticated;

alter table public.operations_hub_relation_events
  drop constraint operations_hub_relation_events_event_type_check;

alter table public.operations_hub_relation_events
  add constraint operations_hub_relation_events_event_type_check
  check (event_type in (
    'FOLDER_SAVE', 'FOLDER_ARCHIVE', 'ORGANIZE', 'REPARENT',
    'GROUP_SAVE', 'GROUP_ASSIGN', 'GROUP_UNASSIGN'
  ));

create or replace function public.get_operations_hub_listing_parent_groups(
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
  with target as (
    select listing.listing_id
    from public.operations_hub_seller_listings listing
    where listing.source_channel = lower(btrim(coalesce(p_source, '')))
      and listing.product_code = btrim(coalesce(p_product_code, ''))
      and listing.option_code = btrim(coalesce(p_option_code, ''))
      and listing.is_active
    limit 1
  ), parents as (
    select
      membership.membership_id,
      grp.relation_group_id,
      grp.sellpia_product_code,
      grp.representative_product_name,
      grp.folder_id,
      folder.folder_name,
      grp.relation_kind,
      grp.updated_at
    from target
    join public.operations_hub_listing_group_memberships membership
      on membership.listing_id = target.listing_id and membership.is_active
    join public.operations_hub_relation_groups grp
      on grp.relation_group_id = membership.relation_group_id and grp.is_active
    left join public.operations_hub_relation_folders folder
      on folder.folder_id = grp.folder_id and folder.is_active
  )
  select jsonb_build_object(
    'groups', coalesce(jsonb_agg(jsonb_build_object(
      'membershipId', parents.membership_id,
      'relationGroupId', parents.relation_group_id,
      'productCode', parents.sellpia_product_code,
      'productName', parents.representative_product_name,
      'folderId', parents.folder_id,
      'folderName', parents.folder_name,
      'relationKind', parents.relation_kind,
      'updatedAt', parents.updated_at
    ) order by
      case when parents.sellpia_product_code ~ '^[0-9]+$' then parents.sellpia_product_code::numeric end nulls last,
      lower(parents.sellpia_product_code)
    ), '[]'::jsonb)
  )
  from parents;
$$;

create or replace function public.save_operations_hub_listing_parent_group(
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
  v_membership public.operations_hub_listing_group_memberships%rowtype;
  v_product_name text;
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
    raise exception '부모가 될 셀피아 개별상품을 선택해주세요.';
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
    raise exception '최신 셀피아 원본에서 개별상품코드 %를 찾을 수 없습니다.', p_sellpia_product_code;
  end if;

  select listing.* into v_listing
  from public.operations_hub_seller_listings listing
  where listing.source_channel = p_source
    and listing.product_code = p_product_code
    and listing.option_code = p_option_code
    and listing.is_active
  for update;
  if not found then
    raise exception '먼저 자식이 될 판매처 상품/옵션의 실제 SKU 연결을 저장해주세요.';
  end if;

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
  end if;

  insert into public.operations_hub_listing_group_memberships (
    listing_id, relation_group_id, is_active, updated_by, updated_at
  ) values (
    v_listing.listing_id, v_group.relation_group_id, true, 'operations_hub_frontend', now()
  )
  on conflict (listing_id, relation_group_id)
  do update set
    is_active = true,
    updated_by = 'operations_hub_frontend',
    updated_at = now()
  returning * into v_membership;

  insert into public.operations_hub_relation_events (
    event_type, listing_id, folder_id, before_value, after_value, changed_by
  ) values (
    'GROUP_ASSIGN', v_listing.listing_id, p_folder_id, null,
    jsonb_build_object(
      'membershipId', v_membership.membership_id,
      'relationGroupId', v_group.relation_group_id,
      'parentSellpiaProductCode', v_group.sellpia_product_code,
      'parentProductName', v_group.representative_product_name,
      'childSource', v_listing.source_channel,
      'childProductCode', v_listing.product_code,
      'childOptionCode', v_listing.option_code
    ),
    'operations_hub_frontend'
  );

  return jsonb_build_object(
    'membershipId', v_membership.membership_id,
    'relationGroupId', v_group.relation_group_id,
    'productCode', v_group.sellpia_product_code,
    'productName', v_group.representative_product_name,
    'folderId', v_group.folder_id,
    'relationKind', v_group.relation_kind,
    'listingId', v_listing.listing_id
  );
end;
$$;

create or replace function public.remove_operations_hub_listing_parent_group(
  p_membership_id bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
set statement_timeout = '4s'
as $$
declare
  v_membership public.operations_hub_listing_group_memberships%rowtype;
  v_group public.operations_hub_relation_groups%rowtype;
begin
  select membership.* into v_membership
  from public.operations_hub_listing_group_memberships membership
  where membership.membership_id = p_membership_id and membership.is_active
  for update;
  if not found then
    raise exception '해제할 부모-자식 관계를 찾을 수 없습니다.';
  end if;

  select grp.* into v_group
  from public.operations_hub_relation_groups grp
  where grp.relation_group_id = v_membership.relation_group_id;

  update public.operations_hub_listing_group_memberships membership
  set is_active = false,
      updated_by = 'operations_hub_frontend',
      updated_at = now()
  where membership.membership_id = p_membership_id;

  insert into public.operations_hub_relation_events (
    event_type, listing_id, folder_id, before_value, after_value, changed_by
  ) values (
    'GROUP_UNASSIGN', v_membership.listing_id, v_group.folder_id,
    to_jsonb(v_membership),
    jsonb_build_object('isActive', false, 'parentSellpiaProductCode', v_group.sellpia_product_code),
    'operations_hub_frontend'
  );

  return jsonb_build_object(
    'membershipId', p_membership_id,
    'removed', true
  );
end;
$$;

revoke all on function public.get_operations_hub_listing_parent_groups(text, text, text) from public;
revoke all on function public.save_operations_hub_listing_parent_group(text, text, text, text, bigint, text) from public;
revoke all on function public.remove_operations_hub_listing_parent_group(bigint) from public;

grant execute on function public.get_operations_hub_listing_parent_groups(text, text, text) to anon, authenticated;
grant execute on function public.save_operations_hub_listing_parent_group(text, text, text, text, bigint, text) to anon, authenticated;
grant execute on function public.remove_operations_hub_listing_parent_group(bigint) to anon, authenticated;

comment on table public.operations_hub_listing_group_memberships is
  'Many-to-many hierarchy: individual Sellpia product groups are parents; marketplace collection, promotion, and set listings are children. No calculation semantics.';
comment on function public.save_operations_hub_listing_parent_group(text, text, text, text, bigint, text) is
  'Adds an individual Sellpia product-code parent to a marketplace child listing without changing component, price, or inventory calculations.';

notify pgrst, 'reload schema';
