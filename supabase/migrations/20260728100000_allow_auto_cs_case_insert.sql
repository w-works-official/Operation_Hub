-- CS auto-detection is read-only until an operator explicitly saves a
-- shortage case.  Permit that exact source alongside manual case creation.

drop policy if exists "cs cases create manual" on public.cs_cases;
drop policy if exists "cs cases create" on public.cs_cases;

create policy "cs cases create"
on public.cs_cases for insert to anon, authenticated
with check (
  source in ('manual', 'auto')
  and status = 'pending'
  and length(btrim(ord_no)) > 0
  and length(btrim(item_no)) > 0
  and length(btrim(case_type)) > 0
);
