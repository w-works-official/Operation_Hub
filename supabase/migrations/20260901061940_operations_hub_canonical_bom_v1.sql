-- Canonical Sellpia-SKU BOM V1.
--
-- This schema is intentionally additive. It does not modify the generic
-- relation graph, seller-listing components, price rules, stock values, or
-- export/change queues. A bundle is a Sellpia SKU whose directed components
-- are other exact Sellpia SKUs. Nested bundles are allowed; cycles are not.

create table public.operations_hub_bundle_definitions (
  bundle_id bigint generated always as identity primary key,
  bundle_sku_code text not null
    check (bundle_sku_code = btrim(bundle_sku_code) and length(bundle_sku_code) between 1 and 120),
  is_active boolean not null default true,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bundle_sku_code)
);

comment on table public.operations_hub_bundle_definitions is
  'Canonical bundle identities keyed only by an exact Sellpia SKU. This table has no direct price or inventory side effects.';

create index operations_hub_bundle_definitions_active_sku_idx
  on public.operations_hub_bundle_definitions (bundle_sku_code, bundle_id)
  where is_active;

create table public.operations_hub_bundle_components (
  bundle_component_id bigint generated always as identity primary key,
  bundle_id bigint not null
    references public.operations_hub_bundle_definitions(bundle_id) on delete restrict,
  component_sku_code text not null
    check (component_sku_code = btrim(component_sku_code) and length(component_sku_code) between 1 and 120),
  component_qty integer not null
    check (component_qty > 0),
  component_role text not null default 'component'
    check (component_role in ('component', 'packaging')),
  sort_order integer not null default 100
    check (sort_order between 0 and 100000),
  is_active boolean not null default true,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bundle_id, component_sku_code)
);

comment on table public.operations_hub_bundle_components is
  'Canonical Sellpia bundle recipe. One durable row per bundle/component pair is soft-deactivated and may be reactivated by upsert.';

create index operations_hub_bundle_components_bundle_active_idx
  on public.operations_hub_bundle_components (bundle_id, sort_order, bundle_component_id)
  where is_active;

create index operations_hub_bundle_components_sku_active_idx
  on public.operations_hub_bundle_components (component_sku_code, bundle_id)
  where is_active;

create table public.operations_hub_bundle_events (
  event_id bigint generated always as identity primary key,
  event_type text not null check (event_type in (
    'DEFINITION_UPSERT', 'COMPONENT_UPSERT', 'COMPONENT_DEACTIVATE'
  )),
  bundle_id bigint references public.operations_hub_bundle_definitions(bundle_id) on delete restrict,
  bundle_component_id bigint references public.operations_hub_bundle_components(bundle_component_id) on delete restrict,
  before_value jsonb,
  after_value jsonb,
  changed_by uuid,
  created_at timestamptz not null default now()
);

comment on table public.operations_hub_bundle_events is
  'Append-only audit trail for canonical BOM mutations.';

create index operations_hub_bundle_events_bundle_created_idx
  on public.operations_hub_bundle_events (bundle_id, created_at desc, event_id desc);

create or replace function public.validate_operations_hub_bundle_definition_v1()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_candidate_count integer;
begin
  new.bundle_sku_code := btrim(coalesce(new.bundle_sku_code, ''));

  if tg_op = 'UPDATE' and old.bundle_sku_code is distinct from new.bundle_sku_code then
    raise exception '세트 SKU 식별자는 변경할 수 없습니다. 기존 구성을 비활성화한 뒤 새 세트를 등록해주세요.';
  end if;

  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  new.updated_by := auth.uid();
  new.updated_at := now();

  if new.is_active then
    select count(*)::integer into v_candidate_count
    from public.sellpia_stock_latest latest
    where latest.sellpia_sku_code = new.bundle_sku_code;
    if v_candidate_count <> 1 then
      raise exception '최신 셀피아 원본에서 세트 SKU %를 정확히 하나 찾을 수 없습니다.', new.bundle_sku_code;
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.validate_operations_hub_bundle_component_v1()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_bundle_sku_code text;
  v_candidate_count integer;
begin
  -- Serialize graph-shape mutations so two concurrent requests cannot create a
  -- cycle after each request independently passes validation.
  perform pg_advisory_xact_lock(hashtextextended('operations_hub_bundle_graph_v1', 0));

  new.component_sku_code := btrim(coalesce(new.component_sku_code, ''));
  new.component_role := lower(btrim(coalesce(new.component_role, 'component')));

  if tg_op = 'UPDATE' and (
    old.bundle_id is distinct from new.bundle_id
    or old.component_sku_code is distinct from new.component_sku_code
  ) then
    raise exception '세트/구성품 식별자는 변경할 수 없습니다. 기존 연결을 비활성화한 뒤 새 연결을 등록해주세요.';
  end if;

  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  new.updated_by := auth.uid();
  new.updated_at := now();

  select definition.bundle_sku_code
  into v_bundle_sku_code
  from public.operations_hub_bundle_definitions definition
  where definition.bundle_id = new.bundle_id
    and definition.is_active;

  if not found then
    raise exception '활성 세트 정의를 찾을 수 없습니다.';
  end if;

  if new.component_qty <= 0 then
    raise exception '구성수량은 1 이상의 정수여야 합니다.';
  end if;

  if new.component_role not in ('component', 'packaging') then
    raise exception '구성품 역할은 component 또는 packaging이어야 합니다.';
  end if;

  if tg_op = 'INSERT' or new.is_active then
    select count(*)::integer into v_candidate_count
    from public.sellpia_stock_latest latest
    where latest.sellpia_sku_code = new.component_sku_code;
    if v_candidate_count <> 1 then
      raise exception '최신 셀피아 원본에서 구성품 SKU %를 정확히 하나 찾을 수 없습니다.', new.component_sku_code;
    end if;
  end if;

  if v_bundle_sku_code = new.component_sku_code then
    raise exception '세트 SKU 자신을 구성품으로 등록할 수 없습니다.';
  end if;

  if not new.is_active then
    return new;
  end if;

  if exists (
    with recursive descendants(sku_code) as (
      select new.component_sku_code
      union
      select child.component_sku_code
      from descendants parent
      join public.operations_hub_bundle_definitions nested_bundle
        on nested_bundle.bundle_sku_code = parent.sku_code
       and nested_bundle.is_active
      join public.operations_hub_bundle_components child
        on child.bundle_id = nested_bundle.bundle_id
       and child.is_active
       and child.bundle_component_id <> coalesce(new.bundle_component_id, -1)
    )
    select 1
    from descendants
    where sku_code = v_bundle_sku_code
  ) then
    raise exception '세트 구성에 순환 참조가 생겨 저장할 수 없습니다.';
  end if;

  return new;
end;
$$;

create or replace function public.audit_operations_hub_bundle_definition_v1()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' or to_jsonb(old) is distinct from to_jsonb(new) then
    insert into public.operations_hub_bundle_events (
      event_type, bundle_id, before_value, after_value, changed_by
    ) values (
      'DEFINITION_UPSERT', new.bundle_id,
      case when tg_op = 'INSERT' then null else to_jsonb(old) end,
      to_jsonb(new), auth.uid()
    );
  end if;
  return new;
end;
$$;

create or replace function public.audit_operations_hub_bundle_component_v1()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_event_type text;
begin
  if tg_op = 'INSERT' or to_jsonb(old) is distinct from to_jsonb(new) then
    v_event_type := case
      when tg_op = 'UPDATE' and old.is_active and not new.is_active
        then 'COMPONENT_DEACTIVATE'
      else 'COMPONENT_UPSERT'
    end;
    insert into public.operations_hub_bundle_events (
      event_type, bundle_id, bundle_component_id, before_value, after_value, changed_by
    ) values (
      v_event_type, new.bundle_id, new.bundle_component_id,
      case when tg_op = 'INSERT' then null else to_jsonb(old) end,
      to_jsonb(new), auth.uid()
    );
  end if;
  return new;
end;
$$;

create trigger operations_hub_bundle_definition_guard_v1
before insert or update on public.operations_hub_bundle_definitions
for each row execute function public.validate_operations_hub_bundle_definition_v1();

create trigger operations_hub_bundle_component_guard_v1
before insert or update on public.operations_hub_bundle_components
for each row execute function public.validate_operations_hub_bundle_component_v1();

create trigger operations_hub_bundle_definition_audit_v1
after insert or update on public.operations_hub_bundle_definitions
for each row execute function public.audit_operations_hub_bundle_definition_v1();

create trigger operations_hub_bundle_component_audit_v1
after insert or update on public.operations_hub_bundle_components
for each row execute function public.audit_operations_hub_bundle_component_v1();

alter table public.operations_hub_bundle_definitions enable row level security;
alter table public.operations_hub_bundle_components enable row level security;
alter table public.operations_hub_bundle_events enable row level security;

revoke all on table public.operations_hub_bundle_definitions from public, anon, authenticated;
revoke all on table public.operations_hub_bundle_components from public, anon, authenticated;
revoke all on table public.operations_hub_bundle_events from public, anon, authenticated;
revoke all on sequence public.operations_hub_bundle_definitions_bundle_id_seq from public, anon, authenticated;
revoke all on sequence public.operations_hub_bundle_components_bundle_component_id_seq from public, anon, authenticated;
revoke all on sequence public.operations_hub_bundle_events_event_id_seq from public, anon, authenticated;

grant select on table public.operations_hub_bundle_definitions to anon, authenticated;
grant select on table public.operations_hub_bundle_components to anon, authenticated;
grant select on table public.operations_hub_bundle_events to authenticated;
grant insert, update on table public.operations_hub_bundle_definitions to anon, authenticated;
grant insert, update on table public.operations_hub_bundle_components to anon, authenticated;
grant insert on table public.operations_hub_bundle_events to anon, authenticated;
grant usage, select on sequence public.operations_hub_bundle_definitions_bundle_id_seq to anon, authenticated;
grant usage, select on sequence public.operations_hub_bundle_components_bundle_component_id_seq to anon, authenticated;
grant usage, select on sequence public.operations_hub_bundle_events_event_id_seq to anon, authenticated;

create policy "operations hub bundle definitions public read"
  on public.operations_hub_bundle_definitions for select
  to anon, authenticated using (true);
create policy "operations hub bundle definitions client insert"
  on public.operations_hub_bundle_definitions for insert
  to anon, authenticated with check (
    created_by is not distinct from (select auth.uid())
    and updated_by is not distinct from (select auth.uid())
  );
create policy "operations hub bundle definitions client update"
  on public.operations_hub_bundle_definitions for update
  to anon, authenticated using (true)
  with check (updated_by is not distinct from (select auth.uid()));

create policy "operations hub bundle components public read"
  on public.operations_hub_bundle_components for select
  to anon, authenticated using (true);
create policy "operations hub bundle components client insert"
  on public.operations_hub_bundle_components for insert
  to anon, authenticated with check (
    created_by is not distinct from (select auth.uid())
    and updated_by is not distinct from (select auth.uid())
  );
create policy "operations hub bundle components client update"
  on public.operations_hub_bundle_components for update
  to anon, authenticated using (true)
  with check (updated_by is not distinct from (select auth.uid()));

create policy "operations hub bundle events operator read"
  on public.operations_hub_bundle_events for select
  to authenticated using (true);
create policy "operations hub bundle events client insert"
  on public.operations_hub_bundle_events for insert
  to anon, authenticated
  with check (
    pg_trigger_depth() > 0
    and changed_by is not distinct from (select auth.uid())
  );

create or replace function public.list_operations_hub_bundle_graph_v1(
  p_query text default ''
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
set statement_timeout = '8s'
as $$
  with input as (
    select btrim(coalesce(p_query, '')) as query_text
  ), matching_bundle_ids as materialized (
    select definition.bundle_id
    from public.operations_hub_bundle_definitions definition
    join public.sellpia_stock_latest bundle_stock
      on bundle_stock.sellpia_sku_code = definition.bundle_sku_code
    cross join input
    where definition.is_active
      and (
        input.query_text = ''
        or definition.bundle_sku_code ilike '%' || input.query_text || '%'
        or coalesce(bundle_stock.sellpia_product_name, '') ilike '%' || input.query_text || '%'
        or coalesce(bundle_stock.sellpia_option_name, '') ilike '%' || input.query_text || '%'
        or exists (
          select 1
          from public.operations_hub_bundle_components matching_component
          join public.sellpia_stock_latest component_stock
            on component_stock.sellpia_sku_code = matching_component.component_sku_code
          where matching_component.bundle_id = definition.bundle_id
            and matching_component.is_active
            and (
              matching_component.component_sku_code ilike '%' || input.query_text || '%'
              or coalesce(component_stock.sellpia_product_name, '') ilike '%' || input.query_text || '%'
              or coalesce(component_stock.sellpia_option_name, '') ilike '%' || input.query_text || '%'
            )
        )
      )
  ), definitions as materialized (
    select
      definition.bundle_id,
      definition.bundle_sku_code,
      bundle_stock.sellpia_product_code,
      bundle_stock.sellpia_product_name,
      bundle_stock.sellpia_option_name,
      definition.created_at,
      definition.updated_at,
      count(component.bundle_component_id) filter (where component.is_active)::integer as component_count
    from public.operations_hub_bundle_definitions definition
    join matching_bundle_ids matching on matching.bundle_id = definition.bundle_id
    join public.sellpia_stock_latest bundle_stock
      on bundle_stock.sellpia_sku_code = definition.bundle_sku_code
    left join public.operations_hub_bundle_components component
      on component.bundle_id = definition.bundle_id
     and component.is_active
    where definition.is_active
    group by definition.bundle_id, bundle_stock.sellpia_product_code,
      bundle_stock.sellpia_product_name, bundle_stock.sellpia_option_name
  ), components as materialized (
    select
      component.bundle_component_id,
      component.bundle_id,
      definition.bundle_sku_code,
      component.component_sku_code,
      component.component_qty,
      component.component_role,
      component.sort_order,
      component_stock.sellpia_product_code,
      component_stock.sellpia_product_name,
      component_stock.sellpia_option_name,
      nested_definition.bundle_id as nested_bundle_id,
      component.created_at,
      component.updated_at
    from public.operations_hub_bundle_components component
    join definitions definition on definition.bundle_id = component.bundle_id
    join public.sellpia_stock_latest component_stock
      on component_stock.sellpia_sku_code = component.component_sku_code
    left join public.operations_hub_bundle_definitions nested_definition
      on nested_definition.bundle_sku_code = component.component_sku_code
     and nested_definition.is_active
    where component.is_active
  )
  select jsonb_build_object(
    'definitions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'bundleId', definition.bundle_id,
        'bundleSkuCode', definition.bundle_sku_code,
        'productCode', definition.sellpia_product_code,
        'productName', definition.sellpia_product_name,
        'optionName', definition.sellpia_option_name,
        'componentCount', definition.component_count,
        'createdAt', definition.created_at,
        'updatedAt', definition.updated_at
      ) order by definition.bundle_sku_code)
      from definitions definition
    ), '[]'::jsonb),
    'components', coalesce((
      select jsonb_agg(jsonb_build_object(
        'bundleComponentId', component.bundle_component_id,
        'bundleId', component.bundle_id,
        'bundleSkuCode', component.bundle_sku_code,
        'componentSkuCode', component.component_sku_code,
        'componentQty', component.component_qty,
        'componentRole', component.component_role,
        'sortOrder', component.sort_order,
        'productCode', component.sellpia_product_code,
        'productName', component.sellpia_product_name,
        'optionName', component.sellpia_option_name,
        'nestedBundleId', component.nested_bundle_id,
        'createdAt', component.created_at,
        'updatedAt', component.updated_at
      ) order by component.bundle_sku_code, component.sort_order, component.bundle_component_id)
      from components component
    ), '[]'::jsonb),
    'counts', jsonb_build_object(
      'bundles', (select count(*) from definitions),
      'components', (select count(*) from components)
    )
  );
$$;

create or replace function public.resolve_operations_hub_bundle_import_codes_v1(
  p_codes jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
set statement_timeout = '8s'
as $$
declare
  v_result jsonb;
begin
  if p_codes is null or jsonb_typeof(p_codes) <> 'array' then
    raise exception '코드 목록은 JSON 배열이어야 합니다.';
  end if;
  if jsonb_array_length(p_codes) > 1000 then
    raise exception '한 번에 확인할 수 있는 코드는 최대 1000개입니다.';
  end if;

  with inputs as materialized (
    select
      case when jsonb_typeof(value) = 'string' then btrim(value #>> '{}') else '' end as input_code,
      ordinality
    from jsonb_array_elements(p_codes) with ordinality
  ), candidate_counts as materialized (
    select
      input.input_code,
      input.ordinality,
      count(latest.sellpia_sku_code)::integer as candidate_count,
      coalesce(jsonb_agg(jsonb_build_object(
        'sellpiaSkuCode', latest.sellpia_sku_code,
        'productCode', latest.sellpia_product_code,
        'productName', latest.sellpia_product_name,
        'optionName', latest.sellpia_option_name
      )) filter (where latest.sellpia_sku_code is not null), '[]'::jsonb) as candidates
    from inputs input
    left join public.sellpia_stock_latest latest
      on latest.sellpia_sku_code = input.input_code
    group by input.input_code, input.ordinality
  )
  select jsonb_build_object(
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'inputCode', candidate.input_code,
      'status', case
        when candidate.input_code = '' then 'invalid'
        when candidate.candidate_count = 0 then 'not_found'
        when candidate.candidate_count > 1 then 'ambiguous'
        else 'matched'
      end,
      'candidateCount', candidate.candidate_count,
      'candidates', candidate.candidates
    ) order by candidate.ordinality), '[]'::jsonb)
  )
  into v_result
  from candidate_counts candidate;

  return v_result;
end;
$$;

create or replace function public.save_operations_hub_bundle_component_v1(
  p_bundle_sku_code text,
  p_component_sku_code text,
  p_component_qty integer default 1,
  p_component_role text default 'component',
  p_sort_order integer default 100
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
set statement_timeout = '8s'
as $$
declare
  v_bundle public.operations_hub_bundle_definitions%rowtype;
  v_component public.operations_hub_bundle_components%rowtype;
  v_before_bundle jsonb;
  v_before_component jsonb;
  v_changed boolean := false;
  v_candidate_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('operations_hub_bundle_graph_v1', 0));

  p_bundle_sku_code := btrim(coalesce(p_bundle_sku_code, ''));
  p_component_sku_code := btrim(coalesce(p_component_sku_code, ''));
  p_component_role := lower(btrim(coalesce(p_component_role, 'component')));
  p_sort_order := coalesce(p_sort_order, 100);

  if p_bundle_sku_code = '' or p_component_sku_code = '' then
    raise exception '세트 SKU와 구성품 SKU를 모두 입력해주세요.';
  end if;
  if p_component_qty is null or p_component_qty <= 0 then
    raise exception '구성수량은 1 이상의 정수여야 합니다.';
  end if;
  if p_component_role not in ('component', 'packaging') then
    raise exception '구성품 역할은 component 또는 packaging이어야 합니다.';
  end if;
  if p_sort_order not between 0 and 100000 then
    raise exception '정렬 순서는 0~100000 범위여야 합니다.';
  end if;

  select count(*)::integer into v_candidate_count
  from public.sellpia_stock_latest latest
  where latest.sellpia_sku_code = p_bundle_sku_code;
  if v_candidate_count <> 1 then
    raise exception '최신 셀피아 원본에서 세트 SKU %를 정확히 하나 찾을 수 없습니다.', p_bundle_sku_code;
  end if;

  select count(*)::integer into v_candidate_count
  from public.sellpia_stock_latest latest
  where latest.sellpia_sku_code = p_component_sku_code;
  if v_candidate_count <> 1 then
    raise exception '최신 셀피아 원본에서 구성품 SKU %를 정확히 하나 찾을 수 없습니다.', p_component_sku_code;
  end if;

  select definition.*
  into v_bundle
  from public.operations_hub_bundle_definitions definition
  where definition.bundle_sku_code = p_bundle_sku_code
  for update;

  if v_bundle.bundle_id is null then
    insert into public.operations_hub_bundle_definitions (
      bundle_sku_code, is_active, created_by, updated_by, updated_at
    ) values (
      p_bundle_sku_code, true, auth.uid(), auth.uid(), now()
    )
    returning * into v_bundle;

  else
    v_before_bundle := to_jsonb(v_bundle);
  end if;

  if v_before_bundle is not null and not v_bundle.is_active then
    update public.operations_hub_bundle_definitions definition
    set is_active = true,
        updated_by = auth.uid(),
        updated_at = now()
    where definition.bundle_id = v_bundle.bundle_id
    returning * into v_bundle;

  end if;

  select component.*
  into v_component
  from public.operations_hub_bundle_components component
  where component.bundle_id = v_bundle.bundle_id
    and component.component_sku_code = p_component_sku_code
  for update;

  if v_component.bundle_component_id is null then
    insert into public.operations_hub_bundle_components (
      bundle_id, component_sku_code, component_qty, component_role, sort_order,
      is_active, created_by, updated_by, updated_at
    ) values (
      v_bundle.bundle_id, p_component_sku_code, p_component_qty, p_component_role, p_sort_order,
      true, auth.uid(), auth.uid(), now()
    )
    returning * into v_component;
    v_changed := true;
  else
    v_before_component := to_jsonb(v_component);
  end if;

  if v_before_component is not null and (
      not v_component.is_active
      or v_component.component_qty is distinct from p_component_qty
      or v_component.component_role is distinct from p_component_role
      or v_component.sort_order is distinct from p_sort_order) then
    update public.operations_hub_bundle_components component
    set component_qty = p_component_qty,
        component_role = p_component_role,
        sort_order = p_sort_order,
        is_active = true,
        updated_by = auth.uid(),
        updated_at = now()
    where component.bundle_component_id = v_component.bundle_component_id
    returning * into v_component;
    v_changed := true;
  end if;

  return jsonb_build_object(
    'bundleId', v_bundle.bundle_id,
    'bundleSkuCode', v_bundle.bundle_sku_code,
    'bundleComponentId', v_component.bundle_component_id,
    'componentSkuCode', v_component.component_sku_code,
    'componentQty', v_component.component_qty,
    'componentRole', v_component.component_role,
    'sortOrder', v_component.sort_order,
    'changed', v_changed
  );
end;
$$;

create or replace function public.deactivate_operations_hub_bundle_component_v1(
  p_component_id bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
set statement_timeout = '8s'
as $$
declare
  v_component public.operations_hub_bundle_components%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('operations_hub_bundle_graph_v1', 0));

  select component.*
  into v_component
  from public.operations_hub_bundle_components component
  join public.operations_hub_bundle_definitions definition
    on definition.bundle_id = component.bundle_id
  where component.bundle_component_id = p_component_id
    and definition.is_active
    and component.is_active
  for update of component;

  if v_component.bundle_component_id is null then
    raise exception '비활성화할 활성 세트 구성품 연결을 찾을 수 없습니다.';
  end if;

  update public.operations_hub_bundle_components component
  set is_active = false,
      updated_by = auth.uid(),
      updated_at = now()
  where component.bundle_component_id = v_component.bundle_component_id
  returning * into v_component;

  return jsonb_build_object(
    'bundleId', v_component.bundle_id,
    'bundleSkuCode', (
      select definition.bundle_sku_code
      from public.operations_hub_bundle_definitions definition
      where definition.bundle_id = v_component.bundle_id
    ),
    'bundleComponentId', v_component.bundle_component_id,
    'componentSkuCode', v_component.component_sku_code,
    'deactivated', true
  );
end;
$$;

create or replace function public.apply_operations_hub_bundle_import_v1(
  p_rows jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
set statement_timeout = '12s'
as $$
declare
  v_item jsonb;
  v_normalized jsonb;
  v_normalized_rows jsonb := '[]'::jsonb;
  v_results jsonb := '[]'::jsonb;
  v_errors jsonb := '[]'::jsonb;
  v_seen jsonb := '{}'::jsonb;
  v_existing jsonb;
  v_result jsonb;
  v_bundle_sku_code text;
  v_component_sku_code text;
  v_component_qty integer;
  v_component_role text;
  v_sort_order integer;
  v_qty_text text;
  v_sort_text text;
  v_key text;
  v_index integer := 0;
  v_candidate_count integer;
  v_cycle_bundles jsonb;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '세트 구성 행은 JSON 배열이어야 합니다.';
  end if;
  if jsonb_array_length(p_rows) > 1000 then
    raise exception '한 번에 저장할 수 있는 세트 구성은 최대 1000행입니다.';
  end if;
  if jsonb_array_length(p_rows) = 0 then
    return jsonb_build_object('applied', true, 'count', 0, 'rows', '[]'::jsonb, 'errors', '[]'::jsonb);
  end if;

  perform pg_advisory_xact_lock(hashtextextended('operations_hub_bundle_graph_v1', 0));

  for v_item in select value from jsonb_array_elements(p_rows)
  loop
    v_index := v_index + 1;

    if jsonb_typeof(v_item) <> 'object' then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object(
        'rowIndex', v_index, 'code', 'invalid_row', 'message', '행은 JSON 객체여야 합니다.'
      ));
      continue;
    end if;

    v_bundle_sku_code := btrim(coalesce(v_item ->> 'bundle_sku_code', ''));
    v_component_sku_code := btrim(coalesce(v_item ->> 'component_sku_code', ''));
    v_qty_text := btrim(coalesce(v_item ->> 'component_qty', ''));
    v_component_role := lower(btrim(coalesce(nullif(v_item ->> 'component_role', ''), 'component')));
    v_sort_text := btrim(coalesce(nullif(v_item ->> 'sort_order', ''), '100'));

    if v_bundle_sku_code = '' or v_component_sku_code = '' then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object(
        'rowIndex', v_index, 'code', 'missing_code', 'message', '세트 SKU와 구성품 SKU가 모두 필요합니다.'
      ));
      continue;
    end if;
    if v_qty_text !~ '^[0-9]+$' or length(v_qty_text) > 10 then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object(
        'rowIndex', v_index, 'code', 'invalid_quantity', 'message', '구성수량은 1 이상의 정수여야 합니다.'
      ));
      continue;
    end if;
    if v_qty_text::numeric <= 0 or v_qty_text::numeric > 2147483647 then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object(
        'rowIndex', v_index, 'code', 'invalid_quantity', 'message', '구성수량 범위를 확인해주세요.'
      ));
      continue;
    end if;
    v_component_qty := v_qty_text::integer;
    if v_component_role not in ('component', 'packaging') then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object(
        'rowIndex', v_index, 'code', 'invalid_role', 'message', '구성품 역할은 component 또는 packaging이어야 합니다.'
      ));
      continue;
    end if;
    if v_sort_text !~ '^[0-9]+$' or length(v_sort_text) > 6 then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object(
        'rowIndex', v_index, 'code', 'invalid_sort_order', 'message', '정렬 순서는 0~100000의 정수여야 합니다.'
      ));
      continue;
    end if;
    v_sort_order := v_sort_text::integer;
    if v_sort_order not between 0 and 100000 then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object(
        'rowIndex', v_index, 'code', 'invalid_sort_order', 'message', '정렬 순서는 0~100000의 정수여야 합니다.'
      ));
      continue;
    end if;
    if v_bundle_sku_code = v_component_sku_code then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object(
        'rowIndex', v_index, 'code', 'self_reference', 'message', '세트 SKU 자신을 구성품으로 등록할 수 없습니다.'
      ));
      continue;
    end if;

    select count(*)::integer into v_candidate_count
    from public.sellpia_stock_latest latest
    where latest.sellpia_sku_code = v_bundle_sku_code;
    if v_candidate_count <> 1 then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object(
        'rowIndex', v_index,
        'code', case when v_candidate_count = 0 then 'bundle_not_found' else 'bundle_ambiguous' end,
        'message', format('최신 셀피아 원본에서 세트 SKU %s를 정확히 하나 찾을 수 없습니다.', v_bundle_sku_code)
      ));
      continue;
    end if;

    select count(*)::integer into v_candidate_count
    from public.sellpia_stock_latest latest
    where latest.sellpia_sku_code = v_component_sku_code;
    if v_candidate_count <> 1 then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object(
        'rowIndex', v_index,
        'code', case when v_candidate_count = 0 then 'component_not_found' else 'component_ambiguous' end,
        'message', format('최신 셀피아 원본에서 구성품 SKU %s를 정확히 하나 찾을 수 없습니다.', v_component_sku_code)
      ));
      continue;
    end if;

    v_normalized := jsonb_build_object(
      'rowIndex', v_index,
      'bundleSkuCode', v_bundle_sku_code,
      'componentSkuCode', v_component_sku_code,
      'componentQty', v_component_qty,
      'componentRole', v_component_role,
      'sortOrder', v_sort_order
    );
    v_key := v_bundle_sku_code || chr(31) || v_component_sku_code;
    v_existing := v_seen -> v_key;

    if v_existing is not null then
      if (v_existing -> 'componentQty') is distinct from (v_normalized -> 'componentQty')
        or (v_existing ->> 'componentRole') is distinct from (v_normalized ->> 'componentRole')
        or (v_existing -> 'sortOrder') is distinct from (v_normalized -> 'sortOrder') then
        v_errors := v_errors || jsonb_build_array(jsonb_build_object(
          'rowIndex', v_index,
          'code', 'conflicting_duplicate',
          'message', format('같은 세트/구성품 쌍 %s → %s에 서로 다른 수량·역할·정렬값이 있습니다.', v_bundle_sku_code, v_component_sku_code)
        ));
      end if;
      continue;
    end if;

    v_seen := v_seen || jsonb_build_object(v_key, v_normalized);
    v_normalized_rows := v_normalized_rows || jsonb_build_array(v_normalized);
  end loop;

  if jsonb_array_length(v_errors) > 0 then
    return jsonb_build_object('applied', false, 'count', 0, 'rows', '[]'::jsonb, 'errors', v_errors);
  end if;

  with recursive staged_edges as materialized (
    select
      row ->> 'bundleSkuCode' as bundle_sku_code,
      row ->> 'componentSkuCode' as component_sku_code
    from jsonb_array_elements(v_normalized_rows) row
  ), all_edges as materialized (
    select definition.bundle_sku_code, component.component_sku_code
    from public.operations_hub_bundle_definitions definition
    join public.operations_hub_bundle_components component
      on component.bundle_id = definition.bundle_id
     and component.is_active
    where definition.is_active
    union
    select bundle_sku_code, component_sku_code from staged_edges
  ), reachable(root_bundle_sku_code, current_sku_code) as (
    select staged.bundle_sku_code, staged.component_sku_code
    from staged_edges staged
    union
    select reachable.root_bundle_sku_code, edge.component_sku_code
    from reachable
    join all_edges edge on edge.bundle_sku_code = reachable.current_sku_code
  )
  select coalesce(jsonb_agg(distinct reachable.root_bundle_sku_code), '[]'::jsonb)
  into v_cycle_bundles
  from reachable
  where reachable.root_bundle_sku_code = reachable.current_sku_code;

  if jsonb_array_length(v_cycle_bundles) > 0 then
    return jsonb_build_object(
      'applied', false,
      'count', 0,
      'rows', '[]'::jsonb,
      'errors', jsonb_build_array(jsonb_build_object(
        'code', 'cycle_detected',
        'message', '업로드 결과에 순환 세트 구성이 생겨 전체 저장을 취소했습니다.',
        'bundleSkuCodes', v_cycle_bundles
      ))
    );
  end if;

  for v_item in select value from jsonb_array_elements(v_normalized_rows)
  loop
    select public.save_operations_hub_bundle_component_v1(
      v_item ->> 'bundleSkuCode',
      v_item ->> 'componentSkuCode',
      (v_item ->> 'componentQty')::integer,
      v_item ->> 'componentRole',
      (v_item ->> 'sortOrder')::integer
    ) into v_result;
    v_results := v_results || jsonb_build_array(v_result);
  end loop;

  return jsonb_build_object(
    'applied', true,
    'count', jsonb_array_length(v_results),
    'rows', v_results,
    'errors', '[]'::jsonb
  );
end;
$$;

revoke all on function public.validate_operations_hub_bundle_definition_v1() from public;
revoke all on function public.validate_operations_hub_bundle_component_v1() from public;
revoke all on function public.audit_operations_hub_bundle_definition_v1() from public;
revoke all on function public.audit_operations_hub_bundle_component_v1() from public;
revoke all on function public.list_operations_hub_bundle_graph_v1(text) from public;
revoke all on function public.resolve_operations_hub_bundle_import_codes_v1(jsonb) from public;
revoke all on function public.save_operations_hub_bundle_component_v1(text, text, integer, text, integer) from public;
revoke all on function public.deactivate_operations_hub_bundle_component_v1(bigint) from public;
revoke all on function public.apply_operations_hub_bundle_import_v1(jsonb) from public;

grant execute on function public.list_operations_hub_bundle_graph_v1(text) to anon, authenticated;
grant execute on function public.resolve_operations_hub_bundle_import_codes_v1(jsonb) to anon, authenticated;
grant execute on function public.save_operations_hub_bundle_component_v1(text, text, integer, text, integer) to anon, authenticated;
grant execute on function public.deactivate_operations_hub_bundle_component_v1(bigint) to anon, authenticated;
grant execute on function public.apply_operations_hub_bundle_import_v1(jsonb) to anon, authenticated;

comment on function public.list_operations_hub_bundle_graph_v1(text) is
  'Lists active canonical Sellpia BOM definitions and complete component lists for bundles matching an optional query.';
comment on function public.resolve_operations_hub_bundle_import_codes_v1(jsonb) is
  'Resolves up to 1000 exact Sellpia SKU codes for canonical BOM import preflight.';
comment on function public.apply_operations_hub_bundle_import_v1(jsonb) is
  'Atomically validates and additively upserts canonical BOM rows. Identical duplicate rows collapse; conflicting duplicates and cycles reject the whole request. Omitted rows are never deactivated.';
comment on function public.save_operations_hub_bundle_component_v1(text, text, integer, text, integer) is
  'SECURITY INVOKER write boundary for the current anon GitHub Pages client. Table triggers enforce exact SKU, quantity, role, self/cycle, and audit rules for RPC and direct writes alike.';
comment on function public.deactivate_operations_hub_bundle_component_v1(bigint) is
  'Soft-deactivates one canonical bundle/component edge and records an audit event.';

notify pgrst, 'reload schema';
