-- A shortage repick is physically picked stock even though it does not emit the
-- ordinary `picked` event. Count the latest workflow state for every unshipped
-- item, rather than only ordinary pick events created on the export date.
create or replace function public.get_inventory_survey_live_counts()
returns table (
  sellpia_sku_code text,
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
  base as (
    select
      lp.*,
      coalesce(oi.qty, lp.qty, 1) as item_qty,
      oi.sellpia_outbound_confirmed_date
    from latest_picking lp
    left join public.order_items oi
      on oi.ord_no = lp.ord_no
     and oi.item_no = lp.item_no
  ),
  normal_picked as (
    select
      b.sellpia_p_code as sku,
      sum(b.item_qty)::bigint as qty
    from base b
    join current_pick_state state
      on state.sellpia_item_no = b.item_no
    where coalesce(b.shortage_qty, b.short_qty, 0) = 0
      and b.sellpia_outbound_confirmed_date is null
      and nullif(btrim(b.sellpia_p_code), '') is not null
      and not exists (
        select 1
        from active_shortage_drawers d
        where d.drawer_no = nullif(btrim(b.drawer_no), '')
      )
    group by b.sellpia_p_code
  ),
  shortage_drawer_picked as (
    select
      b.sellpia_p_code as sku,
      sum(b.item_qty)::bigint as qty
    from base b
    join current_pick_state state
      on state.sellpia_item_no = b.item_no
    where coalesce(b.shortage_qty, b.short_qty, 0) = 0
      and b.sellpia_outbound_confirmed_date is null
      and nullif(btrim(b.sellpia_p_code), '') is not null
      and exists (
        select 1
        from active_shortage_drawers d
        where d.drawer_no = nullif(btrim(b.drawer_no), '')
      )
    group by b.sellpia_p_code
  )
  select
    coalesce(n.sku, s.sku) as sellpia_sku_code,
    coalesce(n.qty, 0)::bigint as picked_qty,
    coalesce(s.qty, 0)::bigint as shortage_drawer_qty,
    now() as calculated_at
  from normal_picked n
  full join shortage_drawer_picked s using (sku)
  order by sellpia_sku_code;
$$;
