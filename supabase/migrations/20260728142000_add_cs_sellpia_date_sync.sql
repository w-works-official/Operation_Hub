-- Sellpia 출고예정일 accepts an order-level free-text processing history.
-- Keep 출고확정일 as an item-level inbound-ETA date.
alter table public.orders
  add column if not exists sellpia_outbound_scheduled_date text null;

-- Earlier local/production drafts stored this field as a date.  The Sellpia
-- 출고예정일 input is actually a free-text, order-level processing history;
-- preserve existing date values as YYYY-MM-DD text while allowing new lines.
alter table public.orders
  alter column sellpia_outbound_scheduled_date type text
  using sellpia_outbound_scheduled_date::text;

alter table public.order_items
  add column if not exists sellpia_outbound_confirmed_date date null;
