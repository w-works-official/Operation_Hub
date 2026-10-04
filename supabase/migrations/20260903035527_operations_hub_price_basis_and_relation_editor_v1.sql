-- One manually overridable basis-price SKU per Sellpia product-code group,
-- plus an authenticated relationship-edge editor used by the matrix UI.

create table if not exists operations_private.operations_hub_price_basis_selections (
  sellpia_product_code text primary key,
  basis_sku_code text not null,
  updated_by text not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint operations_hub_price_basis_product_code_check
    check (sellpia_product_code = btrim(sellpia_product_code) and length(sellpia_product_code) between 1 and 128),
  constraint operations_hub_price_basis_sku_check
    check (basis_sku_code = btrim(basis_sku_code) and length(basis_sku_code) between 1 and 128)
);

alter table operations_private.operations_hub_price_basis_selections enable row level security;
revoke all on table operations_private.operations_hub_price_basis_selections from public, anon, authenticated;

comment on table operations_private.operations_hub_price_basis_selections is
  'Manual overrides for the basis-price SKU of a Sellpia product-code group. Missing rows resolve to the lowest effective system/source price.';

create index if not exists operations_hub_matrix_export_cache_product_group_idx
  on operations_private.operations_hub_matrix_export_cache (
    (coalesce(
      nullif(btrim(profile_json ->> 'sellpia_product_code'), ''),
      regexp_replace(sellpia_sku_code, '-[0-9]+$', '')
    )),
    sellpia_sale_price,
    sellpia_sku_code
  );

create or replace function public.load_operations_hub_price_basis_v1(
  p_skus text[]
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
set statement_timeout = '5s'
as $$
declare
  v_skus text[];
begin
  select coalesce(array_agg(distinct btrim(item)), '{}'::text[])
  into v_skus
  from unnest(coalesce(p_skus, '{}'::text[])) item
  where nullif(btrim(item), '') is not null;

  if cardinality(v_skus) > 200 then
    raise exception '기준가격 조회는 한 번에 200개 SKU까지 가능합니다.';
  end if;
  if cardinality(v_skus) = 0 then
    return '[]'::jsonb;
  end if;

  return (
    with requested as (
      select
        cache.sellpia_sku_code,
        coalesce(
          nullif(btrim(cache.profile_json ->> 'sellpia_product_code'), ''),
          regexp_replace(cache.sellpia_sku_code, '-[0-9]+$', '')
        ) as sellpia_product_code
      from operations_private.operations_hub_matrix_export_cache cache
      where cache.sellpia_sku_code = any(v_skus)
    ),
    requested_groups as (
      select distinct requested.sellpia_product_code
      from requested
    ),
    candidates as (
      select
        cache.sellpia_sku_code,
        product_group.sellpia_product_code,
        coalesce(master.base_price, cache.sellpia_sale_price) as effective_price
      from operations_private.operations_hub_matrix_export_cache cache
      cross join lateral (
        values (coalesce(
          nullif(btrim(cache.profile_json ->> 'sellpia_product_code'), ''),
          regexp_replace(cache.sellpia_sku_code, '-[0-9]+$', '')
        ))
      ) product_group(sellpia_product_code)
      join requested_groups requested_group
        on requested_group.sellpia_product_code = product_group.sellpia_product_code
      left join public.operations_hub_sku_operational_master master
        on master.sellpia_sku_code = cache.sellpia_sku_code
    ),
    ranked as (
      select
        candidates.*,
        row_number() over (
          partition by candidates.sellpia_product_code
          order by candidates.effective_price asc nulls last,
                   candidates.sellpia_sku_code collate "C" asc
        ) as price_rank,
        count(*) over (partition by candidates.sellpia_product_code) as candidate_count
      from candidates
    ),
    resolved as (
      select
        requested_group.sellpia_product_code,
        coalesce(manual_candidate.sellpia_sku_code, automatic.sellpia_sku_code) as basis_sku_code,
        coalesce(manual_candidate.effective_price, automatic.effective_price) as basis_price,
        case when manual_candidate.sellpia_sku_code is not null then 'manual' else 'auto_lowest' end as selection_mode,
        automatic.candidate_count,
        selection.updated_at
      from requested_groups requested_group
      join ranked automatic
        on automatic.sellpia_product_code = requested_group.sellpia_product_code
       and automatic.price_rank = 1
      left join operations_private.operations_hub_price_basis_selections selection
        on selection.sellpia_product_code = requested_group.sellpia_product_code
      left join ranked manual_candidate
        on manual_candidate.sellpia_product_code = selection.sellpia_product_code
       and manual_candidate.sellpia_sku_code = selection.basis_sku_code
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'sellpiaSkuCode', requested.sellpia_sku_code,
      'sellpiaProductCode', requested.sellpia_product_code,
      'basisSkuCode', resolved.basis_sku_code,
      'basisPrice', resolved.basis_price,
      'selectionMode', resolved.selection_mode,
      'candidateCount', resolved.candidate_count,
      'updatedAt', resolved.updated_at
    ) order by requested.sellpia_sku_code), '[]'::jsonb)
    from requested
    join resolved using (sellpia_product_code)
  );
end;
$$;

create or replace function public.save_operations_hub_price_basis_v1(
  p_session_token text,
  p_sellpia_product_code text,
  p_basis_sku_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
set statement_timeout = '5s'
as $$
declare
  v_session jsonb;
  v_actor text;
  v_product_code text := nullif(btrim(p_sellpia_product_code), '');
  v_basis_sku text := nullif(btrim(p_basis_sku_code), '');
  v_probe_sku text;
  v_basis jsonb;
begin
  v_session := operations_private.require_operations_hub_operator_session(p_session_token);
  v_actor := coalesce(nullif(v_session ->> 'username', ''), 'operations_hub_operator');

  if v_product_code is null or length(v_product_code) > 128 then
    raise exception '셀피아 상품코드를 확인해주세요.';
  end if;

  select cache.sellpia_sku_code
  into v_probe_sku
  from operations_private.operations_hub_matrix_export_cache cache
  where coalesce(
    nullif(btrim(cache.profile_json ->> 'sellpia_product_code'), ''),
    regexp_replace(cache.sellpia_sku_code, '-[0-9]+$', '')
  ) = v_product_code
  order by cache.sellpia_sku_code collate "C"
  limit 1;

  if v_probe_sku is null then
    raise exception '셀피아 상품코드 %의 SKU를 찾을 수 없습니다.', v_product_code;
  end if;

  if v_basis_sku is null then
    delete from operations_private.operations_hub_price_basis_selections selection
    where selection.sellpia_product_code = v_product_code;
  else
    if not exists (
      select 1
      from operations_private.operations_hub_matrix_export_cache cache
      where cache.sellpia_sku_code = v_basis_sku
        and coalesce(
          nullif(btrim(cache.profile_json ->> 'sellpia_product_code'), ''),
          regexp_replace(cache.sellpia_sku_code, '-[0-9]+$', '')
        ) = v_product_code
    ) then
      raise exception '선택한 SKU는 같은 셀피아 상품코드 그룹에 속하지 않습니다.';
    end if;

    insert into operations_private.operations_hub_price_basis_selections (
      sellpia_product_code, basis_sku_code, updated_by, updated_at
    ) values (
      v_product_code, v_basis_sku, v_actor, clock_timestamp()
    )
    on conflict (sellpia_product_code)
    do update set
      basis_sku_code = excluded.basis_sku_code,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at;
  end if;

  v_basis := public.load_operations_hub_price_basis_v1(array[v_probe_sku]) -> 0;
  return coalesce(v_basis, '{}'::jsonb);
end;
$$;

create or replace function public.update_operations_hub_relation_edge_v1(
  p_session_token text,
  p_edge_id bigint,
  p_parent_node_id bigint,
  p_child_node_id bigint,
  p_sort_order integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
set statement_timeout = '5s'
as $$
declare
  v_session jsonb;
  v_actor text;
  v_before public.operations_hub_relation_edges%rowtype;
  v_after public.operations_hub_relation_edges%rowtype;
begin
  v_session := operations_private.require_operations_hub_operator_session(p_session_token);
  v_actor := coalesce(nullif(v_session ->> 'username', ''), 'operations_hub_operator');

  if p_edge_id is null or p_parent_node_id is null or p_child_node_id is null
     or p_parent_node_id = p_child_node_id then
    raise exception '수정할 관계와 서로 다른 상위·하위 노드를 선택해주세요.';
  end if;

  select edge.* into v_before
  from public.operations_hub_relation_edges edge
  where edge.edge_id = p_edge_id and edge.is_active
  for update;
  if not found then
    raise exception '수정할 활성 관계를 찾을 수 없습니다.';
  end if;

  if not exists (
    select 1 from public.operations_hub_relation_nodes node
    where node.node_id = p_parent_node_id and node.is_active
  ) or not exists (
    select 1 from public.operations_hub_relation_nodes node
    where node.node_id = p_child_node_id and node.is_active
  ) then
    raise exception '활성 상위/하위 노드를 찾을 수 없습니다.';
  end if;

  if exists (
    select 1
    from public.operations_hub_relation_edges edge
    where edge.edge_id <> p_edge_id
      and edge.parent_node_id = p_parent_node_id
      and edge.child_node_id = p_child_node_id
  ) then
    raise exception '같은 상위·하위 관계가 이미 존재합니다.';
  end if;

  if exists (
    with recursive descendants(node_id) as (
      select p_child_node_id
      union
      select edge.child_node_id
      from public.operations_hub_relation_edges edge
      join descendants parent on parent.node_id = edge.parent_node_id
      where edge.is_active and edge.edge_id <> p_edge_id
    )
    select 1 from descendants where node_id = p_parent_node_id
  ) then
    raise exception '순환 종속관계는 만들 수 없습니다.';
  end if;

  update public.operations_hub_relation_edges edge
  set parent_node_id = p_parent_node_id,
      child_node_id = p_child_node_id,
      sort_order = greatest(0, least(coalesce(p_sort_order, 100), 10000)),
      updated_by = 'operations_hub_frontend',
      updated_at = clock_timestamp()
  where edge.edge_id = p_edge_id
  returning * into v_after;

  insert into public.operations_hub_relation_events (
    event_type, before_value, after_value, changed_by
  ) values (
    'EDGE_SAVE', to_jsonb(v_before), to_jsonb(v_after), v_actor
  );

  return jsonb_build_object(
    'edgeId', v_after.edge_id,
    'parentNodeId', v_after.parent_node_id,
    'childNodeId', v_after.child_node_id,
    'sortOrder', v_after.sort_order,
    'updated', true
  );
end;
$$;

revoke all on function public.load_operations_hub_price_basis_v1(text[]) from public, anon, authenticated;
revoke all on function public.save_operations_hub_price_basis_v1(text, text, text) from public, anon, authenticated;
revoke all on function public.update_operations_hub_relation_edge_v1(text, bigint, bigint, bigint, integer) from public, anon, authenticated;

grant execute on function public.load_operations_hub_price_basis_v1(text[]) to anon, authenticated;
grant execute on function public.save_operations_hub_price_basis_v1(text, text, text) to anon, authenticated;
grant execute on function public.update_operations_hub_relation_edge_v1(text, bigint, bigint, bigint, integer) to anon, authenticated;

comment on function public.load_operations_hub_price_basis_v1(text[]) is
  'Returns the effective basis-price SKU for visible Sellpia SKUs; manual overrides win, otherwise the lowest effective price wins.';
comment on function public.save_operations_hub_price_basis_v1(text, text, text) is
  'Authenticated manual basis-SKU save. A null basis SKU removes the override and restores automatic lowest-price selection.';
comment on function public.update_operations_hub_relation_edge_v1(text, bigint, bigint, bigint, integer) is
  'Authenticated in-place relationship-edge update with active-node, duplicate, and cycle validation.';
