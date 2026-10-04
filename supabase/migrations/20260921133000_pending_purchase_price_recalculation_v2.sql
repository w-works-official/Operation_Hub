create or replace function public.read_operations_hub_pending_purchase_price_recalculation_v2(
  p_session_token text,
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
set statement_timeout = '5s'
as $$
declare
  v_limit integer := least(200, greatest(1, coalesce(p_limit, 100)));
  v_pending_count integer := 0;
  v_skus text[] := array[]::text[];
begin
  perform operations_private.require_operations_hub_operator_session(p_session_token);

  with relevant as (
    select distinct
      master.sellpia_sku_code as sku,
      master.purchase_price_updated_at as source_updated_at
    from public.operations_hub_sku_operational_master master
    join operations_private.hub_rule_assignments assignment
      on assignment.sku = master.sellpia_sku_code
     and assignment.scope = ''
     and assignment.target_field = 'actual_inbound_cost'
    join operations_private.hub_rules rule
      on rule.id = assignment.rule_id
     and rule.is_active
     and rule.target_field = 'actual_inbound_cost'
     and rule.source_field = 'purchase_price'
    where master.purchase_price_updated_at is not null
  ), pending as (
    select relevant.sku
    from relevant
    left join operations_private.hub_calculated_results calculated
      on calculated.sku = relevant.sku
     and calculated.scope = ''
     and calculated.field = 'actual_inbound_cost'
    where calculated.sku is null
       or calculated.status <> 'calculated'
       or calculated.error is not null
       or calculated.calculated_at < relevant.source_updated_at
  ), counted as (
    select count(*)::integer as pending_count from pending
  ), page as (
    select pending.sku
    from pending
    order by pending.sku
    limit v_limit
  )
  select
    counted.pending_count,
    coalesce(array_agg(page.sku order by page.sku) filter (where page.sku is not null), array[]::text[])
  into v_pending_count, v_skus
  from counted
  left join page on true
  group by counted.pending_count;

  return jsonb_build_object(
    'pending_count', coalesce(v_pending_count, 0),
    'batch_count', cardinality(v_skus),
    'affected_skus', to_jsonb(v_skus)
  );
end;
$$;

revoke all on function public.read_operations_hub_pending_purchase_price_recalculation_v2(text, integer)
  from public;
grant execute on function public.read_operations_hub_pending_purchase_price_recalculation_v2(text, integer)
  to anon, authenticated;

comment on function public.read_operations_hub_pending_purchase_price_recalculation_v2(text, integer) is
  'Returns a bounded batch of active purchase-price Rule SKUs whose stored actual inbound cost is missing, failed, or older than the authoritative purchase-price input.';
