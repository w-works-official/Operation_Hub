-- A downloaded inventory-count workbook must only contain a live Sellpia order.
-- Historical picking rows remain for audit, but once their order_items row has
-- been cleaned up they have no reliable outbound status and must not be treated
-- as an unshipped item. Return the own code from the same persisted picking row
-- so the workbook does not depend on whatever invoices happen to be loaded in
-- the browser at download time.
drop function if exists public.get_inventory_survey_live_counts();

create function public.get_inventory_survey_live_counts()
returns table (
  sellpia_sku_code text,
  own_code text,
  picked_qty bigint,
  shortage_drawer_qty bigint,
  calculated_at timestamptz
)
language sql
stable
set search_path = ''
as $$
  with latest_picking as (
    select *
    from (
      select
        p.*,
        row_number() over (
          partition by p.ord_no, p.item_no
          order by p.id desc
        ) as rn
      from public.picking p
    ) ranked
    where rn = 1
  ),
  active_shortage_drawers as (
    select distinct nullif(btrim(s.drawer_no), '') as drawer_no
    from public.shortage s
    where coalesce(s.short_qty, 0) > 0
      and nullif(btrim(s.drawer_no), '') is not null
  ),
  current_pick_state as (
    select sellpia_item_no, event_type
    from (
      select
        e.sellpia_item_no,
        e.event_type,
        e.event_at,
        e.id,
        row_number() over (
          partition by e.sellpia_item_no
          order by e.event_at desc, e.id desc
        ) as rn
      from public.workflow_item_events e
      where e.event_type in (
        'picked',
        'pick_unchecked',
        'shortage_created',
        'shortage_qty_changed',
        'shortage_repick_completed'
      )
        and nullif(btrim(e.sellpia_item_no), '') is not null
    ) ranked
    where rn = 1
      and event_type in ('picked', 'shortage_repick_completed')
  ),
  eligible as (
    select
      lp.sellpia_p_code as sku,
      coalesce(nullif(btrim(lp.p_code), ''), nullif(btrim(oi.prod_code), '')) as own_code,
      coalesce(oi.qty, lp.qty, 1) as item_qty,
      nullif(btrim(lp.drawer_no), '') as drawer_no
    from latest_picking lp
    join public.order_items oi
      on oi.ord_no = lp.ord_no
     and oi.item_no = lp.item_no
    join current_pick_state state
      on state.sellpia_item_no = lp.item_no
    where coalesce(lp.shortage_qty, lp.short_qty, 0) = 0
      and oi.sellpia_outbound_confirmed_date is null
      and nullif(btrim(lp.sellpia_p_code), '') is not null
  ),
  normal_picked as (
    select
      e.sku,
      string_agg(distinct e.own_code, ' / ' order by e.own_code) filter (where e.own_code is not null) as own_code,
      sum(e.item_qty)::bigint as qty
    from eligible e
    where not exists (
      select 1
      from active_shortage_drawers d
      where d.drawer_no = e.drawer_no
    )
    group by e.sku
  ),
  shortage_drawer_picked as (
    select
      e.sku,
      string_agg(distinct e.own_code, ' / ' order by e.own_code) filter (where e.own_code is not null) as own_code,
      sum(e.item_qty)::bigint as qty
    from eligible e
    where exists (
      select 1
      from active_shortage_drawers d
      where d.drawer_no = e.drawer_no
    )
    group by e.sku
  )
  select
    coalesce(n.sku, s.sku) as sellpia_sku_code,
    coalesce(n.own_code, s.own_code) as own_code,
    coalesce(n.qty, 0)::bigint as picked_qty,
    coalesce(s.qty, 0)::bigint as shortage_drawer_qty,
    now() as calculated_at
  from normal_picked n
  full join shortage_drawer_picked s using (sku)
  order by sellpia_sku_code;
$$;
