-- Restrict the count query to current, unconfirmed order rows before looking at
-- persisted picking/event history. This keeps the browser RPC under its
-- statement timeout while retaining picked and shortage-repick-completed rows.
create index if not exists picking_ord_item_latest_idx
  on public.picking (ord_no, item_no, id desc);

create index if not exists order_items_unconfirmed_lookup_idx
  on public.order_items (ord_no, item_no)
  where sellpia_outbound_confirmed_date is null;

create index if not exists workflow_item_events_current_state_idx
  on public.workflow_item_events (sellpia_item_no, event_at desc, id desc)
  where event_type in (
    'picked',
    'pick_unchecked',
    'shortage_created',
    'shortage_qty_changed',
    'shortage_repick_completed'
  );

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
  with live_order_items as (
    select ord_no, item_no, qty, prod_code
    from public.order_items
    where sellpia_outbound_confirmed_date is null
  ),
  latest_picking as (
    select distinct on (p.ord_no, p.item_no)
      p.*,
      oi.qty as order_qty,
      oi.prod_code as order_own_code
    from live_order_items oi
    join public.picking p
      on p.ord_no = oi.ord_no
     and p.item_no = oi.item_no
    order by p.ord_no, p.item_no, p.id desc
  ),
  active_shortage_drawers as (
    select distinct nullif(btrim(s.drawer_no), '') as drawer_no
    from public.shortage s
    where coalesce(s.short_qty, 0) > 0
      and nullif(btrim(s.drawer_no), '') is not null
  ),
  current_pick_state as (
    select distinct on (e.sellpia_item_no)
      e.sellpia_item_no,
      e.event_type
    from public.workflow_item_events e
    join latest_picking lp
      on lp.item_no = e.sellpia_item_no
    where e.event_type in (
      'picked',
      'pick_unchecked',
      'shortage_created',
      'shortage_qty_changed',
      'shortage_repick_completed'
    )
    order by e.sellpia_item_no, e.event_at desc, e.id desc
  ),
  eligible as (
    select
      lp.sellpia_p_code as sku,
      coalesce(nullif(btrim(lp.p_code), ''), nullif(btrim(lp.order_own_code), '')) as own_code,
      coalesce(lp.order_qty, lp.qty, 1) as item_qty,
      nullif(btrim(lp.drawer_no), '') as drawer_no
    from latest_picking lp
    join current_pick_state state
      on state.sellpia_item_no = lp.item_no
     and state.event_type in ('picked', 'shortage_repick_completed')
    where coalesce(lp.shortage_qty, lp.short_qty, 0) = 0
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
