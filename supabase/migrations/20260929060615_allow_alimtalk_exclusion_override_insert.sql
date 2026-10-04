-- Preserve the existing CS-case insert contract while allowing the hidden
-- template_override row used for operator-controlled Alimtalk preferences.

drop policy if exists "cs cases create" on public.cs_cases;

create policy "cs cases create"
on public.cs_cases for insert to anon, authenticated
with check (
  length(btrim(ord_no)) > 0
  and length(btrim(item_no)) > 0
  and length(btrim(case_type)) > 0
  and (
    (
      source in ('manual', 'auto')
      and status = 'pending'
    )
    or (
      source = 'manual'
      and status = 'excluded'
      and case_type = 'template_override'
    )
  )
);
