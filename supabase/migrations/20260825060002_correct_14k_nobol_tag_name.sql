-- Correct the representative-provided 14K tag name without creating a duplicate.
update public.operations_hub_inbound_cost_formula_tags
set tag_name = '14K_노볼',
    updated_at = now()
where tag_name = '14K_노블'
  and not exists (
    select 1
    from public.operations_hub_inbound_cost_formula_tags existing
    where existing.tag_name = '14K_노볼'
  );

delete from public.operations_hub_inbound_cost_formula_tags
where tag_name = '14K_노블'
  and exists (
    select 1
    from public.operations_hub_inbound_cost_formula_tags existing
    where existing.tag_name = '14K_노볼'
  );

notify pgrst, 'reload schema';
