-- TARGET: picking project vgxocngpykhlkosiaeew only.
-- Additive display provenance. This does not modify existing order data.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '15s';

alter table public.orders
  add column if not exists sellpia_ordered_at text;

alter table public.order_items
  add column if not exists sellpia_ordered_at text;

comment on column public.orders.sellpia_ordered_at is
  'Sellpia source order datetime captured by the order-datetime-only enricher. Not receipt_date, scraper timestamp, or a workflow date.';
comment on column public.order_items.sellpia_ordered_at is
  'Sellpia source order datetime copied only for the matching order items by the order-datetime-only enricher.';

notify pgrst, 'reload schema';
commit;
