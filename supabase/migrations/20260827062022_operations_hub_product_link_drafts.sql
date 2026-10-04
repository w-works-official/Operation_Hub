-- Keep a copied seller product identity separate from an actual SKU link.
-- A draft becomes a real link only after the operator chooses an option.
create table if not exists public.operations_hub_product_link_drafts (
  source_channel text not null check (source_channel in ('smartstore', 'makeshop', 'ably')),
  sellpia_sku_code text not null,
  product_code text not null check (btrim(product_code) <> ''),
  product_name text,
  updated_by text not null default 'operations_hub_frontend',
  updated_at timestamptz not null default now(),
  primary key (source_channel, sellpia_sku_code)
);

create index if not exists operations_hub_product_link_drafts_product_idx
  on public.operations_hub_product_link_drafts (source_channel, product_code);

alter table public.operations_hub_product_link_drafts enable row level security;

drop policy if exists "operations hub product link drafts readable"
  on public.operations_hub_product_link_drafts;
create policy "operations hub product link drafts readable"
  on public.operations_hub_product_link_drafts for select
  to anon, authenticated
  using (true);

revoke all on table public.operations_hub_product_link_drafts from public;
revoke all on table public.operations_hub_product_link_drafts from anon, authenticated;
grant select on table public.operations_hub_product_link_drafts to anon, authenticated;

create or replace function public.save_operations_hub_product_link_draft(
  p_sku text,
  p_source text,
  p_product_code text
)
returns table (
  source_channel text,
  sellpia_sku_code text,
  product_code text,
  product_name text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source text := lower(btrim(coalesce(p_source, '')));
  v_sku text := btrim(coalesce(p_sku, ''));
  v_product_code text := btrim(coalesce(p_product_code, ''));
  v_product_name text;
begin
  if v_source not in ('smartstore', 'makeshop', 'ably') then
    raise exception '지원하지 않는 판매처입니다.';
  end if;
  if v_sku = '' or v_product_code = '' then
    raise exception '셀피아 SKU와 판매처 상품코드는 필수입니다.';
  end if;
  if not exists (
    select 1
    from operations_private.operations_hub_matrix_core matrix
    where matrix.sellpia_sku_code = v_sku
  ) then
    raise exception '셀피아 SKU %를 찾을 수 없습니다.', v_sku;
  end if;
  if exists (
    select 1
    from public.operations_hub_manual_links manual
    where manual.source_channel = v_source
      and manual.sellpia_sku_code = v_sku
  ) then
    raise exception '이미 실제 연결이 있는 행입니다. 기존 연결을 먼저 확인해주세요.';
  end if;

  select nullif(btrim(item.product_name), '')
    into v_product_name
  from public.seller_inventory_latest item
  where item.source_channel = v_source
    and item.product_code = v_product_code
  order by
    case when nullif(btrim(item.product_name), '') is null then 1 else 0 end,
    item.option_code
  limit 1;

  if not found then
    raise exception '최신 % 원본에서 상품코드 %를 찾을 수 없습니다.', v_source, v_product_code;
  end if;

  insert into public.operations_hub_product_link_drafts (
    source_channel, sellpia_sku_code, product_code, product_name, updated_by, updated_at
  ) values (
    v_source, v_sku, v_product_code, v_product_name, 'operations_hub_frontend', now()
  )
  on conflict on constraint operations_hub_product_link_drafts_pkey
  do update set
    product_code = excluded.product_code,
    product_name = excluded.product_name,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;

  return query
  select
    draft.source_channel,
    draft.sellpia_sku_code,
    draft.product_code,
    draft.product_name,
    draft.updated_at
  from public.operations_hub_product_link_drafts draft
  where draft.source_channel = v_source
    and draft.sellpia_sku_code = v_sku;
end;
$$;

comment on function public.save_operations_hub_product_link_draft(text, text, text) is
  'Copies only a seller product identity to a Sellpia SKU. It does not create a manual link or mark the row connected.';

create or replace function public.clear_operations_hub_product_link_draft(
  p_sku text,
  p_source text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted integer := 0;
begin
  if lower(btrim(coalesce(p_source, ''))) not in ('smartstore', 'makeshop', 'ably') then
    raise exception '지원하지 않는 판매처입니다.';
  end if;

  delete from public.operations_hub_product_link_drafts draft
  where draft.source_channel = lower(btrim(coalesce(p_source, '')))
    and draft.sellpia_sku_code = btrim(coalesce(p_sku, ''));
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;

comment on function public.clear_operations_hub_product_link_draft(text, text) is
  'Clears a product-code-only staging row without touching any actual seller link.';

create or replace function public.link_operations_hub_product_link_draft_option(
  p_sku text,
  p_source text,
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
declare
  v_source text := lower(btrim(coalesce(p_source, '')));
  v_sku text := btrim(coalesce(p_sku, ''));
  v_product_code text;
  v_option_code text := btrim(coalesce(p_option_code, ''));
begin
  if v_source not in ('smartstore', 'makeshop', 'ably') then
    raise exception '지원하지 않는 판매처입니다.';
  end if;

  select draft.product_code
    into v_product_code
  from public.operations_hub_product_link_drafts draft
  where draft.source_channel = v_source
    and draft.sellpia_sku_code = v_sku
  for update;

  if not found then
    raise exception '옵션 선택 대기 중인 상품코드가 없습니다.';
  end if;

  return query
  select linked.*
  from public.link_operations_hub_seller_item_v2(
    v_sku,
    v_source,
    v_product_code,
    v_option_code
  ) linked;

  delete from public.operations_hub_product_link_drafts draft
  where draft.source_channel = v_source
    and draft.sellpia_sku_code = v_sku;
end;
$$;

comment on function public.link_operations_hub_product_link_draft_option(text, text, text) is
  'Atomically converts a product-code-only draft into a real seller option link and then removes the draft.';

revoke all on function public.save_operations_hub_product_link_draft(text, text, text) from public;
revoke all on function public.clear_operations_hub_product_link_draft(text, text) from public;
revoke all on function public.link_operations_hub_product_link_draft_option(text, text, text) from public;
grant execute on function public.save_operations_hub_product_link_draft(text, text, text) to anon, authenticated;
grant execute on function public.clear_operations_hub_product_link_draft(text, text) to anon, authenticated;
grant execute on function public.link_operations_hub_product_link_draft_option(text, text, text) to anon, authenticated;
