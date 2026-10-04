-- TARGET: picking project vgxocngpykhlkosiaeew, NOT Operations Hub bpgvqmtsjgegnrdzmpep.
-- Additive provenance only. No order/stock rewrite, grant, policy, or date backfill.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '15s';

alter table public.order_items
  add column if not exists sellpia_received_at timestamptz,
  add column if not exists sellpia_received_at_precision text,
  add column if not exists sellpia_received_at_raw text;
alter table public.stg_order_items
  add column if not exists sellpia_received_at timestamptz,
  add column if not exists sellpia_received_at_precision text,
  add column if not exists sellpia_received_at_raw text;

comment on column public.order_items.sellpia_received_at is
  'Source Sellpia receipt/collection time, not scraper time or proven stock movement time. Null if unavailable. KST assumed only for explicit local source date+time.';
comment on column public.order_items.sellpia_received_at_precision is
  'second or minute when timestamp is present; date or unknown when absent. Minute precision represents the whole minute, not a proven exact second.';
comment on column public.order_items.sellpia_received_at_raw is
  'Original receipt field text (up to 160 characters), for timestamp provenance. Re-scraping may replace it; never synthesized from receipt_date or scraped_at.';

notify pgrst, 'reload schema';
commit;
