create index if not exists operations_hub_sku_operational_events_bulk_refresh_field_time_idx
  on public.operations_hub_sku_operational_events (
    field_key,
    created_at desc
  )
  where change_source = 'source_accept'
    and metadata ->> 'operation' = 'bulk_source_refresh';

create or replace function public.read_operations_hub_bulk_source_refresh_recovery_skus_v1(
  p_session_token text,
  p_field_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
set statement_timeout = '10s'
as $$
declare
  v_field text := lower(btrim(coalesce(p_field_key, '')));
  v_request_id uuid;
  v_latest_event_at timestamptz;
  v_affected_count integer := 0;
  v_skus text[] := array[]::text[];
begin
  perform operations_private.require_operations_hub_operator_session(p_session_token);

  if v_field not in ('system_base_price', 'sellpia_purchase_price') then
    raise exception using errcode = '22023', message = '가격계산 복구를 지원하지 않는 원본값 갱신 필드입니다.';
  end if;

  select
    (operational_event.metadata ->> 'request_id')::uuid,
    max(operational_event.created_at),
    count(distinct operational_event.sellpia_sku_code)::integer
  into v_request_id, v_latest_event_at, v_affected_count
  from public.operations_hub_sku_operational_events operational_event
  where operational_event.change_source = 'source_accept'
    and operational_event.field_key = v_field
    and operational_event.metadata ->> 'operation' = 'bulk_source_refresh'
    and nullif(operational_event.metadata ->> 'request_id', '') is not null
  group by operational_event.metadata ->> 'request_id'
  order by max(operational_event.created_at) desc
  limit 1;

  if v_request_id is null then
    return jsonb_build_object(
      'field_key', v_field,
      'affected_count', 0,
      'recovery_count', 0,
      'affected_skus', '[]'::jsonb
    );
  end if;

  select coalesce(array_agg(candidate.sellpia_sku_code order by candidate.sellpia_sku_code), array[]::text[])
  into v_skus
  from (
    select distinct source_event.sellpia_sku_code
    from public.operations_hub_sku_operational_events source_event
    left join operations_private.hub_calculated_results calculated
      on calculated.sku = source_event.sellpia_sku_code
     and calculated.scope = ''
     and calculated.field = 'calculated_base_price'
    where source_event.change_source = 'source_accept'
      and source_event.field_key = v_field
      and source_event.metadata ->> 'operation' = 'bulk_source_refresh'
      and source_event.metadata ->> 'request_id' = v_request_id::text
      and (
        calculated.sku is null
        or calculated.status <> 'calculated'
        or calculated.calculated_at < source_event.created_at
      )
  ) candidate;

  return jsonb_build_object(
    'request_id', v_request_id,
    'field_key', v_field,
    'latest_event_at', v_latest_event_at,
    'affected_count', v_affected_count,
    'recovery_count', cardinality(v_skus),
    'affected_skus', to_jsonb(v_skus)
  );
end;
$$;

revoke all on function public.read_operations_hub_bulk_source_refresh_recovery_skus_v1(text, text)
  from public;
grant execute on function public.read_operations_hub_bulk_source_refresh_recovery_skus_v1(text, text)
  to anon, authenticated;

comment on function public.read_operations_hub_bulk_source_refresh_recovery_skus_v1(text, text) is
  'Returns SKUs from the latest bulk price-input refresh whose current calculated base price is missing, failed, or older than the source event.';
