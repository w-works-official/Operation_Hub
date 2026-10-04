-- Persist an operator-selected Alimtalk template per product-line CS case.
-- NULL deliberately means: use the current automatic template recommendation.

alter table public.cs_cases
  add column if not exists alimtalk_template text null;

grant update (alimtalk_template) on table public.cs_cases to anon, authenticated;
