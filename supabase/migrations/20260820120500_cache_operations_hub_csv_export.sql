create table if not exists public.operations_hub_matrix_export_cache
as
select *
from public.operations_hub_matrix_live
with no data;

alter table public.operations_hub_matrix_export_cache
  add column if not exists cache_refreshed_at timestamptz not null default now();

alter table public.operations_hub_matrix_export_cache
  add column if not exists profile_json jsonb not null default '{}'::jsonb;

alter table public.operations_hub_matrix_export_cache
  add column if not exists seller_drafts_json jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.operations_hub_matrix_export_cache'::regclass
      and contype = 'p'
  ) then
    alter table public.operations_hub_matrix_export_cache
      add constraint operations_hub_matrix_export_cache_pkey primary key (sellpia_sku_code);
  end if;
end;
$$;

create index if not exists operations_hub_matrix_export_cache_stock_idx
  on public.operations_hub_matrix_export_cache (sellpia_current_stock desc nulls last, sellpia_sku_code);

create index if not exists operations_hub_matrix_export_cache_price_idx
  on public.operations_hub_matrix_export_cache (sellpia_sale_price desc nulls last, sellpia_sku_code);

create index if not exists operations_hub_matrix_export_cache_updated_idx
  on public.operations_hub_matrix_export_cache (updated_at desc nulls last, sellpia_sku_code);

alter table public.operations_hub_matrix_export_cache enable row level security;

drop policy if exists operations_hub_matrix_export_cache_read on public.operations_hub_matrix_export_cache;
create policy operations_hub_matrix_export_cache_read
on public.operations_hub_matrix_export_cache
for select
to anon, authenticated
using (true);

revoke all on table public.operations_hub_matrix_export_cache from public;
grant select on table public.operations_hub_matrix_export_cache to anon, authenticated;

create or replace function operations_private.refresh_operations_hub_matrix_export_cache(
  p_actor text default 'operations_hub_export_cache'
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, operations_private
as $$
declare
  v_actor text := coalesce(nullif(btrim(p_actor), ''), 'operations_hub_export_cache');
  v_started_at timestamptz := clock_timestamp();
  v_row_count integer := 0;
begin
  if v_actor !~ '^[0-9A-Za-z_.:@-]{3,120}$' then
    raise exception 'actor 형식이 올바르지 않습니다.';
  end if;

  if not pg_try_advisory_xact_lock(hashtextextended('operations_hub_matrix_export_cache_refresh', 0)) then
    return jsonb_build_object('status', 'locked', 'refreshed_by', v_actor);
  end if;

  truncate table public.operations_hub_matrix_export_cache;

  with product_tag_rollup as (
    select
      assignments.sellpia_product_code,
      jsonb_agg(
        jsonb_build_object(
          'tag_id', tags.tag_id,
          'tag_name', tags.tag_name,
          'tag_color', tags.tag_color,
          'tag_group', tags.tag_group
        ) order by tags.display_order, tags.tag_name
      ) as items,
      string_agg(tags.tag_name, ' · ' order by tags.display_order, tags.tag_name) as summary
    from public.sellpia_tag_assignments assignments
    join public.product_tags tags on tags.tag_id = assignments.tag_id and tags.is_active
    where assignments.is_active and assignments.tag_scope = 'product'
    group by assignments.sellpia_product_code
  ),
  sku_tag_rollup as (
    select
      assignments.sellpia_sku_code,
      jsonb_agg(
        jsonb_build_object(
          'tag_id', tags.tag_id,
          'tag_name', tags.tag_name,
          'tag_color', tags.tag_color,
          'tag_group', tags.tag_group
        ) order by tags.display_order, tags.tag_name
      ) as items,
      string_agg(tags.tag_name, ' · ' order by tags.display_order, tags.tag_name) as summary
    from public.sellpia_tag_assignments assignments
    join public.product_tags tags on tags.tag_id = assignments.tag_id and tags.is_active
    where assignments.is_active and assignments.tag_scope = 'option'
    group by assignments.sellpia_sku_code
  ),
  draft_rollup as (
    select
      draft.sellpia_sku_code,
      jsonb_object_agg(draft.source_channel || ':' || draft.field_key, to_jsonb(draft)) as payload
    from public.operations_hub_active_seller_drafts draft
    group by draft.sellpia_sku_code
  )
  insert into public.operations_hub_matrix_export_cache
  select
    matrix.*,
    v_started_at,
    jsonb_strip_nulls(jsonb_build_object(
      'sellpia_sku_code', matrix.sellpia_sku_code,
      'sellpia_product_code', stock.sellpia_product_code,
      'material', attr.material,
      'product_group', attr.product_group,
      'shape', attr.shape,
      'material_source', attr.material_source,
      'product_group_source', attr.product_group_source,
      'shape_source', attr.shape_source,
      'classifier_version', attr.classifier_version,
      'classified_at', attr.classified_at,
      'updated_by', attr.updated_by,
      'updated_at', attr.updated_at,
      'product_tags', coalesce(product_tags.items, '[]'::jsonb),
      'sku_tags', coalesce(sku_tags.items, '[]'::jsonb),
      'tag_summary', concat_ws(' · ', nullif(product_tags.summary, ''), nullif(sku_tags.summary, ''))
    )),
    coalesce(drafts.payload, '{}'::jsonb)
  from public.operations_hub_matrix_live matrix
  left join public.sellpia_stock_latest stock on stock.sellpia_sku_code = matrix.sellpia_sku_code
  left join catalog.sellpia_product_attributes attr on attr.sellpia_product_code = stock.sellpia_product_code
  left join product_tag_rollup product_tags on product_tags.sellpia_product_code = stock.sellpia_product_code
  left join sku_tag_rollup sku_tags on sku_tags.sellpia_sku_code = matrix.sellpia_sku_code
  left join draft_rollup drafts on drafts.sellpia_sku_code = matrix.sellpia_sku_code;

  get diagnostics v_row_count = row_count;

  return jsonb_build_object(
    'status', 'refreshed',
    'row_count', v_row_count,
    'refreshed_at', v_started_at,
    'refreshed_by', v_actor,
    'duration_ms', greatest(0, round(extract(epoch from (clock_timestamp() - v_started_at)) * 1000))
  );
end;
$$;

revoke all on function operations_private.refresh_operations_hub_matrix_export_cache(text) from public, anon, authenticated;

do $$
declare
  v_definition text;
  v_rewritten text;
begin
  v_definition := pg_get_functiondef(
    'public.export_operations_hub_matrix_chunk(integer,integer,text,text[],text,text,jsonb,text[])'::regprocedure
  );
  v_rewritten := replace(
    v_definition,
    'from public.operations_hub_matrix_live matrix',
    'from public.operations_hub_matrix_export_cache matrix'
  );

  v_rewritten := replace(
    v_rewritten,
    $needle$    left join lateral (
      select to_jsonb(profile) as profile_json
      from public.operations_hub_product_profiles profile
      where profile.sellpia_sku_code = matrix.sellpia_sku_code
      limit 1
    ) filter_profile on v_needs_profile
$needle$,
    ''
  );

  v_rewritten := replace(
    v_rewritten,
    'coalesce(filter_profile.profile_json, ''{}''::jsonb)',
    'coalesce(matrix.profile_json, ''{}''::jsonb)'
  );

  v_rewritten := replace(
    v_rewritten,
    $needle$      to_jsonb(filtered)
      || jsonb_build_object('__profile', to_jsonb(profile))
      || jsonb_build_object('__sellerDrafts', coalesce(drafts.payload, '{}'::jsonb))
$needle$,
    $replacement$      (to_jsonb(filtered) - 'profile_json' - 'seller_drafts_json' - 'cache_refreshed_at')
      || jsonb_build_object('__profile', coalesce(filtered.profile_json, '{}'::jsonb))
      || jsonb_build_object('__sellerDrafts', coalesce(filtered.seller_drafts_json, '{}'::jsonb))
$replacement$
  );

  v_rewritten := replace(
    v_rewritten,
    $needle$  from filtered
  left join public.operations_hub_product_profiles profile
    on profile.sellpia_sku_code = filtered.sellpia_sku_code
  left join lateral (
    select jsonb_object_agg(draft.source_channel || ':' || draft.field_key, to_jsonb(draft)) as payload
    from public.operations_hub_active_seller_drafts draft
    where draft.sellpia_sku_code = filtered.sellpia_sku_code
  ) drafts on true;$needle$,
    '  from filtered;'
  );

  if position('from public.operations_hub_matrix_export_cache matrix' in v_rewritten) = 0
     or position('filter_profile' in v_rewritten) > 0
     or position('operations_hub_product_profiles profile' in v_rewritten) > 0
     or position('operations_hub_active_seller_drafts draft' in v_rewritten) > 0 then
    raise exception 'CSV 내보내기 함수를 캐시 전용 조회로 전환하지 못했습니다.';
  end if;

  execute v_rewritten;
end;
$$;

comment on function public.export_operations_hub_matrix_chunk(integer, integer, text, text[], text, text, jsonb, text[]) is
  'Exports one ordered matrix CSV chunk from a minute-refreshed cache so anonymous browser requests stay below statement timeout.';

alter function public.export_operations_hub_matrix_chunk(integer, integer, text, text[], text, text, jsonb, text[])
  set statement_timeout = '20s';

do $$
begin
  if not exists (
    select 1
    from cron.job
    where jobname = 'operations-hub-csv-export-cache-refresh'
  ) then
    perform cron.schedule(
      'operations-hub-csv-export-cache-refresh',
      '* * * * *',
      $command$select operations_private.refresh_operations_hub_matrix_export_cache('cron_csv_export_cache');$command$
    );
  end if;
end;
$$;

select operations_private.refresh_operations_hub_matrix_export_cache('migration_csv_export_cache');

notify pgrst, 'reload schema';
