-- These functions exist only as table triggers. Supabase project default
-- privileges grant EXECUTE to API roles, so revoke those grants explicitly.
revoke all on function public.normalize_operations_hub_change_status()
  from public, anon, authenticated;
revoke all on function public.invalidate_operations_hub_cancelled_exports()
  from public, anon, authenticated;

notify pgrst, 'reload schema';
