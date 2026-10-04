create index if not exists operations_hub_sku_operational_events_bulk_refresh_request_idx
  on public.operations_hub_sku_operational_events (
    (metadata ->> 'request_id'),
    field_key,
    sellpia_sku_code
  )
  where change_source = 'source_accept'
    and metadata ->> 'operation' = 'bulk_source_refresh';

create or replace function public.read_operations_hub_bulk_source_refresh_affected_skus_v1(
  p_session_token text,
  p_request_id uuid,
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
  v_skus text[];
begin
  perform operations_private.require_operations_hub_operator_session(p_session_token);

  if p_request_id is null then
    raise exception using errcode = '22023', message = '원본값 갱신 요청 ID가 필요합니다.';
  end if;

  if v_field not in (
    'system_base_price',
    'system_stock',
    'sellpia_purchase_price',
    'sellpia_order_unit',
    'sellpia_minimum_order_unit'
  ) then
    raise exception using errcode = '22023', message = '지원하지 않는 원본값 갱신 필드입니다.';
  end if;

  select coalesce(array_agg(event.sellpia_sku_code order by event.sellpia_sku_code), array[]::text[])
  into v_skus
  from (
    select distinct operational_event.sellpia_sku_code
    from public.operations_hub_sku_operational_events operational_event
    where operational_event.change_source = 'source_accept'
      and operational_event.field_key = v_field
      and operational_event.metadata ->> 'operation' = 'bulk_source_refresh'
      and operational_event.metadata ->> 'request_id' = p_request_id::text
  ) event;

  return jsonb_build_object(
    'request_id', p_request_id,
    'field_key', v_field,
    'affected_count', cardinality(v_skus),
    'affected_skus', to_jsonb(v_skus)
  );
end;
$$;

revoke all on function public.read_operations_hub_bulk_source_refresh_affected_skus_v1(text, uuid, text)
  from public;
grant execute on function public.read_operations_hub_bulk_source_refresh_affected_skus_v1(text, uuid, text)
  to anon, authenticated;

comment on function public.read_operations_hub_bulk_source_refresh_affected_skus_v1(text, uuid, text) is
  'Returns the exact SKU set written by one session-gated bulk source refresh so follow-up price materialization stays bounded.';
