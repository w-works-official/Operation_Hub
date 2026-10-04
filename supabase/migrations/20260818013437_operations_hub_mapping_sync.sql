create schema if not exists operations_private;

create table if not exists operations_private.operations_hub_manual_links_backup_20260818_013437
as table public.operations_hub_manual_links with data;

revoke all on table operations_private.operations_hub_manual_links_backup_20260818_013437 from public;
revoke all on table operations_private.operations_hub_manual_links_backup_20260818_013437 from anon, authenticated;

alter table public.operations_hub_manual_links
  add column if not exists mapping_origin text not null default 'manual',
  add column if not exists match_tier text not null default 'MANUAL_LINKED',
  add column if not exists match_score numeric not null default 100,
  add column if not exists mapping_batch_id uuid,
  add column if not exists mapping_note text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.operations_hub_manual_links'::regclass
      and conname = 'operations_hub_manual_links_origin_check'
  ) then
    alter table public.operations_hub_manual_links
      add constraint operations_hub_manual_links_origin_check
      check (mapping_origin in ('manual', 'automatic', 'import'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.operations_hub_manual_links'::regclass
      and conname = 'operations_hub_manual_links_score_check'
  ) then
    alter table public.operations_hub_manual_links
      add constraint operations_hub_manual_links_score_check
      check (match_score between 0 and 100);
  end if;
end;
$$;

create index if not exists operations_hub_manual_links_batch_idx
  on public.operations_hub_manual_links (mapping_batch_id)
  where mapping_batch_id is not null;

create table if not exists operations_private.operations_hub_mapping_batches (
  batch_id uuid primary key default gen_random_uuid(),
  mapping_origin text not null,
  actor text not null,
  status text not null default 'running',
  requested_count integer not null default 0,
  saved_count integer not null default 0,
  failed_count integer not null default 0,
  failure_items jsonb not null default '[]'::jsonb,
  note text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint operations_hub_mapping_batches_origin_check
    check (mapping_origin in ('manual', 'automatic', 'import')),
  constraint operations_hub_mapping_batches_status_check
    check (status in ('running', 'completed', 'partial', 'failed'))
);

alter table operations_private.operations_hub_mapping_batches enable row level security;

drop policy if exists "operations hub mapping batches readable"
  on operations_private.operations_hub_mapping_batches;
create policy "operations hub mapping batches readable"
  on operations_private.operations_hub_mapping_batches
  for select
  to anon, authenticated
  using (true);

revoke all on table operations_private.operations_hub_mapping_batches from public;
grant select on table operations_private.operations_hub_mapping_batches to anon, authenticated;
grant select, insert, update on table operations_private.operations_hub_mapping_batches to service_role;

create table if not exists operations_private.operations_hub_matrix_refresh_state (
  singleton boolean primary key default true,
  core_refreshed_at timestamptz not null default now(),
  refreshed_by text not null default 'migration',
  core_row_count integer not null default 0,
  legacy_mapping_at timestamptz,
  constraint operations_hub_matrix_refresh_state_singleton_check check (singleton)
);

alter table operations_private.operations_hub_matrix_refresh_state enable row level security;

drop policy if exists "operations hub matrix refresh state readable"
  on operations_private.operations_hub_matrix_refresh_state;
create policy "operations hub matrix refresh state readable"
  on operations_private.operations_hub_matrix_refresh_state
  for select
  to anon, authenticated
  using (true);

revoke all on table operations_private.operations_hub_matrix_refresh_state from public;
grant select on table operations_private.operations_hub_matrix_refresh_state to anon, authenticated;
grant select, insert, update on table operations_private.operations_hub_matrix_refresh_state to service_role;

insert into operations_private.operations_hub_matrix_refresh_state (
  singleton,
  core_refreshed_at,
  refreshed_by,
  core_row_count,
  legacy_mapping_at
)
select
  true,
  now(),
  'migration_20260818013437',
  (select count(*)::integer from operations_private.operations_hub_matrix_core),
  greatest(
    coalesce((select max(imported_at) from review.final_excel_mapping_import), '-infinity'::timestamptz),
    coalesce((select max(updated_at) from review.sheet_manual_mappings), '-infinity'::timestamptz)
  )
on conflict (singleton) do nothing;

create or replace function operations_private.save_operations_hub_mapping_batch(
  p_items jsonb,
  p_actor text default 'operations_hub_automation',
  p_origin text default 'automatic',
  p_note text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, operations_private, extensions, pg_temp
as $$
declare
  v_batch_id uuid := gen_random_uuid();
  v_origin text := lower(coalesce(nullif(btrim(p_origin), ''), 'automatic'));
  v_actor text := coalesce(nullif(btrim(p_actor), ''), 'operations_hub_automation');
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 500), '');
  v_requested integer := 0;
  v_saved integer := 0;
  v_failed integer := 0;
  v_failures jsonb := '[]'::jsonb;
  v_seen text[] := array[]::text[];
  v_entry jsonb;
  v_source text;
  v_sku text;
  v_product_code text;
  v_option_code text;
  v_entry_key text;
  v_score numeric;
  v_item public.seller_inventory_latest%rowtype;
  v_before jsonb;
  v_changed_at timestamptz;
begin
  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'p_items는 JSON 배열이어야 합니다.';
  end if;

  v_requested := jsonb_array_length(p_items);
  if v_requested < 1 or v_requested > 500 then
    raise exception '매핑 묶음은 1~500건이어야 합니다. 현재 %건', v_requested;
  end if;
  if v_origin not in ('manual', 'automatic', 'import') then
    raise exception '지원하지 않는 매핑 출처입니다: %', v_origin;
  end if;
  if v_actor !~ '^[0-9A-Za-z_.:@-]{3,120}$' then
    raise exception 'actor 형식이 올바르지 않습니다.';
  end if;

  insert into operations_private.operations_hub_mapping_batches (
    batch_id, mapping_origin, actor, status, requested_count, note
  ) values (
    v_batch_id, v_origin, v_actor, 'running', v_requested, v_note
  );

  for v_entry in select value from jsonb_array_elements(p_items)
  loop
    begin
      v_source := lower(btrim(coalesce(v_entry ->> 'source', v_entry ->> 'source_channel', '')));
      v_sku := btrim(coalesce(v_entry ->> 'sellpia_sku_code', v_entry ->> 'sellpia_sku', ''));
      v_product_code := btrim(coalesce(v_entry ->> 'product_code', ''));
      v_option_code := btrim(coalesce(v_entry ->> 'option_code', ''));
      v_entry_key := v_source || chr(0) || v_sku;

      if v_source not in ('smartstore', 'makeshop', 'ably') then
        raise exception '지원하지 않는 판매처: %', nullif(v_source, '');
      end if;
      if v_sku = '' then
        raise exception '셀피아 SKU가 비어 있습니다.';
      end if;
      if v_product_code = '' then
        raise exception '판매처 상품코드가 비어 있습니다.';
      end if;
      if array_position(v_seen, v_entry_key) is not null then
        raise exception '같은 판매처와 SKU가 묶음에 중복되었습니다.';
      end if;
      v_seen := array_append(v_seen, v_entry_key);

      if not exists (
        select 1
        from operations_private.operations_hub_matrix_core matrix
        where matrix.sellpia_sku_code = v_sku
      ) then
        raise exception '매트릭스 코어에 없는 셀피아 SKU입니다: %', v_sku;
      end if;

      select item.*
      into v_item
      from public.seller_inventory_latest item
      where item.source_channel = v_source
        and item.product_code = v_product_code
        and item.option_code = v_option_code
      limit 1;

      if not found then
        raise exception '최신 판매처 원본에서 상품·옵션 코드를 찾지 못했습니다.';
      end if;

      begin
        v_score := coalesce(nullif(v_entry ->> 'match_score', '')::numeric, 100);
      exception when invalid_text_representation then
        raise exception 'match_score가 숫자가 아닙니다.';
      end;
      if v_score < 0 or v_score > 100 then
        raise exception 'match_score는 0~100이어야 합니다.';
      end if;

      select to_jsonb(existing.*)
      into v_before
      from public.operations_hub_manual_links existing
      where existing.source_channel = v_source
        and existing.sellpia_sku_code = v_sku;

      v_changed_at := clock_timestamp();
      insert into public.operations_hub_manual_links (
        source_channel,
        sellpia_sku_code,
        product_code,
        option_code,
        product_name,
        option_name,
        updated_by,
        updated_at,
        mapping_origin,
        match_tier,
        match_score,
        mapping_batch_id,
        mapping_note
      ) values (
        v_source,
        v_sku,
        v_item.product_code,
        v_item.option_code,
        v_item.product_name,
        v_item.option_name,
        v_actor,
        v_changed_at,
        v_origin,
        case v_origin
          when 'manual' then 'MANUAL_LINKED'
          when 'import' then 'IMPORTED_LINKED'
          else 'AUTO_LINKED'
        end,
        v_score,
        v_batch_id,
        v_note
      )
      on conflict on constraint operations_hub_manual_links_pkey do update set
        product_code = excluded.product_code,
        option_code = excluded.option_code,
        product_name = excluded.product_name,
        option_name = excluded.option_name,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at,
        mapping_origin = excluded.mapping_origin,
        match_tier = excluded.match_tier,
        match_score = excluded.match_score,
        mapping_batch_id = excluded.mapping_batch_id,
        mapping_note = excluded.mapping_note;

      insert into public.operations_hub_link_history (
        sellpia_sku_code,
        source_channel,
        before_link,
        after_link,
        changed_by,
        changed_at
      ) values (
        v_sku,
        v_source,
        v_before,
        jsonb_build_object(
          'product_code', v_item.product_code,
          'option_code', v_item.option_code,
          'product_name', v_item.product_name,
          'option_name', v_item.option_name,
          'mapping_origin', v_origin,
          'match_tier', case v_origin
            when 'manual' then 'MANUAL_LINKED'
            when 'import' then 'IMPORTED_LINKED'
            else 'AUTO_LINKED'
          end,
          'match_score', v_score,
          'mapping_batch_id', v_batch_id,
          'mapping_note', v_note
        ),
        v_actor,
        v_changed_at
      );

      v_saved := v_saved + 1;
    exception when others then
      v_failed := v_failed + 1;
      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'source_channel', nullif(v_source, ''),
        'sellpia_sku_code', nullif(v_sku, ''),
        'product_code', nullif(v_product_code, ''),
        'option_code', nullif(v_option_code, ''),
        'reason', sqlerrm
      ));
    end;
  end loop;

  update operations_private.operations_hub_mapping_batches
  set
    status = case
      when v_saved = 0 then 'failed'
      when v_failed > 0 then 'partial'
      else 'completed'
    end,
    saved_count = v_saved,
    failed_count = v_failed,
    failure_items = v_failures,
    completed_at = clock_timestamp()
  where batch_id = v_batch_id;

  return jsonb_build_object(
    'batch_id', v_batch_id,
    'status', case
      when v_saved = 0 then 'failed'
      when v_failed > 0 then 'partial'
      else 'completed'
    end,
    'requested_count', v_requested,
    'saved_count', v_saved,
    'failed_count', v_failed,
    'failure_items', v_failures
  );
end;
$$;

revoke all on function operations_private.save_operations_hub_mapping_batch(jsonb, text, text, text) from public;
revoke all on function operations_private.save_operations_hub_mapping_batch(jsonb, text, text, text) from anon, authenticated;
grant execute on function operations_private.save_operations_hub_mapping_batch(jsonb, text, text, text) to service_role;

create or replace function operations_private.refresh_operations_hub_matrix_core(
  p_actor text default 'operations_hub_admin'
)
returns jsonb
language plpgsql
security definer
set search_path = public, operations_private, extensions, pg_temp
as $$
declare
  v_started_at timestamptz := clock_timestamp();
  v_completed_at timestamptz;
  v_core_rows integer;
  v_legacy_mapping_at timestamptz;
begin
  if coalesce(nullif(btrim(p_actor), ''), '') !~ '^[0-9A-Za-z_.:@-]{3,120}$' then
    raise exception 'actor 형식이 올바르지 않습니다.';
  end if;

  refresh materialized view concurrently operations_private.operations_hub_matrix_core;

  select count(*)::integer
  into v_core_rows
  from operations_private.operations_hub_matrix_core;

  select greatest(
    coalesce((select max(imported_at) from review.final_excel_mapping_import), '-infinity'::timestamptz),
    coalesce((select max(updated_at) from review.sheet_manual_mappings), '-infinity'::timestamptz)
  )
  into v_legacy_mapping_at;

  v_completed_at := clock_timestamp();
  insert into operations_private.operations_hub_matrix_refresh_state (
    singleton,
    core_refreshed_at,
    refreshed_by,
    core_row_count,
    legacy_mapping_at
  ) values (
    true,
    v_completed_at,
    btrim(p_actor),
    v_core_rows,
    v_legacy_mapping_at
  )
  on conflict (singleton) do update set
    core_refreshed_at = excluded.core_refreshed_at,
    refreshed_by = excluded.refreshed_by,
    core_row_count = excluded.core_row_count,
    legacy_mapping_at = excluded.legacy_mapping_at;

  return jsonb_build_object(
    'status', 'completed',
    'started_at', v_started_at,
    'completed_at', v_completed_at,
    'core_row_count', v_core_rows,
    'legacy_mapping_at', v_legacy_mapping_at,
    'refreshed_by', btrim(p_actor)
  );
end;
$$;

revoke all on function operations_private.refresh_operations_hub_matrix_core(text) from public;
revoke all on function operations_private.refresh_operations_hub_matrix_core(text) from anon, authenticated;
grant execute on function operations_private.refresh_operations_hub_matrix_core(text) to service_role;

create or replace function public.link_operations_hub_seller_item(
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
security invoker
set search_path = public, operations_private, extensions, pg_temp
as $$
declare
  v_item public.seller_inventory_latest%rowtype;
  v_before jsonb;
  v_linked_at timestamptz := clock_timestamp();
  v_batch_id uuid := gen_random_uuid();
begin
  if p_source not in ('smartstore', 'makeshop', 'ably') then
    raise exception '지원하지 않는 판매처입니다: %', p_source;
  end if;
  if nullif(btrim(p_sku), '') is null then
    raise exception '셀피아 SKU가 필요합니다.';
  end if;
  if not exists (
    select 1
    from operations_private.operations_hub_matrix_core matrix
    where matrix.sellpia_sku_code = btrim(p_sku)
  ) then
    raise exception '매트릭스에 없는 셀피아 SKU입니다: %', p_sku;
  end if;

  select item.*
  into v_item
  from public.seller_inventory_latest item
  where item.source_channel = p_source
    and item.product_code = btrim(p_product_code)
    and item.option_code = coalesce(btrim(p_option_code), '')
  limit 1;

  if not found then
    raise exception '최신 판매처 원본에서 선택한 상품을 찾을 수 없습니다.';
  end if;

  select to_jsonb(existing.*)
  into v_before
  from public.operations_hub_manual_links existing
  where existing.source_channel = p_source
    and existing.sellpia_sku_code = btrim(p_sku);

  insert into public.operations_hub_manual_links (
    source_channel,
    sellpia_sku_code,
    product_code,
    option_code,
    product_name,
    option_name,
    updated_by,
    updated_at,
    mapping_origin,
    match_tier,
    match_score,
    mapping_batch_id,
    mapping_note
  ) values (
    p_source,
    btrim(p_sku),
    v_item.product_code,
    v_item.option_code,
    v_item.product_name,
    v_item.option_name,
    'operations_hub_frontend',
    v_linked_at,
    'manual',
    'MANUAL_LINKED',
    100,
    v_batch_id,
    '매트릭스 판매처 검색에서 연결'
  )
  on conflict on constraint operations_hub_manual_links_pkey do update set
    product_code = excluded.product_code,
    option_code = excluded.option_code,
    product_name = excluded.product_name,
    option_name = excluded.option_name,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at,
    mapping_origin = excluded.mapping_origin,
    match_tier = excluded.match_tier,
    match_score = excluded.match_score,
    mapping_batch_id = excluded.mapping_batch_id,
    mapping_note = excluded.mapping_note;

  insert into public.operations_hub_link_history (
    sellpia_sku_code,
    source_channel,
    before_link,
    after_link,
    changed_by,
    changed_at
  ) values (
    btrim(p_sku),
    p_source,
    v_before,
    jsonb_build_object(
      'product_code', v_item.product_code,
      'option_code', v_item.option_code,
      'product_name', v_item.product_name,
      'option_name', v_item.option_name,
      'mapping_origin', 'manual',
      'match_tier', 'MANUAL_LINKED',
      'match_score', 100,
      'mapping_batch_id', v_batch_id
    ),
    'operations_hub_frontend',
    v_linked_at
  );

  return query select
    p_source,
    btrim(p_sku),
    v_item.product_code,
    v_item.option_code,
    v_item.product_name,
    v_item.option_name,
    v_item.stock,
    v_item.price,
    v_linked_at;
end;
$$;

revoke all on function public.link_operations_hub_seller_item(text, text, text, text) from public;
grant execute on function public.link_operations_hub_seller_item(text, text, text, text) to anon, authenticated;

create or replace view public.operations_hub_mapping_sync_status
with (security_invoker = true)
as
with official as (
  select
    count(*)::integer as official_mapping_count,
    count(*) filter (where mapping_origin = 'manual')::integer as manual_mapping_count,
    count(*) filter (where mapping_origin = 'automatic')::integer as automatic_mapping_count,
    count(*) filter (where mapping_origin = 'import')::integer as import_mapping_count,
    max(updated_at) as latest_official_mapping_at
  from public.operations_hub_manual_links
),
legacy as (
  select greatest(
    coalesce((select max(imported_at) from review.final_excel_mapping_import), '-infinity'::timestamptz),
    coalesce((select max(updated_at) from review.sheet_manual_mappings), '-infinity'::timestamptz)
  ) as latest_legacy_mapping_at
),
latest_batch as (
  select
    batch_id,
    mapping_origin,
    actor,
    status,
    requested_count,
    saved_count,
    failed_count,
    created_at,
    completed_at
  from operations_private.operations_hub_mapping_batches
  order by created_at desc, batch_id desc
  limit 1
)
select
  official.official_mapping_count,
  official.manual_mapping_count,
  official.automatic_mapping_count,
  official.import_mapping_count,
  official.latest_official_mapping_at,
  legacy.latest_legacy_mapping_at,
  state.core_refreshed_at,
  state.refreshed_by as core_refreshed_by,
  state.core_row_count,
  legacy.latest_legacy_mapping_at > state.core_refreshed_at as core_refresh_needed,
  latest_batch.batch_id as latest_batch_id,
  latest_batch.mapping_origin as latest_batch_origin,
  latest_batch.actor as latest_batch_actor,
  latest_batch.status as latest_batch_status,
  latest_batch.requested_count as latest_batch_requested_count,
  latest_batch.saved_count as latest_batch_saved_count,
  latest_batch.failed_count as latest_batch_failed_count,
  latest_batch.created_at as latest_batch_created_at,
  latest_batch.completed_at as latest_batch_completed_at,
  md5(concat_ws('|',
    official.official_mapping_count::text,
    coalesce(official.latest_official_mapping_at::text, ''),
    legacy.latest_legacy_mapping_at::text,
    state.core_refreshed_at::text,
    coalesce(latest_batch.batch_id::text, ''),
    coalesce(latest_batch.status, '')
  )) as mapping_version
from official
cross join legacy
cross join operations_private.operations_hub_matrix_refresh_state state
left join latest_batch on true
where state.singleton;

revoke all on public.operations_hub_mapping_sync_status from public;
grant select on public.operations_hub_mapping_sync_status to anon, authenticated;

comment on view public.operations_hub_mapping_sync_status is
  'Operations Hub mapping freshness: official overlay mappings are immediately visible; legacy review mappings require matrix core refresh.';

notify pgrst, 'reload schema';
