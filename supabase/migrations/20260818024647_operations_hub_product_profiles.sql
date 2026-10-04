create table if not exists catalog.sellpia_product_attributes (
  sellpia_product_code text primary key,
  material text not null,
  product_group text not null,
  shape text not null,
  material_source text not null default 'classifier',
  product_group_source text not null default 'classifier',
  shape_source text not null default 'classifier',
  classifier_version text not null default 'product-name-v1',
  classified_at timestamptz not null default now(),
  updated_by text not null default 'system',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sellpia_product_attributes_material_check check (material in ('14K','925 실버','써지컬','티타늄','아크릴/투명','실버','기타')),
  constraint sellpia_product_attributes_product_group_check check (product_group in ('부품/소모품','피어싱','귀걸이','목걸이','반지','팔찌/발찌','헤어/잡화','기타')),
  constraint sellpia_product_attributes_shape_check check (shape in ('세트','링','바벨/바','볼','진주','큐빅/스톤','투명/리테이너','체인','모티브','기타')),
  constraint sellpia_product_attributes_source_check check (
    material_source in ('classifier','manual') and
    product_group_source in ('classifier','manual') and
    shape_source in ('classifier','manual')
  )
);

alter table public.product_tags add column if not exists tag_group text not null default '운영';
alter table public.product_tags add column if not exists display_order integer not null default 100;

update public.product_tags
set tag_group = nullif(btrim(split_part(description, ':', 2)), '')
where description like 'category:%'
  and tag_group = '운영';

create index if not exists ix_product_tags_group_order
  on public.product_tags (tag_group, display_order, tag_name)
  where is_active = true;

create or replace function catalog.touch_sellpia_product_attributes_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, catalog
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists tr_sellpia_product_attributes_updated_at on catalog.sellpia_product_attributes;
create trigger tr_sellpia_product_attributes_updated_at
before update on catalog.sellpia_product_attributes
for each row execute function catalog.touch_sellpia_product_attributes_updated_at();

create or replace function catalog.classify_sellpia_product_name(p_name text)
returns jsonb
language sql
immutable
set search_path = pg_catalog
as $$
  select jsonb_build_object(
    'material', case
      when coalesce(p_name, '') ~* '(^|[^0-9A-Za-z])14K([^0-9A-Za-z]|$)' then '14K'
      when coalesce(p_name, '') ~* '(925|실버925|925실버)' then '925 실버'
      when coalesce(p_name, '') ~* '(써지컬|서지컬|surgical)' then '써지컬'
      when coalesce(p_name, '') ~* '(티타늄|titanium)' then '티타늄'
      when coalesce(p_name, '') ~* '(아크릴|투명|리테이너)' then '아크릴/투명'
      when coalesce(p_name, '') ~* '실버' then '실버'
      else '기타'
    end,
    'product_group', case
      when coalesce(p_name, '') ~* '(부품|소모품|뒷마개|마개|볼만|바만|침만|체인만)' then '부품/소모품'
      when coalesce(p_name, '') ~* '(피어싱|바벨|라블렛|라브렛)' then '피어싱'
      when coalesce(p_name, '') ~* '(귀걸이|이어링|이어커프)' then '귀걸이'
      when coalesce(p_name, '') ~* '(목걸이|네크리스)' then '목걸이'
      when coalesce(p_name, '') ~* '(반지|링반지)' then '반지'
      when coalesce(p_name, '') ~* '(팔찌|발찌|브레이슬릿|앵클릿)' then '팔찌/발찌'
      when coalesce(p_name, '') ~* '(헤어|머리|키링|잡화|핀)' then '헤어/잡화'
      else '기타'
    end,
    'shape', case
      when coalesce(p_name, '') ~* '(세트|(^|[^A-Za-z])set([^A-Za-z]|$))' then '세트'
      when coalesce(p_name, '') ~* '원터치' or replace(coalesce(p_name, ''), '폴리싱', '') ~* '링' then '링'
      when coalesce(p_name, '') ~* '(바벨|라블렛|라브렛|바 피어싱)' then '바벨/바'
      when coalesce(p_name, '') ~* '(볼 피어싱|볼볼|볼$)' then '볼'
      when coalesce(p_name, '') ~* '(진주|펄)' then '진주'
      when coalesce(p_name, '') ~* '(큐빅|스톤|지르코니아|보석)' then '큐빅/스톤'
      when coalesce(p_name, '') ~* '(투명|리테이너)' then '투명/리테이너'
      when coalesce(p_name, '') ~* '(체인|드롭)' then '체인'
      when replace(coalesce(p_name, ''), '특별', '') ~* '(하트|별|꽃|나비|달|십자가|리본|동물|캐릭터)' then '모티브'
      else '기타'
    end
  );
$$;

insert into catalog.sellpia_product_attributes (
  sellpia_product_code, material, product_group, shape,
  material_source, product_group_source, shape_source,
  classifier_version, classified_at, updated_by
)
select source.sellpia_product_code,
  classified.value ->> 'material',
  classified.value ->> 'product_group',
  classified.value ->> 'shape',
  'classifier', 'classifier', 'classifier',
  'product-name-v1', now(), 'initial-classifier'
from (
  select distinct on (sellpia_product_code)
    sellpia_product_code, sellpia_product_name
  from public.sellpia_stock_latest
  where nullif(btrim(sellpia_product_code), '') is not null
  order by sellpia_product_code, snapshot_created_at desc nulls last, source_row_no
) source
cross join lateral (select catalog.classify_sellpia_product_name(source.sellpia_product_name) value) classified
on conflict (sellpia_product_code) do nothing;

alter table catalog.sellpia_product_attributes enable row level security;

drop policy if exists "sellpia product attributes readable" on catalog.sellpia_product_attributes;
create policy "sellpia product attributes readable"
on catalog.sellpia_product_attributes for select
to anon, authenticated
using (true);

drop policy if exists "sellpia product attributes insertable" on catalog.sellpia_product_attributes;
create policy "sellpia product attributes insertable"
on catalog.sellpia_product_attributes for insert
to anon, authenticated
with check (
  length(btrim(sellpia_product_code)) between 1 and 64
  and updated_by <> ''
);

drop policy if exists "sellpia product attributes updatable" on catalog.sellpia_product_attributes;
create policy "sellpia product attributes updatable"
on catalog.sellpia_product_attributes for update
to anon, authenticated
using (true)
with check (
  length(btrim(sellpia_product_code)) between 1 and 64
  and updated_by <> ''
);

grant usage on schema catalog to anon, authenticated, service_role;
grant select, insert, update on catalog.sellpia_product_attributes to anon, authenticated;
grant all on catalog.sellpia_product_attributes to service_role;

create or replace view public.operations_hub_product_profiles
with (security_invoker = true)
as
select
  sku.sellpia_sku_code,
  sku.sellpia_product_code,
  attr.material,
  attr.product_group,
  attr.shape,
  attr.material_source,
  attr.product_group_source,
  attr.shape_source,
  attr.classifier_version,
  attr.classified_at,
  attr.updated_by,
  attr.updated_at,
  coalesce(product_tags.items, '[]'::jsonb) as product_tags,
  coalesce(sku_tags.items, '[]'::jsonb) as sku_tags,
  concat_ws(' · ', nullif(product_tags.summary, ''), nullif(sku_tags.summary, '')) as tag_summary
from (
  select distinct sellpia_sku_code, sellpia_product_code
  from public.sellpia_stock_latest
  where nullif(btrim(sellpia_sku_code), '') is not null
) sku
left join catalog.sellpia_product_attributes attr
  on attr.sellpia_product_code = sku.sellpia_product_code
left join lateral (
  select
    jsonb_agg(jsonb_build_object(
      'tag_id', tags.tag_id,
      'tag_name', tags.tag_name,
      'tag_color', tags.tag_color,
      'tag_group', tags.tag_group
    ) order by tags.display_order, tags.tag_name) as items,
    string_agg(tags.tag_name, ' · ' order by tags.display_order, tags.tag_name) as summary
  from public.sellpia_tag_assignments assignments
  join public.product_tags tags on tags.tag_id = assignments.tag_id and tags.is_active
  where assignments.is_active
    and assignments.tag_scope = 'product'
    and assignments.sellpia_product_code = sku.sellpia_product_code
) product_tags on true
left join lateral (
  select
    jsonb_agg(jsonb_build_object(
      'tag_id', tags.tag_id,
      'tag_name', tags.tag_name,
      'tag_color', tags.tag_color,
      'tag_group', tags.tag_group
    ) order by tags.display_order, tags.tag_name) as items,
    string_agg(tags.tag_name, ' · ' order by tags.display_order, tags.tag_name) as summary
  from public.sellpia_tag_assignments assignments
  join public.product_tags tags on tags.tag_id = assignments.tag_id and tags.is_active
  where assignments.is_active
    and assignments.tag_scope = 'option'
    and assignments.sellpia_sku_code = sku.sellpia_sku_code
) sku_tags on true;

grant select on public.operations_hub_product_profiles to anon, authenticated, service_role;

create or replace function public.ensure_operations_hub_product_profile(p_sku text)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, catalog
as $$
declare
  v_product_code text;
  v_product_name text;
  v_classified jsonb;
  v_result jsonb;
begin
  select sellpia_product_code, sellpia_product_name
  into v_product_code, v_product_name
  from public.sellpia_stock_latest
  where sellpia_sku_code = nullif(btrim(p_sku), '')
  order by snapshot_created_at desc nulls last
  limit 1;

  if v_product_code is null then
    raise exception '셀피아 SKU를 찾을 수 없습니다: %', p_sku;
  end if;

  v_classified := catalog.classify_sellpia_product_name(v_product_name);
  insert into catalog.sellpia_product_attributes (
    sellpia_product_code, material, product_group, shape,
    material_source, product_group_source, shape_source,
    classifier_version, classified_at, updated_by
  ) values (
    v_product_code,
    v_classified ->> 'material', v_classified ->> 'product_group', v_classified ->> 'shape',
    'classifier', 'classifier', 'classifier',
    'product-name-v1', now(), 'profile-ensure'
  ) on conflict (sellpia_product_code) do nothing;

  select to_jsonb(profile) into v_result
  from public.operations_hub_product_profiles profile
  where profile.sellpia_sku_code = p_sku;
  return v_result;
end;
$$;

create or replace function public.save_operations_hub_product_profile(
  p_sku text,
  p_material text,
  p_product_group text,
  p_shape text,
  p_product_tag_ids uuid[],
  p_sku_tag_ids uuid[],
  p_updated_by text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, catalog
as $$
declare
  v_product_code text;
  v_product_tag_ids uuid[] := coalesce(p_product_tag_ids, '{}'::uuid[]);
  v_sku_tag_ids uuid[] := coalesce(p_sku_tag_ids, '{}'::uuid[]);
  v_updated_by text := coalesce(nullif(btrim(p_updated_by), ''), 'operations-hub');
  v_invalid_count integer;
  v_result jsonb;
begin
  if p_material is null or p_material <> all(array['14K','925 실버','써지컬','티타늄','아크릴/투명','실버','기타']) then
    raise exception '허용되지 않은 소재입니다: %', p_material;
  end if;
  if p_product_group is null or p_product_group <> all(array['부품/소모품','피어싱','귀걸이','목걸이','반지','팔찌/발찌','헤어/잡화','기타']) then
    raise exception '허용되지 않은 상품군입니다: %', p_product_group;
  end if;
  if p_shape is null or p_shape <> all(array['세트','링','바벨/바','볼','진주','큐빅/스톤','투명/리테이너','체인','모티브','기타']) then
    raise exception '허용되지 않은 형태입니다: %', p_shape;
  end if;

  select sellpia_product_code into v_product_code
  from public.sellpia_stock_latest
  where sellpia_sku_code = nullif(btrim(p_sku), '')
  order by snapshot_created_at desc nulls last
  limit 1;
  if v_product_code is null then
    raise exception '셀피아 SKU를 찾을 수 없습니다: %', p_sku;
  end if;

  select count(*) into v_invalid_count
  from unnest(v_product_tag_ids || v_sku_tag_ids) requested(tag_id)
  left join public.product_tags tags on tags.tag_id = requested.tag_id and tags.is_active
  where tags.tag_id is null;
  if v_invalid_count > 0 then
    raise exception '비활성 또는 존재하지 않는 태그가 %개 포함되어 있습니다.', v_invalid_count;
  end if;

  insert into catalog.sellpia_product_attributes (
    sellpia_product_code, material, product_group, shape,
    material_source, product_group_source, shape_source,
    classifier_version, classified_at, updated_by
  ) values (
    v_product_code, p_material, p_product_group, p_shape,
    'manual', 'manual', 'manual', 'product-name-v1', now(), v_updated_by
  ) on conflict (sellpia_product_code) do update set
    material = excluded.material,
    product_group = excluded.product_group,
    shape = excluded.shape,
    material_source = 'manual',
    product_group_source = 'manual',
    shape_source = 'manual',
    updated_by = excluded.updated_by;

  update public.sellpia_tag_assignments
  set is_active = false, updated_at = now(), reviewer = v_updated_by
  where is_active
    and tag_scope = 'product'
    and sellpia_product_code = v_product_code
    and not (tag_id = any(v_product_tag_ids));

  update public.sellpia_tag_assignments
  set is_active = false, updated_at = now(), reviewer = v_updated_by
  where is_active
    and tag_scope = 'option'
    and sellpia_sku_code = p_sku
    and not (tag_id = any(v_sku_tag_ids));

  insert into public.sellpia_tag_assignments (
    tag_id, tag_scope, sellpia_product_code, reviewer, memo
  )
  select tag_id, 'product', v_product_code, v_updated_by, 'operations hub product tag'
  from unnest(v_product_tag_ids) requested(tag_id)
  where not exists (
    select 1 from public.sellpia_tag_assignments existing
    where existing.is_active and existing.tag_id = requested.tag_id
      and existing.tag_scope = 'product' and existing.sellpia_product_code = v_product_code
  );

  insert into public.sellpia_tag_assignments (
    tag_id, tag_scope, sellpia_sku_code, reviewer, memo
  )
  select tag_id, 'option', p_sku, v_updated_by, 'operations hub sku tag'
  from unnest(v_sku_tag_ids) requested(tag_id)
  where not exists (
    select 1 from public.sellpia_tag_assignments existing
    where existing.is_active and existing.tag_id = requested.tag_id
      and existing.tag_scope = 'option' and existing.sellpia_sku_code = p_sku
  );

  select to_jsonb(profile) into v_result
  from public.operations_hub_product_profiles profile
  where profile.sellpia_sku_code = p_sku;
  return v_result;
end;
$$;

revoke all on function public.ensure_operations_hub_product_profile(text) from public;
grant execute on function public.ensure_operations_hub_product_profile(text) to anon, authenticated, service_role;
revoke all on function public.save_operations_hub_product_profile(text,text,text,text,uuid[],uuid[],text) from public;
grant execute on function public.save_operations_hub_product_profile(text,text,text,text,uuid[],uuid[],text) to anon, authenticated, service_role;

comment on table catalog.sellpia_product_attributes is 'Product-level attributes seeded once from Sellpia product names; manual edits are never overwritten by classifier refreshes.';
comment on view public.operations_hub_product_profiles is 'Operations Hub read model combining product attributes, product tags, and SKU exception tags.';
