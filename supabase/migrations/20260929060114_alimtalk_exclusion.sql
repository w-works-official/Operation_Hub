-- Persist an operator-controlled Alimtalk exclusion independently from the
-- CS case lifecycle. Existing cases remain included by default.

alter table public.cs_cases
  add column if not exists alimtalk_excluded boolean not null default false;

comment on column public.cs_cases.alimtalk_excluded is
  'When true, this product-line CS target is omitted from Alimtalk CSV exports and send-log writes.';

grant update (alimtalk_excluded) on table public.cs_cases to anon, authenticated;
